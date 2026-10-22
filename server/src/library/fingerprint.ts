import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/** How much of each end of a file the fingerprint reads. Enough to tell two encodings apart, little enough to stay quick over a share. */
const EDGE_BYTES = 1 << 20;

/**
 * What tells one book from another, to add it once and never again
 * (docs/SERVER.md, section 5): each audio file's size and the bytes at its
 * two ends, in the book's order. Two copies of the same files give the
 * same fingerprint wherever they were found and whatever they're called;
 * a different encoding of the same book gives another.
 */
export async function audioFingerprint(files: readonly { absPath: string; sizeBytes: number }[]): Promise<string> {
  const book = createHash("sha256");
  for (const f of files) book.update(`${f.sizeBytes}:${await edges(f.absPath, f.sizeBytes)}\n`);
  return book.digest("hex");
}

/** An EPUB on its own is small: its whole bytes. */
export async function fileFingerprint(absPath: string): Promise<string> {
  const handle = await open(absPath, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function edges(absPath: string, sizeBytes: number): Promise<string> {
  const handle = await open(absPath, "r");
  try {
    const hash = createHash("sha256");
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      hash.update(buffer.subarray(0, bytesRead));
    };
    await read(0, Math.min(EDGE_BYTES, sizeBytes));
    if (sizeBytes > EDGE_BYTES) await read(Math.max(EDGE_BYTES, sizeBytes - EDGE_BYTES), Math.min(EDGE_BYTES, sizeBytes - EDGE_BYTES));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
