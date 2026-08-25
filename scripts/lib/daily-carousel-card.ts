/**
 * daily-carousel-card.ts (#6005 Parte B)
 *
 * Transforma D1/D2/D3 do feed diário do Instagram de post estático (1 card
 * 4:5) em carrossel de 5 slides, benchmark "1 slide = 1 batida" (#6005,
 * padrões 1/7/9/11/12 de `context/instagram-benchmarks-5815.md`). Decisão do
 * editor (sessão 260824, issue #6005): **5 slides fixos**, texto = o MESMO
 * `## d{N}` já escrito pelo `social-writer` (nunca um texto novo), 1 parágrafo
 * por card.
 *
 * Composição fixa dos 5 slides:
 *   1. Capa — `04-{destaque}-4x5.jpg`, já gerado por `gen-social-card-4x5.ts`
 *      (foto + título overlay). Este módulo NÃO regenera esse arquivo — só
 *      referencia a URL já publicada pra ele (ver `resolveCarouselImageUrls`).
 *   2-4. 3 cards de parágrafo — texto puro (sem foto), 1 parágrafo do corpo
 *      de `## d{destaque}` por card (`splitIntoParagraphCards`), quebrado em
 *      até 2 blocos visuais DENTRO do mesmo card quando houver ponto de corte
 *      viável (`splitParagraphIntoTwoBlocks`, #6136 item 2).
 *   5. CTA — texto puro, mesmo copy de `INSTAGRAM_CTA_LINE`
 *      (`social-cta-lines.ts`) pra não divergir do texto que a legenda já usa.
 *
 * Os 4 slides SEM foto (2-5) reusam o layout `buildFlatCardSvg`/`renderFlatCard`
 * de `weekly-flat-card.ts` (paleta clara canônica; título/corpo em TAMANHO
 * FIXO desde o #6078 — ver `DAILY_CAROUSEL_LAYOUT`. O auto-size continua
 * sendo o default do módulo e segue valendo pro carrossel SEMANAL)
 * — já é genérico o bastante (kicker/title/footer), não específico do
 * carrossel semanal apesar do nome do arquivo. Evita reimplementar SVG novo,
 * seguindo a própria recomendação do #6005 ("conferir antes de reimplementar
 * do zero").
 *
 * Diferente do carrossel semanal (upload direto pro KV, `resolveOrGenerate*`
 * com cache próprio): os cards diários são gerados como arquivo LOCAL na
 * pasta da edição (`04-{destaque}-carousel-{slot}-4x5.jpg`) por
 * `scripts/gen-carousel-cards.ts` no Stage 3, e sobem pro KV depois pelo
 * mesmo `upload-images-public.ts` (Stage 5c-pre) que já cuida dos demais
 * assets da edição — consistência com o resto do pipeline diário, que nunca
 * faz upload direto de dentro do Stage 3.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderFlatCard,
  measureFlatCardBody,
  stripInlineBold,
  type FlatCardText,
  type FlatCardLayout,
} from "./weekly-flat-card.ts";
import { INSTAGRAM_CTA_LINE, splitBodyAndTags } from "./social-cta-lines.ts";

/**
 * Corpo dos slides do carrossel DIÁRIO — tamanho fixo, não auto-size
 * (#6078 item 2, decisão do editor em 24/08/2026).
 *
 * 62px e não 64px por um motivo operacional, não estético: como a saída para
 * o texto que não cabe é REESCREVER o parágrafo, o tamanho da fonte define a
 * frequência com que isso cai no colo do editor. Medido sobre 219 parágrafos
 * reais de d1/d2/d3 em 22 edições (`data/editions/*​/03-social.md`), com o
 * mesmo wrap que o render usa:
 *
 *   | tamanho | teto      | precisariam de reescrita |
 *   |---------|-----------|--------------------------|
 *   | 62px    | 12 linhas | 16 de 219 · 7,3%         |
 *   | 64px    | 11 linhas | 33 de 219 · 15,1%        |
 *   | 72px    | 10 linhas | 84 de 219 · 38,4%        |
 *
 * 60px cabe as mesmas 12 linhas que 62px, então 62 domina (maior pelo mesmo
 * custo). 62px também tem corte previsível — no histórico, tudo até 321
 * caracteres coube e tudo a partir de 327 estourou; em 64px há uma zona
 * cinza de 278–299 onde o resultado depende de quais palavras caem na quebra.
 */
export const DAILY_CAROUSEL_BODY_SIZE = 62;

/** Layout dos 4 slides sem foto do carrossel diário. */
export const DAILY_CAROUSEL_LAYOUT: FlatCardLayout = { mode: "fixed", size: DAILY_CAROUSEL_BODY_SIZE };

/**
 * Orientação de tamanho passada ao `social-writer` (`.claude/agents/`).
 * DELIBERADAMENTE abaixo do máximo que coube no histórico (321): o limite
 * real depende de quais palavras caem na quebra de linha, então o prompt
 * pede folga e o guard mecânico (`findOverflowingCarouselSlides`) é quem
 * decide de fato. Um número no prompt não substitui a medição.
 *
 * Reduzido de 300 para 260 no #6136 item 2: a quebra do corpo em 2 blocos
 * (`splitParagraphIntoTwoBlocks`) consome 1 das 12 linhas do teto do #6078
 * como respiro entre os blocos (11 restantes pro texto em vez de 12) — sem
 * reduzir a folga, a mesma contagem de caracteres que cabia em 62px antes
 * passaria a estourar com mais frequência. ~13% de corte (11/12) sobre 300
 * arredonda pra 260; não é uma remedição dos 219 parágrafos históricos do
 * #6078 (esse dado não muda retroativamente), é a mesma folga proporcional
 * aplicada ao espaço vertical que sobrou. Reavaliar com dado real (nova
 * medição de taxa de reescrita) é trabalho futuro, não bloqueante aqui.
 */
export const DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET = 260;

export const CAROUSEL_SLIDE_SLOTS = ["p1", "p2", "p3", "cta"] as const;
export type CarouselSlideSlot = (typeof CAROUSEL_SLIDE_SLOTS)[number];

/**
 * Destaques possíveis numa edição diária (2 ou 3, nunca 4 — regra editorial
 * do #3369). Union fechado pelo mesmo motivo que `CarouselSlideSlot`: chave
 * de carimbo digitada errada vira erro de compilação em vez de entrada órfã
 * que nunca mais é lida (review de tipos do #6068).
 */
export const DAILY_DESTAQUE_IDS = ["d1", "d2", "d3"] as const;
export type DailyDestaqueId = (typeof DAILY_DESTAQUE_IDS)[number];

/**
 * Capa do carrossel — slide 1, gerado por `gen-social-card-4x5.ts`, NUNCA por
 * este módulo. Existe aqui pra quem cruza os 5 slides (invariantes de Stage 4)
 * não remontar o nome à mão.
 */
export function carouselCoverFilename(destaque: string): string {
  return `04-${destaque}-4x5.jpg`;
}

/**
 * Pure: divide o corpo de um texto (sem hashtags — já passado por
 * `splitBodyAndTags`) em exatamente `target` parágrafos-card.
 *
 * Caso comum (texto do `social-writer` desde #6005 Parte B: exatamente 3
 * parágrafos separados por linha em branco) → passthrough direto, 1:1.
 *
 * Resiliente a desvio (edições antigas, texto editado manualmente no Studio):
 *   - MAIS parágrafos que `target`: mantém os primeiros `target - 1`, junta o
 *     resto num último parágrafo (nunca descarta conteúdo).
 *   - MENOS parágrafos que `target`: quebra o(s) parágrafo(s) mais longo(s)
 *     em sentenças, alternando o mais longo a cada iteração, até atingir
 *     `target` — quando não há mais sentenças pra dividir (texto de 1 frase
 *     só), para e retorna o que der, sempre menos que `target`, nunca vazio.
 */
export function splitIntoParagraphCards(body: string, target = 3): string[] {
  let paras = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (paras.length === 0) return [];
  if (paras.length === target) return paras;

  if (paras.length > target) {
    const head = paras.slice(0, target - 1);
    const tail = paras.slice(target - 1).join(" ");
    return [...head, tail];
  }

  // paras.length < target — divide o parágrafo mais longo em sentenças até
  // atingir target (ou esgotar sentenças divisíveis).
  while (paras.length < target) {
    let longestIdx = 0;
    for (let i = 1; i < paras.length; i++) {
      if (paras[i].length > paras[longestIdx].length) longestIdx = i;
    }
    const sentences = paras[longestIdx].match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (!sentences || sentences.length < 2) break; // não dá pra dividir mais
    const mid = Math.ceil(sentences.length / 2);
    const first = sentences.slice(0, mid).join("").trim();
    const second = sentences.slice(mid).join("").trim();
    paras.splice(longestIdx, 1, first, second);
  }
  return paras;
}

/**
 * Handle + micro-CTA dos slides de PARÁGRAFO do carrossel diário (#6086
 * itens a/b — padrões 7/8 de `context/instagram-benchmarks-5815.md`, que o
 * #6005 Parte B não implementou). Nunca aplicados ao slide de CTA — lá o
 * handle já aparece no `INSTAGRAM_CTA_LINE`/footer do slide, e um segundo
 * convite a seguir seria redundante (a própria issue #6086 pede isso).
 *
 * Copy do micro-CTA é autoral deste projeto (não copiado de nenhuma conta de
 * benchmark) — curto o bastante pra não competir com o corpo do texto,
 * cabendo no canto inferior direito da MESMA linha do rodapé (sem consumir
 * espaço vertical novo, ver `buildFlatCardSvg`).
 */
export const DAILY_CAROUSEL_HANDLE = "@diar.ia.br";
export const DAILY_CAROUSEL_MICRO_CTA = "Segue pra não perder amanhã";

/**
 * (#6136 item 3) Kicker do slide de CTA final — upgrade de "Newsletter
 * grátis" pra uma chamada explícita de ASSINATURA. O `title` desse slide
 * (`INSTAGRAM_CTA_LINE`) é deliberadamente mantido intacto — mesmo copy da
 * legenda, decisão original do #6005 Parte B pra não divergir — e por
 * design nunca usa a palavra "assine" (o texto do Instagram evita CTA de
 * e-mail explícito no corpo, ver `social-cta-lines.ts`). O kicker é a única
 * linha do slide livre pra dizer isso sem tocar no corpo: pequena, no topo,
 * cor de marca — não compete visualmente com o texto principal (mesma classe
 * de risco que a issue pede pra evitar).
 */
export const DAILY_CAROUSEL_CTA_KICKER = "Assine grátis, direto no seu e-mail";

/**
 * (#6136 item 2) Pure: divide um bloco de texto em 2 sub-blocos, separados
 * por `\n\n`, pra abrir um respiro visual DENTRO do mesmo card de parágrafo
 * (não confundir com os 3 cards-parágrafo já existentes — isto é uma quebra
 * dentro de CADA um deles).
 *
 * Critério de quebra: sentença mais próxima do meio do texto (mesmo espírito
 * de `splitIntoParagraphCards`, que também prefere fronteira de sentença a
 * corte arbitrário). Sem fronteira de sentença (texto de 1 frase só), cai
 * pro espaço mais próximo do meio (fronteira de palavra). Nunca corta DENTRO
 * de um trecho `**marcado**` (#6086 item c) — um corte ali quebraria o par
 * de delimitadores, deixando `**` órfão na saída (regressão fácil de não
 * perceber num teste que não testa marcação). Texto curto demais pra ter um
 * ponto de corte viável (sem fronteira de sentença nem de palavra fora de
 * um trecho marcado) volta INALTERADO — nunca produz um segundo bloco vazio.
 */
export function splitParagraphIntoTwoBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Trechos `**...**` são intocáveis — nenhum candidato de corte pode cair
  // dentro do intervalo [start, end) de um trecho marcado.
  const boldRanges: [number, number][] = [];
  {
    const re = /\*\*[^*]+\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) boldRanges.push([m.index, m.index + m[0].length]);
  }
  const insideBold = (pos: number): boolean => boldRanges.some(([start, end]) => pos > start && pos < end);

  const mid = trimmed.length / 2;
  const candidates: number[] = [];

  // Fronteiras de sentença: fim de `.`/`!`/`?` (+ fechamento de aspas/parênteses) seguido de espaço.
  const sentenceRe = /[.!?]+(?:["'”’)\]]*)\s+/g;
  let sm: RegExpExecArray | null;
  while ((sm = sentenceRe.exec(trimmed)) !== null) {
    const pos = sm.index + sm[0].length;
    if (pos > 0 && pos < trimmed.length && !insideBold(pos)) candidates.push(pos);
  }

  if (candidates.length === 0) {
    // Sem fronteira de sentença: cai pra fronteira de palavra (qualquer espaço fora de trecho marcado).
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === " " && !insideBold(i)) candidates.push(i + 1);
    }
  }
  if (candidates.length === 0) return trimmed; // nada divisível — texto curto demais

  const splitAt = candidates.reduce((best, pos) => (Math.abs(pos - mid) < Math.abs(best - mid) ? pos : best));
  const first = trimmed.slice(0, splitAt).trim();
  const second = trimmed.slice(splitAt).trim();
  if (!first || !second) return trimmed;
  return `${first}\n\n${second}`;
}

/**
 * Pure: monta o `FlatCardText` de cada um dos 4 slides sem foto (3
 * parágrafos + CTA), a partir do texto genérico JÁ EXTRAÍDO de `## d{N}`
 * (com ou sem bloco de hashtags — `splitBodyAndTags` remove antes de
 * dividir). `paragraphCount` no kicker ("02 / 03") dá orientação de posição
 * no carrossel — o mesmo padrão "1 batida por slide" dos benchmarks.
 */
export function buildCarouselSlideTexts(genericText: string): Record<CarouselSlideSlot, FlatCardText> {
  const { body } = splitBodyAndTags(genericText);
  const paragraphs = splitIntoParagraphCards(body, 3);
  // Preenche até 3 com string vazia só na borda degenerada (texto vazio) —
  // `renderFlatCard`/`buildFlatCardSvg` lidam com título vazio sem lançar,
  // e este caso não deveria acontecer em produção (guard fica no chamador).
  while (paragraphs.length < 3) paragraphs.push("");

  const total = paragraphs.length;
  const entries = paragraphs.map((title, i): [CarouselSlideSlot, FlatCardText] => [
    (`p${i + 1}` as CarouselSlideSlot),
    {
      kicker: `${String(i + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
      // #6136 item 2: quebra visual em 2 blocos dentro do MESMO card.
      title: splitParagraphIntoTwoBlocks(title),
      footer: "diar.ia.br",
      handle: DAILY_CAROUSEL_HANDLE,
      // #6136 item 1: rodapé compacto (só o handle, "@" em brand) — nunca
      // wordmark + handle juntos, que repetia "diar.ia.br" na mesma linha.
      compactHandle: true,
      microCta: DAILY_CAROUSEL_MICRO_CTA,
    },
  ]);

  return {
    ...(Object.fromEntries(entries) as Record<"p1" | "p2" | "p3", FlatCardText>),
    // CTA final: sem handle/microCta — redundante ali (ver comentário acima).
    // #6136 item 3: kicker upgradado pra chamada explícita de assinatura.
    cta: { kicker: DAILY_CAROUSEL_CTA_KICKER, title: INSTAGRAM_CTA_LINE, footer: "diar.ia.br" },
  };
}

/**
 * (#6064 item 1) Carimbo de "com QUAL texto estes slides foram rasterizados".
 *
 * Os cards são imagem: o texto do `## d{N}` vira pixel no Stage 3 e não
 * acompanha mais nenhuma edição posterior do `03-social.md` — e o editor edita
 * exatamente esse arquivo no painel Revisão do Stage 4, DEPOIS do Stage 3.
 * Sem carimbo, a legenda sai com o texto novo e a arte com o velho, em
 * silêncio (a idempotência de `gen-carousel-cards.ts` era por EXISTÊNCIA de
 * arquivo, não por conteúdo).
 *
 * Mesma ideia do `.social-source-hash.json` (#1413) uma camada acima: hash
 * pequeno, determinístico, gravado por quem produz e comparado por quem
 * publica.
 *
 * Hasheia os TEXTOS RENDERIZADOS (kicker + título de cada um dos 4 slides),
 * não o bloco cru: assim uma edição que não muda o que aparece no card —
 * mexer só nas hashtags, por exemplo — não força regeneração à toa.
 *
 * #6086 item c: o `title` entra CRU (com a marcação `**...**`), então mudar
 * SÓ o negrito muda o hash e regenera a arte — exatamente o que se quer,
 * mesma classe do layoutTag abaixo.
 */
export function hashCarouselSlideTexts(genericText: string): string {
  const texts = buildCarouselSlideTexts(genericText);
  const canonical = CAROUSEL_SLIDE_SLOTS.map(
    // #6086: handle/microCta entram no rasterizado (rodapé) mas não em
    // `body`/`title` — precisam estar no carimbo, senão a introdução dos
    // itens a/b não invalida a arte já gerada com o rodapé antigo (mesma
    // classe de silêncio que o `layoutTag` abaixo já corrige pro layout).
    (slot) => `${texts[slot].kicker} || ${texts[slot].title} || ${texts[slot].handle ?? ""} || ${texts[slot].microCta ?? ""}`,
  ).join(" ~~ ");
  // #6078: o carimbo precisa cobrir o LAYOUT também, não só o texto. Sem isto,
  // uma edição cujos slides foram rasterizados com o auto-size antigo tem
  // carimbo batendo com o texto atual, `shouldRenderCarouselSlides` PULA o
  // destaque, e a mudança de tipografia nunca chega na arte — silenciosamente,
  // que é a falha que o #6064 existiu pra matar. Mudar tamanho/modo aqui
  // invalida o carimbo de propósito: a arte antiga É velha em relação ao
  // desenho atual, e regerar é barato.
  const layoutTag = `layout:${DAILY_CAROUSEL_LAYOUT.mode}:${DAILY_CAROUSEL_LAYOUT.mode === "fixed" ? DAILY_CAROUSEL_LAYOUT.size : "auto"}`;
  return createHash("sha256").update(`${canonical} ~~ ${layoutTag}`).digest("hex").slice(0, 16);
}

/**
 * (#6064 item 1) Decisão pura de re-renderizar os slides de um destaque.
 *
 * Regra: `--force` sempre renderiza; slide faltando sempre renderiza; e —
 * o ponto da issue — arquivo presente só é PULADO quando o carimbo bate com
 * o texto atual. Carimbo ausente (edição anterior ao #6064) conta como
 * divergente: regerar é barato, publicar arte defasada não.
 */
export function shouldRenderCarouselSlides(opts: {
  allSlidesExist: boolean;
  storedHash?: string;
  currentHash: string;
  force?: boolean;
}): boolean {
  if (opts.force) return true;
  if (!opts.allSlidesExist) return true;
  return opts.storedHash !== opts.currentHash;
}

/** Caminho do carimbo (um por edição, uma entrada por destaque). */
export function carouselSourceHashPath(editionDir: string): string {
  return resolve(editionDir, "_internal", ".carousel-source-hash.json");
}

export type CarouselSourceHashes = Partial<Record<DailyDestaqueId, string>>;

/**
 * Lê o carimbo. Ausente/ilegível → `{}` — quem chama distingue "sem entrada
 * pra este destaque" (não dá pra verificar) de "entrada diferente"
 * (stale de verdade); nenhum dos dois é motivo pra lançar aqui.
 */
export function readCarouselSourceHashes(editionDir: string): CarouselSourceHashes {
  const path = carouselSourceHashPath(editionDir);
  if (!existsSync(path)) return {}; // nunca gerado — normal, não loga
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { hashes?: CarouselSourceHashes };
    return data.hashes && typeof data.hashes === "object" ? data.hashes : {};
  } catch (err) {
    // Arquivo EXISTE mas não leu/parseou: escrita interrompida, conflito de
    // sync do OneDrive, permissão. O fallback é seguro (regenera tudo), mas
    // engolir sem log esconderia uma corrupção recorrente — mesmo padrão de
    // `refreshSocialSourceHash` (reorder-destaques.ts). #6068.
    console.warn(
      `daily-carousel-card: warn — ${path} existe mas não parseou ` +
        `(${(err as Error).message}); tratando como carimbo ausente (regenera os slides).`,
    );
    return {};
  }
}

/**
 * Grava o carimbo. Por padrão MESCLA com o que já existe — um destaque pulado
 * nesta rodada (texto inalterado) mantém a entrada anterior em vez de sumir.
 *
 * `replace: true` grava exatamente o mapa passado. Necessário para quem
 * precisa REMOVER entradas (`reindexCarouselSourceHashes` no reorder): com o
 * merge, um `delete` feito no objeto em memória era desfeito na escrita, que
 * ressuscitava a entrada antiga vinda do disco. #6068.
 */
export function writeCarouselSourceHashes(
  editionDir: string,
  hashes: CarouselSourceHashes,
  opts: { replace?: boolean } = {},
): void {
  const merged = opts.replace ? { ...hashes } : { ...readCarouselSourceHashes(editionDir), ...hashes };
  writeFileSync(
    carouselSourceHashPath(editionDir),
    JSON.stringify({ hashes: merged, generated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

/** Nome do arquivo local (raiz da edição) de um slide sem foto do carrossel. */
export function carouselSlideFilename(destaque: string, slot: CarouselSlideSlot): string {
  return `04-${destaque}-carousel-${slot}-4x5.jpg`;
}

/**
 * Renderiza os 4 slides sem foto de um destaque (3 parágrafos + CTA) em
 * `outPaths[slot]` — wrapper fino sobre `renderFlatCard`, 1 call por slot.
 * `outPaths` já resolvido pelo chamador (`gen-carousel-cards.ts`) via
 * `carouselSlideFilename` + `editionDir`.
 */
export async function renderCarouselSlides(
  genericText: string,
  outPaths: Record<CarouselSlideSlot, string>,
): Promise<Record<CarouselSlideSlot, string>> {
  const texts = buildCarouselSlideTexts(genericText);
  const result = {} as Record<CarouselSlideSlot, string>;
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    result[slot] = await renderFlatCard(texts[slot], outPaths[slot], DAILY_CAROUSEL_LAYOUT);
  }
  return result;
}

/**
 * Pure: quais slides de um destaque NÃO cabem no card com o tamanho fixo.
 *
 * Existe porque a política de overflow do carrossel diário é REESCREVER o
 * texto (decisão do editor, #6078) — e uma política de reescrita só funciona
 * se alguém FICAR SABENDO que estourou. Sem isto, o tamanho fixo degradaria
 * exatamente como o auto-size degradava antes: em silêncio, na arte
 * publicada.
 *
 * Consumido por `gen-carousel-cards.ts` (bloqueia o render) e pelo invariante
 * `carousel-text-overflow` do Stage 4 (pega o caso do editor ter editado o
 * social DEPOIS do Stage 3, quando o gen não roda de novo sozinho).
 *
 * `excess` é quanto o bloco passou do espaço, em px — serve pra estimar
 * quanto texto precisa sair; `chars` é o tamanho do parágrafo, que é o que o
 * editor de fato manipula.
 */
export function findOverflowingCarouselSlides(
  genericText: string,
): { slot: CarouselSlideSlot; chars: number; lines: number; excessPx: number }[] {
  const texts = buildCarouselSlideTexts(genericText);
  const out: { slot: CarouselSlideSlot; chars: number; lines: number; excessPx: number }[] = [];
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    const m = measureFlatCardBody(texts[slot].title, DAILY_CAROUSEL_LAYOUT);
    if (m.overflows) {
      out.push({
        slot,
        // #6086 item c: chars é o que o editor manipula — texto visível, sem
        // os delimitadores `**` (que não ocupam largura no card).
        chars: stripInlineBold(texts[slot].title).length,
        lines: m.lines.length,
        excessPx: m.blockHeight - m.availableHeight,
      });
    }
  }
  return out;
}

/**
 * Chaves esperadas em `06-public-images.json` (`images`) pra um destaque com
 * carrossel completo: capa (`{destaque}_4x5`, já existente antes deste
 * módulo) + os 4 slides sem foto.
 */
export function carouselImageKeys(destaque: string): { cover: string; slides: Record<CarouselSlideSlot, string> } {
  return {
    cover: `${destaque}_4x5`,
    slides: Object.fromEntries(CAROUSEL_SLIDE_SLOTS.map((slot) => [slot, `${destaque}_carousel_${slot}`])) as Record<
      CarouselSlideSlot,
      string
    >,
  };
}

/**
 * Resolve a lista ORDENADA de URLs pública do carrossel de um destaque
 * (capa → p1 → p2 → p3 → cta) a partir do mapa `images` de
 * `06-public-images.json`. `null` se QUALQUER slide estiver ausente — a
 * carga é tudo-ou-nada: publicar um carrossel incompleto (menos batidas que
 * o prometido, ou faltando o CTA) é pior que cair pro post single-image de
 * sempre. O caller (`publish-instagram.ts`) trata `null` como "sem
 * carrossel disponível — fallback pro card 4:5 único", nunca como erro.
 */
export function resolveCarouselImageUrls(
  images: Record<string, { url?: string }> | undefined,
  destaque: string,
): string[] | null {
  if (!images) return null;
  const { cover, slides } = carouselImageKeys(destaque);
  const coverUrl = images[cover]?.url;
  if (!coverUrl) return null;
  const urls: string[] = [coverUrl];
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    const url = images[slides[slot]]?.url;
    if (!url) return null;
    urls.push(url);
  }
  return urls;
}
