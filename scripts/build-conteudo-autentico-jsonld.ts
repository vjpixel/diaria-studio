/**
 * build-conteudo-autentico-jsonld.ts (#10510)
 *
 * Regrava o bloco JSON-LD (Course + FAQPage + BreadcrumbList) da página de
 * venda `/produto/conteudo-autentico/b` (a versão ativa, para onde a URL principal redireciona), derivado da própria página (perguntas
 * dos `<details>`, preço do card da oferta, meta description). Ver
 * `scripts/lib/conteudo-autentico-page.ts`.
 *
 * Rodar depois de mexer no FAQ, no preço ou na description da página:
 *   npx tsx scripts/build-conteudo-autentico-jsonld.ts          # regrava
 *   npx tsx scripts/build-conteudo-autentico-jsonld.ts --check  # só confere (exit 1 se divergir)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { applyConteudoAutenticoJsonLd } from "./lib/conteudo-autentico-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PAGE_PATH = resolve(ROOT, "workers/site/public/produto/conteudo-autentico/b/index.html");

function main(): void {
  const check = process.argv.includes("--check");
  const html = readFileSync(PAGE_PATH, "utf8");
  const next = applyConteudoAutenticoJsonLd(html);
  if (next === html) {
    console.log("conteudo-autentico: JSON-LD em dia");
    return;
  }
  if (check) {
    console.error("conteudo-autentico: JSON-LD divergente da página. Rode npx tsx scripts/build-conteudo-autentico-jsonld.ts");
    process.exitCode = 1;
    return;
  }
  writeFileSync(PAGE_PATH, next);
  console.log(`conteudo-autentico: JSON-LD regravado em ${PAGE_PATH}`);
}

if (isMainModule(import.meta.url)) main();
