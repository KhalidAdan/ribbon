# The Ribbon server in a container: Node, ffmpeg for reading, measuring and
# picturing books, and Ribbon's EPUB parser and MP3 frame index for read-along
# (packages/server/README.md, "In Docker"). The narration isn't transcribed here: a
# device with a graphics card transcribes each book and sends it. Built from
# the repository's root, which holds the app's own logic the server runs:
#
#   docker build -f packages/server/Dockerfile -t ribbon-server .

# The EPUB parser and the MP3 frame index (packages/desktop/src-tauri/ebook, packages/desktop/src-tauri/frames), built alone: nothing of Tauri is in them.
FROM rust:1-bookworm AS tools
WORKDIR /ribbon
COPY .cargo .cargo
COPY packages/desktop/src-tauri packages/desktop/src-tauri
RUN cargo build --release --locked --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook -p ribbon-frames

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /ribbon
# One install for the repository, of the server and the packages it runs, without the app's.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/host-node/package.json packages/host-node/
COPY packages/desktop/package.json packages/desktop/
COPY packages/server/package.json packages/server/
RUN npm ci --workspace @ribbon/server --workspace @ribbon/core --workspace @ribbon/host-node --include-workspace-root=false --ignore-scripts
COPY packages/core packages/core
COPY packages/host-node packages/host-node
COPY packages/server packages/server
COPY --from=tools /ribbon/target/release/ribbon-ebook /ribbon/target/release/ribbon-frames /usr/local/bin/
ENV RIBBON_EBOOK_TOOL=/usr/local/bin/ribbon-ebook RIBBON_FRAMES_TOOL=/usr/local/bin/ribbon-frames

WORKDIR /ribbon/packages/server
# Its data folder: the database, each person's settings, and (often a bind mount of its own) the books.
ENV RIBBON_DATA=/data
VOLUME /data
EXPOSE 7766
# Node itself, not npm, so a stop reaches the server.
CMD ["node", "--import", "tsx", "src/main.ts"]
