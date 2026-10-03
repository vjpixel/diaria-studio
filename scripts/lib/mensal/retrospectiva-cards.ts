/**
 * scripts/lib/mensal/retrospectiva-cards.ts (#9508)
 *
 * Imagens dos posts por história da Retrospectiva do Mês — o MESMO formato do
 * carrossel dos destaques diários (#6005 Parte B), sem render novo:
 *
 *   - capa 4:5 com o título da história (`generateCard` de
 *     `gen-social-card-4x5.ts`, a partir do `04-d{N}-2x1.jpg` do ciclo), com a
 *     linha de série "Retrospectiva de {Mês}" acima do título;
 *   - 3 slides de parágrafo + slide de CTA (`renderCarouselSlides` de
 *     `daily-carousel-card.ts`), texto = `divulgacao/d{N}.md`, slide de CTA
 *     com `RETROSPECTIVA_CAROUSEL_CTA` (override do #8681).
 *
 * Saída local em `data/monthly/{ciclo}/divulgacao/` com os nomes da diária
 * (`04-d{N}-4x5.jpg`, `04-d{N}-carousel-{p1,p2,p3,cta}-4x5.jpg`) — fora da
 * raiz do ciclo pra não se misturar aos assets do e-mail mensal. Sobem pro KV
 * via `uploadMonthlyImage` (key `img-{ciclo}-{arquivo}`), a mesma convenção
 * das imagens do ciclo.
 *
 * Uso por canal (mesmo recorte da diária): Instagram e Threads = os 5
 * (carrossel); X = capa + 3 parágrafos (sem o CTA, #8202); Facebook e
 * LinkedIn página = só a capa.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { generateCard, overlayWrapLines, computeCarouselTitleFontSize } from "../../gen-social-card-4x5.ts";
import { CAROUSEL_SLIDE_SLOTS, carouselCoverFilename, carouselSlideFilename, renderCarouselSlides } from "../daily-carousel-card.ts";
import { RETROSPECTIVA_CAROUSEL_CTA } from "./retrospectiva-social.ts";
import type { RetrospectivaHistoria } from "./retrospectiva-divulgacao.ts";

/** Ordem do carrossel: capa → p1 → p2 → p3 → cta. */
export const RETROSPECTIVA_CARD_SLOTS = ["cover", ...CAROUSEL_SLIDE_SLOTS] as const;
export type RetrospectivaCardSlot = (typeof RETROSPECTIVA_CARD_SLOTS)[number];
export type RetrospectivaCardSet = Record<RetrospectivaCardSlot, string>;

/** Largura útil do título na capa (1080 - 2×72 de margem), a mesma de `gen-social-card-4x5.ts`. */
const COVER_TITLE_WIDTH = 1080 - 72 * 2;

/** Paths locais das 5 imagens de uma história. */
export function retrospectivaCardPaths(cycleDir: string, h: RetrospectivaHistoria): RetrospectivaCardSet {
  const dir = resolve(cycleDir, "divulgacao");
  return {
    cover: resolve(dir, carouselCoverFilename(h)),
    ...(Object.fromEntries(CAROUSEL_SLIDE_SLOTS.map((s) => [s, resolve(dir, carouselSlideFilename(h, s))])) as Record<
      (typeof CAROUSEL_SLIDE_SLOTS)[number],
      string
    >),
  };
}

/** Pura: o título cabe na capa a 62px em até 3 linhas? (política #8589/#6078: senão, reescrever o título) */
export function retrospectivaCoverTitleFits(title: string): boolean {
  return overlayWrapLines(title, COVER_TITLE_WIDTH).fits;
}

/** Tamanho de fonte COMPARTILHADO entre as 3 capas (o mais restritivo governa, como na diária #5852). */
export function retrospectivaCoverFontSize(titles: string[]): number {
  return computeCarouselTitleFontSize(titles);
}

/**
 * Gera (sobrescreve) as 5 imagens de uma história e devolve os paths.
 * Lança se o `04-d{N}-2x1.jpg` do ciclo não existir — a capa nunca sai sem a
 * imagem da história.
 */
export async function renderRetrospectivaCards(o: {
  cycleDir: string;
  historia: RetrospectivaHistoria;
  title: string;
  corpo: string;
  kicker: string;
  fontSize: number;
}): Promise<RetrospectivaCardSet> {
  const paths = retrospectivaCardPaths(o.cycleDir, o.historia);
  mkdirSync(resolve(o.cycleDir, "divulgacao"), { recursive: true });
  const src = resolve(o.cycleDir, `04-${o.historia}-2x1.jpg`);
  if (!existsSync(src)) throw new Error(`${o.historia}: ${src} ausente — sem a imagem da história não há capa`);
  const cover = await generateCard(o.cycleDir, o.historia, o.title, "", "4x5", {
    outPath: paths.cover,
    kicker: o.kicker,
    fontSizeOverride: o.fontSize,
  });
  if (!cover) throw new Error(`${o.historia}: capa não gerada (imagem de origem ausente)`);
  const { cover: _c, ...slides } = paths;
  await renderCarouselSlides(o.corpo.replace(/\r\n/g, "\n").trim(), slides, RETROSPECTIVA_CAROUSEL_CTA);
  return paths;
}
