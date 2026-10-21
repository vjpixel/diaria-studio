/**
 * onboarding-form-link-sig.ts (#10657)
 *
 * Assinatura por pessoa do link do formulário de onboarding. Sem ela, o
 * Worker `workers/onboarding-form` aceitava POST com QUALQUER e-mail: qualquer
 * um marcava outra pessoa como "preencheu" (o que para os lembretes dela) ou
 * sobrescrevia as respostas dela no KV.
 *
 * O link do e-mail D+6/lembrete leva `?email=...&sig=...`, com
 * `sig = base64url(HMAC-SHA256(segredo, "onboarding-form:v1:" + e-mail normalizado))`.
 * O Worker só mostra o formulário e só grava com `sig` válida para aquele
 * e-mail; o e-mail vai num campo oculto (não editável).
 *
 * Puro e só com Web Crypto (`globalThis.crypto.subtle`): roda igual no Node
 * (executor `scripts/onboarding-followup-run.ts`) e no Worker — sem `node:*`.
 * Os DOIS lados usam este módulo, então a normalização do segredo (trim) e do
 * e-mail vive só aqui: um `\n` sobrando no `.env` ou no `wrangler secret put`
 * não faz um lado assinar com um valor e o outro verificar com outro.
 *
 * ## Como a assinatura chega ao e-mail
 *
 * O e-mail sai como UM broadcast Kit por lote (corpo único pra todo mundo),
 * então a assinatura não pode ir literal no corpo. Ela vive no custom field
 * `form_sig` (`FORM_SIG_KIT_FIELD`) de cada assinante, gravado pelo executor
 * antes do lote, e o link usa a merge tag `{{ subscriber.form_sig }}` — mesmo
 * padrão do `voto_token` (`scripts/publish-voto-tema-kit.ts`).
 *
 * Segredo: `ONBOARDING_FORM_LINK_SECRET` — secret do Worker (wrangler) E var
 * do executor (.env/Doppler), com o MESMO valor, de pelo menos
 * `MIN_LINK_SECRET_LENGTH` caracteres. Ausente ou curto no executor = envio
 * do formulário travado (fail-closed); ausente ou curto no Worker = 503
 * not_configured. Trocar o valor invalida os links já enviados E um
 * formulário aberto antes da troca (o POST dele volta 403 e a pessoa perde as
 * respostas digitadas) — trocar só fora de horário de envio.
 */

import { normalizeFormEmail } from "./onboarding-form-contract.ts";

/** Nome do secret no Worker e da var de ambiente do executor. */
export const ONBOARDING_FORM_LINK_SECRET_ENV = "ONBOARDING_FORM_LINK_SECRET";

/** Tamanho mínimo do segredo (depois do trim). `openssl rand -base64 32` dá 44. */
export const MIN_LINK_SECRET_LENGTH = 32;

/** Custom field do Kit que guarda a assinatura de cada pessoa. Precisa
 *  EXISTIR no Kit: o Kit descarta campo desconhecido em silêncio (2xx), por
 *  isso o executor relê o valor gravado (#9663). */
export const FORM_SIG_KIT_FIELD = "form_sig";

/** Versão no material assinado: trocar o formato invalida links antigos de
 *  propósito, sem colidir com outro uso do mesmo segredo. */
const SIG_CONTEXT = "onboarding-form:v1:";

export type LinkSecretCheck = { ok: true; secret: string } | { ok: false; detalhe: string };

/** Único lugar que normaliza o segredo: trim + tamanho mínimo. */
export function checkLinkSecret(raw: string | null | undefined): LinkSecretCheck {
  const secret = String(raw ?? "").trim();
  if (secret === "") return { ok: false, detalhe: `${ONBOARDING_FORM_LINK_SECRET_ENV} ausente` };
  if (secret.length < MIN_LINK_SECRET_LENGTH) {
    return { ok: false, detalhe: `${ONBOARDING_FORM_LINK_SECRET_ENV} com ${secret.length} caracteres (mínimo ${MIN_LINK_SECRET_LENGTH})` };
  }
  return { ok: true, secret };
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(SIG_CONTEXT + message)));
}

/** Assinatura (base64url, sem padding) do e-mail normalizado. Lança com
 *  segredo ausente ou curto (`checkLinkSecret`): assinar com segredo fraco
 *  daria link forjável. */
export async function signFormEmail(email: string, rawSecret: string): Promise<string> {
  const s = checkLinkSecret(rawSecret);
  if (!s.ok) throw new Error(`[onboarding-form-link-sig] recusando assinar: ${s.detalhe}`);
  return base64url(await hmac(s.secret, normalizeFormEmail(email)));
}

/** Compara em tempo constante (para o mesmo tamanho). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Motivo da recusa, para o log do Worker (nunca o e-mail nem a assinatura). */
export type FormSigRejection = "segredo_invalido" | "email_vazio" | "sig_vazia" | "sig_divergente";

/** Verificação com motivo. Nunca lança. */
export async function checkFormEmailSig(
  email: string | null | undefined,
  sig: string | null | undefined,
  rawSecret: string | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: FormSigRejection }> {
  const s = checkLinkSecret(rawSecret);
  if (!s.ok) return { ok: false, reason: "segredo_invalido" };
  const normalized = normalizeFormEmail(email ?? "");
  if (normalized === "") return { ok: false, reason: "email_vazio" };
  if (!sig) return { ok: false, reason: "sig_vazia" };
  try {
    return constantTimeEqual(await signFormEmail(normalized, s.secret), sig) ? { ok: true } : { ok: false, reason: "sig_divergente" };
  } catch {
    return { ok: false, reason: "sig_divergente" };
  }
}

/** `true` só com segredo válido, e-mail e assinatura presentes e a assinatura
 *  certa para aquele e-mail. Nunca lança. */
export async function verifyFormEmailSig(email: string | null | undefined, sig: string | null | undefined, secret: string | null | undefined): Promise<boolean> {
  return (await checkFormEmailSig(email, sig, secret)).ok;
}
