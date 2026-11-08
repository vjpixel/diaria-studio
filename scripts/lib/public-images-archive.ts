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
 *     geração.
 *   - **Fatia 4, poda gradual.** `pruneKvImages` remove do KV só a key cuja
 *     cópia no R2 foi conferida AGORA contra os bytes do KV, com data de
 *     referência mais velha que `minAgeDays`, fora do É IA? (a menos de
 *     `includeEia`) e nunca uma key sem data derivável. Antes de remover
 *     qualquer coisa, confere que os Workers servem o objeto-canário que só
 *     existe no R2 (`img/kv/…`), prova de que o fallback do `/img/` está no
 *     ar; depois de cada remoção, pede `/img/{key}` aos Workers e, se a
 *     resposta não for 200 com os mesmos bytes, devolve a key ao KV e para.
 *
 * Chaves do jogo nunca entram: a varredura lista só o prefixo `img-` e passa
 * cada key por `isPublicImageKey` (allowlist do #4112, sem `:`).
 *
 * Todo I/O é injetado (`KvImageSource`, `R2ArchiveStore`, `ServedFetch`): os
 * testes rodam sem rede, e os CLIs (`scripts/archive-kv-public-images.ts`,
 * `scripts/prune-kv-public-images.ts`) montam os adaptadores reais com
 * `makeCloudflareKvImageSource`/`makeR2ArchiveStore`/`makeServedFetch`.
 * Os dois CLIs são dry-run por padrão; só `--apply` escreve.
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
import {
  imageCacheControlFor,
  isContentAddressedImageKey,
  isPublicImageKey,
  r2ArchiveKeyForImageKey,
} from "./shared/kv-image.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Prefixo listado no KV: toda key de imagem do pipeline começa assim (#4112). */
export const PUBLIC_IMAGE_KV_PREFIX = "img-";

/**
 * Objeto-canário: só existe no R2 (`img/kv/img-kv-archive-canary.txt`),
 * nunca no KV. `GET /img/img-kv-archive-canary.txt` com 200 e estes bytes
 * prova que o Worker tem o binding `MEDIA` E o fallback para `img/kv/` (desta
 * PR) no ar. `archiveKvImages --apply` grava; `pruneKvImages` exige.
 */
export const KV_ARCHIVE_CANARY_KEY = "img-kv-archive-canary.txt";
export const KV_ARCHIVE_CANARY_BODY = new TextEncoder().encode("diar.ia.br: canario do arquivo KV->R2 (#11412)\n");

/** Defaults dos CLIs. Gradual de propósito. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB por rodada
export const DEFAULT_PRUNE_MIN_AGE_DAYS = 90;
export const DEFAULT_PRUNE_LIMIT = 50;

// ─── Puro ──────────────────────────────────────────────────────────────────

const md5Hex = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && md5Hex(a) === md5Hex(b);

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
 *     seguinte ao 2º mês do ciclo (conservador: a key parece mais nova).
 */
export function imageKeyReferenceDate(key: string): Date | null {
  let m = /^img-(\d{2})(\d{2})(\d{2})-/.exec(key) ?? /^img-unknown-weekly-(\d{2})(\d{2})(\d{2})-/.exec(key);
  if (m) return utcDate(m[1], m[2], m[3]);
  m = /^img-(\d{2})(\d{2})-(\d{2})-/.exec(key);
  if (m) {
    const m1 = Number(m[2]);
    const m2 = Number(m[3]);
    if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) return null;
    const year = 2000 + Number(m[1]) + (m2 < m1 ? 1 : 0);
    return new Date(Date.UTC(year, m2, 1)); // mês m2 (1-based) + 1
  }
  return null;
}

// ─── I/O injetado ──────────────────────────────────────────────────────────

export interface KvImageSource {
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Só para desfazer uma remoção (poda). */
  put(key: string, body: Uint8Array): Promise<void>;
}

export interface R2ObjectInfo {
  size: number;
  etag: string | null;
}

export interface R2ArchiveStore {
  head(key: string): Promise<R2ObjectInfo | null>;
  put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
}

/** GET numa URL pública; devolve status e corpo. */
export type ServedFetch = (url: string) => Promise<{ status: number; body: Uint8Array }>;

/** A cópia no R2 é exatamente estes bytes? Tamanho + ETag MD5 (PUT simples). */
export function r2CopyMatches(info: R2ObjectInfo | null, bytes: Uint8Array): boolean {
  return info !== null && info.size === bytes.length && etagMatchesBody(info.etag, Buffer.from(bytes));
}

async function putAndVerify(r2: R2ArchiveStore, r2Key: string, key: string, bytes: Uint8Array): Promise<void> {
  await r2.put(r2Key, bytes, contentTypeForImageKey(key), imageCacheControlFor(key));
  const after = await r2.head(r2Key);
  if (!r2CopyMatches(after, bytes)) {
    throw new Error(`cópia em ${r2Key} não confere depois do PUT (HEAD: ${after ? `${after.size} bytes, ETag ${after.etag}` : "ausente"})`);
  }
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
  canary?: "written" | "present" | "would-write" | "error";
  entries: ArchiveEntry[];
}

export interface ArchiveOptions {
  apply: boolean;
  /** Teto de bytes copiados na rodada; o que passa vira `deferred` (próxima rodada). */
  maxBytes?: number;
  /** Teto de keys copiadas na rodada; o resto vira `deferred`. */
  limit?: number;
  /** Dry-run: baixa do KV (só leitura) para somar o tamanho do que seria copiado. */
  measure?: boolean;
}

/**
 * Copia para o R2 cada imagem pública do KV que ainda não tem cópia conferida.
 * Nunca escreve no KV. Dry-run (padrão) só lê.
 *
 * Key content-addressed já presente no R2 conta como `already` sem baixar
 * (os bytes de uma key com hash não mudam). Key de convenção fixa (É IA?,
 * cards semanais) presente no R2 é comparada com o KV: cópia velha vira
 * `stale-would-recopy`/`recopied`. Falha numa key vira `error` e a rodada
 * segue.
 */
export async function archiveKvImages(kv: KvImageSource, r2: R2ArchiveStore, opts: ArchiveOptions): Promise<ArchiveReport> {
  const maxBytes = opts.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const keys = (await kv.list(PUBLIC_IMAGE_KV_PREFIX)).filter((k) => k.startsWith(PUBLIC_IMAGE_KV_PREFIX) && isPublicImageKey(k)).sort();
  const report: ArchiveReport = { mode: opts.apply ? "apply" : "dry-run", listed: keys.length, totals: {}, bytesCopied: 0, bytesPlanned: 0, entries: [] };
  let copies = 0;
  const push = (e: ArchiveEntry) => {
    report.entries.push(e);
    report.totals[e.outcome] = (report.totals[e.outcome] ?? 0) + 1;
  };

  for (const key of keys) {
    const r2Key = r2ArchiveKeyForImageKey(key);
    if (!r2Key) {
      push({ key, r2Key, outcome: "skipped-no-archive-key" });
      continue;
    }
    try {
      const head = await r2.head(r2Key);
      if (head && isContentAddressedImageKey(key)) {
        push({ key, r2Key, outcome: "already", bytes: head.size });
        continue;
      }
      if (!head && !opts.apply && !opts.measure) {
        push({ key, r2Key, outcome: "would-copy" });
        continue;
      }
      if (opts.apply && copies >= limit) {
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
      if (!opts.apply) {
        report.bytesPlanned += bytes.length;
        push({ key, r2Key, outcome: head ? "stale-would-recopy" : "would-copy", bytes: bytes.length });
        continue;
      }
      if (report.bytesCopied + bytes.length > maxBytes) {
        push({ key, r2Key, outcome: "deferred", bytes: bytes.length });
        continue;
      }
      await putAndVerify(r2, r2Key, key, bytes);
      report.bytesCopied += bytes.length;
      copies++;
      push({ key, r2Key, outcome: head ? "recopied" : "copied", bytes: bytes.length });
    } catch (err) {
      push({ key, r2Key, outcome: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const canaryR2Key = r2ArchiveKeyForImageKey(KV_ARCHIVE_CANARY_KEY)!;
  try {
    const head = await r2.head(canaryR2Key);
    if (r2CopyMatches(head, KV_ARCHIVE_CANARY_BODY)) report.canary = "present";
    else if (!opts.apply) report.canary = "would-write";
    else {
      await putAndVerify(r2, canaryR2Key, KV_ARCHIVE_CANARY_KEY, KV_ARCHIVE_CANARY_BODY);
      report.canary = "written";
    }
  } catch {
    report.canary = "error";
  }
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
  | "missing-in-kv"
  | "would-delete"
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
  /** Rodada interrompida: canário falhou (nada removido) ou uma remoção foi desfeita. */
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
  /** Teto de keys conferidas (e, com `apply`, removidas) por rodada. */
  limit?: number;
  /** Também poda as imagens do É IA? (convenção fixa). Default: não. */
  includeEia?: boolean;
}

const imgUrl = (origin: string, key: string, bust?: string) =>
  `${origin.replace(/\/+$/, "")}/img/${encodeURIComponent(key)}${bust ? `?kv-prune=${bust}` : ""}`;

async function servedMatches(served: ServedFetch, url: string, bytes: Uint8Array): Promise<CanaryCheck> {
  try {
    const res = await served(url);
    if (res.status !== 200) return { url, ok: false, detail: `HTTP ${res.status}` };
    if (!sameBytes(res.body, bytes)) return { url, ok: false, detail: `corpo com ${res.body.length} bytes não confere (esperado ${bytes.length})` };
    return { url, ok: true };
  } catch (err) {
    return { url, ok: false, detail: `GET falhou: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Poda gradual do KV. Ordem de cada key, do mais barato ao mais caro:
 * forma de arquivo → É IA? → data derivável → idade → teto da rodada → bytes
 * do KV contra a cópia no R2. Só `would-delete` (dry-run) ou `deleted`
 * (apply) passaram por tudo.
 *
 * Com `apply`: canário nos Workers antes de qualquer remoção (falhou → nada
 * é removido); depois de cada remoção, `/img/{key}` em cada Worker tem que
 * devolver 200 com os mesmos bytes, senão a key volta ao KV (`restored`) e a
 * rodada para. Ressalva: o KV é eventualmente consistente, e logo depois do
 * DELETE o Worker ainda pode ler o valor do cache do KV; por isso o canário
 * (objeto que nunca esteve no KV) é a prova de que o fallback existe, e a
 * conferência pós-remoção é a segunda rede.
 */
export async function pruneKvImages(kv: KvImageSource, r2: R2ArchiveStore, served: ServedFetch, opts: PruneOptions): Promise<PruneReport> {
  const minAgeDays = opts.minAgeDays ?? DEFAULT_PRUNE_MIN_AGE_DAYS;
  const limit = opts.limit ?? DEFAULT_PRUNE_LIMIT;
  const cutoff = opts.now.getTime() - minAgeDays * 86_400_000;
  const report: PruneReport = { mode: opts.apply ? "apply" : "dry-run", listed: 0, totals: {}, canary: [], bytesFreed: 0, entries: [] };
  const push = (e: PruneEntry) => {
    report.entries.push(e);
    report.totals[e.outcome] = (report.totals[e.outcome] ?? 0) + 1;
  };

  if (opts.workerOrigins.length === 0) throw new Error("pruneKvImages: workerOrigins vazio — sem Worker para conferir, nada é podado");
  for (const origin of opts.workerOrigins) {
    report.canary.push(await servedMatches(served, imgUrl(origin, KV_ARCHIVE_CANARY_KEY), KV_ARCHIVE_CANARY_BODY));
  }
  const canaryOk = report.canary.every((c) => c.ok);
  if (opts.apply && !canaryOk) {
    report.aborted = "canário do R2 não é servido por todos os Workers (binding MEDIA ou fallback img/kv/ fora do ar, ou archive --apply ainda não gravou o canário): nada removido";
    return report;
  }

  const keys = (await kv.list(PUBLIC_IMAGE_KV_PREFIX)).filter((k) => k.startsWith(PUBLIC_IMAGE_KV_PREFIX) && isPublicImageKey(k)).sort();
  report.listed = keys.length;
  let checked = 0;

  for (const key of keys) {
    if (report.aborted) break;
    const r2Key = r2ArchiveKeyForImageKey(key);
    if (!r2Key) {
      push({ key, r2Key, outcome: "kept-no-archive-key" });
      continue;
    }
    if (key === KV_ARCHIVE_CANARY_KEY) continue; // nunca deveria estar no KV
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
      push({ key, r2Key, outcome: "error", detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!opts.apply) {
      push({ key, r2Key, outcome: "would-delete", bytes: bytes.length });
      continue;
    }

    try {
      await kv.delete(key);
    } catch (err) {
      push({ key, r2Key, outcome: "error", detail: `DELETE falhou: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const bust = String(opts.now.getTime());
    const checks: CanaryCheck[] = [];
    for (const origin of opts.workerOrigins) checks.push(await servedMatches(served, imgUrl(origin, key, bust), bytes));
    const failed = checks.filter((c) => !c.ok);
    if (failed.length === 0) {
      report.bytesFreed += bytes.length;
      push({ key, r2Key, outcome: "deleted", bytes: bytes.length });
      continue;
    }
    const why = failed.map((c) => `${c.url}: ${c.detail}`).join("; ");
    try {
      await kv.put(key, bytes);
      push({ key, r2Key, outcome: "restored", bytes: bytes.length, detail: why });
      report.aborted = `/img/${key} não foi servido depois da remoção (${why}); key devolvida ao KV, rodada interrompida`;
    } catch (err) {
      push({ key, r2Key, outcome: "error", bytes: bytes.length, detail: `${why}; RESTAURAR FALHOU: ${err instanceof Error ? err.message : String(err)}` });
      report.aborted = `/img/${key} não foi servido depois da remoção E a restauração no KV falhou — a cópia está em ${r2Key} no R2; restaurar à mão`;
    }
  }
  return report;
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
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wrapper de produção: lê o arquivo, a flag e o env. Avisa em falha; nunca lança. */
export async function archiveUploadedFileToR2(filePath: string, kvKey: string, root: string = ROOT): Promise<UploadArchiveResult> {
  try {
    const cfg = JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8"));
    const result = await archiveUploadedImageToR2({
      body: readFileSync(filePath),
      kvKey,
      settings: readPublicImagesR2Settings(cfg),
      env: process.env,
    });
    if (result.status === "failed") {
      console.warn(`[public-images-archive] cópia de ${kvKey} no R2 falhou (o KV segue com a imagem; archive-kv-public-images.ts completa depois, #11412): ${result.error}`);
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[public-images-archive] cópia de ${kvKey} no R2 não rodou (#11412): ${error}`);
    return { status: "failed", error };
  }
}

// ─── Adaptadores reais (nunca exercitados em teste com rede) ───────────────

function defaultR2Deps(): R2UploadDeps {
  return { fetch: (u, i) => fetch(u, i), now: () => new Date() };
}

export function makeCloudflareKvImageSource(cfg: CloudflareKVConfig, fetchImpl: typeof fetch = fetch): KvImageSource {
  return {
    list: (prefix) => listWorkerKVKeys(prefix, cfg, fetchImpl),
    get: (key) => getBinaryFromWorkerKV(key, cfg, fetchImpl),
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
      return { size: len === null ? -1 : Number(len), etag: res.headers.get("etag") };
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
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  };
}
