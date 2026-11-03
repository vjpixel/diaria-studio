/**
 * r2-object-upload.ts (#10823)
 *
 * Sobe um arquivo pra um bucket R2 pela API compatível com S3 e devolve a URL
 * PÚBLICA dele. Existe porque o Reels agendado pela fila do Worker
 * `diaria-linkedin-cron` precisa de `video_url` público no disparo (a Graph API
 * baixa o vídeo; o Worker não tem o arquivo), e o vertical do dia passa dos
 * 25 MB por valor do KV que hospeda as imagens sociais. Decisão registrada na
 * #10823 (opção a, R2 free tier).
 *
 * Por que S3 + SigV4 escrito à mão, e não um binding R2 num Worker: o binding
 * exige o bucket já criado no deploy (e o deploy dos Workers é automático no
 * push) — um binding pra bucket inexistente derruba o deploy do Worker inteiro.
 * O upload direto do script não toca em Worker nenhum; sem as env vars o
 * caller cai no comportamento de antes (Instagram pendente até o horário).
 *
 * Configuração (env, nunca no repo):
 *   R2_ACCOUNT_ID            id da conta Cloudflare (endpoint {id}.r2.cloudflarestorage.com)
 *   R2_ACCESS_KEY_ID         chave de API do R2 com escrita no bucket
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET                nome do bucket (legado: SHORTS_R2_BUCKET)
 *   R2_PUBLIC_BASE           base pública do bucket (domínio próprio ou r2.dev), https
 *                            (legado: SHORTS_R2_PUBLIC_BASE)
 *
 * #11412: o mesmo bucket passou a receber as imagens públicas da edição
 * (`img/{AAMMDD}/…`, `scripts/upload-images-public.ts`), não só os verticais
 * (`shorts/`). Por isso os nomes genéricos `R2_BUCKET`/`R2_PUBLIC_BASE`; os
 * `SHORTS_R2_*` continuam aceitos (são os que estão no Doppler hoje) e o
 * genérico vence quando os dois existem.
 */

import { createHash, createHmac } from "node:crypto";

/**
 * #11413: o mínimo pra falar com um bucket pela API S3 (sem URL pública). O
 * backup off-site (`scripts/lib/backup-offsite.ts`) usa só isto, num bucket
 * PRIVADO e com credencial própria; os verticais/imagens usam
 * `R2UploadConfig`, que acrescenta a base pública.
 */
export interface R2BucketAccess {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface R2UploadConfig extends R2BucketAccess {
  /** Base pública https, sem barra no fim. */
  publicBase: string;
}

/**
 * Vars da config. Cada entrada é a lista de nomes aceitos, em ordem de
 * preferência (#11412: genérico primeiro, `SHORTS_*` legado depois).
 */
export const R2_ENV_VARS: readonly (readonly string[])[] = [
  ["R2_ACCOUNT_ID"],
  ["R2_ACCESS_KEY_ID"],
  ["R2_SECRET_ACCESS_KEY"],
  ["R2_BUCKET", "SHORTS_R2_BUCKET"],
  ["R2_PUBLIC_BASE", "SHORTS_R2_PUBLIC_BASE"],
];

/** Primeiro nome da lista com valor não-vazio no env. */
function pickEnv(env: Record<string, string | undefined>, names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const v = env[name]?.trim();
    if (v) return { name, value: v };
  }
  return null;
}

/** Como uma var ausente aparece em `missing`: `R2_BUCKET (ou SHORTS_R2_BUCKET)`. */
const describeEnv = (names: readonly string[]) => (names.length > 1 ? `${names[0]} (ou ${names.slice(1).join(", ")})` : names[0]);

/** Lê a config do env. Falta qualquer var (ou base não-https) → `ready: false` com o que falta. */
export function loadR2UploadConfig(env: Record<string, string | undefined>): { ready: true; config: R2UploadConfig } | { ready: false; missing: string[] } {
  const picked = R2_ENV_VARS.map((names) => pickEnv(env, names));
  const missing = R2_ENV_VARS.filter((_, i) => !picked[i]).map(describeEnv);
  if (missing.length) return { ready: false, missing };
  const [accountId, accessKeyId, secretAccessKey, bucket, publicBaseRaw] = picked;
  const publicBase = publicBaseRaw!.value.replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(publicBase)) return { ready: false, missing: [`${publicBaseRaw!.name} (precisa ser https)`] };
  return {
    ready: true,
    config: {
      accountId: accountId!.value,
      accessKeyId: accessKeyId!.value,
      secretAccessKey: secretAccessKey!.value,
      bucket: bucket!.value,
      publicBase,
    },
  };
}

/** Encoding de path do SigV4 (RFC 3986, `/` preservado entre segmentos). */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeRfc3986(seg))
    .join("/");
}

/** Valor RFC 3986 (o `encodeURIComponent` deixa `!'()*` sem encode; o SigV4 exige). */
const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Query canônica do SigV4: pares encodados e ordenados pela chave. */
function canonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return "";
  return Object.entries(query)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

export interface SigV4Input {
  method: string;
  host: string;
  /** Path absoluto, sem encode (ex.: `/bucket/shorts/a.mp4`). */
  path: string;
  /** Query string, sem encode (#10923: ListObjectsV2). Ausente = sem query. */
  query?: Record<string, string>;
  /** Headers além de host/x-amz-date/x-amz-content-sha256 que entram na assinatura. */
  headers?: Record<string, string>;
  /** Hash hex do corpo, ou `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

/**
 * Assina um request S3 (AWS Signature Version 4, sem query string). Puro:
 * devolve os headers a enviar (Authorization, x-amz-date,
 * x-amz-content-sha256 e os `headers` de entrada). Travado contra o vetor do
 * exemplo "GET Object" da documentação da AWS em
 * test/r2-object-upload-10823.test.ts.
 */
export function signS3Request(input: SigV4Input): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method, encodePath(input.path), canonicalQuery(input.query), canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const out: Record<string, string> = { ...(input.headers ?? {}) };
  out["x-amz-date"] = amzDate;
  out["x-amz-content-sha256"] = input.payloadHash;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** URL pública do objeto (o que vai no `video_url`). */
export function r2PublicUrl(config: R2UploadConfig, key: string): string {
  return `${config.publicBase}/${encodePath(key)}`;
}

export interface R2UploadDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  /** Aviso não-fatal (limpeza de retenção, #10923). Default: console.warn. */
  warn?: (msg: string) => void;
}

/**
 * #10923 — retenção por prefixo. Os verticais (~275 MB/dia) enchiam os 10 GB
 * do plano gratuito do R2 em ~36 dias e passavam a custar em silêncio. O
 * objeto só precisa existir até a Graph API (Reels na fila do Worker) e a
 * Buffer baixarem o vídeo, o que acontece no horário do vertical, no mesmo
 * dia ou no seguinte; 7 dias dão folga para um reenfileiramento. Conta de
 * espaço, não medida no bucket: com um vertical por dia (~275 MB) são ~2 GB; no
 * pior caso, com um corte `_Instagram_` diferente do genérico todo dia (#11355,
 * chave própria com hash), ~550 MB/dia e ~4 GB, e cada troca de corte no mesmo
 * dia soma um objeto. Corte idêntico ao genérico não ocupa nada a mais. O Reels
 * por `video_url` baixa o objeto logo depois do upload (pior caso medido: 72 s).
 *
 * A limpeza roda no próprio upload, com a mesma chave de API (escrita no
 * bucket já inclui listar e apagar objetos). Uma regra de lifecycle no bucket
 * faria o mesmo, mas exige permissão de admin do bucket e um passo manual no
 * painel; aqui não depende de nada além das env vars que o upload já usa.
 */
export const R2_RETENTION_POLICIES: readonly { prefix: string; maxAgeDays: number }[] = [{ prefix: "shorts/", maxAgeDays: 7 }];

/**
 * #11774: teto de cada request ao R2. Sem ele, um PUT/HEAD travado segurava o
 * lock do timer do Instagram até a idade de lock velho (90 min). O PUT leva o
 * vertical inteiro (~275 MB); HEAD, LIST e DELETE são pequenos.
 */
export const R2_PUT_TIMEOUT_MS = 15 * 60_000;
export const R2_REQUEST_TIMEOUT_MS = 60_000;

function s3Host(config: R2BucketAccess): string {
  return `${config.accountId}.r2.cloudflarestorage.com`;
}

async function signedFetch(
  deps: R2UploadDeps,
  config: R2BucketAccess,
  method: string,
  key: string,
  query?: Record<string, string>,
): Promise<Response> {
  return signedR2Request(deps, config, method, key, { query });
}

/**
 * #11413: request S3 assinado ao bucket, pela API (nunca pela URL pública).
 * `key` vazio = o próprio bucket (ListObjectsV2). Com `body`, o hash do corpo
 * entra na assinatura (PUT). Timeout: `timeoutMs`, default
 * `R2_REQUEST_TIMEOUT_MS` (PUT de corpo grande deve passar `R2_PUT_TIMEOUT_MS`).
 */
export async function signedR2Request(
  deps: R2UploadDeps,
  config: R2BucketAccess,
  method: string,
  key: string,
  opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const host = s3Host(config);
  const path = key ? `/${config.bucket}/${key}` : `/${config.bucket}`;
  const payloadHash = sha256Hex(opts.body ?? "");
  const headers = signS3Request({
    method,
    host,
    path,
    query: opts.query,
    headers: opts.headers,
    payloadHash,
    region: "auto",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: deps.now(),
  });
  const qs = canonicalQuery(opts.query);
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(opts.timeoutMs ?? R2_REQUEST_TIMEOUT_MS) };
  if (opts.body) init.body = new Uint8Array(opts.body);
  return deps.fetch(`https://${host}${encodePath(path)}${qs ? `?${qs}` : ""}`, init);
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Parse mínimo da resposta do ListObjectsV2 (puro, exportado pro teste). */
export function parseListObjectsV2(xml: string): { objects: { key: string; lastModified: Date }[]; nextToken: string | null } {
  const objects: { key: string; lastModified: Date }[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
    const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[1])?.[1];
    if (key === undefined || lm === undefined) continue;
    const lastModified = new Date(lm.trim());
    if (Number.isNaN(lastModified.getTime())) continue;
    objects.push({ key: decodeXml(key), lastModified });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated && token ? decodeXml(token) : null };
}

export interface R2PruneResult {
  deleted: string[];
  errors: string[];
}

/**
 * #10923 — apaga os objetos de `prefix` com LastModified mais velho que
 * `maxAgeDays`, exceto os de `keep`. Nunca lança: falha vira `errors` (o
 * upload que acabou de dar certo não pode cair por causa da limpeza).
 */
export async function pruneR2Prefix(
  deps: R2UploadDeps,
  config: R2BucketAccess,
  opts: { prefix: string; maxAgeDays: number; keep?: readonly string[] },
): Promise<R2PruneResult> {
  const out: R2PruneResult = { deleted: [], errors: [] };
  const cutoff = deps.now().getTime() - opts.maxAgeDays * 86_400_000;
  const keep = new Set(opts.keep ?? []);
  const stale: string[] = [];
  try {
    let token: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query: Record<string, string> = { "list-type": "2", prefix: opts.prefix };
      if (token) query["continuation-token"] = token;
      const res = await signedFetch(deps, config, "GET", "", query);
      const body = await res.text().catch(() => "");
      if (!res.ok) {
        out.errors.push(`R2 LIST ${opts.prefix}: HTTP ${res.status} ${body.slice(0, 200)}`);
        return out;
      }
      const parsed = parseListObjectsV2(body);
      for (const o of parsed.objects) {
        if (o.key.startsWith(opts.prefix) && !keep.has(o.key) && o.lastModified.getTime() < cutoff) stale.push(o.key);
      }
      token = parsed.nextToken;
      if (!token) break;
    }
  } catch (e) {
    out.errors.push(`R2 LIST ${opts.prefix}: ${(e as Error).message}`);
    return out;
  }
  for (const key of stale) {
    try {
      const res = await signedFetch(deps, config, "DELETE", key);
      // S3 responde 204 ao DELETE (inclusive de objeto que já não existe).
      if (res.ok) out.deleted.push(key);
      else out.errors.push(`R2 DELETE ${key}: HTTP ${res.status}`);
    } catch (e) {
      out.errors.push(`R2 DELETE ${key}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * PUT do arquivo no bucket e conferência da URL pública (HEAD 200 com o mesmo
 * tamanho). Lança em qualquer falha — o caller não enfileira Reels com URL que
 * a Graph não vai conseguir baixar.
 *
 * Se a key cai num prefixo de `R2_RETENTION_POLICIES` (#10923), depois do
 * upload apaga os objetos velhos do prefixo (nunca o recém-enviado). Falha da
 * limpeza só avisa.
 */
export async function uploadToR2(
  deps: R2UploadDeps,
  config: R2UploadConfig,
  key: string,
  body: Buffer,
  contentType: string,
  /** `keep` (#11774): outras chaves que a poda de retenção não pode apagar (ex.: a capa reaproveitada da mesma rodada). */
  opts: { cacheControl?: string; keep?: readonly string[] } = {},
): Promise<string> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucket}/${key}`;
  // #11412: `cache-control` vira metadado HTTP do objeto (o R2 devolve no GET
  // pelo domínio público) — as imagens content-addressed sobem `immutable`.
  const putHeaders: Record<string, string> = { "content-type": contentType };
  if (opts.cacheControl) putHeaders["cache-control"] = opts.cacheControl;
  const headers = signS3Request({
    method: "PUT",
    host,
    path,
    headers: putHeaders,
    payloadHash: sha256Hex(body),
    region: "auto",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: deps.now(),
  });
  const res = await deps.fetch(`https://${host}${encodePath(path)}`, { method: "PUT", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(R2_PUT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`R2 PUT ${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);

  const url = r2PublicUrl(config, key);
  const head = await deps.fetch(url, { method: "HEAD", signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) });
  if (!head.ok) throw new Error(`R2: ${url} não está público (HEAD ${head.status}) — confira o acesso público do bucket (R2_PUBLIC_BASE/SHORTS_R2_PUBLIC_BASE)`);
  const len = head.headers.get("content-length");
  if (len !== null && Number(len) !== body.length) {
    throw new Error(`R2: ${url} serve ${len} bytes, o arquivo tem ${body.length} — upload incompleto ou cache velho`);
  }
  // #11355: o tamanho não pega vídeo velho de mesmo tamanho servido na chave fixa.
  if (etagConflictsBody(head.headers.get("etag"), body)) {
    throw new Error(`R2: ${url} serve outro conteúdo (ETag ${head.headers.get("etag")} não é o MD5 do arquivo) — cache velho ou upload incompleto`);
  }

  const policy = R2_RETENTION_POLICIES.find((p) => key.startsWith(p.prefix));
  if (policy) {
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    const pruned = await pruneR2Prefix(deps, config, { prefix: policy.prefix, maxAgeDays: policy.maxAgeDays, keep: [key, ...(opts.keep ?? [])] });
    if (pruned.deleted.length) warn(`[r2] retenção ${policy.maxAgeDays}d (#10923): apagados ${pruned.deleted.length} objeto(s) de ${policy.prefix}`);
    for (const e of pruned.errors) warn(`[r2] limpeza de retenção falhou (#10923, não bloqueia o upload): ${e}`);
  }
  return url;
}

/**
 * #11432: o ETag do objeto prova que o conteúdo é este `body`? O `uploadToR2`
 * faz PUT simples (nunca multipart), e nesse caso o ETag do R2 é o MD5 hex do
 * corpo, entre aspas. Aceita o prefixo fraco `W/` (proxy que reescreve). ETag
 * ausente, de multipart (`…-N`) ou diferente → false: na dúvida, sobe de novo.
 */
export function etagMatchesBody(etag: string | null, body: Buffer): boolean {
  if (!etag) return false;
  const tag = etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(tag)) return false;
  return tag === createHash("md5").update(body).digest("hex");
}

/**
 * #11355: o ETag prova que o objeto é OUTRO conteúdo? Só um MD5 bem formado e
 * diferente conta. ETag ausente ou em outro formato não prova nada, e o caller
 * fica com a conferência de tamanho (o oposto de `etagMatchesBody`, que decide
 * reaproveitar e por isso exige a prova positiva).
 */
export function etagConflictsBody(etag: string | null, body: Buffer): boolean {
  if (!etag) return false;
  const tag = etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(tag) && !etagMatchesBody(etag, body);
}

/**
 * #11355: a URL pública de `key` serve exatamente este `body` (tamanho e ETag)?
 * HEAD que falha ou 404 = false: na dúvida, o caller sobe de novo.
 */
export async function r2ObjectHasBody(deps: R2UploadDeps, config: R2UploadConfig, key: string, body: Buffer): Promise<boolean> {
  try {
    const head = await deps.fetch(r2PublicUrl(config, key), { method: "HEAD", signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) });
    const len = head.headers.get("content-length");
    return head.ok && len !== null && Number(len) === body.length && etagMatchesBody(head.headers.get("etag"), body);
  } catch {
    return false;
  }
}

/**
 * #11410: sobe o arquivo, ou reaproveita o objeto que já está no bucket com o
 * MESMO conteúdo (HEAD 200 na URL pública). O vertical do dia costuma já ter
 * subido numa rodada anterior (o `/diaria-publica-video` com o X, ou outra
 * execução do timer do Threads): sem isso cada rodada repetiria o PUT de
 * ~275 MB. Desde o #11432 tamanho igual não basta: o ETag (MD5) tem que bater
 * com o arquivo, senão um objeto corrompido de mesmo tamanho seria
 * reaproveitado em toda retentativa. HEAD que falha, 404, tamanho ou ETag
 * diferente → upload normal (`uploadToR2`, que confere a URL depois). Devolve
 * a URL e se reaproveitou.
 */
export async function reuseOrUploadToR2(
  deps: R2UploadDeps,
  config: R2UploadConfig,
  key: string,
  body: Buffer,
  contentType: string,
  opts: { keep?: readonly string[] } = {},
): Promise<{ url: string; reused: boolean }> {
  if (await r2ObjectHasBody(deps, config, key, body)) return { url: r2PublicUrl(config, key), reused: true };
  return { url: await uploadToR2(deps, config, key, body, contentType, opts.keep ? { keep: opts.keep } : {}), reused: false };
}
