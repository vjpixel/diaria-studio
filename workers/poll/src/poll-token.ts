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

/**
 * #4518: branded type — token cru (24 hex chars, `computePollToken`) e
 * pseudo-email completo (`{token}@vote.eia.diaria.local`,
 * `computePollTokenEmail`) compartilhavam o tipo `string` puro antes desta
 * issue, sem distinção estrutural. O #4512 já corrigiu 2 bugs reais dessa
 * mesma raiz (`inject-poll-token.ts` gravando o pseudo-email completo onde
 * devia gravar só o token cru; `extractPollToken` colapsando "fora do
 * domínio" e "token malformado" no mesmo `null`) — este type torna "passar
 * o valor errado onde o outro é esperado" um erro de COMPILAÇÃO, não algo
 * pego só por um teste E2E dedicado (`test/vote-token-e2e-4512.test.ts`).
 * `computePollTokenEmail` continua retornando `string` plano de propósito —
 * é uma forma distinta (o valor final pós-substituição do merge tag), nunca
 * deveria ser tratada como o token cru em nenhum call site.
 */
export type PollToken = string & { readonly __pollToken: unique symbol };

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
 * (secret, email). Email normalizado (lowercase + trim) AQUI, antes do HMAC —
 * `hmacSign` (workers/poll/src/index.ts) em si não normaliza nada, é o
 * CALLER que precisa normalizar antes de invocá-la; mesmo padrão já usado
 * pelo `sig` de voto (callers de `hmacSign`) e pelo antigo `generatePollSig`
 * (#1083). #4512 (correção de comentário, achado comment-analyzer): a versão
 * anterior atribuía a normalização à própria `hmacSign`.
 */
export async function computePollToken(secret: string, email: string): Promise<PollToken> {
  const normalized = email.toLowerCase().trim();
  const full = await hmacHex(secret, `polltoken:${normalized}`);
  // #4518: hex lowercase de TOKEN_HEX_LEN chars por construção (slice de um
  // digest HMAC-SHA256 sempre hex) — cast seguro, é a ÚNICA função que
  // produz um PollToken a partir de dados crus (secret/email).
  return full.slice(0, TOKEN_HEX_LEN) as PollToken;
}

/** Pseudo-email completo (`{token}@vote.eia.diaria.local`) — a identidade
 * final que aparece na URL de voto DEPOIS que a Beehiiv substitui o merge
 * tag `{{poll_token}}` (template já concatena o domínio,
 * `newsletter-render-html.ts::renderEIA`). #4512 (correção de comentário —
 * achado que motivou a correção de `inject-poll-token.ts`, que gravava
 * exatamente ESTE valor completo no custom field por engano, duplicando o
 * domínio na URL final): o custom field Beehiiv `poll_token` grava só o
 * TOKEN CRU (`computePollToken`, sem domínio) — NÃO o valor desta função.
 * `computePollTokenEmail` não tem caller de produção hoje (só testes, que
 * simulam/verificam a identidade final pós-substituição) — mantida como
 * utilidade pura pequena, testada e espelhada, não removida por não ter
 * custo de manutenção real. */
export async function computePollTokenEmail(secret: string, email: string): Promise<string> {
  const token = await computePollToken(secret, email);
  return `${token}@${VOTE_TOKEN_DOMAIN}`;
}

/** Chave KV onde o script de injeção grava a entrada `token -> email real`.
 * #4518: aceita só `PollToken` (não `string` cru) — thread do branded type
 * até o ponto onde o token vira parte de uma key KV; um caller que tentasse
 * passar o pseudo-email completo (`computePollTokenEmail`) por engano não
 * compila mais. */
export function pollTokenKvKey(token: PollToken): string {
  return `polltoken:${token}`;
}

/** `true` se `token` tem a forma esperada — 24 hex chars minúsculos. Não
 * verifica se o token EXISTE (isso é responsabilidade do lookup no KV).
 * #4518: type guard (`token is PollToken`) — todo caller que narrow por esta
 * função ganha o branded type de graça, sem cast explícito (`extractPollToken`/
 * `classifyPollTokenEmail` abaixo dependem disso). */
export function isValidPollTokenFormat(token: string): token is PollToken {
  return new RegExp(`^[0-9a-f]{${TOKEN_HEX_LEN}}$`).test(token);
}

/** `true` se `email` é um pseudo-email sob o domínio reservado do token de
 * voto (só checa o domínio — não valida a FORMA do token, ver
 * `extractPollToken`/`classifyPollTokenEmail` pra isso). Espelha
 * `isAnonymousWebIdentity` (lib.ts do Worker), mas pro domínio
 * `vote.eia.diaria.local`, não `web.eia.diaria.local`. */
export function isPollTokenIdentity(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return email.slice(at + 1).toLowerCase() === VOTE_TOKEN_DOMAIN;
}

/**
 * Extrai o local-part (token) de um pseudo-email sob o domínio reservado —
 * `null` se `email` não estiver sob o domínio OU se o local-part não bater a
 * forma esperada (24 hex chars). O caller (handleVote) usa o retorno não-null
 * como sinal "resolve isto via KV antes de continuar". Mantida (#4518, não
 * removida) por compat com o único call site de produção hoje
 * (`workers/poll/src/vote.ts`) — `classifyPollTokenEmail` abaixo é a versão
 * recomendada pra código NOVO (força o caller a nomear o caso "malformed").
 */
export function extractPollToken(email: string): PollToken | null {
  if (!isPollTokenIdentity(email)) return null;
  const token = email.slice(0, email.lastIndexOf("@"));
  return isValidPollTokenFormat(token) ? token : null;
}

/**
 * #4518 (proposta 2): discriminated union que colapsa `isPollTokenIdentity` +
 * `extractPollToken` numa única classificação — um caller destructurando
 * `.kind` é obrigado a pelo menos NOMEAR o branch `"malformed"` (`if
 * (pollToken)` sozinho, sobre o retorno nullable de `extractPollToken`,
 * compilava mesmo ignorando silenciosamente esse caso — foi exatamente o bug
 * #4512, corrigido ali por convenção de uso correto, não por construção).
 *
 * - `"not-token-domain"` — `email` não está sob `VOTE_TOKEN_DOMAIN` (caso
 *   comum: e-mail real de assinante, brand ≠ diário/beehiiv).
 * - `"malformed"` — está sob o domínio reservado, mas o local-part NÃO é um
 *   token hex de `TOKEN_HEX_LEN` chars válido (identidade fabricada/
 *   corrompida — sinal de algo quebrado, nunca esperado no fluxo normal).
 * - `"valid"` — token bem-formado, pronto pro lookup no KV
 *   (`pollTokenKvKey`).
 */
export type PollTokenClassification =
  | { kind: "not-token-domain" }
  | { kind: "malformed" }
  | { kind: "valid"; token: PollToken };

export function classifyPollTokenEmail(email: string): PollTokenClassification {
  if (!isPollTokenIdentity(email)) return { kind: "not-token-domain" };
  const token = email.slice(0, email.lastIndexOf("@"));
  if (!isValidPollTokenFormat(token)) return { kind: "malformed" };
  return { kind: "valid", token };
}
