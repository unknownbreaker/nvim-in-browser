// Minimal loopback HTTP static server for a fixture directory (test-pages/).
// Consumed by: scripts/overlay-smoke.mjs, scripts/firefox-behavioral-smoke.mjs.
//
// The two callers' original inline servers were similar but not byte-identical:
// overlay-smoke's decodes the URL, strips the query string, guards against path
// traversal, and always serves "text/html; charset=utf-8"; firefox-behavioral's
// does none of that and instead maps file extension -> content-type. Rather than
// picking one behavior for both (which would be a real behavior change), those
// differences are exposed as options, and each caller passes the options that
// reproduce its own prior behavior exactly, including its default file.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function startFixtureServer(
  dir,
  { defaultFile = "textarea.html", contentType, guardTraversal = false, decodeUri = false } = {},
) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = req.url ?? "/";
      if (decodeUri) rel = decodeURIComponent(rel.split("?")[0]);
      rel = rel === "/" ? defaultFile : rel.replace(/^\/+/, "");
      const file = path.join(dir, rel);
      if (guardTraversal && !file.startsWith(dir)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = await readFile(file);
        const ct = contentType ? contentType(file) : "text/plain";
        res.writeHead(200, { "content-type": ct }).end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
