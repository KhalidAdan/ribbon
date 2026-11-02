#!/usr/bin/env bash
# Whether the server's Docker image works: built from this checkout, started as
# a stranger would start it, the admin made from its first invite, a folder
# with a book in it added, and the book listed. Nothing else builds or starts
# the image, so this is the only check that sees the Dockerfile.
#
#   tools/check-server-image.sh
#
# Scratch data only, and it cleans up after itself. Needs Docker and Node.
set -euo pipefail

image=ribbon-server:check
name=ribbon-check
work=$(mktemp -d)
token=

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

failed() {
  echo "The server's image failed: $1" >&2
  docker logs --tail 30 "$name" >&2 || true
  exit 1
}

# Ask the server from inside its container: passwords are only taken over HTTPS or from its own machine.
api() {
  docker exec "$name" node -e '
    const [method, at, body, token] = process.argv.slice(1);
    const headers = { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    fetch(`http://127.0.0.1:7766${at}`, { method, headers, ...(body ? { body } : {}) })
      .then(async (r) => {
        const text = await r.text();
        if (!r.ok) throw new Error(`${r.status} ${text}`);
        console.log(text);
      })
      .catch((e) => {
        console.error(String(e.message));
        process.exit(1);
      });
  ' "$1" "$2" "${3:-}" "$token"
}

# One value out of the JSON on stdin, by a path such as job.state.
field() {
  node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")})' "$1"
}

docker build -f "${RIBBON_DOCKERFILE:-server/Dockerfile}" -t "$image" .

mkdir -p "$work/data" "$work/media/Test Author/Tone Book"
# The image's own ffmpeg makes the book, so it's checked too.
docker run --rm --user "$(id -u):$(id -g)" -v "$work/media:/media" --entrypoint ffmpeg "$image" \
  -v error -f lavfi -i sine=frequency=330:duration=5 -c:a libmp3lame -b:a 64k \
  -metadata title="Tone Book" -metadata album="Tone Book" -metadata artist="Test Author" \
  "/media/Test Author/Tone Book/01.mp3"

docker run -d --name "$name" --user "$(id -u):$(id -g)" -e RIBBON_FOLDERS=/media \
  -v "$work/data:/data" -v "$work/media:/media:ro" "$image" >/dev/null

for _ in $(seq 60); do
  api GET /healthz >/dev/null 2>&1 && break
  sleep 1
done
api GET /healthz >/dev/null || failed "it never answered /healthz"
echo "It starts and answers."

code=$(docker logs "$name" 2>&1 | sed -nE 's#.*/invite/([A-Za-z0-9_-]+).*#\1#p' | head -1)
[ -n "$code" ] || failed "it printed no invite"
token=$(api POST "/api/invites/$code/accept" '{"name":"admin","password":"a long enough password"}' | field token)
[ -n "$token" ] || failed "the invite made no admin"
echo "The first invite makes the admin."

job=$(api POST /api/library/import '{"folder":"/media"}' | field job.id)
for _ in $(seq 60); do
  state=$(api GET "/api/jobs/$job" | field job.state)
  [ "$state" = done ] || [ "$state" = failed ] && break
  sleep 1
done
[ "$state" = done ] || failed "adding the folder ended as '$state'"
added=$(api GET "/api/jobs/$job" | field job.progress.added)
[ "$added" = 1 ] || failed "adding the folder added '$added' books, not 1"
echo "It adds a folder with its book, using its own ffmpeg."

title=$(api GET /api/books | field books.0.title)
[ "$title" = "Tone Book" ] || failed "it lists '$title', not Tone Book"
echo "It lists the book."

# Ribbon's own Rust commands, which read-along and MP3 seeking run.
docker exec "$name" sh -c 'test -x "$RIBBON_EBOOK_TOOL" && test -x "$RIBBON_FRAMES_TOOL"' || failed "its Rust tools are missing"
echo "Its Rust tools are there."

echo "The server's image works."
