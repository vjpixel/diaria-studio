/**
 * weekly-flat-card.ts (#5330)
 *
 * Card 4:5 SEM foto — capa e CTA final do carrossel semanal do Instagram.
 * Decisão do editor (#5330, 260815): os dois carrosséis semanais (destaques
 * e mais clicados, ver `weekly-instagram-select.ts`) passam a abrir com um
 * slide de apresentação e fechar com um slide de CTA de assinatura — nenhum
 * dos dois tem imagem gerada por IA (custo zero).
 *
 * Layout (revisão ao vivo do editor, #5330 260815 — 2ª rodada): NÃO imita o
 * overlay escuro dos cards de notícia (que só existe pra dar contraste sobre
 * a foto). Usa a paleta CLARA canônica da marca — mesma do site/newsletter
 * (`COLORS.paper` fundo, `COLORS.ink` texto, `COLORS.brand` teal de acento)
 * — e o título ocupa a maior parte do card (tamanho auto-ajustado pra
 * PREENCHER o espaço disponível, não o tamanho pequeno herdado do overlay de
 * notícia): "preenche o card todo, assim não sente falta de não ter
 * imagem". Nunca escolhe um tamanho fixo — cresce até o limite de
 * largura/altura pra cada texto especificamente.
 *
 * Cache: `data/weekly/{key}/_internal/06-flat-cards.json`, chave
 * `{slot}` ("cover" | "cta") — idempotente, mesmo padrão de
 * `06-public-images.json` (nunca regenera/reupload se a chave já existe).
 * `{key}` é o identificador do carrossel (`{saturday}-{mode}`, ver
 * `publish-weekly-social.ts`) — cover/CTA de "destaques" e "mais clicados"
 * nunca colidem mesmo publicados no mesmo sábado.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS, FONTS } from "./shared/design-tokens.ts";
import { assertBrandSerifAvailable } from "./shared/assert-brand-font.ts";
import { uploadImageToWorkerKV } from "./cloudflare-kv-upload.ts";
import { DIARIA_EIA_URL } from "./canonical-urls.ts";
import { esc, wrapTitle } from "../gen-social-card-4x5.ts";
import { cloudflareKvKey } from "../upload-images-public.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const W = 1080;
const H = 1350;
const PAD = 72; // Idêntico a `PAD` em gen-social-card-4x5.ts — mesma margem lateral do overlay de notícia.

const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Tamanho de fonte candidato — maior primeiro, pra achar o maior que cabe. */
const TITLE_SIZE_MIN = 46;
const TITLE_SIZE_MAX = 148;
const TITLE_SIZE_STEP = 2;

/**
 * Largura média de caractere como fração do corpo da fonte. Aproximação
 * usada pelo wrap (não medimos glifo real — o SVG é rasterizado depois).
 * Extraída pra constante no #6078: era literal 0.52 dentro de
 * `fillingFontSize` e precisou ser compartilhada com o caminho de tamanho
 * fixo, senão os dois divergiam em silêncio.
 */
const CHAR_WIDTH_RATIO = 0.52;

/** Geometria vertical do bloco de texto — o mesmo em `fill` e em `fixed`. */
const KICKER_Y = 168;
const BAR_Y = KICKER_Y + 30;
const FOOTER_Y = H - 62;
const TITLE_TOP = BAR_Y + 90;
const TITLE_BOTTOM = FOOTER_Y - 90;

/**
 * Marcação inline de negrito (#6086 item c) — `**trecho**` no `title` vira
 * `<tspan font-weight="700">` no SVG. O padrão 13 dos benchmarks
 * (`context/instagram-benchmarks-5815.md`): exatamente UMA coisa em bold por
 * slide — o bold é o resumo embutido no slide, não ênfase decorativa.
 *
 * Com o corpo do carrossel diário em tamanho FIXO (#6078), o bold passou a
 * ser o único recurso de ênfase dentro do card.
 */
export interface InlineBoldSegment {
  text: string;
  bold: boolean;
}

/** Largura média de caractere BOLD como fração do corpo da fonte (aproximação, mesmo regime de `CHAR_WIDTH_RATIO`). Bold é ~7% mais largo que regular. */
const BOLD_CHAR_WIDTH_RATIO = CHAR_WIDTH_RATIO * 1.07;

/** Pure: divide `title` em segmentos plain/bold a partir da marcação `**...**`. Texto sem `**` volta 1 segmento plain (passthrough). */
export function parseInlineBold(title: string): InlineBoldSegment[] {
  const segments: InlineBoldSegment[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title)) !== null) {
    if (m.index > last) segments.push({ text: title.slice(last, m.index), bold: false });
    segments.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < title.length) segments.push({ text: title.slice(last), bold: false });
  return segments.length > 0 ? segments : [{ text: title, bold: false }];
}

/** Pure: o texto VISÍVEL — marcação `**...**` removida. É isto que o wrap mede (delimitadores não ocupam largura). */
export function stripInlineBold(title: string): string {
  return parseInlineBold(title)
    .map((s) => s.text)
    .join("");
}

/** Palavra com peso — unidade do wrap com marcação inline. */
interface WeightedWord {
  text: string;
  bold: boolean;
}

function wordsWithWeight(title: string): WeightedWord[] {
  return parseInlineBold(title).flatMap((seg) =>
    seg.text
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ text, bold: seg.bold })),
  );
}

/** Largura estimada da palavra em "caracteres regulares" (bold pesa mais). */
function wordWidth(w: WeightedWord): number {
  return w.text.length * (w.bold ? BOLD_CHAR_WIDTH_RATIO / CHAR_WIDTH_RATIO : 1);
}

function greedyWrapWeighted(words: WeightedWord[], maxCharsPerLine: number): WeightedWord[][] {
  const lines: WeightedWord[][] = [];
  let cur: WeightedWord[] = [];
  let curWidth = 0;
  for (const w of words) {
    const ww = wordWidth(w);
    const candidateWidth = cur.length === 0 ? ww : curWidth + 1 + ww; // +1 pelo espaço
    if (candidateWidth > maxCharsPerLine && cur.length > 0) {
      lines.push(cur);
      cur = [w];
      curWidth = ww;
    } else {
      cur.push(w);
      curWidth = candidateWidth;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

export interface FlatCardText {
  kicker: string;
  /**
   * Corpo do card. Aceita marcação inline de negrito (#6086 item c):
   * `**trecho**` vira `<tspan font-weight="700">`. Os delimitadores NÃO
   * contam pra largura no wrap — mede-se o texto visível (`stripInlineBold`),
   * com peso maior pra trechos em bold. Máximo 1 trecho por slide (decisão
   * editorial codificada no prompt do `social-writer`).
   *
   * (#6136 item 2) Aceita também UMA quebra de parágrafo (`\n\s*\n`) — vira
   * um respiro vertical de 1 linha entre os dois blocos, dentro do MESMO
   * card (não confundir com os cards de parágrafo do carrossel, que já são
   * 1 por slide). Só o carrossel DIÁRIO injeta essa quebra
   * (`splitParagraphIntoTwoBlocks` em `daily-carousel-card.ts`); título sem
   * `\n\n` (todo chamador pré-#6136, inclusive o semanal) renderiza
   * exatamente como antes.
   */
  title: string;
  /** Rodapé — texto livre (ex: "diar.ia.br" na capa, "Link na bio" no CTA). */
  footer: string;
  /**
   * Handle do Instagram (#6086 item a) — opcional, renderizado ao lado do
   * wordmark (mesma linha do `footer`, sem crescer o card). `undefined`
   * (default de todo chamador existente, inclusive capa/CTA do semanal em
   * `fill`) não renderiza nada — comportamento idêntico ao pré-#6086.
   */
  handle?: string;
  /**
   * (#6136 item 1) Quando `true` E `handle` está setado, o rodapé renderiza
   * SÓ o handle (com o `@` em `COLORS.brand`) — nunca o wordmark completo
   * (`footer`) seguido do handle, que lia como "diar.ia.br @diar.ia.br"
   * (mesmo nome duas vezes na mesma linha, achado ao vivo do editor). `footer`
   * continua obrigatório (usado quando `compactHandle` é `false`/ausente, ou
   * quando `handle` não está setado) — o campo não vira redundante, só passa
   * a ser ignorado no rodapé nesse modo específico.
   *
   * Restrito ao carrossel DIÁRIO por decisão de segurança (a issue #6136
   * deixou a critério de quem implementou): nenhum chamador do carrossel
   * SEMANAL seta `handle` hoje, então o comportamento dele já não muda; este
   * flag existe pra deixar isso explícito e à prova de um `handle` futuro
   * sendo adicionado ali sem querer herdar o modo compacto.
   */
  compactHandle?: boolean;
  /**
   * Micro-CTA fixo no canto inferior direito (#6086 item b) — opcional,
   * mesma linha do rodapé (à direita, `text-anchor="end"`), também sem
   * consumir espaço vertical novo. `undefined` = nada renderizado.
   */
  microCta?: string;
}

/**
 * Como o bloco de texto é dimensionado e posicionado (#6078 item 2).
 *
 * - `fill` — auto-size (`fillingFontSize`) + bloco centralizado: o texto
 *   CRESCE até preencher o card. Default, e a decisão original do #5330 pra
 *   capa/CTA do carrossel SEMANAL: *"preenche o card todo, assim não sente
 *   falta de não ter imagem"*. Correto quando o card carrega uma frase só.
 * - `fixed` — tamanho fixo + bloco ancorado no TOPO: todos os cards de um
 *   mesmo carrossel saem com a MESMA métrica e o texto curto simplesmente
 *   termina antes, deixando branco embaixo (respiro, não falha).
 *
 * O carrossel DIÁRIO usa `fixed` (decisão do editor, 24/08/2026): ali o card
 * carrega um parágrafo de corpo cujo tamanho varia por edição, e auto-size
 * fazia 4 slides do mesmo post saírem com 4 métricas diferentes. O semanal
 * segue em `fill` — não estava em discussão.
 */
export type FlatCardLayout = { mode: "fill" } | { mode: "fixed"; size: number };

export const DEFAULT_FLAT_CARD_LAYOUT: FlatCardLayout = { mode: "fill" };

/**
 * Pure: resolve tamanho de fonte, linhas quebradas e se o bloco TRANSBORDA o
 * espaço disponível, para um dado layout.
 *
 * `overflows` é o sinal que `gen-carousel-cards.ts` e o invariante
 * `carousel-text-overflow` (Stage 4) consomem pra mandar REESCREVER o
 * parágrafo, em vez de renderizar cortado (decisão do editor, #6078: *"quando
 * um parágrafo passar do limite, a gente reescreve ele para o texto ficar
 * menor"*).
 *
 * Em `fixed` ele dispara no tamanho configurado. Em `fill` é raro mas
 * POSSÍVEL: `fillingFontSize` desce até `TITLE_SIZE_MIN` tentando caber e, se
 * nem no mínimo couber, devolve o mínimo assim mesmo — medido, um texto de
 * ~3000 caracteres transborda em 46px. Esse caso é pré-existente e ninguém
 * age sobre ele hoje (o card do semanal sairia cortado); a medição só passou
 * a torná-lo visível, e vale reportar se alguém quiser tratá-lo.
 */
/** Linha já quebrada — palavras com peso + texto visível (o que `measureFlatCardBody` expõe). */
export interface FlatCardLine {
  words: WeightedWord[];
  text: string;
}

/** Linha "espaçadora" — sem conteúdo, consome 1 `lineGap` de altura pra abrir respiro entre parágrafos (#6136 item 2). */
const BLANK_LINE: FlatCardLine = { words: [], text: "" };

function wrapSingleParagraph(title: string, maxCharsPerLine: number): FlatCardLine[] {
  const hasMarkup = title.includes("**");
  if (!hasMarkup) {
    // Sem marcação: caminho original intocado (wrapTitle + balanceamento) —
    // o default do semanal (#5330) não pode mudar de linha por causa disto.
    return wrapTitle(title, maxCharsPerLine).map((text) => ({ words: [{ text, bold: false }], text }));
  }
  // Com marcação: wrap guloso sobre o peso VISÍVEL (delimitadores fora da
  // contagem, bold ~7% mais largo). O balanceamento do #4575 não se aplica
  // aqui (opera sobre strings cegas a peso); parágrafos longos do carrossel
  // diário (>24 palavras) já caem no guloso hoje, então é o mesmo regime.
  return greedyWrapWeighted(wordsWithWeight(title), maxCharsPerLine).map((words) => ({
    words,
    text: words.map((w) => w.text).join(" "),
  }));
}

/**
 * (#6136 item 2) `title` pode carregar UMA quebra de parágrafo (`\n\s*\n`,
 * mesmo delimitador de `splitIntoParagraphCards`) — cada lado quebra
 * independente (`wrapSingleParagraph`) e os dois grupos de linhas são unidos
 * por uma `BLANK_LINE`, abrindo um respiro vertical de 1 linha entre os
 * blocos. Título sem `\n\n` (todo chamador pré-#6136) cai direto no caminho
 * de 1 parágrafo — comportamento intocado.
 */
function wrapBody(title: string, maxCharsPerLine: number): FlatCardLine[] {
  const paragraphs = title.split(/\n\s*\n/).map((p) => p.trim());
  if (paragraphs.length <= 1) return wrapSingleParagraph(title, maxCharsPerLine);
  return paragraphs.reduce<FlatCardLine[]>((acc, p, i) => {
    const group = wrapSingleParagraph(p, maxCharsPerLine);
    return i === 0 ? group : [...acc, BLANK_LINE, ...group];
  }, []);
}

/**
 * Interno: resolve tamanho + linhas PONDERADAS (com peso bold) de um corpo.
 * `buildFlatCardSvg` consome as linhas ponderadas pra emitir os `<tspan>`;
 * `measureFlatCardBody` (API pública, pré-#6086c) projeta só o texto visível.
 */
function layoutCardBody(
  title: string,
  layout: FlatCardLayout,
): { size: number; lines: FlatCardLine[]; blockHeight: number; availableHeight: number; overflows: boolean } {
  const availableWidth = W - PAD * 2;
  const availableHeight = TITLE_BOTTOM - TITLE_TOP;

  let size: number;
  let lines: FlatCardLine[];
  if (layout.mode === "fill") {
    ({ size, lines } = fillingFontSize(title, availableWidth, availableHeight));
  } else {
    size = layout.size;
    const maxCharsPerLine = Math.max(1, Math.floor(availableWidth / (size * CHAR_WIDTH_RATIO)));
    lines = wrapBody(title, maxCharsPerLine);
  }
  const blockHeight = lines.length * Math.round(size * 1.18);
  return { size, lines, blockHeight, availableHeight, overflows: blockHeight > availableHeight };
}

export function measureFlatCardBody(
  title: string,
  layout: FlatCardLayout = DEFAULT_FLAT_CARD_LAYOUT,
): { size: number; lines: string[]; blockHeight: number; availableHeight: number; overflows: boolean } {
  const { size, lines, blockHeight, availableHeight, overflows } = layoutCardBody(title, layout);
  return { size, lines: lines.map((l) => l.text), blockHeight, availableHeight, overflows };
}

/**
 * Pure: acha o MAIOR tamanho de fonte (múltiplo de `TITLE_SIZE_STEP`) cujo
 * wrap de `title` cabe em `availableHeight` (bloco de linhas) sem estourar
 * `availableWidth` (garantido pelo próprio `maxCharsPerLine` de `wrapTitle`,
 * que já limita a largura de cada linha pro tamanho testado). Começa do
 * maior candidato e desce — o primeiro que couber é o resultado (nunca pior
 * que `TITLE_SIZE_MIN`, mesmo pra título absurdamente longo).
 */
function fillingFontSize(title: string, availableWidth: number, availableHeight: number): { size: number; lines: FlatCardLine[] } {
  for (let size = TITLE_SIZE_MAX; size >= TITLE_SIZE_MIN; size -= TITLE_SIZE_STEP) {
    const maxCharsPerLine = Math.floor(availableWidth / (size * CHAR_WIDTH_RATIO));
    if (maxCharsPerLine < 1) continue;
    const lines = wrapBody(title, maxCharsPerLine);
    const lineGap = Math.round(size * 1.18);
    const blockHeight = lines.length * lineGap;
    if (blockHeight <= availableHeight) return { size, lines };
  }
  const maxCharsPerLine = Math.max(1, Math.floor(availableWidth / (TITLE_SIZE_MIN * CHAR_WIDTH_RATIO)));
  return { size: TITLE_SIZE_MIN, lines: wrapBody(title, maxCharsPerLine) };
}

const WORDMARK = "diar.ia.br";

/**
 * Pure: monta o `<text>` do rodapé — se `footer` TERMINA com o wordmark
 * `diar.ia.br` (caso de `buildFlatCardTexts`: capa leva "{range} · diar.ia.br",
 * CTA leva só "diar.ia.br"), os pontos e o "br" saem em `COLORS.brand`
 * (teal), igual ao wordmark usado em `buildOverlaySvg`/`buildCardSvg`
 * (gen-social-card-4x5.ts) — achado ao vivo (#5330, review do editor): o
 * rodapé estava saindo inteiro em ink sólido, sem a cor de marca que os
 * cards de notícia já usam pro mesmo texto. Footer que não termina com o
 * wordmark (ex: eventual texto livre futuro) cai no fallback plano.
 */
function footerMarkup(footer: string): string {
  if (!footer.endsWith(WORDMARK)) return esc(footer);
  const prefix = footer.slice(0, -WORDMARK.length);
  return `${esc(prefix)}diar<tspan fill="${COLORS.brand}">.</tspan>ia<tspan fill="${COLORS.brand}">.</tspan><tspan fill="${COLORS.brand}">br</tspan>`;
}

/**
 * (#6136 item 1) Rodapé em MODO COMPACTO — só o handle, `@` em `COLORS.brand`,
 * resto em `COLORS.ink`. Substitui inteiramente `footerMarkup(footer) + handleMarkup`
 * (que lia "diar.ia.br · @diar.ia.br", o mesmo nome duas vezes) quando
 * `FlatCardText.compactHandle` está ligado. Handle sem `@` inicial (entrada
 * malformada) cai no texto plano — nunca lança.
 */
function handleOnlyMarkup(handle: string): string {
  if (!handle.startsWith("@")) return esc(handle);
  return `<tspan fill="${COLORS.brand}">@</tspan>${esc(handle.slice(1))}`;
}

/**
 * Pure: monta o SVG do card sem foto — paleta CLARA canônica da marca
 * (`COLORS.paper`/`COLORS.ink`/`COLORS.brand`, mesma do site/newsletter),
 * kicker no topo, título GRANDE preenchendo o espaço disponível (auto-size
 * via `fillingFontSize` — nunca um tamanho fixo pequeno), rodapé na base.
 */
export function buildFlatCardSvg(text: FlatCardText, layout: FlatCardLayout = DEFAULT_FLAT_CARD_LAYOUT): string {
  const kickerY = KICKER_Y;
  const footerY = FOOTER_Y;
  const availableHeight = TITLE_BOTTOM - TITLE_TOP;

  const { size, lines, blockHeight } = layoutCardBody(text.title, layout);
  const lineGap = Math.round(size * 1.18);
  // `fill` centraliza o bloco no espaço entre kicker e rodapé (o texto foi
  // dimensionado pra ocupá-lo). `fixed` ancora no TOPO: o branco que sobra
  // embaixo de um texto curto é o respiro que mantém os cards de um mesmo
  // carrossel parecendo o mesmo template (#6078).
  const blockTop = layout.mode === "fill" ? TITLE_TOP + (availableHeight - blockHeight) / 2 : TITLE_TOP;
  const firstBaselineY = blockTop + size * 0.85;

  // #6086 item c: segmentos contíguos de mesmo peso viram um trecho só;
  // trechos bold saem em `<tspan font-weight="700">`. Linha sem marcação
  // renderiza exatamente como antes (esc puro, zero tspan) — o default do
  // carrossel SEMANAL e de todo chamador pré-#6086c não muda um byte.
  const lineMarkup = (line: FlatCardLine): string => {
    // Segmentos contíguos de mesmo peso; o espaço entre segmentos de peso
    // DIFERENTE fica SEMPRE fora do `<tspan>` (espaço na borda de um tspan é
    // suscetível ao colapso de whitespace do XML).
    const segs: { text: string; bold: boolean }[] = [];
    for (const w of line.words) {
      const last = segs[segs.length - 1];
      if (last && last.bold === w.bold) last.text += ` ${w.text}`;
      else segs.push({ text: w.text, bold: w.bold });
    }
    return segs
      .map((s, i) => {
        const sep = i > 0 ? " " : "";
        return s.bold ? `${sep}<tspan font-weight="700">${esc(s.text)}</tspan>` : `${sep}${esc(s.text)}`;
      })
      .join("");
  };

  const titleLines = lines
    .map(
      (line, i) =>
        `<text x="${PAD}" y="${firstBaselineY + i * lineGap}" font-family="${FONTS.serif}" font-size="${size}" font-weight="400" fill="${COLORS.ink}">${lineMarkup(line)}</text>`,
    )
    .join("\n  ");

  // (#6136 item 1) Modo compacto: rodapé vira SÓ o handle (`@` em brand),
  // nunca wordmark + handle juntos (lia "diar.ia.br · @diar.ia.br", mesmo
  // nome repetido). Fora desse modo, comportamento intocado — handle (#6086
  // item a) segue como tspan menor na mesma linha do wordmark.
  const footerLineMarkup =
    text.compactHandle && text.handle
      ? handleOnlyMarkup(text.handle)
      : `${footerMarkup(text.footer)}${
          text.handle ? `<tspan font-family="${FONT_SANS}" font-size="22" fill="${COLORS.ink}"> · ${esc(text.handle)}</tspan>` : ""
        }`;

  // Micro-CTA (#6086 item b) — canto inferior DIREITO, mesma linha de base
  // do rodapé (`footerY`), `text-anchor="end"` ancorado em `W - PAD` (a
  // mesma margem direita do resto do card). Mesmo motivo do handle: cabe na
  // largura sobrando da linha (rodapé raramente ocupa o card inteiro), sem
  // reservar altura nova.
  const microCtaMarkup = text.microCta
    ? `<text x="${W - PAD}" y="${footerY}" text-anchor="end" font-family="${FONT_SANS}" font-size="24" font-weight="600" fill="${COLORS.brand}">${esc(text.microCta)}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${COLORS.paper}"/>
  <rect x="${PAD}" y="${kickerY - 38}" width="64" height="6" rx="3" fill="${COLORS.brand}"/>
  <text x="${PAD}" y="${kickerY}" font-family="${FONT_SANS}" font-size="30" font-weight="700" letter-spacing="2" fill="${COLORS.brand}">${esc(text.kicker.toUpperCase())}</text>
  ${titleLines}
  <text x="${PAD}" y="${footerY}" font-family="${FONTS.serif}" font-size="34" fill="${COLORS.ink}">${footerLineMarkup}</text>
  ${microCtaMarkup}
</svg>`;
}

/** Renderiza `buildFlatCardSvg` pra um JPEG em disco. */
export async function renderFlatCard(
  text: FlatCardText,
  outPath: string,
  layout: FlatCardLayout = DEFAULT_FLAT_CARD_LAYOUT,
): Promise<string> {
  await sharp({ create: { width: W, height: H, channels: 3, background: COLORS.paper } })
    .composite([{ input: Buffer.from(buildFlatCardSvg(text, layout)), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return outPath;
}

export type FlatCardSlot = "cover" | "cta";

function flatCardsCachePath(dataRoot: string, key: string): string {
  return resolve(dataRoot, "weekly", key, "_internal", "06-flat-cards.json");
}

function readFlatCardUrl(dataRoot: string, key: string, slot: FlatCardSlot): string | null {
  const p = flatCardsCachePath(dataRoot, key);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, { url?: string }>;
    return data[slot]?.url ?? null;
  } catch {
    return null;
  }
}

function writeFlatCardUrl(dataRoot: string, key: string, slot: FlatCardSlot, url: string): void {
  const p = flatCardsCachePath(dataRoot, key);
  mkdirSync(resolve(dataRoot, "weekly", key, "_internal"), { recursive: true });
  const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  existing[slot] = { url };
  writeFileSync(p, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export interface FlatCardGeneratorInput {
  text: FlatCardText;
  outPath: string;
  kvKey: string;
}

/**
 * Injetável — mesmo padrão de `SectionCardGenerator`
 * (weekly-instagram-ondemand-card.ts): testes passam um fake em vez do
 * gerador real, que checa fonte de marca + faz upload real pro KV
 * Cloudflare (rede + dependência de máquina, nunca exercitado em teste).
 */
export type FlatCardGenerator = (input: FlatCardGeneratorInput) => Promise<{ url: string }>;

/** Implementação REAL — NUNCA invocada em teste (mesma classe de restrição de `defaultSectionCardGenerator`). */
export const defaultFlatCardGenerator: FlatCardGenerator = async ({ text, outPath, kvKey }) => {
  await assertBrandSerifAvailable("weekly-flat-card");
  await renderFlatCard(text, outPath);

  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId = platformCfg?.poll?.kv_namespace_id;
  const workerUrl = platformCfg?.poll?.worker_url ?? DIARIA_EIA_URL;
  if (!kvNamespaceId) {
    throw new Error("platform.config.json → poll.kv_namespace_id não configurado (card sem foto capa/CTA)");
  }
  const url = await uploadImageToWorkerKV(outPath, kvKey, { kvNamespaceId, workerUrl });
  return { url };
};

/**
 * Resolve a URL pública do card capa/CTA de um carrossel semanal: cache hit
 * retorna direto (nunca re-renderiza/re-upload); cache miss chama `generator`
 * (default `defaultFlatCardGenerator`) + grava no cache. `key` identifica o
 * carrossel (`{saturday}-{mode}`) — cover/CTA de "destaques" e "mais
 * clicados" nunca colidem.
 */
export async function resolveOrGenerateFlatCardUrl(
  dataRoot: string,
  key: string,
  slot: FlatCardSlot,
  text: FlatCardText,
  generator: FlatCardGenerator = defaultFlatCardGenerator,
): Promise<string> {
  const cached = readFlatCardUrl(dataRoot, key, slot);
  if (cached) return cached;

  const outDir = resolve(dataRoot, "weekly", key, "_internal");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `06-${slot}-4x5.jpg`);
  // #5386: a chave PRECISA casar com a allowlist `/^img-[^:]+$/` de
  // `handleImage` (workers/poll/src/index.ts, fix de segurança do #4112) —
  // um namespace `weekly/...` batia 404 na Graph API do Instagram (fetch da
  // `image_url` pelo lado da Meta, não do nosso Worker) e derrubava o
  // carrossel inteiro. Reusa `cloudflareKvKey()` (mesma convenção de
  // `upload-images-public.ts`/`weekly-instagram-ondemand-card.ts`) — `key`
  // não termina em AAMMDD (`{saturday}-{mode}`, ex "260815-highlights"),
  // então o helper cai no fallback documentado `img-unknown-...`; `key` vai
  // inteiro no filename, preservando a unicidade entre "destaques"/"mais
  // clicados" do mesmo sábado.
  const kvKey = cloudflareKvKey(key, `weekly-${key}-${slot}-4x5.jpg`);

  const { url } = await generator({ text, outPath, kvKey });
  writeFlatCardUrl(dataRoot, key, slot, url);
  return url;
}
