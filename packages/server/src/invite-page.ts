import { escapeHtml, ribbonPage } from "./page.ts";

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
  return ribbonPage("Join Ribbon", body);
}
