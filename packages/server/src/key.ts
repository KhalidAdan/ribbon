import { Sessions } from "@ribbon/auth/sessions";
import { People } from "./auth.ts";
import { readConfig } from "./config.ts";
import { openDatabase } from "./db.ts";

/**
 * Make a key for an assistant to use the server's MCP with (mcp.ts):
 *
 *     npm run key -- khalid            # a key that acts as the admin "khalid"
 *     npm run key -- khalid "Claude"   # the same, named in the list of their devices
 *
 * (in the container: `node --import tsx src/key.ts khalid`.) The key is a
 * session like a device's, good for a year, and it is shown this once:
 * the server keeps only what it needs to know it again. Whoever holds it
 * can do what that person can, so it is for an admin to make and to give
 * to nothing they wouldn't sign in on.
 *
 * It only adds a session, so it's safe to run while the server is up.
 */
const [name, label] = process.argv.slice(2);
const config = readConfig();
const db = openDatabase(config.dataDir);
const person = name ? new People(db).all().find((p) => p.name.toLowerCase() === name.toLowerCase()) : undefined;

if (!person) {
  console.error(name ? `There's nobody called ${name} on this server.` : "Say who the key acts as: npm run key -- <their name here>");
  process.exitCode = 1;
} else if (person.role !== "admin") {
  console.error(`${person.name} isn't an admin, and the MCP takes only an admin's key.`);
  process.exitCode = 1;
} else {
  const key = new Sessions(db).start(person.id, `MCP: ${label ?? "an assistant"}`);
  console.log(`A key for ${person.name}, shown once:\n\n  ${key}\n\nPoint an assistant at ${config.url}/mcp with it as a bearer token. With Claude Code:\n\n  claude mcp add --transport http ribbon ${config.url}/mcp --header "Authorization: Bearer ${key}"\n`);
}
db.close();
