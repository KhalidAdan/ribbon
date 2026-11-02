/** A block of tool output as lines, without a trailing empty one. */
export function lines(text: string): string[] {
  const out = text.split(/\r?\n/);
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
