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
 *   SHORTS_R2_BUCKET         nome do bucket
 *   SHORTS_R2_PUBLIC_BASE    base pública do bucket (domínio próprio ou r2.dev), https
 */

import { createHash, createHmac } from "node:crypto";

export interface R2UploadConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Base pública https, sem barra no fim. */
  publicBase: string;
}

export const R2_ENV_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "SHORTS_R2_BUCKET",
  "SHORTS_R2_PUBLIC_BASE",
] as const;

/** Lê a config do env. Falta qualquer var (ou base não-https) → `ready: false` com o que falta. */
export function loadR2UploadConfig(env: Record<string, string | undefined>): { ready: true; config: R2UploadConfig } | { ready: false; missing: string[] } {
  const missing = R2_ENV_VARS.filter((k) => !env[k]?.trim());
  if (missing.length) return { ready: false, missing: [...missing] };
  const publicBase = env.SHORTS_R2_PUBLIC_BASE!.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(publicBase)) return { ready: false, missing: ["SHORTS_R2_PUBLIC_BASE (precisa ser https)"] };
  return {
    ready: true,
    config: {
      accountId: env.R2_ACCOUNT_ID!.trim(),
      accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
      bucket: env.SHORTS_R2_BUCKET!.trim(),
      publicBase,
    },
  };
}

/** Encoding de path do SigV4 (RFC 3986, `/` preservado entre segmentos). */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

export interface SigV4Input {
  method: string;
  host: string;
  /** Path absoluto, sem encode (ex.: `/bucket/shorts/a.mp4`). */
  path: string;
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
  const canonicalRequest = [input.method, encodePath(input.path), "", canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
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
}

/**
 * PUT do arquivo no bucket e conferência da URL pública (HEAD 200 com o mesmo
 * tamanho). Lança em qualquer falha — o caller não enfileira Reels com URL que
 * a Graph não vai conseguir baixar.
 */
export async function uploadToR2(
  deps: R2UploadDeps,
  config: R2UploadConfig,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucket}/${key}`;
  const headers = signS3Request({
    method: "PUT",
    host,
    path,
    headers: { "content-type": contentType },
    payloadHash: sha256Hex(body),
    region: "auto",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: deps.now(),
  });
  const res = await deps.fetch(`https://${host}${encodePath(path)}`, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`R2 PUT ${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);

  const url = r2PublicUrl(config, key);
  const head = await deps.fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`R2: ${url} não está público (HEAD ${head.status}) — confira o acesso público do bucket (SHORTS_R2_PUBLIC_BASE)`);
  const len = head.headers.get("content-length");
  if (len !== null && Number(len) !== body.length) {
    throw new Error(`R2: ${url} serve ${len} bytes, o arquivo tem ${body.length} — upload incompleto ou cache velho`);
  }
  return url;
}
