import { POCKET_ID } from "@ribbon/auth-pocket-id/pocket-id";
import { People } from "./auth.ts";
import { readConfig } from "./config.ts";
import { openDatabase } from "./db.ts";

/**
 * Say who's who before a server changes from its own accounts to Pocket ID,
 * so everyone keeps their places:
 *
 *     npm run link                      # everyone here, and who is expected at Pocket ID
 *     npm run link -- annie ann         # the person "annie" will sign in to Pocket ID as "ann"
 *
 * (in the container: `node --import tsx src/link.ts annie ann`.) The first
 * time "ann" signs in with Pocket ID they are annie, with annie's places,
 * goal and devices; from then on Pocket ID's own id for them is what finds
 * them, whatever they're called. Someone nobody was expecting becomes a
 * new person, with nothing.
 *
 * It only writes who to expect, so it's safe to run while the server is up.
 */
const [personName, username] = process.argv.slice(2);
const db = openDatabase(readConfig().dataDir);
const people = new People(db);

if (personName && username) {
  if (people.expect(personName, POCKET_ID, username)) console.log(`${personName} is expected at Pocket ID as ${username.toLowerCase()}.`);
  else {
    console.error(`There's nobody called ${personName} on this server.`);
    process.exitCode = 1;
  }
} else if (personName) {
  console.error("Say both: the person here, then their username at Pocket ID.");
  process.exitCode = 1;
}

const expected = people.expected(POCKET_ID);
console.log("\nOn this server:");
for (const person of people.all()) {
  const as = expected.find((link) => link.person === person.name);
  console.log(`  ${person.name}${person.role === "admin" ? " (admin)" : ""}${as ? `, expected at Pocket ID as ${as.username}` : ""}`);
}
db.close();
