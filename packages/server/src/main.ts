import { buildServer } from "./app.ts";
import { readConfig } from "./config.ts";

/**
 * Start the server: `npm start` in `packages/server/`. Settings come from the
 * environment (config.ts): RIBBON_DATA, RIBBON_HOST, RIBBON_PORT,
 * RIBBON_URL, RIBBON_SECRET, and RIBBON_SIGN_IN for how people sign in.
 */
const config = readConfig();
const { app, auth, invites } = await buildServer(config, { logger: true });

if (auth.accounts) {
  // Nobody can sign in yet: say how to make the admin account.
  if (auth.people.count() === 0) {
    const invite = invites.firstAdmin();
    app.log.info(`No one can sign in yet. Open ${config.url}/invite/${invite.code} to make the admin account.`);
  }
} else if (auth.provider.kind === "browser") {
  app.log.info(`People sign in with ${auth.provider.name}. Its client for this server needs the callback URL ${config.url}/sign-in/callback`);
  const admins = auth.people.all().filter((person) => person.role === "admin");
  if (admins.length === 0 && auth.admins.length === 0) app.log.warn("This server has no admin. Name one in RIBBON_ADMINS, by the username they sign in with.");
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`Ribbon server, data in ${config.dataDir}`);
