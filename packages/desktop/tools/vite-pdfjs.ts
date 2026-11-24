/**
 * Vite plugin: what pdf.js fetches as it reads a PDF (docs/COMICS.md,
 * section 12), served beside the app at `/pdfjs/`: its decoders for the
 * kinds of picture old scans are made of (JPEG 2000, JBIG2: `wasm/`), the
 * character maps and stand-in fonts a PDF may lean on (`cmaps/`,
 * `standard_fonts/`), and colour profiles (`iccs/`). They come from the
 * `pdfjs-dist` package as they are: served from it while developing, and
 * copied into the build.
 */
import type { Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const FOLDERS = ["wasm", "cmaps", "standard_fonts", "iccs"];
const TYPES: Record<string, string> = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript" };

export function pdfjsFiles(): Plugin {
  const from = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  let out = "";
  return {
    name: "ribbon-pdfjs-files",
    configResolved(config) {
      out = path.resolve(config.root, config.build.outDir, "pdfjs");
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const asked = decodeURIComponent((req.url ?? "/").split("?")[0]!);
        const file = path.join(from, asked);
        // Only the four folders, and nothing above them.
        if (!FOLDERS.some((f) => file.startsWith(path.join(from, f) + path.sep)) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      if (!out) return;
      for (const folder of FOLDERS) if (existsSync(path.join(from, folder))) await cp(path.join(from, folder), path.join(out, folder), { recursive: true });
    },
  };
}
