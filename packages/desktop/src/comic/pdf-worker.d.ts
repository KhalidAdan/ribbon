/** pdf.js's worker, as an address the bundler gives: declared here so whatever typechecks this folder without Vite's own types (the server's tests do) still knows it. */
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url" {
  const url: string;
  export default url;
}
