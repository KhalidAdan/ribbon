const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^[\\/]{2}[^\\/]/;

/**
 * Synchronous path join with the separator the root already uses. Keeps
 * the double separator that starts a Windows network path, which a naive
 * collapse of repeated separators destroys.
 */
export function joinPath(parts: readonly string[]): string {
  const first = parts.find((p) => p.length > 0) ?? "";
  const sep = DRIVE.test(first) || first.includes("\\") ? "\\" : "/";
  const unc = UNC.test(first);
  const out: string[] = [];
  let firstSeen = false;
  for (const p of parts) {
    if (!p) continue;
    let s = p.replace(/[\\/]+/g, sep);
    if (firstSeen) s = s.replace(sep === "\\" ? /^\\+/ : /^\/+/, "");
    s = s.replace(sep === "\\" ? /\\+$/ : /\/+$/, "");
    if (!firstSeen && unc) s = sep + sep + s.replace(sep === "\\" ? /^\\+/ : /^\/+/, "");
    firstSeen = true;
    if (s) out.push(s);
  }
  return out.join(sep);
}
