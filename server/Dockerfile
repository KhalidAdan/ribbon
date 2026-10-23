# The Ribbon server in a container: Node, ffmpeg for reading, measuring and
# picturing books, and Ribbon's EPUB parser for read-along (server/README.md,
# "In Docker"). Built from the repository's root, which holds the app's own
# logic the server runs:
#
#   docker build -f server/Dockerfile -t ribbon-server .

# The EPUB parser (src-tauri/ebook), built alone: nothing of Tauri or whisper is in it.
FROM rust:1-bookworm AS ebook
WORKDIR /ribbon
COPY .cargo .cargo
COPY src-tauri src-tauri
RUN cargo build --release --locked --manifest-path src-tauri/Cargo.toml -p ribbon-ebook

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /ribbon
# The packages src/core uses (Culvert, Orama), then the server's own.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY src src
COPY server server
COPY --from=ebook /ribbon/target/release/ribbon-ebook /usr/local/bin/ribbon-ebook
ENV RIBBON_EBOOK_TOOL=/usr/local/bin/ribbon-ebook

WORKDIR /ribbon/server
# Its data folder: the database, each person's settings, and (often a bind mount of its own) the books.
ENV RIBBON_DATA=/data
VOLUME /data
EXPOSE 7766
# Node itself, not npm, so a stop reaches the server.
CMD ["node", "--import", "tsx", "src/main.ts"]
