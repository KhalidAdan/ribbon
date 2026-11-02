/** ffmpeg arguments that pull the attached picture out of `inputPath` as a JPEG. */
export function coverArgs(inputPath: string, outputPath: string): string[] {
  return ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", inputPath, "-map", "0:v:0", "-frames:v", "1", "-an", "-c:v", "mjpeg", "-q:v", "3", outputPath];
}
