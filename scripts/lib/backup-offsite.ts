/**
 * backup-offsite.ts (#11413)
 *
 * Cópia off-site, compactada e criptografada, dos backups que hoje vivem só
 * no OneDrive (`data/`): o snapshot semanal da Beehiiv
 * (`data/beehiiv-backup/{AAAA-MM-DD}/`, `scripts/backup-beehiiv.ts`) e o dump
 * das chaves `vote:`/`score:`/`correct:` do É IA? (KV `POLL` do Worker
 * `workers/poll`).
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
 *   eia-votes/{AAAA-MM-DD}.jsonl.gz.enc JSONL `{key, value}` das chaves do KV, gzip
 *
 * Cifra: `backup-offsite-crypto.ts` (AES-256-GCM, chave `BACKUP_ENCRYPTION_KEY`).
 * Lógica de I/O injetável (`fetch`, runner do `tar`, `sleep`) pra teste sem rede.
 */

import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";

import { kvRestBulkGet, KvRestHttpError, KV_BULK_GET_MAX_KEYS, type KvRestConfig } from "./cloudflare-kv-rest.ts";
import { BACKUP_KEY_ENV, backupBinding, parseBackupKey, type BackupBinding, type BackupKey } from "./backup-offsite-crypto.ts";
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

const KIND_SUFFIX: Record<OffsiteKind, string> = {
  beehiiv: ".tar.gz.enc",
  "eia-votes": ".jsonl.gz.enc",
};

export const OFFSITE_KINDS = Object.keys(KIND_SUFFIX) as readonly OffsiteKind[];

export function isOffsiteKind(v: string): v is OffsiteKind {
  return Object.prototype.hasOwnProperty.call(KIND_SUFFIX, v);
}

/** Tipo pelo sufixo (vale pra chave do bucket e pra arquivo local já baixado). */
export function kindFromKey(key: string): OffsiteKind | null {
  return OFFSITE_KINDS.find((k) => key.endsWith(KIND_SUFFIX[k])) ?? null;
}

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

/**
 * Vínculo `{tipo}/{AAAA-MM-DD}` que o formato v2 autentica (#11961 item 4).
 * O upload usa o mesmo `kind`/`date` de `offsiteObjectKey`, então o blob só
 * decifra sob a chave em que foi gravado.
 */
export function offsiteBinding(kind: OffsiteKind, date: string): BackupBinding {
  return backupBinding(kind, date);
}

/**
 * Vínculo recalculado a partir da chave do objeto ou do nome de um arquivo já
 * baixado: tipo pelo sufixo, data pelo nome. `null` se faltar um dos dois (um
 * blob v1 ainda restaura; um v2 falha pedindo o nome original).
 */
export function offsiteBindingFromName(name: string): BackupBinding | null {
  const kind = kindFromKey(name);
  const date = dateFromOffsiteKey(name);
  return kind && date ? offsiteBinding(kind, date) : null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Credencial S3 do bucket de backup (sem a chave de cifra). */
export const BACKUP_OFFSITE_ACCESS_ENV = ["R2_ACCOUNT_ID", "R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY"] as const;

/**
 * Lista com ao menos um item (#11961): "não pronto" sem motivo, ou "sem
 * credencial" sem dizer qual, é estado que o tipo não deixa montar.
 */
export type NonEmptyList<T> = [T, ...T[]];

/** Type guard de `NonEmptyList`. */
export function isNonEmptyList<T>(xs: T[]): xs is NonEmptyList<T> {
  return xs.length > 0;
}

/** `ready: false` sempre diz qual variável falta (#11961). */
export type OffsiteAccessResult = { ready: true; access: R2BucketAccess } | { ready: false; missing: NonEmptyList<string> };

/** Credencial de acesso ao bucket (listar/ler/gravar). Não exige a chave de cifra. */
export function loadOffsiteAccess(env: Record<string, string | undefined>): OffsiteAccessResult {
  const missing: string[] = BACKUP_OFFSITE_ACCESS_ENV.filter((n) => !env[n]?.trim());
  if (isNonEmptyList(missing)) return { ready: false, missing };
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

/**
 * `missing` = nomes de variável ausentes (vazias); `invalid` = motivo de uma
 * variável presente mas malformada (hoje só a chave de cifra), nunca o valor
 * (#11961: antes os dois iam juntos em `missing`, e "ausente" e "malformada"
 * pedem ações diferentes). `ready: false` sempre tem ao menos um dos dois, e
 * é o tipo que garante: um `ready: false` com as duas listas vazias não
 * compila.
 */
export type OffsiteConfigResult =
  | { ready: true; access: R2BucketAccess; key: BackupKey }
  | { ready: false; missing: NonEmptyList<string>; invalid: string[] }
  | { ready: false; missing: string[]; invalid: NonEmptyList<string> };

/** Linha única dos problemas de `OffsiteConfigResult` não pronto, pro log/alarme. */
export function describeOffsiteConfigProblems(r: { missing: readonly string[]; invalid: readonly string[] }): string {
  const parts: string[] = [];
  if (r.missing.length) parts.push(`ausente: ${r.missing.join(", ")}`);
  if (r.invalid.length) parts.push(`inválida: ${r.invalid.join("; ")}`);
  return parts.join("; ");
}

/**
 * Credencial + chave de cifra (`BACKUP_ENCRYPTION_KEY`, ou `keyEnv`). Chave
 * ausente entra em `missing` (o nome); malformada, em `invalid` com o motivo,
 * nunca com o valor.
 */
export function loadOffsiteConfig(env: Record<string, string | undefined>, keyEnv: string = BACKUP_KEY_ENV): OffsiteConfigResult {
  const acc = loadOffsiteAccess(env);
  const missing = acc.ready ? [] : [...acc.missing];
  const invalid: string[] = [];
  let key: BackupKey | null = null;
  if (!env[keyEnv]?.trim()) {
    missing.push(keyEnv);
  } else {
    try {
      key = parseBackupKey(env[keyEnv], keyEnv);
    } catch (e) {
      invalid.push((e as Error).message);
    }
  }
  if (acc.ready && key) return { ready: true, access: acc.access, key };
  if (isNonEmptyList(missing)) return { ready: false, missing, invalid };
  if (isNonEmptyList(invalid)) return { ready: false, missing, invalid };
  // Inalcançável: acesso não pronto já pôs nomes em `missing`, e chave nula
  // veio de `missing.push(keyEnv)` ou de `invalid.push(...)`.
  throw new Error("loadOffsiteConfig: configuração não pronta sem motivo (bug)");
}

// ---------------------------------------------------------------------------
// R2: PUT + conferência, LIST, GET — sempre pela API S3 assinada
// ---------------------------------------------------------------------------

export interface PutVerifyResult {
  key: string;
  bytes: number;
  /** ETag do HEAD é o MD5 do corpo enviado (prova positiva de conteúdo, quando comparável). */
  etagVerified: boolean;
}

/**
 * PUT do objeto e conferência por HEAD assinado: tamanho igual ao enviado e,
 * quando o ETag é comparável (MD5 de PUT simples, não multipart), igual ao MD5
 * do corpo. Lança em qualquer falha.
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

export const LIST_MAX_PAGES = 50;

/**
 * ListObjectsV2 paginado de um prefixo (teto de 50 páginas = 50k objetos).
 * Lança se: HTTP != 2xx, corpo ilegível, 200 sem `<ListBucketResult` (proxy,
 * página de erro — nunca vira "nenhum objeto") ou o teto de páginas esgotar
 * com continuação pendente.
 */
export async function listOffsiteObjects(deps: R2UploadDeps, access: R2BucketAccess, prefix: string): Promise<OffsiteObject[]> {
  const out: OffsiteObject[] = [];
  let token: string | null = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await signedR2Request(deps, access, "GET", "", { query });
    let body: string;
    try {
      body = await res.text();
    } catch (e) {
      throw new Error(`R2 LIST ${prefix}: corpo ilegível (HTTP ${res.status}): ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`R2 LIST ${prefix}: HTTP ${res.status} ${body.slice(0, 200)}`);
    if (!body.includes("<ListBucketResult")) throw new Error(`R2 LIST ${prefix}: resposta 200 sem <ListBucketResult>: ${body.slice(0, 200)}`);
    const parsed = parseListObjectsV2(body);
    out.push(...parsed.objects.filter((o) => o.key.startsWith(prefix)));
    token = parsed.nextToken;
    if (!token) return out;
  }
  throw new Error(`R2 LIST ${prefix}: ${LIST_MAX_PAGES} páginas e ainda há continuação — listagem incompleta`);
}

/** GET assinado do objeto. 404 vira erro explícito. */
export async function getOffsiteObject(deps: R2UploadDeps, access: R2BucketAccess, key: string): Promise<Buffer> {
  const res = await signedR2Request(deps, access, "GET", key, { timeoutMs: R2_PUT_TIMEOUT_MS });
  if (res.status === 404) throw new Error(`R2 GET ${key}: objeto não existe no bucket ${access.bucket}`);
  if (!res.ok) throw new Error(`R2 GET ${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Objeto mais recente pela DATA DA CHAVE (`dateFromOffsiteKey`); o
 * `LastModified` só desempata (e decide entre chaves sem data). Um reenvio
 * manual de uma data antiga não passa a ser "o mais recente".
 */
export function latestOffsiteObject(objects: readonly OffsiteObject[]): OffsiteObject | null {
  let best: OffsiteObject | null = null;
  for (const o of objects) {
    if (!best) {
      best = o;
      continue;
    }
    const a = dateFromOffsiteKey(best.key) ?? "";
    const b = dateFromOffsiteKey(o.key) ?? "";
    if (b > a || (b === a && o.lastModified.getTime() > best.lastModified.getTime())) best = o;
  }
  return best;
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

/**
 * #12544: o `tar` que o Node acha no Windows é o GNU tar do Git (MSYS). Ele
 * cria com `-C C:\x\y`, mas na EXTRAÇÃO recusa o mesmo caminho (`Cannot
 * open: No such file or directory`, medido em 12/11/2026 no Neo); com barra
 * normal (`C:/x/y`) as duas pontas funcionam. Fora do win32 o caminho vai
 * intacto (barra invertida é caractere válido em nome de arquivo no Linux).
 */
export function tarDirArg(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? dir.replaceAll("\\", "/") : dir;
}

/** tar.gz do CONTEÚDO de `dir` (caminhos relativos, `./...`). */
export function tarGzDirectory(dir: string, run: TarRunner = systemTar): Buffer {
  const r = run(["-czf", "-", "-C", tarDirArg(dir), "."]);
  if (r.status !== 0) throw new Error(`tar -czf falhou (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  if (r.stdout.length === 0) throw new Error("tar -czf devolveu arquivo vazio");
  return r.stdout;
}

/** Extrai um tar.gz em `outDir` (que já precisa existir). */
export function extractTarGz(archive: Buffer, outDir: string, run: TarRunner = systemTar): void {
  const r = run(["-xzf", "-", "-C", tarDirArg(outDir)], archive);
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
 * Prefixos exportados — só dado do jogo que não se reconstrói:
 *   vote:{edição}:{email}  o voto bruto (escolha, ts, acertou)
 *   score:{email}          placar e apelido — o apelido não se reconstrói a partir dos votos
 *   correct:{edição}       gabarito da edição
 *
 * Ficam de fora, de propósito:
 *   - as imagens (`/img/` do Worker): arquivo do pipeline, já existe em outro lugar;
 *   - `stats:{edição}`, `counted:…` (guards de contagem) e `leaderboard-snapshot:`:
 *     agregados e caches derivados dos votos (`rebuild-stats.ts` reconstrói o
 *     `stats:` a partir dos `vote:`);
 *   - `nickname:` (índice reverso apelido→email): reconstruível a partir de `score:`
 *     (`migrate-nickname-index.ts`);
 *   - `eiameta:` (descrição/crédito da imagem): vem da edição, em `data/editions/`.
 */
export const EIA_VOTE_KV_PREFIXES: readonly string[] = ["vote:", "score:", "correct:"];

/**
 * Chaves que somem entre o list e o get (purga de votos, TTL) são toleradas
 * até `max(5, 0,5% das listadas)` por prefixo; acima disso o dump falha em vez
 * de sair como completo.
 */
export const DUMP_SKIP_TOLERANCE_ABS = 5;
export const DUMP_SKIP_TOLERANCE_RATIO = 0.005;

export function dumpSkipTolerance(listed: number): number {
  return Math.max(DUMP_SKIP_TOLERANCE_ABS, Math.floor(listed * DUMP_SKIP_TOLERANCE_RATIO));
}

export interface KvDumpSource {
  list: (prefix: string) => Promise<string[]>;
  /** Lê até `KV_BULK_GET_MAX_KEYS` chaves; ausente = `null`. */
  getMany: (keys: readonly string[]) => Promise<Map<string, string | null>>;
  /** Causas dos lotes que caíram no GET por chave (vazio = tudo pelo bulk). */
  fallbackCauses?: () => string[];
}

export interface KvPrefixCount {
  listed: number;
  dumped: number;
  skipped: number;
}

export interface KvDumpResult {
  jsonl: string;
  counts: Record<string, KvPrefixCount>;
  total: number;
  /** Lotes lidos via GET por chave, com a causa do bulk. */
  fallbackCauses: string[];
}

/** Resumo de uma linha do dump, pro log (`vote: 1234/1236 (2 puladas), ...`). */
export function describeKvDump(d: KvDumpResult): string {
  const parts = Object.entries(d.counts).map(([p, c]) => `${p} ${c.dumped}/${c.listed}${c.skipped ? ` (${c.skipped} sumiram entre list e get)` : ""}`);
  const fb = d.fallbackCauses.length ? `; via fallback GET em ${d.fallbackCauses.length} lote(s): ${d.fallbackCauses[0]}` : "";
  return `${d.total} chaves (${parts.join(", ")})${fb}`;
}

/**
 * JSONL ordenado por chave, uma linha `{"key","value"}` por chave dos
 * prefixos. Lança se: nenhuma chave `vote:` (token/namespace errado ou KV
 * vazio); `vote:` > 0 com `score:` = 0 (dump incoerente); ou mais chaves
 * sumidas entre o list e o get do que `dumpSkipTolerance` num prefixo.
 */
export async function dumpKvPrefixes(src: KvDumpSource, prefixes: readonly string[] = EIA_VOTE_KV_PREFIXES): Promise<KvDumpResult> {
  const counts: Record<string, KvPrefixCount> = {};
  const lines: string[] = [];
  for (const prefix of prefixes) {
    const keys = [...new Set(await src.list(prefix))].filter((k) => k.startsWith(prefix)).sort();
    const c: KvPrefixCount = { listed: keys.length, dumped: 0, skipped: 0 };
    for (let i = 0; i < keys.length; i += KV_BULK_GET_MAX_KEYS) {
      const batch = keys.slice(i, i + KV_BULK_GET_MAX_KEYS);
      const values = await src.getMany(batch);
      for (const k of batch) {
        const v = values.get(k);
        if (v === null || v === undefined) {
          c.skipped++;
          continue;
        }
        lines.push(JSON.stringify({ key: k, value: v }));
        c.dumped++;
      }
    }
    counts[prefix] = c;
    if (c.skipped > dumpSkipTolerance(c.listed)) {
      throw new Error(`dump parcial: ${c.skipped} de ${c.listed} chaves ${prefix} sem valor no get (tolerância ${dumpSkipTolerance(c.listed)}) — não gravado`);
    }
  }
  const votes = counts["vote:"]?.dumped ?? 0;
  if (prefixes.includes("vote:") && votes === 0) {
    throw new Error("nenhuma chave vote: no KV POLL — token/namespace errado? dump não gravado");
  }
  if (prefixes.includes("score:") && votes > 0 && (counts["score:"]?.dumped ?? 0) === 0) {
    throw new Error(`${votes} chaves vote: e nenhuma score: — dump incoerente, não gravado`);
  }
  lines.sort();
  return { jsonl: lines.length ? lines.join("\n") + "\n" : "", counts, total: lines.length, fallbackCauses: src.fallbackCauses?.() ?? [] };
}

export interface KvRestDumpOpts {
  warn?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Tentativas extras do bulk antes de cair no GET por chave (default 2). */
  bulkRetries?: number;
  /** Backoff base em ms, dobra a cada tentativa (default 2000). */
  backoffMs?: number;
}

/**
 * Fonte REST do dump: `list` paginado + bulk get (100 chaves por chamada).
 *
 * - 401/403 no bulk: lança na hora (credencial sem acesso; o GET por chave
 *   também falharia, e milhares de requests a mais não ajudam).
 * - Outro erro: tenta o bulk de novo `bulkRetries` vezes com backoff; se
 *   continuar falhando, lê SÓ AQUELE LOTE por GET individual (o próximo lote
 *   volta a tentar o bulk) e registra a causa em `fallbackCauses`.
 *
 * Teto de rate limit: a API da Cloudflare aceita ~1.200 requests a cada 5
 * minutos por usuário. O GET por chave gasta 100 requests por lote; com
 * milhares de `vote:` caindo todos no fallback, o dump passa desse teto e
 * começa a receber 429 (que vira erro do lote).
 */
export function kvRestDumpSource(
  cfg: KvRestConfig,
  ops: { list: (prefix: string) => Promise<string[]>; get: (key: string) => Promise<string | null> },
  opts: KvRestDumpOpts = {},
): KvDumpSource {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.bulkRetries ?? 2;
  const backoff = opts.backoffMs ?? 2000;
  const causes: string[] = [];
  return {
    list: ops.list,
    fallbackCauses: () => [...causes],
    async getMany(keys) {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(backoff * 2 ** (attempt - 1));
        try {
          return await kvRestBulkGet(cfg, keys);
        } catch (e) {
          if (e instanceof KvRestHttpError && (e.status === 401 || e.status === 403)) {
            throw new Error(`bulk get do KV recusado (HTTP ${e.status}), credencial sem acesso ao namespace: ${e.message}`);
          }
          lastErr = e as Error;
        }
      }
      const cause = lastErr?.message ?? "erro desconhecido";
      causes.push(cause);
      warn(`[backup-offsite] bulk get do KV falhou ${retries + 1}x (${cause}); este lote de ${keys.length} vai por GET por chave`);
      const out = new Map<string, string | null>();
      try {
        for (const k of keys) out.set(k, await ops.get(k));
      } catch (e) {
        throw new Error(`GET por chave falhou depois do bulk falhar (${cause}): ${(e as Error).message}`);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Alarme da cópia remota (consumido por beehiiv-backup-staleness-alarm.ts)
// ---------------------------------------------------------------------------

type RemoteVerdict = "ok" | "missing" | "stale" | "error";

/**
 * Veredito de um prefixo, discriminado por `verdict` (#11961): `ok`/`stale`
 * sempre têm o objeto mais recente e a idade; `missing`/`error` nunca têm; só
 * `error` tem a mensagem.
 */
export type RemotePrefixStatus =
  | { kind: OffsiteKind; verdict: "ok" | "stale"; latestKey: string; ageDays: number }
  | { kind: OffsiteKind; verdict: "missing"; latestKey: null; ageDays: null }
  | { kind: OffsiteKind; verdict: "error"; latestKey: null; ageDays: null; error: string };

/**
 * `ok` e `fingerprint` casados (#11961): ok ⇔ fingerprint null.
 * `configured: false` sempre nomeia a variável que falta.
 */
export type RemoteOffsiteEvaluation =
  | { configured: false; missing: NonEmptyList<string>; ok: false; fingerprint: string; prefixes: [] }
  | { configured: true; ok: true; fingerprint: null; prefixes: RemotePrefixStatus[] }
  | { configured: true; ok: false; fingerprint: string; prefixes: RemotePrefixStatus[] };

/**
 * @pure — veredito por prefixo. Mais recente e idade pela DATA DA CHAVE
 * (início do dia em UTC), como o check local mede o snapshot — um upload
 * atrasado (mesma data, `LastModified` horas depois) não muda a idade.
 * Chave sem data cai no `LastModified`. Idade > `maxAgeDays` = stale; sem
 * objeto = missing; `listing` com `error` = error.
 */
export function evaluateRemotePrefix(
  kind: OffsiteKind,
  listing: { objects: OffsiteObject[] } | { error: string },
  nowMs: number,
  maxAgeDays: number,
): RemotePrefixStatus {
  if ("error" in listing) return { kind, verdict: "error", latestKey: null, ageDays: null, error: listing.error };
  const latest = latestOffsiteObject(listing.objects);
  if (!latest) return { kind, verdict: "missing", latestKey: null, ageDays: null };
  const date = dateFromOffsiteKey(latest.key);
  const refMs = date ? Date.parse(`${date}T00:00:00Z`) : latest.lastModified.getTime();
  const ageDays = (nowMs - refMs) / 86_400_000;
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
  return fingerprint === null ? { configured: true, ok: true, fingerprint, prefixes } : { configured: true, ok: false, fingerprint, prefixes };
}

/** Linha legível de um prefixo, pro log e pro corpo do alarme. */
export function describeRemotePrefix(p: RemotePrefixStatus): string {
  const age = p.ageDays === null ? "" : ` (${Math.round(p.ageDays * 10) / 10} dia(s) pela data da chave)`;
  if (p.verdict === "error") return `${p.kind}: erro ao listar — ${p.error}`;
  if (p.verdict === "missing") return `${p.kind}: nenhum objeto em ${offsitePrefix(p.kind)}`;
  return `${p.kind}: ${p.verdict}, mais recente ${p.latestKey}${age}`;
}

/**
 * Bytes legíveis (log do tamanho de cada upload — a faixa grátis do R2 é
 * 10 GB por conta, divididos com os verticais e as imagens públicas).
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
