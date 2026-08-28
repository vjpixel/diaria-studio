#!/usr/bin/env npx tsx
/**
 * render-kit-html-preview.ts (#6506)
 *
 * Renderiza o fragmento HTML do canal Kit (`esp: "kit"`) e grava em
 * `_internal/newsletter-final-kit.html` — SEM nenhuma chamada de rede,
 * mesmo quando `platform.config.json` → `publishing.newsletter.backend`
 * ainda é `"beehiiv"` (estado atual, migração Kit em curso, label
 * `kit-migration`). Existe pra dar visibilidade ao tamanho do e-mail Kit
 * ANTES do cutover — sem isto, `checkKitHtmlSize`
 * (`scripts/lib/invariant-checks/stage-4.ts`) nunca teria o que medir, e o
 * primeiro sinal de "passou de 102 KB" só apareceria depois que o backend
 * já tivesse trocado pra Kit de verdade (achado ao vivo #6506: o e-mail
 * Kit já estourava 102 KB numa medição de 28/08/2026, com o backend ainda
 * em Beehiiv — sem este script, ninguém teria visto isso antes do 1º envio
 * real).
 *
 * Reusa `buildKitHtml` de `publish-newsletter-kit.ts` — a MESMA função pura
 * (parse + render + substituição de imagem + swap de crédito de afiliado)
 * que o publisher real usaria pra montar o `content` do broadcast. Nenhuma
 * chamada de rede acontece aqui: `06-public-images.json` já foi escrito
 * pelo Stage 3 (upload de imagens), então a substituição de
 * `{{IMG:filename}}` é local.
 *
 * Uso:
 *   npx tsx scripts/render-kit-html-preview.ts <edition-dir>
 *
 * Idempotente — sobrescreve `_internal/newsletter-final-kit.html` a cada
 * chamada (mesmo padrão do render Beehiiv em render-newsletter-html.ts,
 * que também sobrescreve `newsletter-final.html`).
 *
 * Exit codes: 0 sucesso (mesmo quando o HTML sai maior que 102 KB — quem
 * decide se isso BLOQUEIA é `checkKitHtmlSize`, não este script); 1 uso/erro.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { extractContent } from "./lib/newsletter-parse.ts";
import { buildKitHtml } from "./publish-newsletter-kit.ts";
import type { PublicImagesFile } from "./substitute-image-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveOutputPath(editionDir: string): string {
  return resolve(editionDir, "_internal", "newsletter-final-kit.html");
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  const argv = process.argv.slice(2);
  const editionDirArg = parseCliArgs(argv).positional[0];
  const log = (msg: string) => process.stderr.write(`[render-kit-html-preview] ${msg}\n`);

  if (!editionDirArg) {
    log("uso: npx tsx scripts/render-kit-html-preview.ts <edition-dir>");
    process.exitCode = 1;
    return;
  }

  const editionDir = resolve(rootDir, editionDirArg);
  const content = extractContent(editionDir);

  const imagesPath = resolve(editionDir, "06-public-images.json");
  const publicImages: PublicImagesFile = existsSync(imagesPath)
    ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
    : {};

  // #6195: sem `kitAffiliateUrl`/`kitOfferText` aqui — este script é só
  // MEDIÇÃO de tamanho, não publicação real. `aplicarCreditoKit` (dentro de
  // buildKitHtml) faz o swap de crédito de afiliado mesmo sem esses opts
  // (fica neutro), o que não muda o tamanho do HTML de forma relevante —
  // ver docstring de `buildKitHtml`/`sending-platform-credit.ts` se precisar
  // do comportamento exato.
  const { html, unresolvedImages, renderWarnings } = buildKitHtml(content, publicImages);

  if (unresolvedImages.length > 0) {
    log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
  }
  if (renderWarnings.length > 0) {
    log(`warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Kit: ${renderWarnings.map((w) => w.event).join(", ")}`);
  }

  const outPath = resolveOutputPath(editionDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  const bytes = Buffer.byteLength(html, "utf8");
  const kb = (bytes / 1024).toFixed(1);
  log(`gravado: ${outPath} (${bytes} bytes, ${kb} KB)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[render-kit-html-preview] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
