/**
 * use-melhor-carousel.ts (#9568 item 3)
 *
 * Carrossel tipográfico (sem foto) do 4º post social — o item de maior score
 * do USE MELHOR. Decisão do editor (04/10/2026): **card tipográfico sem foto**,
 * no layout que o carrossel já usa (`buildFlatCardSvg`/`renderFlatCard`), sem
 * Van Gogh nem og:image, e **com quantos slides o conteúdo precisar** —
 * diferente dos 5 slides fixos de D1/D2/D3 (`daily-carousel-card.ts`).
 *
 * Composição: capa → p1..pN → CTA.
 *   - Capa: kicker "USE MELHOR" + título do item, no tamanho fixo da capa do
 *     carrossel SEMANAL (`WEEKLY_FLAT_CARD_LAYOUT`, 84px) — é a capa
 *     tipográfica que já existe no repo.
 *   - p1..pN: 1 parágrafo de `## um` por slide, mesma tipografia/rodapé dos
 *     slides de parágrafo do carrossel diário (62px fixo, handle + micro-CTA).
 *     N = número de parágrafos do texto, entre 1 e `USE_MELHOR_MAX_PARAGRAPH_SLIDES`.
 *   - CTA: idêntico ao slide CTA do carrossel diário.
 *
 * Os textos vêm do MESMO `## um` que o `social-writer` escreve (nunca um texto
 * dedicado) — mesma regra do #6005 Parte B. Não toca em nada de D1/D2/D3.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderFlatCard,
  measureFlatCardBody,
  stripInlineBold,
  WEEKLY_FLAT_CARD_LAYOUT,
  type FlatCardText,
  type FlatCardLayout,
} from "./weekly-flat-card.ts";
import {
  buildCarouselSlideTexts,
  splitIntoParagraphCards,
  splitParagraphIntoTwoBlocks,
  DAILY_CAROUSEL_LAYOUT,
  DAILY_CAROUSEL_HANDLE,
  DAILY_CAROUSEL_MICRO_CTA,
} from "./daily-carousel-card.ts";
import { splitBodyAndTags } from "./social-cta-lines.ts";
import { USE_MELHOR_POST_ID } from "./use-melhor-post.ts";

/**
 * Teto de slides de parágrafo. O Instagram aceita até 10 itens por carrossel
 * na API de publicação; capa + 8 parágrafos + CTA = 10. Texto com mais
 * parágrafos que isso tem a cauda fundida no último slide
 * (`splitIntoParagraphCards`), nunca descartada.
 */
export const USE_MELHOR_MAX_PARAGRAPH_SLIDES = 8;

export const USE_MELHOR_COVER_KICKER = "USE MELHOR";

/** Layout da capa (tipográfica, 84px fixo — a capa do carrossel semanal). */
export const USE_MELHOR_COVER_LAYOUT: FlatCardLayout = WEEKLY_FLAT_CARD_LAYOUT;

export interface UseMelhorSlide {
  /** "cover" | "p1".."pN" | "cta" */
  slot: string;
  text: FlatCardText;
  layout: FlatCardLayout;
}

/** Nome do arquivo local (raiz da edição) de um slide do 4º post. */
export function useMelhorSlideFilename(slot: string): string {
  return `04-${USE_MELHOR_POST_ID}-carousel-${slot}-4x5.jpg`;
}

/** Chave em `06-public-images.json` (`images`) de um slide do 4º post. */
export function useMelhorSlideImageKey(slot: string): string {
  return `${USE_MELHOR_POST_ID}_carousel_${slot}`;
}

/** Pure: quantos parágrafos-slide o texto gera (1..USE_MELHOR_MAX_PARAGRAPH_SLIDES; 0 se vazio). */
export function countUseMelhorParagraphs(genericText: string): number {
  const { body } = splitBodyAndTags(genericText);
  const paras = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return Math.min(paras.length, USE_MELHOR_MAX_PARAGRAPH_SLIDES);
}

/**
 * Pure: monta os slides (capa → p1..pN → CTA) a partir do texto de `## um` e
 * do título do item. `[]` quando o corpo é vazio — o chamador trata como
 * "sem carrossel" (fail-soft), nunca renderiza só capa + CTA.
 */
export function buildUseMelhorSlides(genericText: string, itemTitle: string): UseMelhorSlide[] {
  const n = countUseMelhorParagraphs(genericText);
  if (n === 0) return [];
  const { body } = splitBodyAndTags(genericText);
  const paragraphs = splitIntoParagraphCards(body, n);
  const total = paragraphs.length;
  // CTA reusado do carrossel diário (mesmo kicker/copy/rodapé) — fonte única.
  const dailyCta = buildCarouselSlideTexts("x").cta;
  return [
    {
      slot: "cover",
      text: { kicker: USE_MELHOR_COVER_KICKER, title: itemTitle.trim(), footer: "diar.ia.br" },
      layout: USE_MELHOR_COVER_LAYOUT,
    },
    ...paragraphs.map(
      (p, i): UseMelhorSlide => ({
        slot: `p${i + 1}`,
        text: {
          kicker: `${String(i + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
          title: splitParagraphIntoTwoBlocks(p),
          footer: "diar.ia.br",
          handle: DAILY_CAROUSEL_HANDLE,
          compactHandle: true,
          microCta: DAILY_CAROUSEL_MICRO_CTA,
        },
        layout: DAILY_CAROUSEL_LAYOUT,
      }),
    ),
    { slot: "cta", text: dailyCta, layout: DAILY_CAROUSEL_LAYOUT },
  ];
}

export interface UseMelhorSlideOverflow {
  slot: string;
  chars: number;
  lines: number;
  excessPx: number;
}

/** Pure: slides do 4º post que não cabem no card (mesma medição do carrossel diário). */
export function findOverflowingUseMelhorSlides(genericText: string, itemTitle: string): UseMelhorSlideOverflow[] {
  const out: UseMelhorSlideOverflow[] = [];
  for (const s of buildUseMelhorSlides(genericText, itemTitle)) {
    const m = measureFlatCardBody(s.text.title, s.layout);
    if (m.overflows) {
      out.push({
        slot: s.slot,
        chars: stripInlineBold(s.text.title).length,
        lines: m.lines.length,
        excessPx: m.blockHeight - m.availableHeight,
      });
    }
  }
  return out;
}

/** Pure: carimbo do texto RENDERIZADO (kicker + título + rodapé + layout de cada slide). */
export function hashUseMelhorSlides(slides: UseMelhorSlide[]): string {
  const canonical = slides
    .map((s) => {
      const layoutTag = s.layout.mode === "fixed" ? `fixed:${s.layout.size}` : "fill";
      return `${s.slot} || ${s.text.kicker} || ${s.text.title} || ${s.text.handle ?? ""} || ${s.text.microCta ?? ""} || ${layoutTag}`;
    })
    .join(" ~~ ");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Carimbo próprio — separado do `.carousel-source-hash.json` de D1/D2/D3. */
export function useMelhorCarouselHashPath(editionDir: string): string {
  return resolve(editionDir, "_internal", ".use-melhor-carousel-hash.json");
}

export interface UseMelhorCarouselStamp {
  hash: string;
  slots: string[];
}

export function readUseMelhorCarouselStamp(editionDir: string): UseMelhorCarouselStamp | null {
  const p = useMelhorCarouselHashPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as Partial<UseMelhorCarouselStamp>;
    return typeof d.hash === "string" && Array.isArray(d.slots) ? { hash: d.hash, slots: d.slots } : null;
  } catch {
    return null;
  }
}

export function writeUseMelhorCarouselStamp(editionDir: string, stamp: UseMelhorCarouselStamp): void {
  const p = useMelhorCarouselHashPath(editionDir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...stamp, generated_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

/** Renderiza os slides em `{editionDir}/04-um-carousel-{slot}-4x5.jpg`. */
export async function renderUseMelhorSlides(editionDir: string, slides: UseMelhorSlide[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of slides) {
    out.push(await renderFlatCard(s.text, resolve(editionDir, useMelhorSlideFilename(s.slot)), s.layout));
  }
  return out;
}

/**
 * Resolve as URLs públicas ORDENADAS do carrossel do 4º post a partir de
 * `06-public-images.json` (`images`) e da lista de slots gravada no carimbo.
 * `null` se QUALQUER slide faltar — tudo-ou-nada, mesma regra de
 * `resolveCarouselImageUrls` dos destaques (#6005 Parte B).
 */
export function resolveUseMelhorCarouselImageUrls(
  images: Record<string, { url?: string }> | undefined,
  slots: string[],
): string[] | null {
  if (!images || slots.length < 3) return null; // capa + ≥1 parágrafo + CTA
  const urls: string[] = [];
  for (const slot of slots) {
    const url = images[useMelhorSlideImageKey(slot)]?.url;
    if (!url) return null;
    urls.push(url);
  }
  return urls;
}
