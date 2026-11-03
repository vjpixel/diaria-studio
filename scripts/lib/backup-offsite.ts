/**
 * backup-offsite.ts (#11413)
 *
 * Cópia off-site, compactada e criptografada, dos backups que hoje vivem só
 * no OneDrive (`data/`): o snapshot semanal da Beehiiv
 * (`data/beehiiv-backup/{AAAA-MM-DD}/`, `scripts/backup-beehiiv.ts`) e o dump
 * dos votos do É IA? (KV `POLL` do Worker `workers/poll`).
 *
 * Destino: bucket R2 PRIVADO `diaria-backup` (sem r2.dev, sem domínio), com
 * lifecycle `retencao-8-semanas` (apaga após 56 dias) configurado no painel.
 * Credencial própria, restrita a esse bucket (`R2_BACKUP_ACCESS_KEY_ID`/
 * `R2_BACKUP_SECRET_ACCESS_KEY`) — nunca as `R2_ACCESS_KEY_ID`/
 * `R2_SECRET_ACCESS_KEY` dos shorts — e nenhuma URL pública: toda leitura,
 * inclusive a conferência pós-upload, passa pela API S3 assinada
 * (`signedR2Request`, `r2-object-upload.ts`).
 *
 * Chaves no bucket:
 *   beehiiv/{AAAA-MM-DD}.tar.gz.enc     tar + gzip do diretório do snapshot
 *   eia-votes/{AAAA-MM-DD}.jsonl.gz.enc JSONL `{key, value}` das chaves de voto do KV, gzip
 *
 * Cifra: `backup-offsite-crypto.ts` (AES-256-GCM, chave `BACKUP_ENCRYPTION_KEY`).
 * Lógica de I/O injetável (`fetch`, runner do `tar`) pra teste sem rede.
 */

import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";

import { kvRestBulkGet, KV_BULK_GET_MAX_KEYS, type KvRestConfig } from "./cloudflare-kv-rest.ts";
import { parseBackupKey } from "./backup-offsite-crypto.ts";
import {
  etagConflictsBody,
  etagMatchesBody,
  parseListObjectsV2,
  R2_PUT_TIMEOUT_MS,
  signedR2Request,
  type R2BucketAccess,
  type R2UploadDeps,
} from "./r2-object-upload.ts";

export const BACKUP_OFFSITE_BUCKET = "diaria-backup";

export type OffsiteKind = "beehiiv" | "eia-votes";
export const OFFSITE_KINDS: readonly OffsiteKind[] = ["beehiiv", "eia-votes"];

const KIND_SUFFIX: Record<OffsiteKind, string> = {
  beehiiv: ".tar.gz.enc",
  "eia-votes": ".jsonl.gz.enc",
};

export const offsitePrefix = (kind: OffsiteKind) => `${kind}/`;

/** Chave do objeto no bucket. Lança com data fora de `AAAA-MM-DD`. */
export function offsiteObjectKey(kind: OffsiteKind, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`data inválida para o backup off-site: "${date}" (esperado AAAA-MM-DD)`);
  return `${offsitePrefix(kind)}${date}${KIND_SUFFIX[kind]}`;
}

/** Data `AAAA-MM-DD` embutida numa chave de objeto, ou `null`. */
export function dateFromOffsiteKey(key: string): string | null {
  return /(?:^|[/\\])(\d{4}-\d{2}-\d{2})\.[a-z.]+$/.exec(key)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Credencial S3 do bucket de backup (sem a chave de cifra). */
export const BACKUP_OFFSITE_ACCESS_ENV = ["R2_ACCOUNT_ID", "R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY"] as const;

export type OffsiteAccessResult = { ready: true; access: R2BucketAccess } | { ready: false; missing: string[] };

/** Credencial de acesso ao bucket (listar/ler/gravar). Não exige a chave de cifra. */
export function loadOffsiteAccess(env: Record<string, string | undefined>): OffsiteAccessResult {
  const missing = BACKUP_OFFSITE_ACCESS_ENV.filter((n) => !env[n]?.trim());
  if (missing.length) return { ready: false, missing: [...missing] };
  return {
    ready: true,
    access: {
      accountId: env.R2_ACCOUNT_ID!.trim(),
      accessKeyId: env.R2_BACKUP_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.R2_BACKUP_SECRET_ACCESS_KEY!.trim(),
      bucket: BACKUP_OFFSITE_BUCKET,
    },
  };
}

export type OffsiteConfigResult = { ready: true; access: R2BucketAccess; key: Buffer } | { ready: false; missing: string[] };

/**
 * Credencial + chave de cifra (`BACKUP_ENCRYPTION_KEY`, ou `keyEnv`). Chave
 * malformada entra em `missing` com o motivo, nunca com o valor.
 */
export function loadOffsiteConfig(env: Record<string, string | undefined>, keyEnv: string = "BACKUP_ENCRYPTION_KEY"): OffsiteConfigResult {
  const acc = loadOffsiteAccess(env);
  const missing = acc.ready ? [] : [...acc.missing];
  let key: Buffer | null = null;
  try {
    key = parseBackupKey(env[keyEnv], keyEnv);
  } catch (e) {
    missing.push((e as Error).message);
  }
  if (!acc.ready || !key || missing.length) return { ready: false, missing };
  return { ready: true, access: acc.access, key };
}

// ---------------------------------------------------------------------------
// R2: PUT + conferência, LIST, GET — sempre pela API S3 assinada
// ---------------------------------------------------------------------------

export interface PutVerifyResult {
  key: string;
  bytes: number;
  /** ETag do HEAD é o MD5 do corpo enviado (prova positiva de conteúdo). */
  etagVerified: boolean;
}

/**
 * PUT do objeto e conferência por HEAD assinado: tamanho igual ao enviado e
 * ETag sem conflito com o MD5 do corpo (PUT simples, nunca multipart). Lança
 * em qualquer falha.
 */
export async function putAndVerifyOffsite(deps: R2UploadDeps, access: R2BucketAccess, key: string, body: Buffer): Promise<PutVerifyResult> {
  const put = await signedR2Request(deps, access, "PUT", key, {
    body,
    headers: { "content-type": "application/octet-stream" },
    timeoutMs: R2_PUT_TIMEOUT_MS,
  });
  if (!put.ok) throw new Error(`R2 PUT ${key}: HTTP ${put.status} ${(await put.text().catch(() => "")).slice(0, 300)}`);
  await put.body?.cancel().catch(() => {});
  const head = await signedR2Request(deps, access, "HEAD", key);
  if (!head.ok) throw new Error(`R2 HEAD ${key} depois do upload: HTTP ${head.status}`);
  const len = head.headers.get("content-length");
  if (len === null || Number(len) !== body.length) {
    throw new Error(`R2 ${key}: HEAD informa ${len ?? "sem content-length"} bytes, o enviado tem ${body.length}`);
  }
  const etag = head.headers.get("etag");
  if (etagConflictsBody(etag, body)) throw new Error(`R2 ${key}: ETag ${etag} não é o MD5 do corpo enviado`);
  return { key, bytes: body.length, etagVerified: etagMatchesBody(etag, body) };
}

export interface OffsiteObject {
  key: string;
  lastModified: Date;
}

/** ListObjectsV2 paginado de um prefixo (teto de 50 páginas = 50k objetos). */
export async function listOffsiteObjects(deps: R2UploadDeps, access: R2BucketAccess, prefix: string): Promise<OffsiteObject[]> {
  const out: OffsiteObject[] = [];
  let token: string | null = null;
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await signedR2Request(deps, access, "GET", "", { query });
    const body = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`R2 LIST ${prefix}: HTTP ${res.status} ${body.slice(0, 200)}`);
    const parsed = parseListObjectsV2(body);
    out.push(...parsed.objects.filter((o) => o.key.startsWith(prefix)));
    token = parsed.nextToken;
    if (!token) break;
  }
  return out;
}

/** GET assinado do objeto. 404 vira erro explícito. */
export async function getOffsiteObject(deps: R2UploadDeps, access: R2BucketAccess, key: string): Promise<Buffer> {
  const res = await signedR2Request(deps, access, "GET", key, { timeoutMs: R2_PUT_TIMEOUT_MS });
  if (res.status === 404) throw new Error(`R2 GET ${key}: objeto não existe no bucket ${access.bucket}`);
  if (!res.ok) throw new Error(`R2 GET ${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// tar + gzip (binário `tar` do sistema: GNU tar no 300, bsdtar no Windows)
// ---------------------------------------------------------------------------

export type TarRunner = (args: string[], input?: Buffer) => { status: number | null; stdout: Buffer; stderr: string };

export const systemTar: TarRunner = (args, input) => {
  const r = spawnSync("tar", args, { input, maxBuffer: 4 * 1024 ** 3 });
  if (r.error) throw new Error(`tar não pôde ser executado: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr?.toString() ?? "" };
};

/** tar.gz do CONTEÚDO de `dir` (caminhos relativos, `./...`). */
export function tarGzDirectory(dir: string, run: TarRunner = systemTar): Buffer {
  const r = run(["-czf", "-", "-C", dir, "."]);
  if (r.status !== 0) throw new Error(`tar -czf falhou (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  if (r.stdout.length === 0) throw new Error("tar -czf devolveu arquivo vazio");
  return r.stdout;
}

/** Extrai um tar.gz em `outDir` (que já precisa existir). */
export function extractTarGz(archive: Buffer, outDir: string, run: TarRunner = systemTar): void {
  const r = run(["-xzf", "-", "-C", outDir], archive);
  if (r.status !== 0) throw new Error(`tar -xzf falhou (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
}

export const gzip = (b: Buffer) => gzipSync(b);
export const gunzip = (b: Buffer) => gunzipSync(b);

// ---------------------------------------------------------------------------
// Dump dos votos do É IA? (KV POLL)
// ---------------------------------------------------------------------------

/** Namespace POLL (mesmo id de `poll-kv.ts`/`purge-leaderboard.ts`). */
export const POLL_KV_NAMESPACE_ID_DEFAULT = "72784da4ae39444481eb422ebac357c6";

/**
 * Prefixos exportados. Só dado do jogo, nunca as imagens (`/img/` do Worker,
 * fora destes prefixos):
 *   vote:{edição}:{email}  o voto bruto (escolha, ts, acertou)
 *   score:{email}          placar e apelido — o apelido não se reconstrói a partir dos votos
 *   correct:{edição}       gabarito da edição
 */
export const EIA_VOTE_KV_PREFIXES: readonly string[] = ["vote:", "score:", "correct:"];

export interface KvDumpSource {
  list: (prefix: string) => Promise<string[]>;
  /** Lê até `KV_BULK_GET_MAX_KEYS` chaves; ausente = `null`. */
  getMany: (keys: readonly string[]) => Promise<Map<string, string | null>>;
}

export interface KvDumpResult {
  jsonl: string;
  counts: Record<string, number>;
  total: number;
}

/**
 * JSONL ordenado por chave, uma linha `{"key","value"}` por chave dos
 * prefixos. Chave que sumiu entre o list e o get é pulada. Lança se nenhuma
 * chave `vote:` for encontrada (token/namespace errado ou KV vazio — nos dois
 * casos não é um backup que valha gravar como "ok").
 */
export async function dumpKvPrefixes(src: KvDumpSource, prefixes: readonly string[] = EIA_VOTE_KV_PREFIXES): Promise<KvDumpResult> {
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  for (const prefix of prefixes) {
    const keys = [...new Set(await src.list(prefix))].filter((k) => k.startsWith(prefix)).sort();
    let n = 0;
    for (let i = 0; i < keys.length; i += KV_BULK_GET_MAX_KEYS) {
      const batch = keys.slice(i, i + KV_BULK_GET_MAX_KEYS);
      const values = await src.getMany(batch);
      for (const k of batch) {
        const v = values.get(k);
        if (v === null || v === undefined) continue;
        lines.push(JSON.stringify({ key: k, value: v }));
        n++;
      }
    }
    counts[prefix] = n;
  }
  if (prefixes.includes("vote:") && !counts["vote:"]) {
    throw new Error("nenhuma chave vote: no KV POLL — token/namespace errado? dump não gravado");
  }
  lines.sort();
  return { jsonl: lines.length ? lines.join("\n") + "\n" : "", counts, total: lines.length };
}

/**
 * Fonte REST do dump: `list` paginado + bulk get. Se o bulk get falhar, avisa
 * uma vez e cai no GET individual (`get`) pro resto.
 */
export function kvRestDumpSource(
  cfg: KvRestConfig,
  ops: { list: (prefix: string) => Promise<string[]>; get: (key: string) => Promise<string | null> },
  warn: (m: string) => void = (m) => console.warn(m),
): KvDumpSource {
  let bulkBroken = false;
  return {
    list: ops.list,
    async getMany(keys) {
      if (!bulkBroken) {
        try {
          return await kvRestBulkGet(cfg, keys);
        } catch (e) {
          bulkBroken = true;
          warn(`[backup-offsite] bulk get do KV falhou (${(e as Error).message}); seguindo com GET por chave`);
        }
      }
      const out = new Map<string, string | null>();
      for (const k of keys) out.set(k, await ops.get(k));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Alarme da cópia remota (consumido por beehiiv-backup-staleness-alarm.ts)
// ---------------------------------------------------------------------------

export type RemoteVerdict = "ok" | "missing" | "stale" | "error";

export interface RemotePrefixStatus {
  kind: OffsiteKind;
  verdict: RemoteVerdict;
  latestKey: string | null;
  ageDays: number | null;
  error?: string;
}

export type RemoteOffsiteEvaluation =
  | { configured: false; missing: string[]; ok: false; fingerprint: string; prefixes: [] }
  | { configured: true; ok: boolean; fingerprint: string | null; prefixes: RemotePrefixStatus[] };

/**
 * @pure — veredito por prefixo. Mais recente = maior `lastModified`. Idade >
 * `maxAgeDays` = stale. Sem objeto = missing. `listing` com `error` = error.
 */
export function evaluateRemotePrefix(
  kind: OffsiteKind,
  listing: { objects: OffsiteObject[] } | { error: string },
  nowMs: number,
  maxAgeDays: number,
): RemotePrefixStatus {
  if ("error" in listing) return { kind, verdict: "error", latestKey: null, ageDays: null, error: listing.error };
  if (listing.objects.length === 0) return { kind, verdict: "missing", latestKey: null, ageDays: null };
  const latest = listing.objects.reduce((a, b) => (b.lastModified.getTime() > a.lastModified.getTime() ? b : a));
  const ageDays = (nowMs - latest.lastModified.getTime()) / 86_400_000;
  return { kind, verdict: ageDays > maxAgeDays ? "stale" : "ok", latestKey: latest.key, ageDays };
}

/**
 * @pure — fingerprint estável do conjunto de problemas (veredito + objeto mais
 * recente por prefixo, nunca a idade nem o texto do erro), `null` se tudo ok.
 */
export function remoteOffsiteFingerprint(prefixes: readonly RemotePrefixStatus[]): string | null {
  const bad = prefixes.filter((p) => p.verdict !== "ok");
  if (bad.length === 0) return null;
  return `remote:${bad.map((p) => `${p.kind}=${p.verdict}@${p.latestKey ?? "none"}`).join(",")}`;
}

/**
 * Lista os prefixos no bucket e avalia. Credencial ausente vira avaliação
 * `configured: false` (alarme), nunca "ok". Falha de rede/HTTP num prefixo
 * vira `error` naquele prefixo.
 */
export async function checkRemoteOffsiteBackup(
  deps: R2UploadDeps,
  env: Record<string, string | undefined>,
  maxAgeDays: number,
  kinds: readonly OffsiteKind[] = OFFSITE_KINDS,
): Promise<RemoteOffsiteEvaluation> {
  const acc = loadOffsiteAccess(env);
  if (!acc.ready) {
    return { configured: false, missing: acc.missing, ok: false, fingerprint: `remote:no-credentials:${acc.missing.join(",")}`, prefixes: [] };
  }
  const nowMs = deps.now().getTime();
  const prefixes: RemotePrefixStatus[] = [];
  for (const kind of kinds) {
    let listing: { objects: OffsiteObject[] } | { error: string };
    try {
      listing = { objects: await listOffsiteObjects(deps, acc.access, offsitePrefix(kind)) };
    } catch (e) {
      listing = { error: (e as Error).message };
    }
    prefixes.push(evaluateRemotePrefix(kind, listing, nowMs, maxAgeDays));
  }
  const fingerprint = remoteOffsiteFingerprint(prefixes);
  return { configured: true, ok: fingerprint === null, fingerprint, prefixes };
}

/** Linha legível de um prefixo, pro log e pro corpo do alarme. */
export function describeRemotePrefix(p: RemotePrefixStatus): string {
  const age = p.ageDays === null ? "" : ` (${Math.round(p.ageDays * 10) / 10} dia(s))`;
  if (p.verdict === "error") return `${p.kind}: erro ao listar — ${p.error}`;
  if (p.verdict === "missing") return `${p.kind}: nenhum objeto em ${offsitePrefix(p.kind)}`;
  return `${p.kind}: ${p.verdict}, mais recente ${p.latestKey}${age}`;
}

/** Bytes legíveis (log do tamanho de cada upload — a faixa grátis do R2 é 10 GB divididos com os verticais). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
