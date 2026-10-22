import { buildServer } from "./app.ts";
import { readConfig } from "./config.ts";

/**
 * Start the server: `npm start` in `server/`. Settings come from the
 * environment (config.ts): RIBBON_DATA, RIBBON_HOST, RIBBON_PORT,
 * RIBBON_URL, RIBBON_SECRET.
 */
const config = readConfig();
const { app, db, invites } = await buildServer(config, { logger: true });

// Nobody can sign in yet: say how to make the admin account.
const people = Number(db.prepare('SELECT count(*) AS n FROM "user"').get()?.n ?? 0);
if (people === 0) {
  const invite = invites.firstAdmin();
  app.log.info(`No one can sign in yet. Open ${config.url}/invite/${invite.code} to make the admin account.`);
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`Ribbon server, data in ${config.dataDir}`);
