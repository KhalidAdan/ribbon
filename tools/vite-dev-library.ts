/**
 * Vite plugin: expose one library folder to the browser during
 * development so the UI can be driven end to end without Tauri.
 * Enabled only when ODIO_DEV_LIBRARY points at a folder.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  csv: "text/csv",
};

export function devLibrary(root: string | undefined): Plugin {
  const base = "/__odio";
  const absRoot = root ? path.resolve(root) : null;

  function inside(p: string): string {
    const abs = path.resolve(p);
    if (!absRoot || !abs.toLowerCase().startsWith(absRoot.toLowerCase())) throw new Error(`outside library: ${p}`);
    return abs;
  }

  async function body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  function json(res: ServerResponse, status: number, value: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value ?? null));
  }

  return {
    name: "odio-dev-library",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith(base)) return next();
        const op = url.pathname.slice(base.length + 1);
        try {
          if (op === "root") return json(res, 200, { root: absRoot });
          if (!absRoot) return json(res, 404, { error: "ODIO_DEV_LIBRARY not set" });

          if (op === "file") {
            const p = inside(url.searchParams.get("path") ?? "");
            if (req.method === "PUT") {
              const data = await body(req);
              const tmp = `${p}.${process.pid}.tmp`;
              await fs.writeFile(tmp, data);
              await fs.rename(tmp, p);
              return json(res, 200, true);
            }
            const st = await fs.stat(p);
            const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
            res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
            res.setHeader("accept-ranges", "bytes");
            res.setHeader("access-control-allow-origin", "*");
            const range = req.headers.range;
            if (range) {
              const m = /bytes=(\d*)-(\d*)/.exec(range);
              const start = m?.[1] ? Number(m[1]) : 0;
              const end = m?.[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
              res.statusCode = 206;
              res.setHeader("content-range", `bytes ${start}-${end}/${st.size}`);
              res.setHeader("content-length", String(end - start + 1));
              if (req.method === "HEAD") return res.end();
              createReadStream(p, { start, end }).pipe(res);
              return;
            }
            res.statusCode = 200;
            res.setHeader("content-length", String(st.size));
            if (req.method === "HEAD") return res.end();
            createReadStream(p).pipe(res);
            return;
          }

          const args = JSON.parse((await body(req)).toString("utf8") || "{}") as Record<string, unknown>;
          switch (op) {
            case "readDir": {
              const entries = await fs.readdir(inside(String(args.path)), { withFileTypes: true });
              return json(
                res,
                200,
                entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
              );
            }
            case "stat": {
              const s = await fs.stat(inside(String(args.path)));
              return json(res, 200, { sizeBytes: s.size, mtimeMs: Math.round(s.mtimeMs), isDir: s.isDirectory() });
            }
            case "exists": {
              try {
                await fs.access(inside(String(args.path)));
                return json(res, 200, true);
              } catch {
                return json(res, 200, false);
              }
            }
            case "mkdir":
              await fs.mkdir(inside(String(args.path)), { recursive: true });
              return json(res, 200, true);
            case "remove":
              await fs.rm(inside(String(args.path)), { recursive: true, force: true });
              return json(res, 200, true);
            case "run": {
              const tool = String(args.tool);
              if (tool !== "ffprobe" && tool !== "ffmpeg") return json(res, 400, { error: "bad tool" });
              const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
                execFile(tool, args.args as string[], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                  const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
                  resolve({ code, stdout: String(stdout), stderr: String(stderr) });
                });
              });
              return json(res, 200, out);
            }
            default:
              return json(res, 404, { error: `unknown op ${op}` });
          }
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
