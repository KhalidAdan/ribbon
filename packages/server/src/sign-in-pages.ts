import { escapeHtml, ribbonPage } from "./page.ts";

/**
 * The pages someone sees in a browser while signing a device in
 * (sign-in-routes.ts): the one a TV's code leads to, and what's said when a
 * sign-in ends, well or badly. Each says plainly what to do next.
 */

/** Where a TV's code is typed, for someone who opened the address without scanning the TV's picture of it. */
export function askForCodePage(problem?: string): string {
  return ribbonPage(
    "Sign in a device",
    `<h1>Sign in a device</h1>
      <p class="lede">Type the code your TV is showing.</p>
      <form method="get" action="/link">
        <label for="code">Code</label>
        <input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="ABCD-EFGH">
        <p class="error" role="alert">${escapeHtml(problem ?? "")}</p>
        <button type="submit">Continue</button>
      </form>`,
  );
}

/** A device is waiting on this code: say which, and offer the way this server signs people in. */
export function approveDevicePage(opts: { code: string; device: string; signIn: { kind: "password" } | { kind: "browser"; name: string } }): string {
  const code = escapeHtml(opts.code);
  const start = `<h1>Sign in ${escapeHtml(opts.device || "a device")}</h1>
      <p class="code">${code}</p>
      <p class="lede">If that's the code on its screen, sign in here and it will open your library.</p>`;
  if (opts.signIn.kind === "browser") {
    return ribbonPage("Sign in a device", `${start}<a class="button" href="/sign-in/start?device=${encodeURIComponent(opts.code)}">Sign in with ${escapeHtml(opts.signIn.name)}</a>`);
  }
  return ribbonPage(
    "Sign in a device",
    `${start}
      <form id="approve" novalidate>
        <label for="name">Name</label>
        <input id="name" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <p id="error" class="error" role="alert"></p>
        <button type="submit">Sign in</button>
      </form>
      <div id="done" hidden><p class="lede">You're in. Look at the device: it's opening your library.</p></div>
      <script>
        const form = document.getElementById("approve");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const error = document.getElementById("error");
          error.textContent = "";
          const button = form.querySelector("button");
          button.disabled = true;
          try {
            const r = await fetch("/api/sign-in/device/approve", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: ${JSON.stringify(opts.code)}, name: form.name.value.trim(), password: form.password.value }),
            });
            const answer = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(answer.error || "That didn't work. Try again.");
            form.hidden = true;
            document.querySelector(".lede").hidden = true;
            document.getElementById("done").hidden = false;
          } catch (err) {
            error.textContent = err.message;
            button.disabled = false;
          }
        });
      </script>`,
  );
}

/** A device was signed in from this browser. */
export function deviceSignedInPage(opts: { device: string; person: string }): string {
  return ribbonPage(
    "You're in",
    `<h1>You're in</h1>
      <p class="lede"><strong>${escapeHtml(opts.device || "The device")}</strong> is signed in as <strong>${escapeHtml(opts.person)}</strong>. Look at its screen: it's opening your library. You can close this page.</p>`,
  );
}

/** A sign-in that ended with nobody signed in, and why. */
export function signInFailedPage(why: string): string {
  return ribbonPage(
    "That didn't work",
    `<h1>That didn't work</h1>
      <p class="lede">${escapeHtml(why)}</p>`,
  );
}
