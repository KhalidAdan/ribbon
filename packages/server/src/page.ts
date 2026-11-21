/**
 * A page the server serves itself, to someone with no app in front of them
 * yet: joining from an invite, signing a TV in from a phone. Plain HTML,
 * styled with Ribbon's own colours and type (docs/DESIGN.md), light or dark
 * as the system is.
 */
export function ribbonPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --canvas: #fafaf9; --surface: #ffffff; --line: rgb(10 10 10 / 0.14); --ink: #0a0a0a; --ink-2: #5f5f5f; --primary: #0a0a0a; --on-primary: #fafafa; --place: #d97706; }
  @media (prefers-color-scheme: dark) { :root { --canvas: #0a0a0a; --surface: #141414; --line: rgb(255 255 255 / 0.14); --ink: #ededed; --ink-2: #a1a1a1; --primary: #ededed; --on-primary: #0a0a0a; --place: #f5a524; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--canvas); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px; }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; margin: 0 0 .25rem; text-wrap: balance; }
  .lede { color: var(--ink-2); margin: 0 0 1.5rem; text-wrap: pretty; }
  .lede strong { color: var(--ink); font-weight: 500; }
  label { display: block; font-weight: 500; margin-top: 1rem; }
  input { display: block; width: 100%; margin-top: .375rem; padding: .5rem .625rem; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--place); outline-offset: 2px; }
  .hint { color: var(--ink-2); font-size: .875rem; margin: .25rem 0 0; }
  .error { color: #dc2626; min-height: 1.5rem; margin: 1rem 0 0; }
  @media (prefers-color-scheme: dark) { .error { color: #f87171; } }
  button { margin-top: .5rem; width: 100%; padding: .625rem; font: inherit; font-weight: 500; color: var(--on-primary); background: var(--primary); border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  a.button { display: block; margin-top: .5rem; padding: .625rem; text-align: center; text-decoration: none; font-weight: 500; color: var(--on-primary); background: var(--primary); border-radius: 6px; }
  a.button:focus-visible { outline: 2px solid var(--place); outline-offset: 2px; }
  .code { font: 600 1.5rem/2rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; margin: 0 0 1rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
