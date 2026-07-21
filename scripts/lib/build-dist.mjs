// Build-dist toggle wrapper: runs `node scripts/build.mjs` with or without
// NVIM_TEST_HOOKS=1. Consumed by: scripts/overlay-smoke.mjs,
// scripts/firefox-behavioral-smoke.mjs — both self-build a test-hooks dist to
// drive activation, then restore the production dist in a `finally`. Each
// caller keeps its own try/finally control flow and console logging; this
// only provides the build call itself, with the execFileSync cwd/env
// semantics unchanged from the originals.
import { execFileSync } from "node:child_process";

export function buildDist({ testHooks, root }) {
  const env = { ...process.env };
  if (testHooks) env.NVIM_TEST_HOOKS = "1";
  else delete env.NVIM_TEST_HOOKS;
  execFileSync("node", ["scripts/build.mjs"], { cwd: root, env, stdio: "inherit" });
}
