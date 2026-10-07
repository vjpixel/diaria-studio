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
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
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
  splitParagraphIntoTwoBlocks,
  DAILY_CAROUSEL_LAYOUT,
  DAILY_CAROUSEL_HANDLE,
  DAILY_CAROUSEL_MICRO_CTA,
} from "./daily-carousel-card.ts";
import type { CarouselCtaOverride } from "./instagram-test-override.ts";
import { splitBodyAndTags } from "./social-cta-lines.ts";
import { USE_MELHOR_POST_ID } from "./use-melhor-post.ts";
import {
  useMelhorSlideFilename,
  useMelhorSlideImageKey,
  useMelhorCarouselHashPath,
  type UseMelhorCarouselStamp,
} from "./use-melhor-slide-files.ts";

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

// #9568 (Stage 5): nomes/carimbo moram no módulo FOLHA `use-melhor-slide-files.ts`
// (importável por `upload-images-public.ts` sem ciclo) — re-exportados aqui.
export {
  useMelhorSlideFilename,
  useMelhorSlideImageKey,
  useMelhorCarouselHashPath,
  readUseMelhorCarouselStamp,
  type UseMelhorCarouselStamp,
} from "./use-melhor-slide-files.ts";

/**
 * Pure (#9791): parágrafos do `## um` PRESERVANDO as quebras de linha simples
 * dentro de cada um — um card pode agrupar 2 itens da lista numerada em linhas
 * consecutivas ("1) ...\n2) ..."), e o slide precisa saber onde cada item
 * começa. Acima de `USE_MELHOR_MAX_PARAGRAPH_SLIDES` a cauda é fundida no
 * último card (mesma regra de `splitIntoParagraphCards`, nunca descarta).
 */
export function splitUseMelhorParagraphs(body: string): string[] {
  const paras = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
  if (paras.length <= USE_MELHOR_MAX_PARAGRAPH_SLIDES) return paras;
  const head = paras.slice(0, USE_MELHOR_MAX_PARAGRAPH_SLIDES - 1);
  return [...head, paras.slice(USE_MELHOR_MAX_PARAGRAPH_SLIDES - 1).join("\n")];
}

/** Marcador de item de lista numerada no início da linha: "1. ", "2) ". */
const USE_MELHOR_LIST_MARKER = /^(\d{1,2})[.)]\s+(\S.*)$/;

export interface UseMelhorListItem {
  n: number;
  text: string;
}

/**
 * Pure (#9789/#9791): itens numerados de UM parágrafo do `## um`, ou `null`
 * quando o parágrafo não abre com marcador de lista ("1. ", "1) ") — é
 * introdução, fechamento ou texto corrido. Linha sem marcador depois de um
 * item é continuação dele (quebra manual), nunca item novo.
 */
export function parseUseMelhorListItems(paragraph: string): UseMelhorListItem[] | null {
  const lines = paragraph
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const items: UseMelhorListItem[] = [];
  for (const line of lines) {
    const m = line.match(USE_MELHOR_LIST_MARKER);
    if (m) items.push({ n: Number(m[1]), text: line.replace(/\s+/g, " ") });
    else if (items.length === 0) return null;
    else items[items.length - 1].text += ` ${line.replace(/\s+/g, " ")}`;
  }
  return items;
}

/**
 * Pure: texto do corpo de um slide de parágrafo do 4º post. Parágrafo que
 * agrupa 2+ itens numerados (#9791) vira 1 bloco por item (separados por
 * linha em branco, mesmo respiro do `\n\n` de `wrapBody`) — o corte cai na
 * fronteira entre itens, nunca no meio de um. Qualquer outro parágrafo segue
 * exatamente o caminho de sempre (espaços colapsados +
 * `splitParagraphIntoTwoBlocks`), então o carimbo de textos antigos não muda.
 */
export function useMelhorSlideBody(paragraph: string): string {
  const items = parseUseMelhorListItems(paragraph);
  if (items && items.length >= 2) return items.map((i) => i.text).join("\n\n");
  return splitParagraphIntoTwoBlocks(paragraph.replace(/\s+/g, " ").trim());
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
export function buildUseMelhorSlides(
  genericText: string,
  itemTitle: string,
  /**
   * #8681: override de TESTE do slide CTA (`_internal/instagram-test.json`).
   * Propagado pro 4º post também — o teste é da arte do CTA no Instagram, e
   * o 4º post sai no mesmo perfil; sem isso a edição de teste misturaria os
   * dois CTAs (self-review #9572, finding 4).
   */
  ctaOverride?: CarouselCtaOverride | null,
): UseMelhorSlide[] {
  const n = countUseMelhorParagraphs(genericText);
  if (n === 0) return [];
  const { body } = splitBodyAndTags(genericText);
  const paragraphs = splitUseMelhorParagraphs(body);
  const total = paragraphs.length;
  // CTA reusado do carrossel diário (mesmo kicker/copy/rodapé) — fonte única.
  const dailyCta = buildCarouselSlideTexts("x", ctaOverride).cta;
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
          title: useMelhorSlideBody(p),
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
export function findOverflowingUseMelhorSlides(
  genericText: string,
  itemTitle: string,
  ctaOverride?: CarouselCtaOverride | null,
): UseMelhorSlideOverflow[] {
  const out: UseMelhorSlideOverflow[] = [];
  for (const s of buildUseMelhorSlides(genericText, itemTitle, ctaOverride)) {
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

/** Faixa de parágrafos do `## um` pedida ao `social-writer` (§3c). */
export const USE_MELHOR_MIN_PARAGRAPHS = 2;
export const USE_MELHOR_MAX_PARAGRAPHS = 6;

/**
 * Pure: lint de FORMA do `## um` (self-review #9572, finding 6). Os lints
 * sociais existentes (`linkedin-schema`, `no-email-cta-instagram`,
 * `no-trailing-question`) só enumeram `## d{N}`/`post_pixel`, e a faixa de
 * 600–900 chars do §3a não serve pra um texto de 2–6 parágrafos — então o
 * `## um` ganha checagem própria, com as regras do §3c do `social-writer`:
 * nº de parágrafos, channel-neutral (sem URL, sem `diar.ia.br`/"link na
 * bio"/"segue @") e sem pergunta no fim. Devolve 1 mensagem por problema
 * (vazio = ok). Warning-only no chamador: o 4º post é fail-soft.
 */
export function lintUseMelhorPostText(genericText: string): string[] {
  const { body } = splitBodyAndTags(genericText);
  const paras = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const problems: string[] = [];
  if (paras.length < USE_MELHOR_MIN_PARAGRAPHS || paras.length > USE_MELHOR_MAX_PARAGRAPHS) {
    problems.push(
      `${paras.length} parágrafo(s) — o §3c pede ${USE_MELHOR_MIN_PARAGRAPHS} a ${USE_MELHOR_MAX_PARAGRAPHS} (1 slide por parágrafo)`,
    );
  }
  if (/https?:\/\/|\bwww\./i.test(body)) problems.push("contém URL — o texto é channel-neutral (link entra só no publish)");
  if (/diar\.ia\.br|link na bio|\bsegue @/i.test(body)) {
    problems.push(`contém CTA de canal ("diar.ia.br"/"link na bio"/"segue @") — injetado só no publish`);
  }
  const last = paras[paras.length - 1] ?? "";
  if (/\?["'”’)\]*_]*\s*$/.test(last)) problems.push("termina em pergunta — mesma regra do no-trailing-question");
  return problems;
}

/** Teto de itens da lista numerada num mesmo card (#9791). */
export const USE_MELHOR_MAX_ITEMS_PER_CARD = 2;

/**
 * Pure (#9789/#9791): lint de LISTA do `## um` — complementa
 * `lintUseMelhorPostText` com as regras de formato pedidas pelo editor no
 * gate da 261007:
 *   - direto ao ponto: o 1º parágrafo (1º slide) já é o item 1, nunca uma
 *     introdução/gancho — a capa (kicker + título) faz a abertura;
 *   - etapas/recomendações em lista numerada ("1. "/"1) "), numeração
 *     contínua a partir de 1, sem parágrafo fora da lista;
 *   - no máximo `USE_MELHOR_MAX_ITEMS_PER_CARD` itens por card, e 2 cards
 *     vizinhos de 1 item que caberiam juntos (mesma medição do overflow,
 *     62px fixo) devem ser agrupados — sem reduzir abaixo do mínimo de
 *     parágrafos do §3c.
 * Devolve 1 mensagem por problema (vazio = ok). Warning-only no chamador,
 * como o resto do 4º post (fail-soft, #9568).
 */
export function lintUseMelhorPostList(genericText: string): string[] {
  const { body } = splitBodyAndTags(genericText);
  const paras = splitUseMelhorParagraphs(body);
  if (paras.length === 0) return [];
  const parsed = paras.map(parseUseMelhorListItems);
  const problems: string[] = [];

  if (parsed[0] === null) {
    problems.push(
      "1º parágrafo não é item da lista numerada — o §3c pede ir direto ao ponto (sem introdução: a capa já abre o post; o 1º slide é o item 1)",
    );
  }
  const outside = parsed
    .map((p, i) => (p === null && i > 0 ? i + 1 : null))
    .filter((i): i is number => i !== null);
  if (outside.length > 0) {
    problems.push(`parágrafo(s) ${outside.join(", ")} fora da lista numerada — cada parágrafo é 1 ou 2 itens "N. ..."`);
  }
  const numbers = parsed.flatMap((p) => (p ?? []).map((i) => i.n));
  if (numbers.length > 0 && numbers.some((n, i) => n !== i + 1)) {
    problems.push(`numeração da lista não é contínua a partir de 1 (${numbers.join(", ")})`);
  }
  const crowded = parsed
    .map((p, i) => (p && p.length > USE_MELHOR_MAX_ITEMS_PER_CARD ? i + 1 : null))
    .filter((i): i is number => i !== null);
  if (crowded.length > 0) {
    problems.push(
      `parágrafo(s) ${crowded.join(", ")} com mais de ${USE_MELHOR_MAX_ITEMS_PER_CARD} itens — no máximo ${USE_MELHOR_MAX_ITEMS_PER_CARD} por card`,
    );
  }

  // #9791: pares vizinhos de 1 item que caberiam no mesmo card. Guloso, da
  // esquerda pra direita; nunca sugere fundir abaixo do mínimo de parágrafos.
  const mergeable: string[] = [];
  let remaining = paras.length;
  for (let i = 0; i + 1 < paras.length && remaining > USE_MELHOR_MIN_PARAGRAPHS; ) {
    const a = parsed[i];
    const b = parsed[i + 1];
    if (a?.length === 1 && b?.length === 1) {
      const merged = useMelhorSlideBody(`${paras[i]}\n${paras[i + 1]}`);
      if (!measureFlatCardBody(merged, DAILY_CAROUSEL_LAYOUT).overflows) {
        mergeable.push(`${i + 1}+${i + 2}`);
        remaining -= 1;
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  if (mergeable.length > 0) {
    problems.push(
      `parágrafos ${mergeable.join(", ")} cabem no mesmo card — agrupar os 2 itens em linhas consecutivas do mesmo parágrafo (#9791)`,
    );
  }
  return problems;
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
 * Remove slides do 4º post que sobraram de um render anterior com MAIS
 * parágrafos (ex.: `## um` encolheu de 4 pra 3 → `p4` antigo fica no disco).
 * Quem lê o carimbo já ignora a sobra, mas quem lista por glob (preview do
 * Studio, um upload futuro do Stage 5) mostraria um slide fantasma
 * (self-review #9572, findings 2/3). Devolve os arquivos removidos.
 */
export function removeStaleUseMelhorSlides(editionDir: string, keepSlots: string[]): string[] {
  if (!existsSync(editionDir)) return [];
  const keep = new Set(keepSlots.map((s) => useMelhorSlideFilename(s)));
  const re = new RegExp(`^04-${USE_MELHOR_POST_ID}-carousel-(cover|p\\d+|cta)-4x5\\.jpg$`);
  const removed: string[] = [];
  for (const f of readdirSync(editionDir)) {
    if (re.test(f) && !keep.has(f)) {
      unlinkSync(resolve(editionDir, f));
      removed.push(f);
    }
  }
  return removed;
}

/**
 * Pure: o carrossel gerado está defasado em relação ao texto atual?
 * `true` quando o `## um` (ou o título do item / override de CTA) mudou
 * depois do Stage 3 — mesmo papel do `carousel-cards-stale` dos destaques
 * (self-review #9572, finding 1). `false` quando bate ou quando não dá pra
 * comparar (sem carimbo / texto vazio — outros avisos já cobrem).
 *
 * #9630: com `stamp.cover_title` gravado, o título da conferência é o GRAVADO
 * (o que está de fato na capa), não `itemTitle` — editar o título do item no
 * gate 4 não invalida mais a arte; só o `## um`/CTA mudando invalida.
 * `itemTitle` só vale para carimbos antigos, sem o campo.
 */
export function isUseMelhorCarouselStale(
  stamp: UseMelhorCarouselStamp | null,
  genericText: string | null,
  itemTitle: string | null,
  ctaOverride?: CarouselCtaOverride | null,
): boolean {
  if (!stamp || !genericText || !genericText.trim()) return false;
  const title = stamp.cover_title ?? itemTitle;
  if (title === null) return false;
  const slides = buildUseMelhorSlides(genericText.trim(), title, ctaOverride);
  if (slides.length === 0) return false;
  return hashUseMelhorSlides(slides) !== stamp.hash;
}

/**
 * Pure (#9635): o título GRAVADO na capa (`stamp.cover_title`, #9630) difere
 * do título que a edição resolve agora (`resolveUseMelhorCoverTitle`)? Caso
 * típico: o editor traduziu/editou o título do item USE MELHOR no gate 4
 * depois do Stage 3 — o carrossel segue valendo (o `## um` não mudou), mas a
 * capa sai com o título anterior. `null` quando bate, quando o carimbo é
 * antigo (sem `cover_title` — aí `isUseMelhorCarouselStale` já compara pelo
 * título atual) ou quando não há título atual. Comparação ignora espaços nas
 * pontas. Nunca bloqueia nada: quem chama só AVISA.
 */
export function useMelhorCoverTitleDrift(
  stamp: UseMelhorCarouselStamp | null,
  currentTitle: string | null,
): { stamped: string; current: string } | null {
  if (!stamp || typeof stamp.cover_title !== "string" || currentTitle === null) return null;
  const stamped = stamp.cover_title.trim();
  const current = currentTitle.trim();
  if (!current || stamped === current) return null;
  return { stamped, current };
}

/** Texto do aviso de #9635 (compartilhado pelo status do gate 4 e pelo Stage 5). */
export function describeUseMelhorCoverTitleDrift(
  drift: { stamped: string; current: string },
  editionDir = "{edição}",
): string {
  return (
    `capa do carrossel com o título anterior ("${drift.stamped}") — o item na edição agora é ` +
    `"${drift.current}". O post sai assim mesmo; pra atualizar a capa, re-rodar ` +
    `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir} --force" + ` +
    `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}".`
  );
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
