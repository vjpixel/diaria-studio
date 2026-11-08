/**
 * public-images-archive.ts (#11412, fatias 3 e 4)
 *
 * As imagens públicas antigas (e-mails já enviados, carrosséis semanais, PDF
 * do LinkedIn semanal, Retrospectiva do Mês) só existem no KV `POLL`, o mesmo
 * namespace do jogo É IA?. A fatia 1 mandou as imagens NOVAS da diária para o
 * R2; esta camada cuida do resto:
 *
 *   - **Fatia 3, arquivo durável.** `archiveKvImages` copia cada key `img-*`
 *     do KV para o R2, em `r2ArchiveKeyForImageKey(key)` (`img/{AAMMDD}/…`
 *     para key com data, `img/kv/{key}` para as demais), e confere a cópia
 *     (tamanho + ETag = MD5 dos bytes do KV). `archiveUploadedFileToR2` faz a
 *     mesma cópia no momento do upload dos cards semanais, do PDF semanal e
 *     das imagens mensais, para que o KV deixe de ser a única cópia já na
 *     geração. O uploader da anual não copia no upload: as `img-annual-*`
 *     ficam para o `archive-kv-public-images.ts` e, sem data derivável, nunca
 *     são podadas.
 *   - **Fatia 4, poda gradual.** `pruneKvImages` remove do KV só a key cuja
 *     cópia no R2 foi conferida AGORA contra os bytes do KV, com data de
 *     referência mais velha que `minAgeDays`, fora do É IA? (a menos de
 *     `includeEia`) e nunca uma key sem data derivável. Antes de remover
 *     qualquer coisa, confere que os Workers servem, do R2, os dois
 *     objetos-canário que só existem lá (`img/kv/…` e `img/{AAMMDD}/…`). Logo
 *     depois de cada remoção pede `/img/{key}` aos Workers (200 com os mesmos
 *     bytes); no fim da rodada espera o cache de borda do KV vencer (≥ 70 s) e
 *     pede de novo, agora exigindo `X-Image-Source: r2`. Qualquer falha devolve
 *     a key ao KV (com releitura) e interrompe a rodada.
 *
 * Chaves do jogo nunca entram: a varredura lista só o prefixo `img-` e passa
 * cada key por `isPublicImageKey` (allowlist do #4112, sem `:`), antes de
 * qualquer leitura de valor.
 *
 * Todo I/O é injetado (`KvReader`/`KvPruner`, `R2ArchiveStore`,
 * `ServedFetch`): os testes rodam sem rede, e os CLIs
 * (`scripts/archive-kv-public-images.ts`, `scripts/prune-kv-public-images.ts`)
 * montam os adaptadores reais. O arquivo recebe só `KvReader` (sem `delete`
 * nem `put`). Os dois CLIs são dry-run por padrão; só `--apply` escreve.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteTextFromWorkerKV,
  getBinaryFromWorkerKV,
  listWorkerKVKeys,
  putBinaryToWorkerKV,
  type CloudflareKVConfig,
} from "./cloudflare-kv-upload.ts";
import {
  etagMatchesBody,
  loadR2UploadConfig,
  signedR2Request,
  R2_PUT_TIMEOUT_MS,
  type R2BucketAccess,
  type R2UploadDeps,
} from "./r2-object-upload.ts";
import { readPublicImagesR2Settings, type PublicImagesR2Settings } from "./public-images-r2.ts";
import { logEvent, type RunLogEvent } from "./run-log.ts";
import {
  IMAGE_SOURCE_HEADER,
  imageCacheControlFor,
  isContentAddressedImageKey,
  isPublicImageKey,
  r2ArchiveKeyForImageKey,
} from "./shared/kv-image.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Prefixo listado no KV: toda key de imagem do pipeline começa assim (#4112). */
export const PUBLIC_IMAGE_KV_PREFIX = "img-";

/**
 * Objetos-canário: só existem no R2, nunca no KV. `GET /img/{canário}` com
 * 200, estes bytes e `X-Image-Source: r2` prova que o Worker tem o binding
 * `MEDIA`, o fallback do caminho correspondente e o header de origem no ar.
 * São dois porque o fallback tem dois caminhos: `img/kv/{key}` (semanal,
 * Retrospectiva) e `img/{AAMMDD}/…` (keys datadas). `archiveKvImages --apply`
 * grava os dois; `pruneKvImages` exige os dois.
 */
export const KV_ARCHIVE_CANARY_KEY = "img-kv-archive-canary.txt";
export const KV_ARCHIVE_DATED_CANARY_KEY = "img-260101-kv-archive-canary.txt";
export const KV_ARCHIVE_CANARY_KEYS: readonly string[] = [KV_ARCHIVE_CANARY_KEY, KV_ARCHIVE_DATED_CANARY_KEY];
export const KV_ARCHIVE_CANARY_BODY = new TextEncoder().encode("diar.ia.br: canario do arquivo KV->R2 (#11412)\n");

/** Defaults dos CLIs. Gradual de propósito. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB por rodada
export const DEFAULT_PRUNE_MIN_AGE_DAYS = 90;
export const DEFAULT_PRUNE_LIMIT = 50;
/** Espera antes da re-conferência final da poda: o cache de borda do KV dura até ~60 s. */
export const DEFAULT_PRUNE_SETTLE_MS = 70_000;

// ─── Puro ──────────────────────────────────────────────────────────────────

const md5Hex = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && md5Hex(a) === md5Hex(b);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `Content-Type` do objeto no R2, pela extensão. Sem extensão conhecida → `image/jpeg` (o que o KV sempre serviu). */
export function contentTypeForImageKey(key: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "image/jpeg";
  }
}

/**
 * Imagem do É IA? (convenção fixa, `noCacheBust`, que `/vote`, `/jogar` e o
 * embed montam): `img-{AAMMDD}-01-eia-{A|B|real|ia}.jpg`, mais o typo legado
 * `01-eai-`. A poda deixa estas no KV por padrão.
 */
export function isEiaConventionKey(key: string): boolean {
  return /-01-e(ia|ai)-(A|B|real|ia)\.jpg$/.test(key);
}

function utcDate(yy: string, mm: string, dd: string): Date | null {
  const y = 2000 + Number(yy);
  const m = Number(mm);
  const d = Number(dd);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Data de referência da key, para a idade mínima da poda. `null` = não dá
 * para saber (a key nunca é podada):
 *   - `img-{AAMMDD}-…` → o AAMMDD;
 *   - `img-unknown-weekly-{AAMMDD}-…` (carrossel semanal) → o sábado;
 *   - `img-{AAMM}-{MM}-…` (ciclo da Retrospectiva/mensal) → 1º dia do mês
 *     seguinte ao 2º mês do ciclo (conservador: a key parece mais nova). Só
 *     vale quando o 2º mês é o seguinte do 1º (`2606-07`, `2612-01`): uma key
 *     `img-{AAMM}-{NN}-…` em que `NN` é outra coisa (índice de uma key mensal
 *     legada) fica sem data.
 */
export function imageKeyReferenceDate(key: string): Date | null {
  let m = /^img-(\d{2})(\d{2})(\d{2})-/.exec(key) ?? /^img-unknown-weekly-(\d{2})(\d{2})(\d{2})-/.exec(key);
  if (m) return utcDate(m[1], m[2], m[3]);
  m = /^img-(\d{2})(\d{2})-(\d{2})-/.exec(key);
  if (m) {
    const m1 = Number(m[2]);
    const m2 = Number(m[3]);
    if (m1 < 1 || m1 > 12 || m2 !== (m1 % 12) + 1) return null;
    const year = 2000 + Number(m[1]) + (m2 < m1 ? 1 : 0);
    return new Date(Date.UTC(year, m2, 1)); // mês m2 (1-based) + 1
  }
  return null;
}

// ─── I/O injetado ──────────────────────────────────────────────────────────

/** Só leitura do KV: é tudo o que o arquivo (fatia 3) recebe. */
export interface KvReader {
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Uint8Array | null>;
}

/** Leitura + remoção do KV, para a poda (fatia 4). `put` só desfaz uma remoção. */
export interface KvPruner extends KvReader {
  delete(key: string): Promise<void>;
  put(key: string, body: Uint8Array): Promise<void>;
}

export interface R2ObjectInfo {
  /** `-1` quando o HEAD não trouxe `content-length` (nunca casa com nada). */
  size: number;
  etag: string | null;
}

export interface R2ArchiveStore {
  head(key: string): Promise<R2ObjectInfo | null>;
  put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
}

/** GET numa URL pública; devolve status, corpo e o header `X-Image-Source` (`kv`/`r2`, `null` sem o header). */
export type ServedFetch = (url: string) => Promise<{ status: number; body: Uint8Array; source?: string | null }>;

/**
 * A cópia no R2 é exatamente estes bytes? Tamanho conhecido e igual + ETag
 * MD5 forte (PUT simples) igual ao MD5 dos bytes. ETag fraco (`W/`), de
 * multipart (`…-N`) ou ausente nunca confere.
 */
export function r2CopyMatches(info: R2ObjectInfo | null, bytes: Uint8Array): boolean {
  if (!info || info.size < 0 || info.size !== bytes.length) return false;
  if (!info.etag || /^W\//i.test(info.etag.trim())) return false;
  return etagMatchesBody(info.etag, Buffer.from(bytes));
}

/** O HEAD tem a forma de um PUT simples (tamanho + ETag MD5 forte)? Só então a presença de uma key com hash basta. */
function looksLikeSimplePut(info: R2ObjectInfo): boolean {
  return info.size >= 0 && !!info.etag && /^"?[0-9a-f]{32}"?$/i.test(info.etag.trim());
}

async function putAndVerify(r2: R2ArchiveStore, r2Key: string, key: string, bytes: Uint8Array): Promise<void> {
  await r2.put(r2Key, bytes, contentTypeForImageKey(key), imageCacheControlFor(key));
  const after = await r2.head(r2Key);
  if (!r2CopyMatches(after, bytes)) {
    throw new Error(`cópia em ${r2Key} não confere depois do PUT (HEAD: ${after ? `${after.size} bytes, ETag ${after.etag}` : "ausente"})`);
  }
}

function tally<O extends string>(entries: readonly { outcome: O }[]): Partial<Record<O, number>> {
  const totals: Partial<Record<O, number>> = {};
  for (const e of entries) totals[e.outcome] = (totals[e.outcome] ?? 0) + 1;
  return totals;
}

// ─── Fatia 3: arquivo durável ──────────────────────────────────────────────

export type ArchiveOutcome =
  | "already"
  | "would-copy"
  | "copied"
  | "stale-would-recopy"
  | "recopied"
  | "skipped-no-archive-key"
  | "missing-in-kv"
  | "deferred"
  | "too-large"
  | "error";

export interface ArchiveEntry {
  key: string;
  r2Key: string | null;
  outcome: ArchiveOutcome;
  bytes?: number;
  error?: string;
}

export interface ArchiveReport {
  mode: "dry-run" | "apply";
  listed: number;
  totals: Partial<Record<ArchiveOutcome, number>>;
  /** Bytes gravados no R2 nesta rodada (apply). */
  bytesCopied: number;
  /** Bytes a copiar (dry-run com `measure`; sem `measure` fica 0 e as `would-copy` vêm sem tamanho). */
  bytesPlanned: number;
  /** Estado dos dois canários, o pior deles (`error` > `would-write` > `written` > `present`). */
  canary?: "written" | "present" | "would-write" | "error";
  /** Causa do `canary: "error"` (key do R2 + mensagem). */
  canaryError?: string;
  entries: ArchiveEntry[];
}

export interface ArchiveOptions {
  apply: boolean;
  /** Teto de bytes copiados na rodada; o que passa vira `deferred` (próxima rodada). Objeto maior que o teto inteiro vira `too-large`. */
  maxBytes?: number;
  /** Teto de keys copiadas na rodada (só cópias reais contam); o resto vira `deferred`. */
  limit?: number;
  /** Dry-run: baixa do KV (só leitura) para somar o tamanho do que seria copiado. */
  measure?: boolean;
  /** Baixa e compara também as keys com hash já presentes no R2 (sem isso, a presença basta). */
  verify?: boolean;
}

/**
 * Copia para o R2 cada imagem pública do KV que ainda não tem cópia conferida.
 * Nunca escreve no KV (recebe só `KvReader`). Dry-run (padrão) só lê.
 *
 * Key content-addressed já presente no R2, com HEAD de PUT simples (tamanho +
 * ETag MD5), conta como `already` sem baixar (os bytes de uma key com hash
 * não mudam); com `verify`, ou com HEAD de outra forma, é baixada e comparada.
 * Key de convenção fixa (É IA?, cards semanais) presente no R2 é comparada
 * com o KV: cópia velha vira `stale-would-recopy`/`recopied`. O teto de keys
 * conta só cópias reais: depois dele, key sem cópia vira `deferred` sem ser
 * baixada, e key com cópia ainda é conferida. Objeto maior que `maxBytes`
 * vira `too-large` (nunca caberia numa rodada). Falha numa key vira `error`
 * e a rodada segue.
 */
export async function archiveKvImages(kv: KvReader, r2: R2ArchiveStore, opts: ArchiveOptions): Promise<ArchiveReport> {
  const maxBytes = opts.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const keys = (await kv.list(PUBLIC_IMAGE_KV_PREFIX)).filter((k) => k.startsWith(PUBLIC_IMAGE_KV_PREFIX) && isPublicImageKey(k)).sort();
  const report: ArchiveReport = { mode: opts.apply ? "apply" : "dry-run", listed: keys.length, totals: {}, bytesCopied: 0, bytesPlanned: 0, entries: [] };
  let copies = 0;
  const push = (e: ArchiveEntry) => report.entries.push(e);

  for (const key of keys) {
    const r2Key = r2ArchiveKeyForImageKey(key);
    if (!r2Key) {
      push({ key, r2Key, outcome: "skipped-no-archive-key" });
      continue;
    }
    try {
      const head = await r2.head(r2Key);
      if (head && isContentAddressedImageKey(key) && !opts.verify && looksLikeSimplePut(head)) {
        push({ key, r2Key, outcome: "already", bytes: head.size });
        continue;
      }
      if (!head && !opts.apply && !opts.measure) {
        push({ key, r2Key, outcome: "would-copy" });
        continue;
      }
      if (opts.apply && copies >= limit && !head) {
        push({ key, r2Key, outcome: "deferred" });
        continue;
      }
      const bytes = await kv.get(key);
      if (!bytes) {
        push({ key, r2Key, outcome: "missing-in-kv" });
        continue;
      }
      if (head && r2CopyMatches(head, bytes)) {
        push({ key, r2Key, outcome: "already", bytes: bytes.length });
        continue;
      }
      if (bytes.length > maxBytes) {
        push({ key, r2Key, outcome: "too-large", bytes: bytes.length, error: `${bytes.length} bytes > teto da rodada (${maxBytes}); rodar com --max-mb maior` });
        continue;
      }
      if (!opts.apply) {
        report.bytesPlanned += bytes.length;
        push({ key, r2Key, outcome: head ? "stale-would-recopy" : "would-copy", bytes: bytes.length });
        continue;
      }
      if (copies >= limit || report.bytesCopied + bytes.length > maxBytes) {
        push({ key, r2Key, outcome: "deferred", bytes: bytes.length });
        continue;
      }
      await putAndVerify(r2, r2Key, key, bytes);
      report.bytesCopied += bytes.length;
      copies++;
      push({ key, r2Key, outcome: head ? "recopied" : "copied", bytes: bytes.length });
    } catch (err) {
      push({ key, r2Key, outcome: "error", error: errMsg(err) });
    }
  }

  const states: Array<"written" | "present" | "would-write"> = [];
  for (const canaryKey of KV_ARCHIVE_CANARY_KEYS) {
    const canaryR2Key = r2ArchiveKeyForImageKey(canaryKey)!;
    try {
      const head = await r2.head(canaryR2Key);
      if (r2CopyMatches(head, KV_ARCHIVE_CANARY_BODY)) states.push("present");
      else if (!opts.apply) states.push("would-write");
      else {
        await putAndVerify(r2, canaryR2Key, canaryKey, KV_ARCHIVE_CANARY_BODY);
        states.push("written");
      }
    } catch (err) {
      report.canary = "error";
      report.canaryError = `${canaryR2Key}: ${errMsg(err)}`;
      break;
    }
  }
  if (!report.canary) {
    report.canary = states.includes("would-write") ? "would-write" : states.includes("written") ? "written" : "present";
  }
  report.totals = tally(report.entries);
  return report;
}

// ─── Fatia 4: poda gradual ─────────────────────────────────────────────────

export type PruneOutcome =
  | "kept-no-archive-key"
  | "kept-no-date"
  | "kept-too-recent"
  | "kept-eia"
  | "kept-limit"
  | "kept-not-archived"
  | "kept-archive-mismatch"
  | "kept-kv-changed"
  | "missing-in-kv"
  | "would-delete"
  /** Removida e servida logo depois, ainda sem a re-conferência final (só aparece se a rodada for cortada no meio). */
  | "deleted-unverified"
  | "deleted"
  | "restored"
  | "error";

export interface PruneEntry {
  key: string;
  r2Key: string | null;
  outcome: PruneOutcome;
  bytes?: number;
  detail?: string;
}

export interface CanaryCheck {
  url: string;
  ok: boolean;
  detail?: string;
}

export interface PruneReport {
  mode: "dry-run" | "apply";
  listed: number;
  totals: Partial<Record<PruneOutcome, number>>;
  canary: CanaryCheck[];
  /**
   * Rodada interrompida: canário falhou (nada removido), uma remoção não foi
   * servida do R2 e foi desfeita, a restauração no KV falhou, ou um DELETE
   * deu erro (removido ou não).
   */
  aborted?: string;
  bytesFreed: number;
  entries: PruneEntry[];
}

export interface PruneOptions {
  apply: boolean;
  now: Date;
  /** Origens dos Workers que servem `/img/` (ex.: `https://eia.diar.ia.br`, `https://diar.ia.br`). */
  workerOrigins: readonly string[];
  minAgeDays?: number;
  /** Teto de keys conferidas por rodada; com `apply`, `deleted ≤ limit`. */
  limit?: number;
  /** Também poda as imagens do É IA? (convenção fixa). Default: não. */
  includeEia?: boolean;
  /** Espera antes da re-conferência final (default `DEFAULT_PRUNE_SETTLE_MS`). */
  settleMs?: number;
  /** Injetável no teste. */
  sleep?: (ms: number) => Promise<void>;
}

const imgUrl = (origin: string, key: string, bust?: string) =>
  `${origin.replace(/\/+$/, "")}/img/${encodeURIComponent(key)}${bust ? `?kv-prune=${bust}` : ""}`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function servedMatches(served: ServedFetch, url: string, bytes: Uint8Array, requireR2: boolean): Promise<CanaryCheck> {
  try {
    const res = await served(url);
    if (res.status !== 200) return { url, ok: false, detail: `HTTP ${res.status}` };
    if (!sameBytes(res.body, bytes)) return { url, ok: false, detail: `corpo com ${res.body.length} bytes não confere (esperado ${bytes.length})` };
    if (requireR2 && res.source !== "r2") {
      return { url, ok: false, detail: res.source ? `servido de "${res.source}", não do R2` : `sem o header ${IMAGE_SOURCE_HEADER} (Worker sem o deploy do #11412 fatia 4)` };
    }
    return { url, ok: true };
  } catch (err) {
    return { url, ok: false, detail: `GET falhou: ${errMsg(err)}` };
  }
}

/** Devolve a key ao KV e relê; só conta como restaurada se a releitura trouxer os mesmos bytes. */
async function restoreToKv(kv: KvPruner, key: string, bytes: Uint8Array): Promise<string | null> {
  try {
    await kv.put(key, bytes);
    const back = await kv.get(key);
    if (back && sameBytes(back, bytes)) return null;
    return back ? `releitura trouxe ${back.length} bytes que não conferem` : "releitura não achou a key";
  } catch (err) {
    return errMsg(err);
  }
}

/**
 * Poda gradual do KV. Ordem de cada key, do mais barato ao mais caro:
 * forma de arquivo → É IA? → data derivável → idade → teto da rodada → bytes
 * do KV contra a cópia no R2. Só `would-delete` (dry-run) ou `deleted`
 * (apply) passaram por tudo.
 *
 * Com `apply`:
 *   1. os dois canários, em cada Worker, têm que vir 200 com os bytes certos
 *      e `X-Image-Source: r2` (falhou → nada é removido);
 *   2. o KV é relido logo antes do DELETE e tem que trazer os mesmos bytes;
 *   3. DELETE com erro: o KV é relido; se a key sumiu, segue a conferência
 *      normal, senão a key é regravada; nos dois casos a rodada para;
 *   4. logo depois da remoção, `/img/{key}` em cada Worker tem que vir 200
 *      com os mesmos bytes, e a key fica `deleted-unverified`;
 *   5. no fim, depois de `settleMs` (o cache de borda do KV ainda pode servir
 *      o valor removido), cada key é pedida de novo e tem que vir do R2.
 * Falha em 4 ou 5 devolve a key ao KV, relê para conferir (`restored`, ou
 * `error` com "RESTAURAR FALHOU" e a key do R2) e interrompe a rodada.
 */
export async function pruneKvImages(kv: KvPruner, r2: R2ArchiveStore, served: ServedFetch, opts: PruneOptions): Promise<PruneReport> {
  const minAgeDays = opts.minAgeDays ?? DEFAULT_PRUNE_MIN_AGE_DAYS;
  const limit = opts.limit ?? DEFAULT_PRUNE_LIMIT;
  const settleMs = opts.settleMs ?? DEFAULT_PRUNE_SETTLE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const cutoff = opts.now.getTime() - minAgeDays * 86_400_000;
  const report: PruneReport = { mode: opts.apply ? "apply" : "dry-run", listed: 0, totals: {}, canary: [], bytesFreed: 0, entries: [] };
  const push = (e: PruneEntry) => report.entries.push(e);
  const abort = (msg: string) => {
    report.aborted = report.aborted ? `${report.aborted} | ${msg}` : msg;
  };
  const finish = () => {
    report.totals = tally(report.entries);
    return report;
  };

  if (opts.workerOrigins.length === 0) throw new Error("pruneKvImages: workerOrigins vazio — sem Worker para conferir, nada é podado");
  for (const origin of opts.workerOrigins) {
    for (const canaryKey of KV_ARCHIVE_CANARY_KEYS) {
      report.canary.push(await servedMatches(served, imgUrl(origin, canaryKey), KV_ARCHIVE_CANARY_BODY, true));
    }
  }
  if (opts.apply && !report.canary.every((c) => c.ok)) {
    abort(
      "canários do R2 não são servidos do R2 por todos os Workers (binding MEDIA, fallback img/kv/ ou img/{AAMMDD}/, header X-Image-Source fora do ar, ou archive --apply ainda não gravou os canários): nada removido",
    );
    return finish();
  }

  const keys = (await kv.list(PUBLIC_IMAGE_KV_PREFIX)).filter((k) => k.startsWith(PUBLIC_IMAGE_KV_PREFIX) && isPublicImageKey(k)).sort();
  report.listed = keys.length;
  let checked = 0;
  const bust = String(opts.now.getTime());
  const pending: Array<{ entry: PruneEntry; bytes: Uint8Array }> = [];

  /** Falha de conferência depois do DELETE: devolve a key ao KV e interrompe. */
  const undo = async (entry: PruneEntry, bytes: Uint8Array, why: string) => {
    const restoreError = await restoreToKv(kv, entry.key, bytes);
    if (restoreError === null) {
      entry.outcome = "restored";
      entry.detail = why;
      abort(`/img/${entry.key} não foi servido do R2 depois da remoção (${why}); key devolvida ao KV, rodada interrompida`);
    } else {
      entry.outcome = "error";
      entry.detail = `${why}; RESTAURAR FALHOU: ${restoreError}; a cópia está em ${entry.r2Key} no R2`;
      abort(`/img/${entry.key} não foi servido do R2 depois da remoção E a restauração no KV falhou (${restoreError}) — a cópia está em ${entry.r2Key} no R2; restaurar à mão`);
    }
  };

  const checkAll = async (key: string, bytes: Uint8Array, tag: string, requireR2: boolean) => {
    const checks: CanaryCheck[] = [];
    for (const origin of opts.workerOrigins) checks.push(await servedMatches(served, imgUrl(origin, key, `${bust}-${tag}`), bytes, requireR2));
    return checks.filter((c) => !c.ok).map((c) => `${c.url}: ${c.detail}`).join("; ");
  };

  for (const key of keys) {
    if (report.aborted) break;
    const r2Key = r2ArchiveKeyForImageKey(key);
    if (!r2Key) {
      push({ key, r2Key, outcome: "kept-no-archive-key" });
      continue;
    }
    if (KV_ARCHIVE_CANARY_KEYS.includes(key)) continue; // nunca deveria estar no KV
    if (isEiaConventionKey(key) && !opts.includeEia) {
      push({ key, r2Key, outcome: "kept-eia" });
      continue;
    }
    const ref = imageKeyReferenceDate(key);
    if (!ref) {
      push({ key, r2Key, outcome: "kept-no-date" });
      continue;
    }
    if (ref.getTime() > cutoff) {
      push({ key, r2Key, outcome: "kept-too-recent" });
      continue;
    }
    if (checked >= limit) {
      push({ key, r2Key, outcome: "kept-limit" });
      continue;
    }
    checked++;
    let bytes: Uint8Array | null;
    try {
      bytes = await kv.get(key);
      if (!bytes) {
        push({ key, r2Key, outcome: "missing-in-kv" });
        continue;
      }
      const head = await r2.head(r2Key);
      if (!head) {
        push({ key, r2Key, outcome: "kept-not-archived", bytes: bytes.length });
        continue;
      }
      if (!r2CopyMatches(head, bytes)) {
        push({ key, r2Key, outcome: "kept-archive-mismatch", bytes: bytes.length, detail: `R2 ${head.size} bytes, ETag ${head.etag}; KV ${bytes.length} bytes` });
        continue;
      }
    } catch (err) {
      push({ key, r2Key, outcome: "error", detail: errMsg(err) });
      continue;
    }
    if (!opts.apply) {
      push({ key, r2Key, outcome: "would-delete", bytes: bytes.length });
      continue;
    }

    // Relê logo antes do DELETE: a key pode ter sido regravada desde a conferência.
    try {
      const again = await kv.get(key);
      if (!again || !sameBytes(again, bytes)) {
        push({ key, r2Key, outcome: "kept-kv-changed", bytes: bytes.length, detail: again ? `KV mudou para ${again.length} bytes desde a conferência` : "a key sumiu do KV desde a conferência" });
        continue;
      }
    } catch (err) {
      push({ key, r2Key, outcome: "error", detail: `releitura antes do DELETE falhou: ${errMsg(err)}` });
      continue;
    }

    let deleteError: string | undefined;
    try {
      await kv.delete(key);
    } catch (err) {
      deleteError = errMsg(err);
      // Falha ambígua (timeout/5xx com a remoção aplicada): relê o KV.
      let still: Uint8Array | null | undefined;
      try {
        still = await kv.get(key);
      } catch {
        still = undefined;
      }
      if (still !== null) {
        // A key segue no KV: nada a desfazer. Sem releitura (`undefined`), não
        // dá para saber se saiu: regrava os mesmos bytes, por garantia.
        const restoreError = still === undefined ? await restoreToKv(kv, key, bytes) : null;
        const tail = still !== undefined ? "; a key segue no KV" : restoreError ? `; releitura falhou e RESTAURAR FALHOU: ${restoreError}; a cópia está em ${r2Key} no R2` : "; releitura falhou, key regravada no KV";
        push({ key, r2Key, outcome: "error", bytes: bytes.length, detail: `DELETE falhou: ${deleteError}${tail}` });
        abort(`DELETE de ${key} falhou (${deleteError}); rodada interrompida${restoreError ? ` — a restauração no KV falhou, a cópia está em ${r2Key} no R2; conferir à mão` : ""}`);
        continue;
      }
    }

    const entry: PruneEntry = {
      key,
      r2Key,
      outcome: "deleted-unverified",
      bytes: bytes.length,
      detail: deleteError ? `DELETE devolveu erro (${deleteError}), mas a key saiu do KV` : undefined,
    };
    push(entry);
    const why = await checkAll(key, bytes, "0", false);
    if (why) await undo(entry, bytes, why);
    else pending.push({ entry, bytes });
    if (deleteError) abort(`DELETE de ${key} devolveu erro (${deleteError}) com a remoção aplicada; rodada interrompida`);
  }

  // Re-conferência final: depois do cache de borda do KV vencer, cada key
  // removida tem que vir do R2, nos dois Workers.
  if (pending.length > 0) {
    await sleep(settleMs);
    for (const { entry, bytes } of pending) {
      const why = await checkAll(entry.key, bytes, "final", true);
      if (why) {
        await undo(entry, bytes, why);
        continue;
      }
      entry.outcome = "deleted";
      report.bytesFreed += bytes.length;
    }
  }
  return finish();
}

// ─── Fatia 3, na geração: cópia no R2 junto do upload pro KV ───────────────

export type UploadArchiveResult = { status: "archived"; r2Key: string } | { status: "skipped"; reason: string } | { status: "failed"; error: string };

/**
 * Grava no R2 a cópia durável de uma imagem que acabou de subir pro KV
 * (cards e PDF do carrossel semanal, imagens do mensal/Retrospectiva, card
 * sob demanda). Nunca lança: o upload pro KV já deu certo, e a cópia é rede
 * de segurança (`archive-kv-public-images.ts` completa o que faltar). Fica
 * atrás da mesma flag da fatia 1 (`public_images_r2.enabled`).
 */
export async function archiveUploadedImageToR2(input: {
  body: Uint8Array;
  kvKey: string;
  settings: PublicImagesR2Settings;
  env: Record<string, string | undefined>;
  store?: R2ArchiveStore;
  deps?: R2UploadDeps;
}): Promise<UploadArchiveResult> {
  if (!input.settings.enabled) return { status: "skipped", reason: "public_images_r2.enabled desligada" };
  const r2Key = r2ArchiveKeyForImageKey(input.kvKey);
  if (!r2Key) return { status: "skipped", reason: `key "${input.kvKey}" fora da allowlist de /img/` };
  let store = input.store;
  if (!store) {
    const cfg = loadR2UploadConfig(input.env);
    if (!cfg.ready) return { status: "skipped", reason: `env do R2 incompleto (${cfg.missing.join(", ")})` };
    store = makeR2ArchiveStore(input.deps ?? defaultR2Deps(), cfg.config);
  }
  try {
    await putAndVerify(store, r2Key, input.kvKey, input.body);
    return { status: "archived", r2Key };
  } catch (err) {
    return { status: "failed", error: errMsg(err) };
  }
}

export interface UploadedFileArchiveDeps {
  env?: Record<string, string | undefined>;
  store?: R2ArchiveStore;
  warn?: (msg: string) => void;
  log?: (event: RunLogEvent) => void;
}

/**
 * Wrapper de produção: lê a flag, o arquivo e o env. Com a flag ligada, todo
 * resultado que não seja `archived` (falha do R2, env incompleto, key fora da
 * allowlist, erro lendo arquivo/config) vira aviso no stderr E evento `warn`
 * no `data/run-log.jsonl`; com a flag desligada, silêncio. Nunca lança.
 */
export async function archiveUploadedFileToR2(filePath: string, kvKey: string, root: string = ROOT, deps: UploadedFileArchiveDeps = {}): Promise<UploadArchiveResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const log = deps.log ?? ((e: RunLogEvent) => void logEvent(e, root));
  let result: UploadArchiveResult;
  try {
    const settings = readPublicImagesR2Settings(JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8")));
    if (!settings.enabled) return { status: "skipped", reason: "public_images_r2.enabled desligada" };
    result = await archiveUploadedImageToR2({ body: readFileSync(filePath), kvKey, settings, env: deps.env ?? process.env, store: deps.store });
  } catch (err) {
    result = { status: "failed", error: `não rodou: ${errMsg(err)}` };
  }
  if (result.status !== "archived") {
    const why = result.status === "failed" ? result.error : result.reason;
    const message = `cópia de ${kvKey} no R2 ${result.status === "failed" ? "falhou" : "pulada"} (o KV segue com a imagem; archive-kv-public-images.ts completa depois, #11412): ${why}`;
    warn(`[public-images-archive] ${message}`);
    try {
      log({ edition: null, stage: null, agent: "public-images-archive", level: "warn", message, details: { kvKey, filePath, status: result.status, why } });
    } catch {
      // o log nunca derruba o upload
    }
  }
  return result;
}

// ─── Adaptadores reais (exercitados em teste com fetch stub) ───────────────

function defaultR2Deps(): R2UploadDeps {
  return { fetch: (u, i) => fetch(u, i), now: () => new Date() };
}

/** Só leitura (para o arquivo): o objeto nem tem `delete`/`put`. */
export function makeCloudflareKvReader(cfg: CloudflareKVConfig, fetchImpl: typeof fetch = fetch): KvReader {
  return {
    list: (prefix) => listWorkerKVKeys(prefix, cfg, fetchImpl),
    get: (key) => getBinaryFromWorkerKV(key, cfg, fetchImpl),
  };
}

export function makeCloudflareKvImageSource(cfg: CloudflareKVConfig, fetchImpl: typeof fetch = fetch): KvPruner {
  return {
    ...makeCloudflareKvReader(cfg, fetchImpl),
    delete: (key) => deleteTextFromWorkerKV(key, cfg, fetchImpl),
    put: (key, body) => putBinaryToWorkerKV(key, body, cfg, fetchImpl),
  };
}

/** R2 pela API S3 assinada (nunca pela URL pública, que pode ter cache). */
export function makeR2ArchiveStore(deps: R2UploadDeps, access: R2BucketAccess): R2ArchiveStore {
  return {
    async head(key) {
      const res = await signedR2Request(deps, access, "HEAD", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 HEAD ${key}: HTTP ${res.status}`);
      const len = res.headers.get("content-length");
      const size = len === null || !/^\d+$/.test(len) ? -1 : Number(len);
      return { size, etag: res.headers.get("etag") };
    },
    async put(key, body, contentType, cacheControl) {
      const res = await signedR2Request(deps, access, "PUT", key, {
        body: Buffer.from(body),
        headers: { "content-type": contentType, "cache-control": cacheControl },
        timeoutMs: R2_PUT_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`R2 PUT ${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      await res.body?.cancel().catch(() => {});
    },
  };
}

export function makeServedFetch(fetchImpl: typeof fetch = fetch): ServedFetch {
  return async (url) => {
    const res = await fetchImpl(url, { method: "GET", headers: { "User-Agent": "diaria-studio/public-images-archive" }, signal: AbortSignal.timeout(60_000) });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), source: res.headers.get(IMAGE_SOURCE_HEADER) };
  };
}
