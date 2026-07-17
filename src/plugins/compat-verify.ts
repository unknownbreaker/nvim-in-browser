// On-demand dynamic compatibility verifier. Boots a throwaway sandboxed Neovim
// (its own worker + wasm instance), stages the candidate plugin under the site
// pack `opt/` dir so nothing auto-loads, installs a Lua "recording prelude" that
// monkey-patches every unsupported entry point to RECORD-then-return-benign, then
// `:packadd`s the candidate and runs its setup(). Whatever the plugin *tried* to
// do (spawn a process, open a socket, require a native/hard-dep module) is read
// back over RPC as a list of attempts.
//
// Why this works with no engine changes: our engine compiles the unsupported
// syscalls (spawn/exec/dlopen/sockets) to CLEAN-FAIL stubs — they surface as
// catchable Lua errors, they do NOT trap the wasm. So we can intercept at the
// Lua level (before the plugin loads) and observe intent. See
// docs/research/2026-07-17-plugin-compatibility-detection.md §2, §4.
//
// This module touches chrome.* + NvimClient, so it runs ONLY in the options page.
// Do NOT import it into any worker or content-script bundle.
import { NvimClient } from "../engine/client";
import { pluginFilesToOpt } from "./pack-layout";

export interface VerifyResult {
  ok: boolean;
  attempts: string[];
  loadError?: string;
  crashed?: boolean;
}

// Clean, no-config boot argv (mirrors nvim-host's default NVIM_ARGV): `-u NORC`
// reads no init, `--noplugin` skips auto-sourced packages. Nothing under opt/
// auto-loads anyway; this just guarantees a stock Neovim with no user state.
const CLEAN_ARGV = ["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];

const DEFAULT_TIMEOUT_MS = 20_000;

// The recording prelude, injected (once) BEFORE the candidate loads. Each patch
// is guarded (pcall / existence check) so a field missing on an older build
// (e.g. vim.system) can't error the whole prelude. Every shim RECORDS its name
// into `_NIB.calls` then returns a benign value so execution keeps going and we
// capture as many attempts as possible, rather than aborting on the first one.
const RECORDING_PRELUDE = `
_NIB = { calls = {} }
local function rec(n) _NIB.calls[#_NIB.calls + 1] = n end

-- Process spawning: return empty/zero so callers keep going.
pcall(function()
  vim.fn.system = function() rec('system'); return '' end
  vim.fn.systemlist = function() rec('systemlist'); return '' end
  vim.fn.jobstart = function() rec('jobstart'); return 0 end
  vim.fn.termopen = function() rec('termopen'); return 0 end
end)
pcall(function()
  if vim.system ~= nil then
    vim.system = function()
      rec('vim.system')
      return { wait = function() return { code = 1 } end }
    end
  end
end)
pcall(function() os.execute = function() rec('os.execute'); return true end end)
pcall(function() io.popen = function() rec('io.popen'); return nil end end)

-- libuv spawn / sockets on vim.uv AND vim.loop (usually the same table).
pcall(function()
  local seen = {}
  local uvs = {}
  if vim.uv then uvs[#uvs + 1] = vim.uv end
  if vim.loop then uvs[#uvs + 1] = vim.loop end
  for _, uv in ipairs(uvs) do
    if not seen[uv] then
      seen[uv] = true
      uv.spawn = function() rec('uv.spawn'); return nil end
      uv.new_tcp = function() rec('uv.new_tcp'); return nil end
      uv.new_udp = function() rec('uv.new_udp'); return nil end
      uv.getaddrinfo = function() rec('uv.getaddrinfo'); return nil end
    end
  end
end)

-- Native code loading.
pcall(function() package.loadlib = function() rec('package.loadlib'); return nil end end)

-- Channels / host sockets.
pcall(function()
  vim.fn.sockconnect = function() rec('sockconnect'); return 0 end
  vim.fn.serverstart = function() rec('serverstart'); return '' end
  vim.fn.chansend = function() rec('chansend'); return 0 end
end)

-- Capability probes forced truthy so guarded branches actually run and reveal
-- what they'd attempt. has() is forced only for external hosts (python3/node);
-- nvim/nvim-* version gates are left to the real answer.
pcall(function()
  vim.fn.executable = function() return 1 end
  vim.fn.exepath = function(x) return '/usr/bin/' .. tostring(x) end
  local _has = vim.fn.has
  vim.fn.has = function(f)
    if f == 'python3' or f == 'node' then return 1 end
    return _has(f)
  end
end)

-- Wrap require to RECORD risky module names (then delegate, so a missing native
-- module still throws its own catchable error — which is fine). socket.* etc.
-- match on the leading dotted component.
pcall(function()
  local risky = {
    ffi = true, socket = true, ssl = true, cjson = true, posix = true,
    plenary = true, telescope = true, ['nvim-treesitter'] = true, mason = true,
    lspconfig = true, ['nvim-dap'] = true, ['null-ls'] = true, ['none-ls'] = true,
    gitsigns = true, conform = true, ['nvim-lint'] = true, toggleterm = true,
    ['fzf-lua'] = true, ['neo-tree'] = true, ['nvim-tree'] = true,
  }
  local _oldrequire = _G.require
  _G.require = function(m)
    if type(m) == 'string' then
      local base = m:match('^[^.]+')
      if risky[m] or (base ~= nil and risky[base]) then
        rec("require('" .. m .. "')")
      end
    end
    return _oldrequire(m)
  end
end)
`;

// Best-effort activation: require the candidate's main module and call setup({})
// so setup-time side effects (which is where most spawn/socket attempts live)
// run and get recorded. `...` carries the list of module-name guesses.
const ACTIVATE_LUA = `
local names = ...
for _, n in ipairs(names) do
  local ok, m = pcall(require, n)
  if ok and type(m) == 'table' and type(m.setup) == 'function' then
    pcall(m.setup, {})
  end
end
`;

// Guess the Lua module name from the plugin dir name: try it verbatim, and with
// a trailing `.nvim` stripped (the common "<mod>.nvim" convention).
function candidateModuleNames(name: string): string[] {
  const stripped = name.replace(/\.nvim$/, "");
  return Array.from(new Set([name, stripped]));
}

function makeClient(): NvimClient {
  return new NvimClient(
    chrome.runtime.getURL("engine-worker.js"),
    chrome.runtime.getURL("nvim-asyncify.wasm"),
    chrome.runtime.getURL("nvim-runtime.tar.gz"),
    chrome.runtime.getManifest().version,
  );
}

export async function verifyPluginCompat(
  name: string,
  files: { path: string; data: Uint8Array }[],
  opts?: { timeoutMs?: number },
): Promise<VerifyResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let client: NvimClient | undefined;
  let crashed = false;
  let loadError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Construct the client INSIDE the try so a Worker/getURL failure returns a
    // VerifyResult rather than throwing out of the verifier.
    const c = makeClient();
    client = c;
    // A post-ready worker fatal routes here; a pre-ready fatal rejects start()
    // (handled by the surrounding try). Either way we flag the run as crashed.
    c.onFatal = () => {
      crashed = true;
    };

    // Run the full boot->record->packadd->read sequence, mutating loadError in the
    // load-failure case but still continuing on to read back the recorded attempts.
    const runSequence = async (): Promise<string[]> => {
      await c.start(20, 4, {
        argv: CLEAN_ARGV,
        configFiles: pluginFilesToOpt(name, files),
      });
      // Install the recording prelude BEFORE the plugin ever runs.
      await c.request("nvim_exec_lua", [RECORDING_PRELUDE, []]);
      // Load the plugin. A sourcing error rejects the RPC — record it but continue.
      try {
        await c.request("nvim_exec2", ["packadd " + name, {}]);
      } catch (e) {
        loadError = e instanceof Error ? e.message : String(e);
      }
      // Best-effort: require the main module + run setup({}) so its side effects
      // (and any unsupported calls therein) are captured. Never fatal on its own.
      try {
        await c.request("nvim_exec_lua", [ACTIVATE_LUA, [candidateModuleNames(name)]]);
      } catch {
        // A require/setup throw is expected for hard-dep plugins; the require wrap
        // already recorded the attempt, so swallow and read _NIB below.
      }
      const raw = await c.request("nvim_exec_lua", ["return vim.json.encode(_NIB.calls)", []]);
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
      } catch {
        parsed = [];
      }
      // vim.json.encode of an empty Lua table yields "{}", not "[]", so guard with
      // Array.isArray (an empty object then correctly becomes no attempts).
      const list = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
      return Array.from(new Set(list));
    };

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("verify timed out")), timeoutMs);
    });
    const attempts = await Promise.race([runSequence(), timeout]);
    const ok = attempts.length === 0 && !loadError && !crashed;
    return { ok, attempts, loadError, crashed };
  } catch {
    // Timeout, a pre-ready boot fatal, or an unexpected RPC failure. We could not
    // observe a clean run, so report a crash (never throw out of the verifier).
    return { ok: false, attempts: [], loadError, crashed: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      client?.dispose();
    } catch {
      // dispose just terminates the worker; ignore any teardown error.
    }
  }
}
