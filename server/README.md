# Ribbon server

The books, and each person's place in them, for the people you invite. The
design is [docs/SERVER.md](../docs/SERVER.md); this is how to run it.

Built so far: accounts. People sign in with a name and a password (Better
Auth), and the admin invites them. The books, the library and places come
next (docs/SERVER.md, section 12).

## Running it

Node 24 or later.

```bash
cd server
npm install
npm start
```

The first start prints a link: open it to make the admin account. Until
someone does, every start prints it again.

```text
No one can sign in yet. Open http://localhost:7766/invite/… to make the admin account.
```

## Settings

From the environment:

| Variable | Default | What it is |
| --- | --- | --- |
| `RIBBON_DATA` | `ribbon-data`, where it's started | Its data folder: the database, the books, each person's places. Back it up. |
| `RIBBON_HOST` | `127.0.0.1` | Where it listens. This machine only, until you choose otherwise. |
| `RIBBON_PORT` | `7766` | |
| `RIBBON_URL` | `http://localhost:7766` | The address people use to reach it. Invite links are made from it. |
| `RIBBON_SECRET` | made on the first start | Signs sessions. Kept in the data folder unless given here. |

## Reaching it from elsewhere

The server speaks plain HTTP on this machine. How anyone else reaches it is
yours to choose: a reverse proxy with HTTPS (Caddy, nginx), Tailscale Serve,
a tunnel. Passwords are only accepted over HTTPS, or from this machine, and
the iPhone app needs HTTPS anyway. Set `RIBBON_URL` to the address people
use, so invite links point there.

## Inviting people

Signed in as the admin, `POST /api/invites` makes a link that's good once,
for a week. The admin pages that do this come later; until then:

```bash
curl -X POST "$RIBBON_URL/api/invites" -H "authorization: Bearer <your token>"
```

## Tests

```bash
npm test
npm run typecheck
```
