/**
 * format-weekly-social.ts (#4101, restrito ao Instagram pelo #4483)
 *
 * Formatação da caption do post semanal do Instagram (os itens mais
 * clicados da semana — ver `weekly-instagram-select.ts`).
 *
 * **#4483 removeu LinkedIn/Facebook/Threads/Twitter-X deste arquivo** — a
 * skill `/diaria-instagram-semanal` (renomeada de `/diaria-semanal`)
 * publica exclusivamente no Instagram agora (o recap semanal do LinkedIn
 * passou a ser coberto por `/diaria-linkedin-semanal`, #4456). As funções
 * `formatLinkedInWeekly`/`formatFacebookWeekly`/`formatThreadsWeekly`/
 * `formatTwitterWeeklyThread` e as constantes de limite de caracteres
 * associadas foram removidas junto — ver histórico do arquivo (git log)
 * pra recuperar caso algum canal volte a fazer sentido aqui no futuro.
 *
 * Pura (texto in, texto out) — nenhuma I/O ou chamada de rede.
 * `publish-weekly-social.ts` consome esta função antes de despachar.
 *
 * #4537 item 1: o link de arquivo saía cru (`https://diar.ia.br`), sem UTM —
 * resíduo do #4295, que só cobriu os links da pipeline DIÁRIA. UTM montado
 * via `new URL()` + `searchParams` (nunca concatenação), mesmo padrão de
 * `buildFacebookCtaUrl` em `social-cta-lines.ts`, a partir do triplo único em
 * `scripts/lib/shared/utm-registry.ts` (`INSTAGRAM_WEEKLY_ARCHIVE_UTM`).
 */

import { INSTAGRAM_WEEKLY_ARCHIVE_UTM } from "./shared/utm-registry.ts";

/** Limite de caracteres de caption no Instagram (mesmo valor de publish-instagram.ts). */
export const INSTAGRAM_WEEKLY_CHAR_LIMIT = 2200;

/** Monta a URL do link de arquivo com UTM (#4537) — exportada pra teste, mesmo
 * padrão de `buildFacebookCtaUrl` (`social-cta-lines.ts`). */
export function buildInstagramWeeklyArchiveUrl(): string {
  const url = new URL("https://diar.ia.br");
  url.searchParams.set("utm_source", INSTAGRAM_WEEKLY_ARCHIVE_UTM.source);
  url.searchParams.set("utm_medium", INSTAGRAM_WEEKLY_ARCHIVE_UTM.medium);
  url.searchParams.set("utm_campaign", INSTAGRAM_WEEKLY_ARCHIVE_UTM.campaign);
  return url.toString();
}

const ARCHIVE_URL = buildInstagramWeeklyArchiveUrl();

const INTRO_LINE = "Os mais clicados da semana na diar.ia.br:";

/** Shape mínimo que a formatação precisa — desacoplado do tipo de seleção completo (`InstagramRankedCandidate`). */
export interface InstagramWeeklyItem {
  title: string;
  /** "Por que isso importa" do destaque de origem — "" para itens de RADAR (`InstagramRawCandidate.why`). */
  why?: string;
  /** Corpo do destaque OU descrição de 1 linha de RADAR (`InstagramRawCandidate.body`) — usado como contexto quando `why` está vazio. */
  body?: string;
}

/** Tamanho alvo da linha de contexto por item — 1 frase curta, não um parágrafo (#5330). */
const CONTEXT_LINE_MAX_CHARS = 140;

/**
 * Extrai 1 frase curta de contexto por item pra caption — `why` (destaques)
 * ou a 1ª frase de `body` (RADAR, sem `why`), truncada preservando palavras
 * inteiras. "" se não houver nada de contexto (nunca deveria acontecer pro
 * shape real produzido por `weekly-instagram-select.ts`, mas a função é
 * defensiva pra qualquer chamador com `InstagramWeeklyItem` mínimo).
 */
function contextLine(item: InstagramWeeklyItem): string {
  const source = (item.why || item.body || "").trim();
  if (!source) return "";
  const firstSentence = source.split(/(?<=[.!?])\s/)[0] ?? source;
  if (firstSentence.length <= CONTEXT_LINE_MAX_CHARS) return firstSentence;
  const cut = firstSentence.lastIndexOf(" ", CONTEXT_LINE_MAX_CHARS - 1);
  const idx = cut > 0 ? cut : CONTEXT_LINE_MAX_CHARS - 1;
  return `${firstSentence.slice(0, idx)}...`;
}

/**
 * Instagram: caption sem links clicáveis (IG não linka no corpo) — títulos
 * numerados, cada um com 1 linha curta de contexto ("por que importa" do
 * destaque, ou a descrição de 1 linha do item de RADAR — #5330, ajuste
 * pós-benchmark de contas do nicho: headline sozinha performa pior que
 * headline + 1 frase de porquê importa) + "link na bio" apontando pro
 * arquivo. Truncado no limite de caption do IG (2200 chars) preservando
 * palavras inteiras, mesmo padrão de `truncateCaption` em
 * publish-instagram.ts.
 *
 * Formato de imagem: carrossel (#4146, decisão do editor 260727) — 1 card
 * 4:5 por item selecionado, na mesma ordem numerada desta caption. Desde o
 * #4483, os itens não correspondem mais 1:1 a dias da semana (podem vir de
 * D1/D2/D3 de qualquer dia, inclusive 2 itens do mesmo dia) — esta função só
 * numera os títulos (`items.length` itens); a montagem do carrossel em si
 * (`image_urls`, 1 por item, resolvida pelo destaque/edição de origem de
 * CADA item) é responsabilidade de `publish-weekly-social.ts`
 * (`resolveWeeklyImageUrls`).
 */
export function formatInstagramWeekly(items: InstagramWeeklyItem[]): string {
  if (items.length === 0) return "";
  const body =
    `${INTRO_LINE}\n\n` +
    items
      .map((it, i) => {
        const ctx = contextLine(it);
        return ctx ? `${i + 1}. ${it.title}\n${ctx}` : `${i + 1}. ${it.title}`;
      })
      .join("\n\n") +
    `\n\nEdição completa de cada matéria no link da bio. Arquivo completo em ${ARCHIVE_URL}.`;
  return truncateAtLimit(body, INSTAGRAM_WEEKLY_CHAR_LIMIT);
}

function truncateAtLimit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 3);
  const idx = cut > 0 ? cut : maxLen - 3;
  return text.slice(0, idx) + "...";
}
