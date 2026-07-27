/**
 * format-weekly-social.ts (#4101)
 *
 * Formatação por rede do post semanal de destaques (os "5 D1" da semana,
 * ver `select-weekly-d1.ts`). Decisão do editor (260727): não é um texto
 * único replicado nas 5 redes — o limite de caracteres separa os canais
 * (o mesmo motivo pelo qual #3991 pôde colapsar LinkedIn/Facebook/Instagram
 * num texto só NÃO se aplica aqui: lá os 3 aceitavam o mesmo formato; aqui
 * Threads (500) e Twitter/X (280/tweet) não cabem o texto de LinkedIn/Facebook).
 *
 * Todas as funções são puras (texto in, texto/array out) — nenhuma faz I/O
 * ou chamada de rede. `publish-weekly-social.ts` e `prep-weekly-twitter.ts`
 * consomem estas funções antes de despachar.
 */

import { WeeklyD1Item } from "./select-weekly-d1.ts";

/** Limite de caracteres por post no Threads (mesmo valor de publish-threads.ts). */
export const THREADS_WEEKLY_CHAR_LIMIT = 500;

/** Limite de caracteres por tweet no X (mesmo valor de prep-twitter-posts.ts). */
export const TWITTER_WEEKLY_CHAR_LIMIT = 280;

/** Limite de caracteres de caption no Instagram (mesmo valor de publish-instagram.ts). */
export const INSTAGRAM_WEEKLY_CHAR_LIMIT = 2200;

const ARCHIVE_URL = "https://diar.ia.br";

const INTRO_LINE = "Os destaques da semana na Diar.ia:";

function numberedHeadlines(items: WeeklyD1Item[]): string {
  return items.map((it, i) => `${i + 1}. ${it.title}\n${it.url}`).join("\n\n");
}

/**
 * LinkedIn: lista numerada completa (título + link), sem limite prático de
 * caracteres relevante (LinkedIn aceita até ~3000 chars — 5 manchetes cabem
 * folgado). Sem CTA de e-mail/link embutido aqui — mesmo invariante de
 * `social-cta-lines.ts` (LINKEDIN_CTA_LINE = null): o post principal do
 * LinkedIn não leva URL de e-mail no corpo.
 */
export function formatLinkedInWeekly(items: WeeklyD1Item[]): string {
  if (items.length === 0) return "";
  return `${INTRO_LINE}\n\n${numberedHeadlines(items)}`;
}

/**
 * Facebook: mesma estrutura do LinkedIn, com o CTA de e-mail (padrão
 * `FACEBOOK_CTA_LINE` de social-cta-lines.ts) ao final — Facebook aceita
 * link cru no corpo sem penalidade de algoritmo (diferente do LinkedIn).
 */
export function formatFacebookWeekly(items: WeeklyD1Item[]): string {
  if (items.length === 0) return "";
  return (
    `${INTRO_LINE}\n\n${numberedHeadlines(items)}\n\n` +
    "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br."
  );
}

/**
 * Instagram: caption sem links clicáveis (IG não linka no corpo) — títulos
 * numerados + "link na bio" apontando pro arquivo. Truncado no limite de
 * caption do IG (2200 chars) preservando palavras inteiras, mesmo padrão de
 * `truncateCaption` em publish-instagram.ts.
 *
 * Formato de imagem (decisão de implementação, ver PR #4101 self-review):
 * usa o card 4:5 (título embutido) da edição de SEXTA como imagem única do
 * post — não um carrossel de 5 cards. Um carrossel Instagram exige criar 5
 * media containers `is_carousel_item` + 1 container pai `CAROUSEL`, fluxo
 * não coberto pelo Worker de agendamento existente (que só aceita 1
 * `image_url` por entry) — ver nota no cabeçalho de `publish-weekly-social.ts`.
 */
export function formatInstagramWeekly(items: WeeklyD1Item[]): string {
  if (items.length === 0) return "";
  const body =
    `${INTRO_LINE}\n\n` +
    items.map((it, i) => `${i + 1}. ${it.title}`).join("\n") +
    `\n\nEdição completa de cada dia no link da bio. Arquivo completo em ${ARCHIVE_URL}.`;
  return truncateAtLimit(body, INSTAGRAM_WEEKLY_CHAR_LIMIT);
}

function truncateAtLimit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 3);
  const idx = cut > 0 ? cut : maxLen - 3;
  return text.slice(0, idx) + "...";
}

/**
 * Threads: ≤500 chars. Tenta caber as 5 manchetes SEM link (só título
 * numerado + link único pro arquivo no fim) — esse é o formato que cabe mais
 * apertado sem link por item. Se ainda assim exceder o limite (títulos muito
 * longos), reduz progressivamente pra menos manchetes + "+N mais no link" —
 * nunca corta no meio de uma linha/palavra, sempre retorna ≤500.
 *
 * Garantia de pior caso (self-review #4101): mesmo com 5 títulos longos
 * (~52 chars cada, o máximo permitido por destaque), o fallback de redução
 * de manchetes sempre converge — no limite, cai pra 0 manchetes + só o link,
 * que sempre cabe em 500 chars.
 */
export function formatThreadsWeekly(items: WeeklyD1Item[]): string {
  if (items.length === 0) return "";

  for (let n = items.length; n >= 0; n--) {
    const shown = items.slice(0, n);
    const remaining = items.length - n;
    const headlines = shown.map((it, i) => `${i + 1}. ${it.title}`).join("\n");
    const tail =
      remaining > 0
        ? `\n\n+${remaining} destaque${remaining > 1 ? "s" : ""} no arquivo: ${ARCHIVE_URL}`
        : `\n\nArquivo completo: ${ARCHIVE_URL}`;
    const candidate = n > 0 ? `${INTRO_LINE}\n\n${headlines}${tail}` : `${INTRO_LINE}${tail}`;
    if (candidate.length <= THREADS_WEEKLY_CHAR_LIMIT) return candidate;
  }

  // Inalcançável na prática (o candidato com n=0 é curtíssimo), mas mantém o
  // contrato "nunca retorna >500 chars" mesmo em caso hipotético extremo.
  return `${INTRO_LINE}\n\n${ARCHIVE_URL}`.slice(0, THREADS_WEEKLY_CHAR_LIMIT);
}

/**
 * Twitter/X: sem espaço pra 5 manchetes num tweet só (280 chars) — vira
 * thread (#4101, mesmo padrão de encadeamento de `publish-threads.ts`):
 * tweet[0] é a abertura ("🧵"), tweets[1..N] são 1 manchete + link cada,
 * truncando o título (nunca a URL) se a linha exceder 280 chars.
 *
 * Cada elemento do array retornado é 1 tweet — o caller (prep-weekly-twitter.ts)
 * publica via Buffer MCP como thread encadeada.
 */
export function formatTwitterWeeklyThread(items: WeeklyD1Item[]): string[] {
  if (items.length === 0) return [];

  const intro = `Os destaques da semana na Diar.ia 🧵 (1/${items.length + 1})`;
  const tweets = [intro];

  items.forEach((it, i) => {
    const n = i + 2; // 1 = abertura
    const suffix = ` (${n}/${items.length + 1})`;
    const urlPart = `\n${it.url}`;
    // Orçamento pro título: limite total menos URL, quebra de linha e sufixo de contagem.
    // Piso de 10 chars: URLs reais do projeto (~40-120 chars) nunca chegam perto de
    // esgotar o orçamento, mas o piso evita slice/lastIndexOf com índice negativo
    // no caso hipotético de uma URL patologicamente longa (self-review #4101).
    const budget = Math.max(10, TWITTER_WEEKLY_CHAR_LIMIT - urlPart.length - suffix.length);
    const title = it.title.length <= budget ? it.title : truncateAtLimit(it.title, budget);
    tweets.push(`${title}${suffix}${urlPart}`);
  });

  return tweets;
}
