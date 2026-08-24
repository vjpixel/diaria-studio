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
 * `--force` regenera mesmo se nada mudou. Sem ele a idempotência é POR
 * CONTEÚDO (#6064 item 1): pula quando os 4 arquivos existem E o texto do
 * `## d{N}` ainda rasteriza no mesmo carimbo gravado em
 * `_internal/.carousel-source-hash.json`; se o editor editou o social depois
 * (painel Revisão do Stage 4), o destaque é REGERADO em vez de pulado. Antes
 * disso a idempotência era por existência de arquivo, e a arte publicada
 * ficava com o texto pré-edição em silêncio.
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
  hashCarouselSlideTexts,
  shouldRenderCarouselSlides,
  readCarouselSourceHashes,
  writeCarouselSourceHashes,
  type CarouselSourceHashes,
} from "./lib/daily-carousel-card.ts";

export interface GenCarouselCardsResult {
  generated: string[];
  skipped: { destaque: string; reason: string }[];
  /** Destaques regerados porque o texto do social mudou desde o carimbo (#6064). */
  refreshed: string[];
}

/**
 * Seam de render (#6068, review de cobertura): `renderCarouselSlides` chama
 * `sharp` + fonte de marca, então o caminho de REGERAÇÃO — o que esta issue
 * existe pra consertar — não era testável sem depender do ambiente gráfico.
 * Injetável exatamente como `RenameFileDeps` em `reorder-destaques.ts`.
 */
export type RenderCarouselSlidesFn = typeof renderCarouselSlides;

export async function genCarouselCards(
  editionDir: string,
  opts: { force?: boolean; render?: RenderCarouselSlidesFn } = {},
): Promise<GenCarouselCardsResult> {
  const render = opts.render ?? renderCarouselSlides;
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    throw new Error(`03-social.md ausente em ${editionDir} — rode a Etapa 2 primeiro`);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");
  const section = extractSection(socialMd, "Social");
  const destaqueCount = readDestaqueCount(editionDir);
  const destaques = destaqueCount === 3 ? (["d1", "d2", "d3"] as const) : (["d1", "d2"] as const);

  const generated: string[] = [];
  const skipped: { destaque: string; reason: string }[] = [];
  const refreshed: string[] = [];
  const storedHashes = readCarouselSourceHashes(editionDir);
  const hashes: CarouselSourceHashes = {};

  for (const d of destaques) {
    const dText = section ? extractDestaqueBlock(section, d) : null;
    if (!dText) {
      skipped.push({ destaque: d, reason: `bloco '## ${d}' não encontrado em '# Social' de 03-social.md` });
      continue;
    }

    const outPaths = Object.fromEntries(
      CAROUSEL_SLIDE_SLOTS.map((slot) => [slot, resolve(editionDir, carouselSlideFilename(d, slot))]),
    ) as Record<(typeof CAROUSEL_SLIDE_SLOTS)[number], string>;

    // #6064 item 1: idempotência por CONTEÚDO, não por existência de arquivo.
    // Texto igual ao do carimbo → pula; texto editado depois (Studio, Stage 4)
    // → regera, senão a arte publicada fica com o texto pré-edição.
    const hash = hashCarouselSlideTexts(dText.trim());
    hashes[d] = hash;
    const allSlidesExist = CAROUSEL_SLIDE_SLOTS.every((slot) => existsSync(outPaths[slot]));
    if (!shouldRenderCarouselSlides({ allSlidesExist, storedHash: storedHashes[d], currentHash: hash, force: opts.force })) {
      generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => outPaths[slot]));
      continue;
    }
    if (allSlidesExist && storedHashes[d] !== hash) refreshed.push(d);

    const rendered = await render(dText.trim(), outPaths);
    generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => rendered[slot]));
    // #6068: carimbo gravado LOGO APÓS cada render bem-sucedido, não num
    // único write no fim. `renderCarouselSlides` escreve os 4 slots em
    // sequência e falha de render é bloqueante — com o write no fim, um throw
    // no destaque 2 descartava também o carimbo do destaque 1 que já tinha
    // renderizado certo, deixando um ERROR falso de `carousel-cards-stale`
    // até alguém re-rodar. O merge de `writeCarouselSourceHashes` torna a
    // escrita incremental barata e idempotente.
    writeCarouselSourceHashes(editionDir, { [d]: hash });
  }

  // Destaques PULADOS (carimbo já batia) também precisam constar — cobre a
  // edição pré-#6064 cujo carimbo nasce agora, sem re-render.
  if (Object.keys(hashes).length > 0) writeCarouselSourceHashes(editionDir, hashes);

  return { generated, skipped, refreshed };
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
