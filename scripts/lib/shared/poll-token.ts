/**
 * poll-token.ts (#4487)
 *
 * Token opaco por assinante pro link de voto do quiz "É IA?" no e-mail
 * (esp="beehiiv", modo merge-tag). Substitui o e-mail cru na URL de voto
 * (`/vote?email={{email}}&edition=...&choice=...`) — achado #4487/#4456:
 * quem recebe a edição ENCAMINHADA (WhatsApp/e-mail) herda o link do
 * remetente e, ao clicar, vota EM NOME DELE (mesmo e-mail na URL), sujando
 * o leaderboard e vazando o e-mail real do assinante pra quem quer que
 * receba o encaminhamento.
 *
 * Design (#4487, "Comece por aqui" — item de maior impacto da issue):
 *
 * 1. Token = HMAC-SHA256(POLL_SECRET, "polltoken:" + email-normalizado),
 *    truncado pra 24 hex chars (~96 bits) — DETERMINÍSTICO: a mesma entrada
 *    sempre produz o mesmo token, então o script de injeção
 *    (`scripts/inject-poll-token.ts`) é idempotente sem precisar ler estado
 *    prévio pra decidir se recalcula.
 *
 * 2. HMAC é IRREVERSÍVEL por construção — o token NÃO pode ser decodificado
 *    de volta pro e-mail sem uma tabela de lookup. Essa tabela é o KV
 *    `polltoken:{token} -> email`, escrito pelo MESMO script de injeção no
 *    momento em que popula o custom field `poll_token` na Beehiiv (única
 *    forma de colocar um valor NÃO-email por assinante na URL de merge-tag
 *    — Beehiiv só expõe merge tags de campos padrão/custom já populados
 *    ANTES do envio, sem suporte a função/transform no editor de post, ver
 *    #1186 — o antecessor `poll_sig`/`inject-poll-sig.ts` usava o mesmo
 *    mecanismo de custom field, removido em #1186 por decisão editorial
 *    ("leaderboard não tem aposta real, HMAC de anti-forjamento
 *    desnecessário") que NÃO se aplica aqui: o objetivo desta vez não é
 *    autenticar o voto, é parar de vazar e-mail + herdar identidade no
 *    encaminhamento.
 *
 * 3. `email` real continua sendo a chave canônica de TODO o resto do
 *    sistema (`score:{email}`, `vote:{edition}:{email}`, nickname,
 *    streak, leaderboard) — o Worker resolve token → email LOGO NO INÍCIO
 *    de `handleVote` (antes de qualquer lógica de score/dedup/sig) e segue
 *    100% inalterado a partir daí. Isso preserva o histórico de quem já
 *    vota há meses — sem essa resolução, trocar a URL pra um token novo
 *    resetaria silenciosamente streak/nickname de todo mundo (identidade
 *    nova = registro novo).
 *
 * 4. Token sem entrada no KV (nunca injetado — subscriber novo antes do
 *    próximo sync incremental — ou POLL_SECRET rotacionado sem re-sync)
 *    falha como "link inválido", mesmo comportamento de qualquer outro
 *    parâmetro malformado em `/vote`. Fail-closed, nunca fail-open pra um
 *    e-mail arbitrário.
 *
 * Domínio reservado `VOTE_TOKEN_DOMAIN`: o token vira o local-part de um
 * pseudo-email (`{token}@vote.eia.diaria.local`), reaproveitando o parser
 * de `email` já existente em `/vote` (mesmo truque de `web.eia.diaria.local`
 * pro brand `web` anônimo, #3976/#4011 — mas um domínio DISTINTO e
 * reservado só pro modo merge-tag do diário; nunca reusar
 * `WEB_TOKEN_DOMAIN` aqui, são identidades de natureza diferente: o token
 * `web` é anônimo/client-side e nunca resolve pra um e-mail real, o token
 * `vote.eia.diaria.local` sempre resolve pra um assinante real via KV).
 *
 * **Fronteira `lib/shared/` (#2747):** só Web Crypto (`crypto.subtle`),
 * zero import de `node:*` — roda idêntico em Node (script de injeção,
 * testes) e no runtime Cloudflare Workers. Espelhado byte-a-byte em
 * `workers/poll/src/poll-token.ts` (o bundle do Worker `poll` não alcança
 * `scripts/**`, mesmo motivo/mecanismo de `session-cookie.ts`/
 * `utm-registry.ts` — ver header desse arquivo). Sincronia lint-enforced
 * por `test/poll-token-mirror-4487.test.ts`.
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
