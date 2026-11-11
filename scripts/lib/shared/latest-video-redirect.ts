/**
 * scripts/lib/shared/latest-video-redirect.ts (#12735)
 *
 * `diar.ia.br/video`: link FIXO da bio (TikTok, Instagram, Threads) que leva
 * ao vídeo horizontal mais recente da diar.ia.br no YouTube. Decisão do editor
 * no briefing do overnight 261110e (10/11/2026): "link na bio + legenda" — o
 * redirect fixo para as redes sem link clicável na legenda, com UTM por rede,
 * e o link do horizontal da edição na legenda onde a rede aceita (LinkedIn,
 * Facebook, X; `scripts/publish-shorts.ts`).
 *
 * Miolo PURO, sem I/O, importado pelos dois lados:
 *   - `workers/site/src/index.ts` (o Worker do apex) lê o registro do KV
 *     `POLL` e responde 302;
 *   - `scripts/set-latest-video-redirect.ts` (e o `--publish` do
 *     `publish-shorts.ts`) monta e grava o registro a partir de
 *     `_internal/05-video-url.txt` da edição.
 *
 * Registro no KV (`LATEST_VIDEO_KV_KEY`): JSON `{ url, aammdd, updated_at,
 * public_at?, previous? }` (#12801: `public_at` = quando o horizontal agendado
 * fica público; `previous` = o registro que vigorava antes, servido até lá —
 * `effectiveLatestVideoRecord`), com `url` sempre `https://youtu.be/{id}` (a forma que `05-video-url.txt`
 * guarda). Registro ausente, ilegível ou com URL fora dessa forma → o
 * redirect cai na lista de vídeos do canal (`LATEST_VIDEO_FALLBACK_URL`),
 * que também mostra o horizontal mais recente no topo: o link da bio nunca
 * responde 404 nem leva a um destino arbitrário gravado no KV.
 *
 * A gravação só avança (`shouldReplaceLatestVideo`): rodar o publish de uma
 * edição ANTERIOR (retomada, reenvio) nunca faz o link da bio voltar no tempo.
 *
 * Limite registrado (a ponderar pelo editor, comentário de 10/11 20:44 na
 * #12735): quem assiste o vertical de um dia depois que o horizontal do dia
 * seguinte já saiu cai no horizontal novo, não no daquela edição. A legenda
 * das redes que aceitam link leva o horizontal DA edição, sem esse problema.
 */

import { LATEST_VIDEO_BIO_UTM, LATEST_VIDEO_BIO_UTM_SOURCES } from "./utm-registry.ts";

/** Caminho do redirect no apex. */
export const LATEST_VIDEO_PATH = "/video";

/** Chave do registro no KV `POLL` (o namespace que a pipeline já escreve). */
export const LATEST_VIDEO_KV_KEY = "video:latest-horizontal";

/** Destino quando não há registro válido: a aba de vídeos (horizontais) do canal. */
export const LATEST_VIDEO_FALLBACK_URL = "https://www.youtube.com/@diariabr/videos";

/**
 * `utm_medium`/`utm_campaign` dos links da bio. Os valores moram no registry
 * de UTMs (`LATEST_VIDEO_BIO_UTM`, entradas `*-bio-video-horizontal-12735` de
 * `UTM_EMITTERS`, #12786); aqui só são reexportados.
 */
export const LATEST_VIDEO_BIO_UTM_MEDIUM = LATEST_VIDEO_BIO_UTM.medium;
export const LATEST_VIDEO_BIO_UTM_CAMPAIGN = LATEST_VIDEO_BIO_UTM.campaign;

/** Redes cujo caminho até o horizontal é o link da bio (sem link clicável na legenda do vertical). */
export const LATEST_VIDEO_BIO_NETWORKS = LATEST_VIDEO_BIO_UTM_SOURCES;
export type LatestVideoBioNetwork = (typeof LATEST_VIDEO_BIO_NETWORKS)[number];

/** Link da bio de uma rede: `https://diar.ia.br/video?utm_source={rede}&utm_medium=bio&utm_campaign=video-horizontal`. */
export function latestVideoBioLink(network: LatestVideoBioNetwork, origin = "https://diar.ia.br"): string {
  const u = new URL(LATEST_VIDEO_PATH, origin);
  u.searchParams.set("utm_source", network);
  u.searchParams.set("utm_medium", LATEST_VIDEO_BIO_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", LATEST_VIDEO_BIO_UTM_CAMPAIGN);
  return u.toString();
}

/**
 * #12869: origem do `public_at` (ver `resolveEditionHorizontalPublicAt` em
 * `scripts/set-latest-video-redirect.ts`).
 */
export const LATEST_VIDEO_PUBLIC_AT_SOURCES = ["upload", "upload_immediate", "edition_default"] as const;
export type LatestVideoPublicAtSource = (typeof LATEST_VIDEO_PUBLIC_AT_SOURCES)[number];

export interface LatestVideoRecord {
  /** `https://youtu.be/{id}`. */
  url: string;
  /** Edição do horizontal (AAMMDD). */
  aammdd: string;
  /** ISO da gravação. */
  updated_at: string;
  /**
   * #12801: ISO de quando o horizontal fica público (o `publishAt` do upload
   * agendado; no caminho de reserva, sem registro do upload, as 06:00 BRT
   * presumidas da edição). Ausente = já público (upload na hora pela API).
   * Enquanto não passa, o redirect usa `previous` (ou a lista do canal).
   */
  public_at?: string;
  /**
   * #12869: de onde veio o `public_at` — `upload`/`upload_immediate` (o
   * registro do upload deste vídeo, autoritativo) ou `edition_default` (as
   * 06:00 BRT presumidas do caminho de reserva). Um `edition_default` nunca
   * substitui um `public_at` vindo do upload (`shouldReplaceLatestVideo`).
   * Ausente = registro anterior ao #12869.
   */
  public_at_source?: LatestVideoPublicAtSource;
  /**
   * #12801: o horizontal que o link da bio servia antes deste registro (sem
   * `previous` aninhado: um nível só). Cobre a janela entre o upload da
   * noite de D-1 e o `public_at` de D.
   */
  previous?: LatestVideoPrevious;
}

/** #12801: o registro anterior guardado dentro do novo. */
export type LatestVideoPrevious = Omit<LatestVideoRecord, "previous">;

const YOUTU_BE_RE = /^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/;
const AAMMDD_RE = /^\d{6}$/;

/** Pure: um registro (sem `previous`) a partir de um objeto já decodificado, ou `null`. */
function parseRecordFields(v: unknown): LatestVideoPrevious | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.url !== "string" || !YOUTU_BE_RE.test(r.url)) return null;
  if (typeof r.aammdd !== "string" || !AAMMDD_RE.test(r.aammdd)) return null;
  const out: LatestVideoPrevious = { url: r.url, aammdd: r.aammdd, updated_at: typeof r.updated_at === "string" ? r.updated_at : "" };
  // #12801: `public_at` ilegível é descartado (o registro conta como já público, o comportamento de antes).
  if (typeof r.public_at === "string" && !Number.isNaN(Date.parse(r.public_at))) out.public_at = r.public_at;
  // #12869: fonte desconhecida é descartada (conta como registro anterior ao campo).
  if (typeof r.public_at_source === "string" && (LATEST_VIDEO_PUBLIC_AT_SOURCES as readonly string[]).includes(r.public_at_source)) {
    out.public_at_source = r.public_at_source as LatestVideoPublicAtSource;
  }
  return out;
}

/** Pure: o registro lido do KV, ou `null` se ausente/ilegível/fora do formato. Nunca lança. */
export function parseLatestVideoRecord(raw: string | null | undefined): LatestVideoRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const out: LatestVideoRecord | null = parseRecordFields(v);
  if (!out) return null;
  // `previous` ilegível some sem invalidar o registro principal.
  const previous = parseRecordFields((v as Record<string, unknown>).previous);
  if (previous) out.previous = previous;
  return out;
}

/** Pure (#12801): o registro já é público em `now`? Sem `public_at`, sim. */
export function isLatestVideoPublic(record: LatestVideoPrevious, now: Date): boolean {
  if (!record.public_at) return true;
  return Date.parse(record.public_at) <= now.getTime();
}

/**
 * Pure (#12801): o registro que o redirect usa em `now`. O horizontal de D é
 * gravado na noite de D-1 ainda `private` (publica às 06:00 BRT de D); até
 * o `public_at` passar, o link da bio segue no horizontal anterior
 * (`previous`) e, sem ele (ou se também não for público), cai na lista do
 * canal (`null`). Nunca devolve um vídeo privado.
 */
export function effectiveLatestVideoRecord(record: LatestVideoRecord | null, now: Date): LatestVideoPrevious | null {
  if (!record) return null;
  if (isLatestVideoPublic(record, now)) return record;
  if (record.previous && isLatestVideoPublic(record.previous, now)) return record.previous;
  return null;
}

/**
 * Pure (#12869): o mesmo instante de publicação? Compara por `Date.parse`, não
 * como texto: a YouTube API devolve `publishAt` sem milissegundos
 * (`...T09:00:00Z`) e o default da edição sai de `toISOString()` (`.000Z`).
 * Os dois ausentes = iguais (já público).
 */
export function sameLatestVideoPublicAt(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/**
 * Pure (#12869): confiança no `public_at` do registro. O do upload (com ou sem
 * `publishAt`) vale 2; o presumido da edição vale 1. Registro anterior ao
 * #12869, sem `public_at_source`: com `public_at` pode ter vindo do upload,
 * então vale 2 (conservador: o presumido não o sobrescreve); sem `public_at`
 * (anterior ao #12801) vale 0 e qualquer fonte o completa (#12863).
 */
function publicAtRank(r: LatestVideoPrevious): number {
  if (r.public_at_source === "upload" || r.public_at_source === "upload_immediate") return 2;
  if (r.public_at_source === "edition_default") return 1;
  return r.public_at !== undefined ? 2 : 0;
}

/**
 * Pure: o registro novo substitui o atual? Só quando a edição é igual ou mais
 * nova (AAMMDD compara como texto) e algo mudou: a edição, o link ou, na
 * mesma edição e link, o `public_at` (#12863 — o `publishAt` real que chega
 * depois das 06:00 presumidas do caminho de reserva, ou registro anterior ao
 * #12801 sem `public_at`). Registro atual ilegível (`null`) é substituído.
 *
 * #12869: na mesma edição e link, a fonte do `public_at` só sobe — um
 * `edition_default` (cópia do Drive atrasada, registro do upload ilegível de
 * passagem) nunca troca o `publishAt` que veio do upload, senão o link da bio
 * iria para o vídeo ainda privado entre as 06:00 presumidas e o real. O
 * instante compara por `Date.parse`; mesmo instante com fonte melhor grava,
 * para o registro passar a proteger o valor.
 */
export function shouldReplaceLatestVideo(current: LatestVideoRecord | null, next: LatestVideoRecord): boolean {
  if (!current) return true;
  if (next.aammdd < current.aammdd) return false;
  if (next.aammdd !== current.aammdd || next.url !== current.url) return true;
  const rankNext = publicAtRank(next);
  const rankCurrent = publicAtRank(current);
  if (rankNext < rankCurrent) return false;
  if (!sameLatestVideoPublicAt(next.public_at, current.public_at)) return true;
  return rankNext > rankCurrent;
}

/**
 * Pure: destino do 302. Leva os `utm_*` do pedido (o YouTube os ignora, mas
 * ficam no histórico do navegador e em qualquer encurtador posterior); o
 * resto da query string fica de fora, pra o link da bio não virar um
 * redirecionador aberto de parâmetros.
 */
export function buildLatestVideoTarget(reqUrl: URL, record: LatestVideoPrevious | null): string {
  const target = new URL(record ? record.url : LATEST_VIDEO_FALLBACK_URL);
  for (const [k, v] of reqUrl.searchParams) {
    if (/^utm_[a-z]+$/.test(k) && v) target.searchParams.set(k, v);
  }
  return target.toString();
}

/**
 * Rede do clique, para o contador: uma das redes da bio ou `outro`. Lista
 * fechada de propósito: `utm_source` livre criaria uma chave de KV por valor
 * inventado no link.
 */
export function latestVideoClickSource(reqUrl: URL): LatestVideoBioNetwork | "outro" {
  const s = (reqUrl.searchParams.get("utm_source") ?? "").toLowerCase();
  return (LATEST_VIDEO_BIO_NETWORKS as readonly string[]).includes(s) ? (s as LatestVideoBioNetwork) : "outro";
}

/** Chave do contador diário de cliques por rede (KV `CURSOS_SUBSCRIBERS`, mesmo molde de `apoiar-counters.ts`). */
export function latestVideoClickCounterKey(source: string, day: string): string {
  return `counter:video:${source}:${day}`;
}
