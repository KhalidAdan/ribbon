// The `hyphen` package ships no types: its core and its pattern files.
declare module "hyphen/hyphen.js" {
  interface Options {
    hyphenChar?: string;
    minWordLength?: number;
    html?: boolean;
    exceptions?: string[];
  }
  export default function createHyphenator(patterns: unknown, options?: Options): (text: string) => string;
}

declare module "hyphen/patterns/*" {
  const patterns: unknown;
  export default patterns;
}
