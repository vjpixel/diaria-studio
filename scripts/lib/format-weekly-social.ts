/**
 * format-weekly-social.ts (#4101, restrito ao Instagram pelo #4483,
 * Facebook de volta pelo #5348)
 *
 * Formatação da caption dos carrosséis semanais (os itens mais clicados OU
 * os principais destaques da semana — ver `weekly-instagram-select.ts`).
 *
 * **#4483 removeu LinkedIn/Facebook/Threads/Twitter-X deste arquivo** — a
 * skill `/diaria-instagram-semanal` (renomeada de `/diaria-semanal`) passou
 * a publicar exclusivamente no Instagram (o recap semanal do LinkedIn segue
 * coberto por `/diaria-linkedin-semanal`, #4456, fora de escopo aqui). As
 * funções `formatLinkedInWeekly`/`formatFacebookWeekly`/
 * `formatThreadsWeekly`/`formatTwitterWeeklyThread` foram removidas junto.
 *
 * **#5348 (260815, decisão do editor) trouxe `formatFacebookWeekly` de
 * volta** — o carrossel agora publica também no Facebook, mesmo agendamento
 * do Instagram, sem flag/canal separado. **Threads segue de fora**: o
 * publisher de Threads deste repo (`workers/linkedin-cron/src/dispatch.ts`
 * `fireThreads`) é TEXT-only hoje — não suporta NENHUMA imagem, muito menos
 * carrossel — implementar isso do zero (containers de imagem + polling de
 * status obrigatório, ao contrário do Instagram/Facebook) é engenharia do
 * mesmo porte do #4153 original; decisão explícita de escopo reduzido, ver
 * comentário do editor na issue #5348 e `publish-weekly-social.ts` (busca
 * por "#5348").
 *
 * Pura (texto in, texto out) — nenhuma I/O ou chamada de rede.
 * `publish-weekly-social.ts` consome estas funções antes de despachar.
 *
 * #4537 item 1: o link de arquivo saía cru (`https://diar.ia.br`), sem UTM —
 * resíduo do #4295, que só cobriu os links da pipeline DIÁRIA. UTM montado
 * via `new URL()` + `searchParams` (nunca concatenação), mesmo padrão de
 * `buildFacebookCtaUrl` em `social-cta-lines.ts`, a partir do triplo único em
 * `scripts/lib/shared/utm-registry.ts` (`INSTAGRAM_WEEKLY_ARCHIVE_UTM`).
 *
 * #5348 self-review: `formatFacebookWeekly` usa um triplo UTM PRÓPRIO
 * (`FACEBOOK_WEEKLY_ARCHIVE_UTM`, `source:"facebook"`) — nunca reusa o do
 * Instagram. O link é clicável no CORPO do post do Facebook (o Instagram
 * suprime link no corpo, usa "link na bio"), então o volume de clique real
 * tende a divergir bastante entre os 2 canais; misturar as 2 fontes sob o
 * mesmo `utm_source=instagram` mascararia qual canal está de fato
 * convertendo — mesmo racional que já motivou o #4537 a dar UTM a este link.
 */

import { INSTAGRAM_WEEKLY_ARCHIVE_UTM, FACEBOOK_WEEKLY_ARCHIVE_UTM } from "./shared/utm-registry.ts";

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

/** #5348: mesmo padrão de `buildInstagramWeeklyArchiveUrl`, mas com o
 * triplo UTM PRÓPRIO do Facebook (`FACEBOOK_WEEKLY_ARCHIVE_UTM`) — ver nota
 * no cabeçalho do arquivo sobre por que não reusa o do Instagram. */
export function buildFacebookWeeklyArchiveUrl(): string {
  const url = new URL("https://diar.ia.br");
  url.searchParams.set("utm_source", FACEBOOK_WEEKLY_ARCHIVE_UTM.source);
  url.searchParams.set("utm_medium", FACEBOOK_WEEKLY_ARCHIVE_UTM.medium);
  url.searchParams.set("utm_campaign", FACEBOOK_WEEKLY_ARCHIVE_UTM.campaign);
  return url.toString();
}

const ARCHIVE_URL = buildInstagramWeeklyArchiveUrl();
const FACEBOOK_ARCHIVE_URL = buildFacebookWeeklyArchiveUrl();

/** Modo do carrossel semanal (#5330) — cada um tem intro própria na caption. */
export type WeeklyInstagramMode = "clicked" | "highlights";

const INTRO_LINES: Record<WeeklyInstagramMode, string> = {
  clicked: "Os mais clicados da semana na diar.ia.br:",
  highlights: "Os principais destaques da semana na diar.ia.br:",
};

/** Shape mínimo que a formatação precisa — desacoplado do tipo de seleção completo (`InstagramRankedCandidate`). */
export interface InstagramWeeklyItem {
  title: string;
  /** "Por que isso importa" do destaque de origem — "" para itens de RADAR (`InstagramRawCandidate.why`). */
  why?: string;
  /** Corpo do destaque OU descrição de 1 linha de RADAR (`InstagramRawCandidate.body`) — usado como contexto quando `why` está vazio. */
  body?: string;
}

/**
 * Extrai 1 frase de contexto por item pra caption — `why` (destaques) ou a
 * 1ª frase de `body` (RADAR, sem `why`). "" se não houver nada de contexto
 * (nunca deveria acontecer pro shape real produzido por
 * `weekly-instagram-select.ts`, mas a função é defensiva pra qualquer
 * chamador com `InstagramWeeklyItem` mínimo).
 *
 * SEMPRE a frase inteira — achado ao vivo (#5330, review do editor 260815):
 * um truncamento próprio de 140 chars cortava a frase NO MEIO ("...expõe a
 * falta de"), ilegível. A rede de segurança contra estourar o limite de
 * caption do Instagram é só `truncateAtLimit` no corpo INTEIRO (2200 chars),
 * no fim de `formatInstagramWeekly` — 1ª sentença editorial real neste
 * dataset nunca passou de ~310 chars, então 5 linhas de contexto cabem
 * folgado dentro do limite mesmo sem cap por linha.
 */
function contextLine(item: InstagramWeeklyItem): string {
  const source = (item.why || item.body || "").trim();
  if (!source) return "";
  return source.split(/(?<=[.!?])\s/)[0] ?? source;
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
export function formatInstagramWeekly(items: InstagramWeeklyItem[], mode: WeeklyInstagramMode = "clicked"): string {
  if (items.length === 0) return "";
  const body =
    `${INTRO_LINES[mode]}\n\n` +
    items
      .map((it, i) => {
        const ctx = contextLine(it);
        return ctx ? `${i + 1}. ${it.title}\n${ctx}` : `${i + 1}. ${it.title}`;
      })
      .join("\n\n") +
    `\n\nEdição completa de cada matéria no link da bio. Arquivo completo em ${ARCHIVE_URL}.`;
  return truncateAtLimit(body, INSTAGRAM_WEEKLY_CHAR_LIMIT);
}

/**
 * Facebook (#5348): MESMO carrossel/itens/ordem do Instagram — a única
 * diferença de formato é a linha final. Facebook aceita link clicável no
 * corpo do post (Instagram não linka), então em vez de "link na bio" a CTA
 * aponta DIRETO pro arquivo — sem precisar da indireção "vá no perfil,
 * procure o link". Sem limite de caption prático (feed post do Facebook
 * aceita ~63.200 chars, muito acima do que este carrossel produz) — nenhum
 * truncamento é aplicado, diferente do Instagram.
 */
export function formatFacebookWeekly(items: InstagramWeeklyItem[], mode: WeeklyInstagramMode = "clicked"): string {
  if (items.length === 0) return "";
  return (
    `${INTRO_LINES[mode]}\n\n` +
    items
      .map((it, i) => {
        const ctx = contextLine(it);
        return ctx ? `${i + 1}. ${it.title}\n${ctx}` : `${i + 1}. ${it.title}`;
      })
      .join("\n\n") +
    `\n\nEdição completa de cada matéria e arquivo completo: ${FACEBOOK_ARCHIVE_URL}`
  );
}

function truncateAtLimit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 3);
  const idx = cut > 0 ? cut : maxLen - 3;
  return text.slice(0, idx) + "...";
}
