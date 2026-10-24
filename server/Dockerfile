# The Ribbon server in a container: Node, ffmpeg for reading, measuring and
# picturing books, Ribbon's EPUB parser and MP3 frame index for read-along,
# and its speech, with the whisper model the apps download, to transcribe the
# narration (server/README.md, "In Docker"). Built from the repository's root,
# which holds the app's own logic the server runs:
#
#   docker build -f server/Dockerfile -t ribbon-server .
#
# whisper.cpp is compiled for the processor of the machine that builds the
# image (its vector instructions: AVX2 where there is one), so build it on the
# machine that runs it.

# The EPUB parser, the MP3 frame index and speech (src-tauri/ebook, src-tauri/frames, src-tauri/speech), built alone:
# nothing of Tauri is in them. whisper.cpp needs cmake, and uses the bindings that come with whisper-rs rather than making its own.
FROM rust:1-bookworm AS tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake \
  && rm -rf /var/lib/apt/lists/*
# whisper base, as the apps download it (src-tauri/src/speech.rs, MODEL_URL), checked against Hugging Face's own hash of it.
RUN curl -fsSL -o /ggml-base-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin \
  && echo "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898  /ggml-base-q5_1.bin" | sha256sum -c -
WORKDIR /ribbon
COPY .cargo .cargo
COPY src-tauri src-tauri
ENV WHISPER_DONT_GENERATE_BINDINGS=1
RUN cargo build --release --locked --manifest-path src-tauri/Cargo.toml -p ribbon-ebook -p ribbon-frames -p ribbon-speech

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
COPY --from=tools /ggml-base-q5_1.bin /usr/local/share/ribbon/
COPY --from=tools /ribbon/target/release/ribbon-ebook /ribbon/target/release/ribbon-frames /ribbon/target/release/ribbon-speech /usr/local/bin/
ENV RIBBON_EBOOK_TOOL=/usr/local/bin/ribbon-ebook RIBBON_FRAMES_TOOL=/usr/local/bin/ribbon-frames
# The narration is transcribed here, behind everything else, on half the machine (RIBBON_SPEECH_THREADS to change it);
# run with RIBBON_SPEECH_MODEL= to leave it to the devices.
ENV RIBBON_SPEECH_TOOL=/usr/local/bin/ribbon-speech RIBBON_SPEECH_MODEL=/usr/local/share/ribbon/ggml-base-q5_1.bin

WORKDIR /ribbon/server
# Its data folder: the database, each person's settings, and (often a bind mount of its own) the books.
ENV RIBBON_DATA=/data
VOLUME /data
EXPOSE 7766
# Node itself, not npm, so a stop reaches the server.
CMD ["node", "--import", "tsx", "src/main.ts"]
