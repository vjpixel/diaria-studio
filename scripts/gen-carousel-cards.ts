/**
 * gen-carousel-cards.ts (#6005 Parte B)
 *
 * Gera os 4 slides SEM foto (3 parágrafos + CTA) do carrossel diário do
 * Instagram pra cada destaque presente em `03-social.md` — a capa (slide 1)
 * é o `04-{destaque}-4x5.jpg` que `gen-social-card-4x5.ts` já gera, não
 * regenerado aqui. Ver `scripts/lib/daily-carousel-card.ts` (miolo pure) pro
 * design completo.
 *
 * Roda no Stage 3 (`stage-3-run.ts`), DEPOIS de `gen-social-card-4x5.ts` —
 * depende só de `03-social.md` (Stage 2) já existir, não da geração de
 * imagem em si.
 *
 * Uso:
 *   npx tsx scripts/gen-carousel-cards.ts --edition-dir data/editions/260824/ [--force]
 *
 * Saída local (raiz da edição): `04-{destaque}-carousel-{p1,p2,p3,cta}-4x5.jpg`.
 * `--force` regenera mesmo se o arquivo já existir (default: idempotente,
 * pula o que já está no disco — mesmo padrão de `image-generate.ts`).
 *
 * Best-effort por destaque: falha ao extrair o texto de UM destaque não
 * aborta os demais (o carrossel daquele destaque cai pro fallback de post
 * single-image em `publish-instagram.ts` — ver `resolveCarouselImageUrls`);
 * falha do RENDER (fonte de marca ausente, sharp) é bloqueante — mesma
 * severidade de `gen-social-card-4x5.ts` (#4090), porque nesse caso NENHUM
 * card sem foto vai sair certo, não só o de um destaque.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import { readDestaqueCount } from "./lib/invariant-checks/stage-3.ts";
import { extractSection, extractDestaqueBlock } from "./lib/extract-section.ts";
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  renderCarouselSlides,
} from "./lib/daily-carousel-card.ts";

export interface GenCarouselCardsResult {
  generated: string[];
  skipped: { destaque: string; reason: string }[];
}

export async function genCarouselCards(editionDir: string, opts: { force?: boolean } = {}): Promise<GenCarouselCardsResult> {
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    throw new Error(`03-social.md ausente em ${editionDir} — rode a Etapa 2 primeiro`);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");
  const section = extractSection(socialMd, "Social");
  const destaqueCount = readDestaqueCount(editionDir);
  const destaques = destaqueCount === 3 ? ["d1", "d2", "d3"] : ["d1", "d2"];

  const generated: string[] = [];
  const skipped: { destaque: string; reason: string }[] = [];

  for (const d of destaques) {
    const dText = section ? extractDestaqueBlock(section, d) : null;
    if (!dText) {
      skipped.push({ destaque: d, reason: `bloco '## ${d}' não encontrado em '# Social' de 03-social.md` });
      continue;
    }

    const outPaths = Object.fromEntries(
      CAROUSEL_SLIDE_SLOTS.map((slot) => [slot, resolve(editionDir, carouselSlideFilename(d, slot))]),
    ) as Record<(typeof CAROUSEL_SLIDE_SLOTS)[number], string>;

    if (!opts.force && CAROUSEL_SLIDE_SLOTS.every((slot) => existsSync(outPaths[slot]))) {
      generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => outPaths[slot]));
      continue; // idempotente — já gerado numa rodada anterior
    }

    const rendered = await renderCarouselSlides(dText.trim(), outPaths);
    generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => rendered[slot]));
  }

  return { generated, skipped };
}

async function main(): Promise<void> {
  // Mesmo guard de gen-social-card-4x5.ts (#4090) — sem isso os cards saem
  // com fallback de fonte, fora da marca, em silêncio.
  await assertBrandSerifAvailable("gen-carousel-cards");
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"] ?? "";
  if (!editionDir) {
    console.error("uso: gen-carousel-cards.ts --edition-dir <dir> [--force]");
    process.exit(1);
  }
  const force = args.flags.has("force");

  const result = await genCarouselCards(editionDir, { force });
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
