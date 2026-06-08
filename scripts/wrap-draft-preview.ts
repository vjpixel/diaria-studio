/**
 * wrap-draft-preview.ts
 *
 * Envolve o HTML email da newsletter num wrapper mobile-friendly para preview.
 * Adiciona viewport meta, padding, font-size ajustado e stacking do É IA? em mobile.
 *
 * Uso:
 *   npx tsx scripts/wrap-draft-preview.ts --html data/editions/260526/_internal/newsletter-final.html --out data/editions/260526/_internal/draft-preview.html
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const htmlIdx = args.indexOf("--html");
const outIdx = args.indexOf("--out");
if (htmlIdx < 0 || outIdx < 0) {
  console.error("Usage: --html <input> --out <output>");
  process.exit(2);
}

const inputPath = args[htmlIdx + 1];
const outPath = args[outIdx + 1];

const body = readFileSync(inputPath, "utf8");

const wrapped = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Newsletter Preview</title>
<style>
  body {
    margin: 0;
    padding: 12px;
    background: #ffffff;
    font-size: 16px;
  }
  .preview-wrapper {
    max-width: 620px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 0;
    padding: 16px;
    box-shadow: none;
  }
  .preview-wrapper img {
    max-width: 100%;
    height: auto !important;
  }
  .preview-wrapper table {
    max-width: 100% !important;
  }
  .preview-wrapper td {
    word-break: break-word;
  }
  @media (max-width: 480px) {
    body { padding: 6px; }
    .preview-wrapper { padding: 10px; border-radius: 0; }
    .preview-wrapper p,
    .preview-wrapper td { font-size: 16px !important; line-height: 1.55 !important; }
    .preview-wrapper .mob-stack {
      display: block !important;
      width: 100% !important;
      padding: 0 0 12px 0 !important;
    }
  }
</style>
</head>
<body>
<div class="preview-wrapper">
${body}
</div>
</body>
</html>`;

writeFileSync(outPath, wrapped);
console.log(JSON.stringify({ out: outPath, bytes: Buffer.byteLength(wrapped) }));
