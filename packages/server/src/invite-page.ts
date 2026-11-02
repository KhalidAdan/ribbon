/**
 * The page an invite link opens: pick a name and a password, and the
 * account exists. Plain HTML, styled with Ribbon's own colours and type
 * (docs/DESIGN.md), light or dark as the system is. It's the one page
 * someone sees before they have an app connected, so it says plainly what
 * to do next.
 */
export function invitePage(opts: { code: string; usable: boolean; serverUrl: string }): string {
  const url = escapeHtml(opts.serverUrl);
  const body = opts.usable
    ? `<h1>Join this Ribbon library</h1>
      <p class="lede">Pick the name and password you'll sign in with.</p>
      <form id="join" novalidate>
        <label for="name">Name</label>
        <input id="name" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.]+">
        <p class="hint">Letters, numbers, dots and underscores.</p>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
        <p class="hint">At least 8 characters.</p>
        <p id="error" class="error" role="alert"></p>
        <button type="submit">Join</button>
      </form>
      <div id="done" hidden>
        <p class="lede">In Ribbon, choose <strong>Connect to a server</strong>, and sign in at <strong>${url}</strong> as <strong id="who"></strong>.</p>
      </div>
      <script>
        const form = document.getElementById("join");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const error = document.getElementById("error");
          error.textContent = "";
          const button = form.querySelector("button");
          button.disabled = true;
          try {
            const r = await fetch(location.pathname.replace(/^\\/invite\\//, "/api/invites/") + "/accept", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: form.name.value.trim(), password: form.password.value }),
            });
            const answer = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(answer.error || "That didn't work. Try again.");
            document.getElementById("who").textContent = answer.user.name;
            document.querySelector("h1").textContent = "You're in";
            form.hidden = true;
            document.querySelector(".lede").hidden = true;
            document.getElementById("done").hidden = false;
          } catch (err) {
            error.textContent = err.message;
            button.disabled = false;
          }
        });
      </script>`
    : `<h1>This invite can't be used</h1>
      <p class="lede">It has been used already, or it has expired. Ask the server's admin for a new one.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join Ribbon</title>
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
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
