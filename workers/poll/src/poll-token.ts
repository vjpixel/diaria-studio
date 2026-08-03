/**
 * workers/poll/src/poll-token.ts (#4487)
 *
 * **Espelho local** de `scripts/lib/shared/poll-token.ts` — a fonte da
 * verdade do projeto. Mesmo motivo de `session-cookie.ts`/`utm-registry.ts`/
 * `ds-tokens.generated.ts` neste diretório: o bundle do Worker `poll` é
 * construído pelo `wrangler`/esbuild a partir de `workers/poll/src/**` e
 * nunca alcança `scripts/**` — nenhum arquivo deste diretório importa de
 * fora dele hoje. Um import relativo `../../../scripts/lib/shared/...`
 * funcionaria no `tsc --noEmit` mas arrastaria o diretório inteiro pra
 * dentro do grafo do bundle — risco desnecessário num artefato que sobe pra
 * produção.
 *
 * **A sincronia é lint-enforced:** `test/poll-token-mirror-4487.test.ts`
 * compara este arquivo (via comportamento, não string-diff de fonte) com o
 * shared e falha se qualquer coisa divergir. Editar um dos dois sem o outro
 * quebra o CI.
 *
 * NÃO editar aqui sem editar `scripts/lib/shared/poll-token.ts` também (ou
 * vice-versa) — copiar byte-a-byte é o contrato.
 */

/** Domínio pseudo-email reservado pro token opaco do voto por e-mail (diário,
 * modo merge-tag). Nunca usar pra brand "web" (anônimo) nem vice-versa. */
export const VOTE_TOKEN_DOMAIN = "vote.eia.diaria.local";

/** Comprimento do token (hex chars) — 24 chars = 96 bits, truncado do HMAC-SHA256 completo. */
const TOKEN_HEX_LEN = 24;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Token determinístico (24 hex chars) — mesma saída sempre pro mesmo par
 * (secret, email). Email normalizado (lowercase + trim) antes do HMAC, igual
 * ao padrão já usado pelo `sig` de voto (`hmacSign`, workers/poll/src/index.ts)
 * e pelo antigo `generatePollSig` (#1083).
 */
export async function computePollToken(secret: string, email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  const full = await hmacHex(secret, `polltoken:${normalized}`);
  return full.slice(0, TOKEN_HEX_LEN);
}

/** Pseudo-email completo (`{token}@vote.eia.diaria.local`) — o valor gravado
 * no custom field Beehiiv `poll_token` e usado na URL de voto do e-mail. */
export async function computePollTokenEmail(secret: string, email: string): Promise<string> {
  const token = await computePollToken(secret, email);
  return `${token}@${VOTE_TOKEN_DOMAIN}`;
}

/** Chave KV onde o script de injeção grava a entrada `token -> email real`. */
export function pollTokenKvKey(token: string): string {
  return `polltoken:${token}`;
}

/** `true` se `token` tem a forma esperada — 24 hex chars minúsculos. Não
 * verifica se o token EXISTE (isso é responsabilidade do lookup no KV). */
export function isValidPollTokenFormat(token: string): boolean {
  return new RegExp(`^[0-9a-f]{${TOKEN_HEX_LEN}}$`).test(token);
}

/** `true` se `email` é um pseudo-email sob o domínio reservado do token de
 * voto (só checa o domínio — não valida a FORMA do token, ver
 * `extractPollToken` pra isso). Espelha `isAnonymousWebIdentity` (lib.ts do
 * Worker), mas pro domínio `vote.eia.diaria.local`, não `web.eia.diaria.local`. */
export function isPollTokenIdentity(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return email.slice(at + 1).toLowerCase() === VOTE_TOKEN_DOMAIN;
}

/**
 * Extrai o local-part (token) de um pseudo-email sob o domínio reservado —
 * `null` se `email` não estiver sob o domínio OU se o local-part não bater a
 * forma esperada (24 hex chars). O caller (handleVote) usa o retorno não-null
 * como sinal "resolve isto via KV antes de continuar".
 */
export function extractPollToken(email: string): string | null {
  if (!isPollTokenIdentity(email)) return null;
  const token = email.slice(0, email.lastIndexOf("@"));
  return isValidPollTokenFormat(token) ? token : null;
}
