/**
 * ensure-html-document.ts (#13055)
 *
 * Garante `<!doctype html>` + `<meta charset>` + viewport nas páginas de prévia
 * montadas à mão antes de publicar no Artifact (prévia do artigo do LinkedIn no
 * Passo 7b de `/diaria-linkedin-semanal`, páginas de apoio e `index.html` do
 * gate do `/diaria-pacote-semanal`). Sem doctype a página abre em quirks mode.
 * Idempotente: arquivo que já abre com doctype fica igual.
 *
 * Reescreve os arquivos no lugar. Uso só em cópias do scratchpad, nunca em
 * `data/` (o `ln-{cycle}.html` é fragmento colável de propósito).
 *
 * Uso:
 *   npx tsx scripts/ensure-html-document.ts {scratchpad}/pacote-26w46/*.html
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ensureHtmlDocument, hasHtmlDoctype } from "./lib/shared/html-document.ts";
import { isMainModule } from "./lib/cli-args.ts";

export function ensureHtmlDocumentFiles(paths: readonly string[]): { changed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const p of paths) {
    const html = readFileSync(p, "utf8");
    if (hasHtmlDoctype(html)) {
      unchanged.push(p);
      continue;
    }
    writeFileSync(p, ensureHtmlDocument(html), "utf8");
    changed.push(p);
  }
  return { changed, unchanged };
}

if (isMainModule(import.meta.url)) {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    console.error("uso: npx tsx scripts/ensure-html-document.ts arquivo.html [arquivo.html ...]");
    process.exit(2);
  }
  const { changed, unchanged } = ensureHtmlDocumentFiles(paths);
  for (const p of changed) console.log(`[ensure-html-document] documento completo: ${p}`);
  for (const p of unchanged) console.log(`[ensure-html-document] já tinha doctype: ${p}`);
}
