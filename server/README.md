# Ribbon server

The books, and each person's place in them, for the people you invite. The
design is [docs/SERVER.md](../docs/SERVER.md); this is how to run it.

Built so far:

- **Accounts.** People sign in with a name and a password (Better Auth), and
  the admin invites them.
- **Adding a folder.** The admin points the server at a folder on its
  machine; it copies in each book it doesn't have yet, reads its chapters and
  makes its covers. The folder is only ever read.

The library the apps read, and places, come next (docs/SERVER.md,
section 12).

## Running it

Node 24 or later, and ffmpeg (with ffprobe) on the `PATH`: adding books reads
them with ffprobe and makes covers with ffmpeg. The server shares Ribbon's own
logic (`src/core/`), so install the repository's packages too:

```bash
npm install
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

## Adding a folder

Signed in as the admin, give the folder's full path on the server's machine.
It runs as a job; ask for the job to see how it's going:

```bash
curl -X POST "$RIBBON_URL/api/library/import" -H "authorization: Bearer <your token>" \
  -H "content-type: application/json" -d '{"folder": "/srv/audiobooks"}'
curl "$RIBBON_URL/api/jobs/<job id>" -H "authorization: Bearer <your token>"
```

A book already on the server, by its files or its ISBN or ASIN, is skipped.

## Tests

```bash
npm test
npm run typecheck
```
