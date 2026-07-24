/**
 * twitter-oauth1.ts (#3994)
 *
 * Assinatura OAuth 1.0a (HMAC-SHA1) pra chamadas autenticadas à API v2 do
 * X/Twitter em nome de usuário (`POST /2/tweets`). A API v2 aceita OAuth 1.0a
 * User Context ou OAuth 2.0 User Context (PKCE + refresh) — OAuth 1.0a foi
 * escolhido porque as credenciais são estáticas (sem fluxo de refresh a
 * manter), mesmo padrão de nomenclatura de env vars sugerido no #3994
 * (`TWITTER_API_KEY`/`_SECRET`/`_ACCESS_TOKEN`/`_ACCESS_SECRET`).
 *
 * Zero dependências externas — HMAC-SHA1 via `node:crypto` nativo (princípio
 * de zero custo/complexidade recorrente do CLAUDE.md: não adicionar uma lib
 * OAuth só pra isso).
 *
 * Referência do algoritmo: RFC 5849 §3.4 (Signature Base String + HMAC-SHA1).
 * Testado contra o vetor de exemplo oficial do Twitter (docs de OAuth 1.0a,
 * request `statuses/update`) — ver twitter-oauth1.test.ts.
 */

import { createHmac, randomBytes } from "node:crypto";

/**
 * Percent-encode conforme RFC 3986 (exigido pelo OAuth 1.0a — mais estrito
 * que `encodeURIComponent`: também escapa `!`, `*`, `'`, `(`, `)`).
 */
export function percentEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Monta a Signature Base String (RFC 5849 §3.4.1): método HTTP + URL base
 * (sem query string) + parâmetros normalizados (oauth_* + quaisquer params
 * extras), todos percent-encoded e concatenados com `&`.
 *
 * `params` deve incluir TODOS os parâmetros que entram na assinatura — pra
 * `POST /2/tweets` com corpo JSON, isso é só os `oauth_*` (o corpo JSON não
 * é `application/x-www-form-urlencoded`, então não entra na base string).
 */
export function buildSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  return [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");
}

/** Signing key (RFC 5849 §3.4.2): consumerSecret + '&' + tokenSecret, ambos percent-encoded. */
export function buildSigningKey(consumerSecret: string, tokenSecret: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

/** HMAC-SHA1(signingKey, baseString), retorna base64 — a oauth_signature. */
export function signHmacSha1(baseString: string, signingKey: string): string {
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

export interface OAuth1Input {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  /** Parâmetros extras que entram na assinatura (ex: query string em GET). Vazio para POST JSON. */
  extraParams?: Record<string, string>;
  /** Injetável para testes (#2552-style DI) — default: gerado. */
  nonce?: string;
  /** Injetável para testes — default: Date.now()/1000, arredondado. */
  timestampSec?: number;
}

/**
 * Gera o header `Authorization: OAuth ...` completo pra uma requisição
 * assinada com OAuth 1.0a. `nonce`/`timestampSec` são injetáveis só para
 * testes determinísticos — produção sempre usa os defaults gerados.
 */
export function generateOAuth1AuthHeader(input: OAuth1Input): string {
  const {
    method,
    url,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
    extraParams = {},
    nonce = randomBytes(16).toString("hex"),
    timestampSec = Math.floor(Date.now() / 1000),
  } = input;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestampSec),
    oauth_token: token,
    oauth_version: "1.0",
  };

  const allParams = { ...extraParams, ...oauthParams };
  const baseString = buildSignatureBaseString(method, url, allParams);
  const signingKey = buildSigningKey(consumerSecret, tokenSecret);
  const signature = signHmacSha1(baseString, signingKey);

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const headerStr = Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
    .join(", ");

  return `OAuth ${headerStr}`;
}
