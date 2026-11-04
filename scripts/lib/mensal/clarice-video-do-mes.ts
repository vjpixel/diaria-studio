/**
 * clarice-video-do-mes.ts (#12092) — miolo puro do bloco "Vídeo do mês" na
 * Clarice News.
 *
 * Pedido do editor (03/11/2026): a Clarice News do ciclo `2610-11` (envio de
 * 04/11) leva o horizontal de outubro mais visto no @diariabr. A versão
 * recorrente (vídeo do mês no render da mensal) é a #12081; aqui o bloco entra
 * por INJEÇÃO no HTML já renderizado (`_internal/cloudflare-preview.html`),
 * que é o que `clarice-reapply-scheduled-html.ts` e o grupo `novos` leem.
 * Re-renderizar a mensal a partir do `draft.md` apaga a injeção: rodar o
 * injetor de novo depois (é idempotente).
 *
 * Sem I/O: a CLI (`scripts/clarice-video-do-mes.ts`) faz a chamada à YouTube
 * Data API e a leitura/escrita do arquivo.
 */
import { COLORS, FONTS } from "../shared/design-tokens.ts";
import { escHtml } from "../html-escape.ts";
import { breakBrandDomainAutolink } from "../shared/brand-wordmark.ts";
import { DIARIA_YOUTUBE_SUBSCRIBE_URL } from "../canonical-urls.ts";
import { renderKicker } from "./monthly-render.ts";

export const VIDEO_DO_MES_START = "<!-- video-do-mes:start (#12092) -->";
export const VIDEO_DO_MES_END = "<!-- video-do-mes:end -->";
export const VIDEO_DO_MES_KICKER = "Vídeo do mês";

/** Shorts vão até 3 min; acima disso é horizontal. */
export const SHORT_MAX_SECONDS = 180;

const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Vídeo como sai de `videos.list?part=snippet,contentDetails,statistics,status`. */
export interface YouTubeVideoItem {
  id?: string;
  snippet?: { title?: string; description?: string; publishedAt?: string; tags?: string[] };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
  status?: { privacyStatus?: string; uploadStatus?: string };
}

export interface VideoDoMesPick {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string;
  durationSeconds: number;
}

/** `2610-11` → mês do CONTEÚDO (outubro de 2026), que é o "mês passado" do envio. */
export function contentMonthOfCycle(cycle: string): { year: number; month: number; label: string } {
  const m = /^(\d{2})(\d{2})-(\d{2})$/.exec(cycle);
  if (!m) throw new Error(`ciclo inválido: "${cycle}" (esperado {conteúdo}-{envio}, ex: 2610-11)`);
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`ciclo inválido: "${cycle}" (mês ${m[2]})`);
  return { year, month, label: MONTHS_PT[month - 1] };
}

/** Janela do mês em BRT (UTC-3, sem horário de verão desde 2019), em ms UTC. */
export function monthWindowBrtMs(year: number, month: number): { startMs: number; endMs: number } {
  const startMs = Date.UTC(year, month - 1, 1, 3, 0, 0);
  const endMs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 3, 0, 0);
  return { startMs, endMs };
}

/** ISO 8601 de duração do YouTube (`PT1H2M3S`) → segundos. Formato inesperado → NaN. */
export function parseIsoDurationSeconds(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? "");
  if (!m || !iso || iso === "P" || iso === "PT") return Number.NaN;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

export function isShortVideo(v: YouTubeVideoItem): boolean {
  const title = v.snippet?.title ?? "";
  const description = v.snippet?.description ?? "";
  const tags = v.snippet?.tags ?? [];
  if (/#shorts?\b/i.test(`${title} ${description}`) || tags.some((t) => /^#?shorts?$/i.test(t))) return true;
  const secs = parseIsoDurationSeconds(v.contentDetails?.duration);
  // Duração ilegível não prova que é horizontal: fica de fora.
  return !Number.isFinite(secs) || secs <= SHORT_MAX_SECONDS;
}

/**
 * Horizontal PÚBLICO publicado no mês (BRT) com mais views. Empate: o mais
 * antigo (teve o mesmo número com mais tempo no ar, mas a regra só precisa ser
 * determinística). `null` quando nenhum vídeo casa.
 */
export function pickVideoDoMes(videos: YouTubeVideoItem[], year: number, month: number): VideoDoMesPick | null {
  const { startMs, endMs } = monthWindowBrtMs(year, month);
  const picks: VideoDoMesPick[] = [];
  for (const v of videos) {
    if (!v.id) continue;
    if (v.status?.privacyStatus !== "public") continue;
    if (isShortVideo(v)) continue;
    const publishedAt = v.snippet?.publishedAt ?? "";
    const ms = Date.parse(publishedAt);
    if (Number.isNaN(ms) || ms < startMs || ms >= endMs) continue;
    const views = Number(v.statistics?.viewCount ?? "");
    if (!Number.isFinite(views)) continue;
    picks.push({
      videoId: v.id,
      title: v.snippet?.title ?? "",
      views,
      publishedAt,
      durationSeconds: parseIsoDurationSeconds(v.contentDetails?.duration),
    });
  }
  picks.sort((a, b) => b.views - a.views || Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return picks[0] ?? null;
}

/** UTM própria do bloco (corpo da #12092): fora do prefixo `clarice-` de propósito. */
export function videoDoMesCampaign(cycle: string): string {
  contentMonthOfCycle(cycle); // valida
  return `video-do-mes-${cycle}`;
}

export function videoDoMesUrl(videoId: string, cycle: string): string {
  if (!/^[\w-]{6,20}$/.test(videoId)) throw new Error(`videoId inválido: "${videoId}"`);
  const params = new URLSearchParams({
    v: videoId,
    utm_source: "clarice",
    utm_medium: "email",
    utm_campaign: videoDoMesCampaign(cycle),
  });
  return `https://www.youtube.com/watch?${params}`;
}

export function defaultVideoDoMesFrase(cycle: string): string {
  // Sem "diar.ia.br" em texto puro: o Gmail autolinka o domínio. O título vem
  // do YouTube e pode trazê-lo ("diar.ia.br comentada"): passa por
  // `breakBrandDomainAutolink` no build.
  return `O episódio mais assistido de ${contentMonthOfCycle(cycle).label} no nosso canal do YouTube.`;
}

/** Atributo href com `&amp;`, como o render da mensal escreve (#12053). */
function hrefAttr(url: string): string {
  return escHtml(url);
}

/**
 * `imageUrl` é a imagem do DESTAQUE da edição que o vídeo comenta (pedido do
 * editor, 04/11/2026: não a capa do YouTube), linkada para o vídeo, no mesmo
 * estilo da imagem dos destaques da mensal. O título sai como o h2 dos
 * destaques (mesma ordem: kicker, título, imagem) e sem link (pedido do
 * editor): o link do vídeo fica na imagem e no "Assista ao vídeo".
 */
export function buildVideoDoMesHtml(input: {
  cycle: string;
  videoId: string;
  title: string;
  frase: string;
  imageUrl?: string;
}): string {
  const title = input.title.trim();
  const frase = input.frase.trim();
  if (!title) throw new Error("título do vídeo vazio");
  if (!frase) throw new Error("frase vazia");
  if (/[→←]/.test(title + frase)) throw new Error("seta no texto do bloco (#9721)");
  const imageUrl = input.imageUrl?.trim();
  if (imageUrl && !/^https:\/\//.test(imageUrl)) throw new Error(`imagem precisa de URL https pública: "${imageUrl}"`);
  const link = `color:${COLORS.ink};text-decoration:underline;text-decoration-color:${COLORS.brand};`;
  const videoHref = hrefAttr(videoDoMesUrl(input.videoId, input.cycle));
  return [
    VIDEO_DO_MES_START,
    renderKicker(VIDEO_DO_MES_KICKER),
    // Mesmo h2 de `renderDestaque` (monthly-render.ts), sem link.
    `<h2 style="margin:0 0 20px 0;font-size:26px;font-family:${FONTS.serif};line-height:1.2;color:${COLORS.ink};">${breakBrandDomainAutolink(escHtml(title))}</h2>`,
    ...(imageUrl
      ? [`<a href="${videoHref}" style="text-decoration:none;"><img src="${hrefAttr(imageUrl)}" width="100%" border="0" alt="${escHtml(title)}" style="display:block;width:100%;height:auto;border-radius:6px;margin:0 0 20px 0;border:0;" /></a>`]
      : []),
    `<p style="margin:0 0 16px 0;font-family:${FONTS.sans};">${escHtml(frase)} <a href="${videoHref}" style="${link}">Assista ao vídeo</a> e <a href="${hrefAttr(DIARIA_YOUTUBE_SUBSCRIBE_URL)}" style="${link}">inscreva-se no canal</a>.</p>`,
    `<div style="line-height:28px;font-size:0;">&nbsp;</div>`,
    VIDEO_DO_MES_END,
  ].join("\n");
}

const RESUMO_KICKER_TEXT = "&nbsp;Resumo do mês</td>";
/**
 * Começo de QUALQUER kicker do render, tirado do próprio `renderKicker` (tudo
 * antes do rótulo): casa a tabela do kicker inteira, não só a bolinha teal, que
 * também abre o rótulo "O fio condutor" dentro de um destaque.
 */
const KICKER_PREFIX = renderKicker("\u0000").split("\u0000")[0];

/**
 * Insere (ou move/troca) o bloco logo depois da seção "Resumo do mês", antes do
 * kicker seguinte (pedido do editor, 04/11/2026; antes ia antes do "Para
 * encerrar"). Idempotente: um bloco anterior entre os marcadores é removido de
 * onde estiver e reinserido no lugar certo, nunca duplicado. Sem o kicker do
 * resumo ou sem seção depois dele, lança: injetar num lugar arbitrário seria
 * pior que parar.
 */
export function injectVideoDoMes(html: string, block: string): { html: string; replaced: boolean } {
  let base = html;
  let replaced = false;
  const start = html.indexOf(VIDEO_DO_MES_START);
  if (start >= 0) {
    const end = html.indexOf(VIDEO_DO_MES_END, start);
    if (end < 0) throw new Error("marcador de início do vídeo do mês sem o de fim: HTML corrompido, conferir à mão");
    let after = end + VIDEO_DO_MES_END.length;
    if (html[after] === "\n") after += 1;
    base = html.slice(0, start) + html.slice(after);
    replaced = true;
  }
  const resumo = base.indexOf(RESUMO_KICKER_TEXT);
  if (resumo < 0) throw new Error('kicker "Resumo do mês" não encontrado no HTML: não sei onde pôr o bloco');
  const tableStart = base.indexOf(KICKER_PREFIX, resumo + RESUMO_KICKER_TEXT.length);
  if (tableStart < 0) throw new Error('nenhuma seção depois do "Resumo do mês": não sei onde pôr o bloco');
  return { html: base.slice(0, tableStart) + block + "\n" + base.slice(tableStart), replaced };
}
