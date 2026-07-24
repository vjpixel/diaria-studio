/**
 * workers/poll/src/magic-link.ts (#3996 — Fase B do #3975)
 *
 * Migração de score anônimo→e-mail CROSS-DEVICE/CROSS-SESSÃO, via link
 * mágico de confirmação. Fase A (#3975, identify.ts) já resolve "mesma
 * sessão anônima ATUAL → e-mail" sem fricção (merge determinístico,
 * `mergeWebScores`/`mergeWebScoreByMonth`). O que faltava (#3996): se
 * `email` JÁ tem histórico identificado (`score:{email}` existente) sob um
 * token anônimo DIFERENTE do da sessão atual — nunca confirmado como
 * pertencendo à mesma pessoa — o merge automático SEM verificação seria
 * exatamente o vetor de abuso documentado no header de identify.ts:
 * "alguém pode reivindicar pontos de qualquer sessão passada sob qualquer
 * e-mail" (mesmo de terceiro, sem confirmação). Decisão do editor (260724):
 * exigir confirmação de posse do e-mail via link mágico (token único,
 * mecanismo análogo — mas SEPARADO — do double opt-in da Beehiiv) antes de
 * qualquer merge NÃO-determinístico entre sessões diferentes.
 *
 * Mecanismo:
 *   1. `hasOrphanHistory` detecta o caso: `score:{email}` existe E o par
 *      (email, anonEmail-da-sessão-atual) nunca foi confirmado antes
 *      (`identify-linked:{email}:{anonEmail}` ausente no KV).
 *   2. Quando detectado, `handleJogarIdentify` (identify.ts) NÃO mergeia na
 *      hora — cria um token de confirmação (`createPendingMerge`, UUID via
 *      `crypto.randomUUID()`, TTL 24h) e manda um e-mail transacional via
 *      Brevo (`sendMagicLinkEmail`) com o link `/confirm-merge?token=...`.
 *   3. `GET /confirm-merge` (`handleConfirmMerge`) valida o token (existe,
 *      não expirado — TTL do KV — , one-time-use via delete-on-read) e SÓ
 *      ENTÃO chama `performIdentifyMerge` (identify.ts) — a MESMA função
 *      usada pelo caminho sem-conflito, nunca duplicada.
 *   4. Após qualquer merge bem-sucedido (imediato OU confirmado),
 *      `markIdentifyLinked` grava `identify-linked:{email}:{anonEmail}` —
 *      próximas re-sincronizações silenciosas do MESMO device
 *      (`window.__jogarIdentify.sync`, disparada a cada rodada jogada,
 *      ver identityFormScript/jogar.ts) caem no caminho rápido de novo, sem
 *      precisar de um novo e-mail a cada rodada.
 *
 * Segurança (self-review #2038 tem foco extra aqui, ver PR):
 *   - Token: `crypto.randomUUID()` (não sequencial, não adivinhável),
 *     TTL 24h via `expirationTtl` do KV, one-time-use (delete imediato na
 *     leitura — replay do MESMO link sempre falha após o 1º uso, mesmo
 *     antes do TTL expirar).
 *   - Rate-limit por PAR (anonEmail atual, email alvo) — `checkMagicLinkSendRateLimit`
 *     — evita disparo em massa de e-mails de confirmação pra endereços
 *     arbitrários a partir de um único token anônimo. `hasPendingMerge`
 *     evita reenvio duplicado enquanto o link anterior ainda está vivo
 *     (crítico pro `sync()` silencioso não gerar 1 e-mail por rodada
 *     jogada).
 *   - Enumeração de e-mail (item 6 da issue): a resposta de
 *     `POST /jogar/identify` é UNIFORME (`{ ok: true, pending: true }`)
 *     tanto quando o teto de rate-limit foi atingido quanto quando o
 *     e-mail acabou de ser enviado — nunca diferencia os dois motivos.
 *     Risco residual DOCUMENTADO (não fechado 100%): o fato de a resposta
 *     ser `pending: true` (merge diferido) em vez do caminho imediato
 *     (`{ ok: true, subscribed }`) já sinaliza "este e-mail tem histórico
 *     prévio" pra quem testar o endpoint sistematicamente — mesma classe de
 *     informação que o leaderboard público já expõe (nickname/email
 *     mascarado), não uma superfície nova de dados privados, mas não é
 *     constant-time/constant-response perfeito. Fechar isso 100% exigiria
 *     SEMPRE responder `pending: true` (mesmo no 1º cadastro, sem
 *     histórico) — o que reintroduziria fricção pra todo mundo (contrário
 *     ao requisito explícito de manter a Fase A sem fricção). Ver follow-up
 *     sugerido no PR se o editor quiser fechar esse resíduo depois.
 *   - Token nunca aparece em `console.error` (grep por `event.*magiclink`
 *     neste arquivo: nenhum log inclui `token`/`email`/`confirmUrl`).
 *   - `GET /confirm-merge` valida a FORMA do `token` (UUID) antes de
 *     qualquer leitura de KV — mesma disciplina de `isValidWebToken`/
 *     `isValidVoteEditionFormat` no resto do worker.
 *
 * Nota de import circular (mesmo padrão JÁ usado por index.ts↔subscribe.ts↔
 * identify.ts, ver header de identify.ts): este módulo importa
 * `performIdentifyMerge`/tipos de `identify.ts`; `identify.ts` importa deste
 * módulo (`hasOrphanHistory`, `hasPendingMerge`, etc.) — ciclo seguro porque
 * todo valor importado só é USADO em request-time (dentro de funções),
 * nunca no top-level de nenhum dos dois módulos.
 */
import type { Env } from "./index";
import { htmlEscape, safeParseKv } from "./lib";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";
import { performIdentifyMerge, type IdentifyMergeInput } from "./identify";

/** TTL do token de confirmação — 24h (item 2 da issue). */
export const MAGIC_LINK_TTL_SEC = 60 * 60 * 24;

/** Teto de e-mails de confirmação por par (anonEmail atual, email alvo) por janela (item 5). */
export const MAGIC_LINK_SEND_RATE_LIMIT = 3;
export const MAGIC_LINK_SEND_RATE_WINDOW_SEC = 60 * 60 * 24; // 24h

/** Forma genérica de UUID (v1-v5) — token gerado por `crypto.randomUUID()`
 * (sempre v4, mas o validador aceita a forma genérica por robustez, mesma
 * disciplina "validar FORMA, não reimplementar geração" do resto do worker). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidMagicLinkToken(token: string): boolean {
  return UUID_RE.test(token);
}

export function generateMagicLinkToken(): string {
  return crypto.randomUUID();
}

function pendingMergeKey(token: string): string {
  return `magiclink:${token}`;
}

function pendingForKey(email: string, anonEmail: string): string {
  return `pending-for:${email}:${anonEmail}`;
}

function identifyLinkedKey(email: string, anonEmail: string): string {
  return `identify-linked:${email}:${anonEmail}`;
}

function magicLinkSendRateKey(anonEmail: string, email: string): string {
  return `rl:magiclink:${anonEmail}:${email}`;
}

/**
 * #3996: true quando o par (email, anonEmail) já foi CONFIRMADO antes
 * (imediatamente — 1ª identificação sem conflito — ou via link mágico) —
 * `hasOrphanHistory` usa isto pra decidir se o par atual já é "de confiança"
 * mesmo com `score:{email}` pré-existente.
 */
export async function isIdentifyLinked(bEnv: Env, email: string, anonEmail: string): Promise<boolean> {
  return !!(await bEnv.POLL.get(identifyLinkedKey(email, anonEmail)));
}

/** Marca o par (email, anonEmail) como confirmado — chamado por `performIdentifyMerge`
 * (identify.ts) após QUALQUER merge bem-sucedido (imediato ou confirmado). */
export async function markIdentifyLinked(bEnv: Env, email: string, anonEmail: string): Promise<void> {
  await bEnv.POLL.put(identifyLinkedKey(email, anonEmail), "1");
}

/**
 * #3996: detecta "score histórico órfão" — `score:{email}` já existe no KV
 * (histórico identificado prévio, de QUALQUER origem) E o par (email,
 * anonEmail-da-sessão-atual) nunca foi confirmado. Quando `true`,
 * `handleJogarIdentify` (identify.ts) NÃO mergeia na hora — dispara o fluxo
 * de confirmação por link mágico (`handleOrphanIdentify`, identify.ts).
 *
 * `false` cobre 2 casos legítimos de caminho rápido (sem fricção,
 * preservando a UX da Fase A):
 *   1. `score:{email}` nunca existiu (1ª identificação desse e-mail, em
 *      qualquer device) — nada a proteger, merge é trivial.
 *   2. `score:{email}` existe MAS já foi confirmado pra este MESMO
 *      anonEmail antes (1ª identificação neste device já passou pelo fluxo
 *      — imediato ou via link mágico — e o re-sync silencioso subsequente
 *      não deve pedir confirmação de novo a cada rodada).
 *
 * IMPORTANTE: o CALLER (`handleJogarIdentify`, identify.ts) só consulta esta
 * função quando `name` (do form) é NÃO-vazio — ou seja, só pra submissões
 * EXPLÍCITAS do form de identidade, nunca pro re-sync silencioso
 * (`sync()`/identityFormScript, `name: ""`). Sem esse gate no caller,
 * qualquer jogador identificado ANTES do #3996 existir (cujo par nunca foi
 * gravado em `identify-linked`, chave que não existia antes desta issue)
 * teria o PRÓXIMO re-sync automático classificado como órfão — quebra
 * silenciosa e permanente (achado de self-review, ver comentário completo
 * no call site em identify.ts).
 */
export async function hasOrphanHistory(bEnv: Env, email: string, anonEmail: string): Promise<boolean> {
  const [existingRaw, linked] = await Promise.all([
    bEnv.POLL.get(`score:${email}`),
    bEnv.POLL.get(identifyLinkedKey(email, anonEmail)),
  ]);
  return !!existingRaw && !linked;
}

export interface MagicLinkRateLimitResult {
  allowed: boolean;
  count: number;
}

/**
 * #3996 (item 5): rate-limit de ENVIO por par (anonEmail atual, email alvo)
 * — independente do rate-limit geral de `/jogar/identify` (`checkIdentifyRateLimit`,
 * identify.ts, por IP). Este é mais estrito e por PAR: mesmo um IP dentro do
 * teto geral não pode martelar e-mails de confirmação pro MESMO alvo
 * repetidamente. `hasPendingMerge` (abaixo) já intercepta a maioria dos
 * reenvios (link ainda vivo) antes de chegar aqui — este teto é defesa em
 * profundidade pro caso do link anterior ter expirado/sido consumido e um
 * novo ciclo de tentativas começar.
 */
export async function checkMagicLinkSendRateLimit(
  kv: KVNamespace,
  anonEmail: string,
  email: string,
  limit: number = MAGIC_LINK_SEND_RATE_LIMIT,
  windowSec: number = MAGIC_LINK_SEND_RATE_WINDOW_SEC,
): Promise<MagicLinkRateLimitResult> {
  const key = magicLinkSendRateKey(anonEmail, email);
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

export interface PendingMerge {
  email: string;
  anonEmail: string;
  name: string;
  edition: string;
}

/**
 * #3996: true quando já existe um link mágico VIVO (não expirado, não
 * consumido) pro par (email, anonEmail) — usado pra NÃO reenviar e-mail a
 * cada chamada de `handleOrphanIdentify` enquanto o link anterior ainda
 * pode ser confirmado (crítico: `window.__jogarIdentify.sync`, jogar.ts,
 * chama `/jogar/identify` a cada rodada jogada — sem este guard, cada
 * rodada geraria um novo e-mail).
 */
export async function hasPendingMerge(bEnv: Env, email: string, anonEmail: string): Promise<boolean> {
  const token = await bEnv.POLL.get(pendingForKey(email, anonEmail));
  if (!token) return false;
  // Confere que o token referenciado pelo índice secundário ainda é válido —
  // ambos são escritos com o MESMO TTL (ver createPendingMerge), então só
  // divergem em teoria por corrida entre os 2 `put`s; tratar como "sem
  // pendência" nesse caso deixa o caller criar um novo ciclo limpo.
  const stillValid = await bEnv.POLL.get(pendingMergeKey(token));
  return !!stillValid;
}

/**
 * #3996: cria o token de confirmação + registra o índice secundário
 * (email,anonEmail)→token (usado por `hasPendingMerge` pra dedup de envio).
 * Ambas as chaves compartilham o mesmo TTL (`MAGIC_LINK_TTL_SEC`).
 */
export async function createPendingMerge(bEnv: Env, pending: PendingMerge): Promise<string> {
  const token = generateMagicLinkToken();
  await Promise.all([
    bEnv.POLL.put(pendingMergeKey(token), JSON.stringify(pending), { expirationTtl: MAGIC_LINK_TTL_SEC }),
    bEnv.POLL.put(pendingForKey(pending.email, pending.anonEmail), token, { expirationTtl: MAGIC_LINK_TTL_SEC }),
  ]);
  return token;
}

/**
 * #3996: consome o token — leitura + DELETE IMEDIATO (one-time-use: replay
 * do MESMO link após o 1º uso bem-sucedido sempre retorna `null`, mesmo
 * antes do TTL expirar). Também limpa o índice secundário (`pending-for`)
 * pra não deixar referência órfã apontando pra um token já consumido.
 *
 * `null` cobre 3 casos indistinguíveis pro chamador (mesma mensagem de erro
 * em todos — não vaza qual dos 3 ocorreu): token nunca existiu, expirou
 * (TTL do KV), ou já foi usado antes.
 */
export async function consumePendingMerge(bEnv: Env, token: string): Promise<PendingMerge | null> {
  const raw = await bEnv.POLL.get(pendingMergeKey(token));
  if (!raw) return null;
  await bEnv.POLL.delete(pendingMergeKey(token));
  // #3996 (item 6): `context` do log é um literal fixo — nunca o token nem
  // o e-mail, mesmo em caso de parse error.
  const pending = safeParseKv<PendingMerge>(raw, "magiclink_consume_parse_error", "pending-merge");
  if (pending) await bEnv.POLL.delete(pendingForKey(pending.email, pending.anonEmail));
  return pending;
}

/**
 * Pure (#3996): monta a URL de confirmação a partir da URL da request atual
 * (mesmo host/protocolo — nunca hardcoded) + `?brand=web` (o router de
 * index.ts deriva `bEnv` do brand na query string; `/confirm-merge` só faz
 * sentido pro brand `web`, mesmo racional de `/jogar/identify?brand=web` em
 * identityFormScript/jogar.ts).
 */
export function buildConfirmMergeUrl(requestUrl: string, token: string): string {
  const url = new URL(requestUrl);
  url.pathname = "/confirm-merge";
  url.search = "";
  url.searchParams.set("token", token);
  url.searchParams.set("brand", "web");
  return url.toString();
}

export interface MagicLinkEmailInput {
  name: string;
  email: string;
  confirmUrl: string;
}

export interface MagicLinkEmailResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "brevo_error";
}

/**
 * #3996: envio do e-mail de confirmação via API transacional da Brevo
 * (`POST /v3/smtp/email`, doc developers.brevo.com/reference/sendtransacemail)
 * — mesma conta/key já paga usada pelas campanhas em massa da Clarice
 * (`scripts/lib/brevo-client.ts`, header `api-key`, confirmado o mesmo
 * padrão de auth aqui), zero custo recorrente adicional.
 *
 * SEGREDO PRÓPRIO (não compartilhado com `BREVO_CLARICE_API_KEY` dos
 * scripts Node): o worker `poll` roda num ambiente de execução SEPARADO
 * (Cloudflare Workers, secrets via `wrangler secret put`) do processo Node
 * dos scripts do repo — não há como o worker ler `process.env` da máquina
 * do editor. `BREVO_API_KEY` aqui é um secret PRÓPRIO do worker; o editor
 * pode configurá-lo com o MESMO valor de `BREVO_CLARICE_API_KEY` (mesma
 * conta Brevo, permissão de "transactional emails" precisa estar habilitada
 * pra essa key — não verificável a partir deste sandbox de desenvolvimento;
 * documentado em SECRETS.md pro editor confirmar/ativar).
 *
 * Ausência de `BREVO_API_KEY`/`BREVO_SENDER_EMAIL` → `not_configured`
 * (mesmo padrão de `subscribeToBeehiiv`, subscribe.ts): o mecanismo inteiro
 * (detecção + token + rate-limit + endpoint de confirmação) já funciona e
 * fica pronto; só o e-mail em si não sai até o secret ser configurado. Isto
 * é FAIL-CLOSED do lado do merge (nunca mergeia sem confirmação, mesmo sem
 * secret) — não um fallback pra merge imediato.
 *
 * `fetchImpl` injetável — NUNCA rede real em teste (#633, guard do
 * overnight): todos os testes deste módulo mockam `fetchImpl`.
 */
export async function sendMagicLinkEmail(
  env: Env,
  input: MagicLinkEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MagicLinkEmailResult> {
  const apiKey = env.BREVO_API_KEY;
  const senderEmail = env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) return { ok: false, status: 503, reason: "not_configured" };

  const senderName = env.BREVO_SENDER_NAME || "Diar.ia — É IA?";
  const greeting = input.name.trim() ? `Oi, ${htmlEscape(input.name.trim())}!` : "Oi!";
  const safeUrl = htmlEscape(input.confirmUrl);
  const body = {
    sender: { email: senderEmail, name: senderName },
    to: [{ email: input.email, ...(input.name.trim() ? { name: input.name.trim() } : {}) }],
    subject: "Confirme a migração do seu histórico no É IA?",
    htmlContent: `<p>${greeting}</p><p>Detectamos que este e-mail já tem histórico no ranking do <strong>É IA?</strong>. Pra migrar o que você acabou de jogar neste navegador pro mesmo ranking, confirme clicando no link abaixo (vale por 24h):</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>Se você não pediu isso, ignore este e-mail — nada muda no seu ranking.</p>`,
  };

  let res: Response;
  try {
    res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, reason: "brevo_error" };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: "brevo_error" };
}

/**
 * Pure (#3996): HTML de resposta pro clique no link mágico — página simples,
 * mesmo DS canônico (ds-tokens.generated.ts) do resto do worker. `ok=false`
 * cobre token ausente/malformado/expirado/já usado — SEMPRE a mesma
 * mensagem genérica (nunca distingue o motivo, ver `consumePendingMerge`).
 */
export function confirmMergeHtmlResponse(ok: boolean, message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? — confirmação de ranking</title>
<style>
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 480px; margin: 60px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  p.msg { font-family: ${DS_FONTS.serif}; font-size: 1.3rem; line-height: 1.5; margin: 20px 0; }
  a { color: ${DS_COLORS.ink}; }
</style>
</head>
<body>
<p class="msg">${htmlEscape(message)}</p>
<p><a href="/jogar">Voltar para o jogo</a></p>
</body>
</html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Handler `GET /confirm-merge?token=...&brand=web` (#3996). Fluxo: valida a
 * FORMA do token (UUID, antes de qualquer leitura de KV) → consome
 * (`consumePendingMerge` — one-time-use) → `performIdentifyMerge` (MESMA
 * função de identify.ts, nunca duplicada) → HTML de sucesso.
 *
 * Token inválido/expirado/já usado → HTML genérico de erro, sempre a MESMA
 * mensagem (nunca revela qual dos 3 motivos — mesma disciplina de
 * `/share/{token}`/`/quiz-share/{token}`, exceto que aqui não faz sentido
 * redirecionar pro jogo com um 302 silencioso: é uma confirmação explícita,
 * a pessoa precisa saber que não funcionou).
 */
export async function handleConfirmMerge(url: URL, bEnv: Env): Promise<Response> {
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token || !isValidMagicLinkToken(token)) {
    return confirmMergeHtmlResponse(false, "Link inválido.");
  }
  const pending = await consumePendingMerge(bEnv, token);
  if (!pending) {
    return confirmMergeHtmlResponse(false, "Link inválido, expirado ou já usado.");
  }
  const mergeInput: IdentifyMergeInput = {
    email: pending.email,
    anonEmail: pending.anonEmail,
    name: pending.name,
    edition: pending.edition || null,
  };
  await performIdentifyMerge(bEnv, mergeInput);
  return confirmMergeHtmlResponse(true, `Pronto! Seu histórico foi migrado — você está no ranking como ${pending.email}.`);
}
