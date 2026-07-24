/**
 * workers/poll/src/identify.ts (#3975)
 *
 * Identidade por e-mail no leaderboard do "É IA?" standalone (brand `web`).
 * Decisão do editor (260723): "Peça o nome ou apelido E o e-mail da pessoa
 * para que ela possa entrar no leaderboard [...] Não faz sentido ter o jogo
 * se não estamos capturando o e-mail das pessoas."
 *
 * Fase A (esta entrega — ver PR #3975 pro rationale completo de faseamento):
 *   1. Jogar continua 100% anônimo durante as rodadas (token UUID client-side,
 *      `anonEmailForToken` em jogar.ts — INTOCADO).
 *   2. Form único na tela final (`#seq-final` da sequência e no resultado do
 *      par único, `renderJogarPageHtml`/`renderJogarSequencePageHtml` em
 *      jogar.ts) pede nome/apelido + e-mail + checkbox de assinatura opcional
 *      (reusa `subscribeToBeehiiv`, #3580).
 *   3. `POST /jogar/identify` migra o score da sessão anônima ATUAL
 *      (`score:{anonEmail}` / `score-by-month:{slug}:{anonEmail}`, ambos já
 *      branded pelo brand `web`) pra uma entrada `score:{email}` /
 *      `score-by-month:{slug}:{email}` — merge determinístico (soma totais,
 *      mantém o maior streak, ver `mergeWebScores`/`mergeWebScoreByMonth`).
 *      A entrada ANTERIOR sob o token anônimo NUNCA é apagada (ela só some
 *      da exibição pública via o filtro `isAnonymousWebIdentity`, ver
 *      leaderboard-routes.ts).
 *   4. E-mail identificado persiste em localStorage (`eia_web_identified_email`,
 *      ver identityFormScript/jogar.ts) — o CLIENTE continua votando via o
 *      MESMO token anônimo (o guard #3976 `isValidWebToken` em `handleVote`
 *      exige a forma `{uuid}@web.eia.diaria.local` — nunca aceita um e-mail
 *      real como identidade de VOTO, isso não muda), mas dispara um
 *      re-sync SILENCIOSO (`name` vazio → preserva nickname existente, ver
 *      `mergeWebScores`) pra este mesmo endpoint depois de cada rodada
 *      seguinte — "próximos votos desse browser já saem direto na
 *      identidade do e-mail" sem reabrir o form.
 *
 * Fase B (#3996 — IMPLEMENTADA neste módulo em conjunto com magic-link.ts):
 * migração de score anônimo→e-mail preexistente vindo de OUTRO device/sessão
 * sem re-jogar. `score:{email}` já é uma chave GLOBAL (não por device) — se
 * `email` JÁ tem histórico identificado (de qualquer origem) sob um token
 * DIFERENTE do da sessão atual, mergear direto sem verificação seria
 * exatamente "reivindicar pontos de qualquer sessão passada sob qualquer
 * e-mail" (o risco descrito no parágrafo de Segurança abaixo, sem limite).
 * `hasOrphanHistory` (magic-link.ts) detecta esse caso; quando true,
 * `handleJogarIdentify` desvia pro fluxo de confirmação por link mágico
 * (`handleOrphanIdentify` abaixo) em vez de mergear na hora — ver rationale
 * completo no header de magic-link.ts.
 *
 * Segurança: a "identificação" imediata (caminho SEM histórico órfão, ver
 * acima) continua NÃO verificando posse do e-mail (mesmo nível de confiança
 * que o nickname já tem hoje — zero verificação, ver `handleSetName` em
 * index.ts) — isto não é uma regressão: `/vote` continua SÓ aceitando o
 * token anônimo UUID como identidade de escrita (#3976) — o e-mail aqui é só
 * um RÓTULO de exibição atribuído pelo dono do token atual (quem controla o
 * localStorage deste browser), nunca uma credencial de autorização de voto.
 * Alguém pode identificar o PRÓPRIO score anônimo (sem histórico prévio sob
 * outro token) sob qualquer e-mail (mesmo de terceiro) sem confirmação —
 * mesma classe de risco que digitar qualquer nickname hoje, não uma classe
 * nova. O que #3996 fecha é especificamente o caso onde JÁ HÁ histórico
 * identificado em jogo — esse caminho agora exige confirmação de posse.
 */
import type { Env } from "./index";
import { json } from "./index";
import {
  AAMMDD_RE,
  editionToMonthSlug,
  isAnonymousWebIdentity, // #3975: e-mail não pode ser o próprio domínio anônimo
  isValidVoteEmailFormat,
  isValidWebToken, // #3976: anonEmail precisa ser o token client-side genuíno
  safeParseKv,
} from "./lib";
import { invalidateSnapshot } from "./leaderboard-routes";
import { subscribeToBeehiiv } from "./subscribe";
// #3996 (Fase B): ciclo de import seguro com magic-link.ts (mesmo padrão já
// documentado no header deste arquivo e no de magic-link.ts) — valores só
// usados em request-time, nunca no top-level de nenhum dos dois módulos.
import {
  hasOrphanHistory,
  hasPendingMerge,
  createPendingMerge,
  checkMagicLinkSendRateLimit,
  sendMagicLinkEmail,
  buildConfirmMergeUrl,
  markIdentifyLinked,
} from "./magic-link";

/** Shape de `score:{email}` (brand web) — ver `updateScore` em vote.ts. */
export interface WebScore {
  total: number;
  correct: number;
  streak: number;
  last_edition: string | null;
  nickname?: string | null;
}

/** Shape de `score-by-month:{slug}:{email}` (brand web) — ver `updateScoreByMonth` em vote.ts. */
export interface WebScoreByMonth {
  total: number;
  correct: number;
  last_edition: string | null;
  nickname: string | null;
  last_vote_ts?: string;
}

/**
 * Pure (#3975): `AAMMDD` mais recente entre duas edições (comparação lexical
 * — válida porque AAMMDD é zero-padded e cresce monotonicamente com o
 * tempo). `null` de um dos lados retorna o outro; ambos `null` retorna `null`.
 */
export function pickMoreRecentEdition(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Pure (#3975): regra de merge determinística entre o score PRÉ-EXISTENTE de
 * um e-mail identificado (`existing`, pode ser `null` — 1ª identificação) e
 * o score da sessão anônima ATUAL (`incoming`, pode ser `null` — token que
 * nunca votou, ex: identificar antes de jogar). Testada explicitamente
 * (ver test/poll-jogar-identify-3975.test.ts):
 *   - total/correct: SOMA (o que a pessoa acabou de jogar precisa contar).
 *   - streak: MAIOR dos dois (não soma — streak é uma sequência contínua,
 *     não um contador cumulativo; somar dois streaks de dispositivos
 *     diferentes produziria um número sem sentido semântico).
 *   - last_edition: a mais RECENTE das duas (lexical, AAMMDD).
 *   - nickname: `name` (trim) quando não-vazio SEMPRE vence — é o valor que
 *     o formulário explícito acabou de enviar. `name` vazio (re-sync
 *     silencioso pós-identificação, ver header do arquivo) preserva o
 *     nickname já existente (existing primeiro, incoming como fallback).
 */
export function mergeWebScores(
  existing: WebScore | null,
  incoming: WebScore | null,
  name: string,
): WebScore {
  const trimmedName = name.trim();
  const nickname = trimmedName || existing?.nickname || incoming?.nickname || null;
  if (!existing && !incoming) {
    return { total: 0, correct: 0, streak: 0, last_edition: null, nickname };
  }
  if (!existing) {
    return { total: incoming!.total ?? 0, correct: incoming!.correct ?? 0, streak: incoming!.streak ?? 0, last_edition: incoming!.last_edition ?? null, nickname };
  }
  if (!incoming) {
    return { total: existing.total ?? 0, correct: existing.correct ?? 0, streak: existing.streak ?? 0, last_edition: existing.last_edition ?? null, nickname };
  }
  return {
    total: (existing.total ?? 0) + (incoming.total ?? 0),
    correct: (existing.correct ?? 0) + (incoming.correct ?? 0),
    streak: Math.max(existing.streak ?? 0, incoming.streak ?? 0),
    last_edition: pickMoreRecentEdition(existing.last_edition ?? null, incoming.last_edition ?? null),
    nickname,
  };
}

/**
 * Pure (#3975): mesmo racional de `mergeWebScores`, pro índice mensal
 * (`score-by-month:{slug}:{email}`) que alimenta o leaderboard público
 * diretamente. Sem `streak` (não existe nesse índice, ver
 * `scoreByMonthEntriesToLeaderboard`/`updateScoreByMonth`). `last_vote_ts`
 * usa o MAIS RECENTE dos dois (comparação ISO 8601 lexical, mesma disciplina
 * de `mergeYearEntries` em leaderboard-routes.ts) — tiebreaker de dense-rank.
 */
export function mergeWebScoreByMonth(
  existing: WebScoreByMonth | null,
  incoming: WebScoreByMonth | null,
  name: string,
): WebScoreByMonth {
  const trimmedName = name.trim();
  const nickname = trimmedName || existing?.nickname || incoming?.nickname || null;
  const lastVoteTs = existing?.last_vote_ts && incoming?.last_vote_ts
    ? (existing.last_vote_ts >= incoming.last_vote_ts ? existing.last_vote_ts : incoming.last_vote_ts)
    : (existing?.last_vote_ts ?? incoming?.last_vote_ts);
  if (!existing && !incoming) {
    return { total: 0, correct: 0, last_edition: null, nickname };
  }
  if (!existing) {
    return { total: incoming!.total ?? 0, correct: incoming!.correct ?? 0, last_edition: incoming!.last_edition ?? null, nickname, ...(lastVoteTs ? { last_vote_ts: lastVoteTs } : {}) };
  }
  if (!incoming) {
    return { total: existing.total ?? 0, correct: existing.correct ?? 0, last_edition: existing.last_edition ?? null, nickname, ...(lastVoteTs ? { last_vote_ts: lastVoteTs } : {}) };
  }
  return {
    total: (existing.total ?? 0) + (incoming.total ?? 0),
    correct: (existing.correct ?? 0) + (incoming.correct ?? 0),
    last_edition: pickMoreRecentEdition(existing.last_edition ?? null, incoming.last_edition ?? null),
    nickname,
    ...(lastVoteTs ? { last_vote_ts: lastVoteTs } : {}),
  };
}

export interface ParsedIdentify {
  name: string;
  email: string;
  anonEmail: string;
  optin: boolean;
  /** AAMMDD representativo da sessão (1ª edição da sequência, ou a edição do
   * par único) — usado só pra derivar o monthSlug do índice mensal a migrar.
   * String vazia = migração global apenas (sem score-by-month). */
  edition: string;
  /** honeypot — campo invisível que só bot preenche. */
  honeypot: string;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truthyFlag(v: unknown): boolean {
  if (v === true) return true;
  const s = asStr(v).trim().toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes";
}

/**
 * Pure (#3975): parse do corpo do POST — mesmo padrão de
 * `parseSubscribeBody` (subscribe.ts, #3580): aceita `application/json`
 * (caminho real do cliente) e `application/x-www-form-urlencoded`
 * (fallback defensivo). Nunca lança.
 */
export function parseIdentifyBody(raw: string, contentType: string): ParsedIdentify {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return {
        name: asStr(o.name),
        email: asStr(o.email),
        anonEmail: asStr(o.anonEmail),
        optin: truthyFlag(o.optin),
        edition: asStr(o.edition),
        honeypot: asStr(o.website),
      };
    } catch {
      return { name: "", email: "", anonEmail: "", optin: false, edition: "", honeypot: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return {
    name: params.get("name") ?? "",
    email: params.get("email") ?? "",
    anonEmail: params.get("anonEmail") ?? "",
    optin: truthyFlag(params.get("optin")),
    edition: params.get("edition") ?? "",
    honeypot: params.get("website") ?? "",
  };
}

export type IdentifyValidation =
  | { ok: true; name: string; email: string; anonEmail: string; edition: string | null; optin: boolean }
  | { ok: false; status: number; error: string };

/**
 * Pure (#3975): valida o input server-side. Ordem (mesma disciplina de
 * `validateSubscribeInput`, subscribe.ts):
 *   1. honeypot preenchido → `honeypot` (handler responde 200 fake-success).
 *   2. e-mail em forma inválida OU sob o próprio domínio anônimo reservado
 *      (`isAnonymousWebIdentity` — identificar-se COMO um token anônimo não
 *      faz sentido, e quebraria o próprio filtro que #3975 introduz) → 400
 *      `invalid_email`.
 *   3. `anonEmail` ausente ou não é a forma exata de token client-side
 *      genuíno (#3976 `isValidWebToken`) → 400 `invalid_anon_email` — sem
 *      isso, qualquer chamador poderia migrar o score de UM token anônimo
 *      arbitrário (não necessariamente o seu) pra qualquer e-mail.
 * `name` NÃO é obrigatório aqui (pode ser "" — re-sync silencioso pós-
 * identificação, ver header do arquivo); o form client-side exige
 * preenchimento via atributo `required`, mas a validação server-side
 * permanece permissiva pro caminho automático.
 */
export function validateIdentifyInput(p: ParsedIdentify): IdentifyValidation {
  if (p.honeypot && p.honeypot.trim() !== "") {
    return { ok: false, status: 200, error: "honeypot" };
  }
  const email = (p.email || "").trim().toLowerCase();
  if (!isValidVoteEmailFormat(email) || isAnonymousWebIdentity(email)) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  const anonEmail = (p.anonEmail || "").trim().toLowerCase();
  if (!anonEmail || !isValidWebToken(anonEmail)) {
    return { ok: false, status: 400, error: "invalid_anon_email" };
  }
  const name = (p.name || "").trim().slice(0, IDENTIFY_NAME_MAX);
  const editionRaw = (p.edition || "").trim();
  const edition = AAMMDD_RE.test(editionRaw) ? editionRaw : null;
  return { ok: true, name, email, anonEmail, edition, optin: p.optin };
}

export interface IdentifyRateLimitResult {
  allowed: boolean;
  count: number;
}

/** Teto de tamanho pro nome — mesmo valor de subscribe.ts (`SUBSCRIBE_NAME_MAX`). */
export const IDENTIFY_NAME_MAX = 100;

export const IDENTIFY_RATE_LIMIT = 10;
export const IDENTIFY_RATE_WINDOW_SEC = 3600; // 1h

/**
 * #3975: rate-limit por IP via KV — mesmo mecanismo de
 * `checkSubscribeRateLimit` (subscribe.ts, #3580), key própria
 * (`rl:identify:{ip}`, prefixo distinto de `rl:subscribe:{ip}`) pra não
 * compartilhar o mesmo balde: identificar o score e assinar a newsletter são
 * ações DIFERENTES que um mesmo leitor pode fazer em sequência sem se
 * limitarem mutuamente. Limite mais alto que subscribe (10 vs 5) porque o
 * re-sync silencioso (ver header do arquivo) pode disparar 1x por rodada
 * jogada, não só 1x por sessão.
 */
export async function checkIdentifyRateLimit(
  kv: KVNamespace,
  ip: string,
  limit: number = IDENTIFY_RATE_LIMIT,
  windowSec: number = IDENTIFY_RATE_WINDOW_SEC,
): Promise<IdentifyRateLimitResult> {
  if (!ip) return { allowed: true, count: 0 };
  const key = `rl:identify:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

export interface IdentifyDeps {
  fetchImpl?: typeof fetch;
}

export interface IdentifyMergeInput {
  email: string;
  anonEmail: string;
  name: string;
  edition: string | null;
}

/**
 * #3996: merge de fato — score GLOBAL (`score:{email}`, merge com
 * `score:{anonEmail}`) + índice MENSAL quando `edition` foi informada +
 * invalidate do snapshot do mês + marca o par (email, anonEmail) como
 * LINKED (`markIdentifyLinked`, magic-link.ts) pra próximas
 * re-sincronizações silenciosas do MESMO device caírem no caminho rápido.
 *
 * Extraído do corpo de `handleJogarIdentify` (era inline até #3996) pra ser
 * reusado IDENTICAMENTE pelos 2 caminhos que podem completar uma
 * identificação: o caminho SEM histórico órfão (direto, abaixo) e o
 * caminho CONFIRMADO via link mágico (`handleConfirmMerge`, magic-link.ts,
 * após o clique) — a lógica de merge nunca é duplicada entre os dois.
 */
export async function performIdentifyMerge(bEnv: Env, input: IdentifyMergeInput): Promise<void> {
  const { email, anonEmail, name, edition } = input;

  // Migra o score GLOBAL (score:{email}) — merge com a sessão anônima atual.
  const [existingRaw, incomingRaw] = await Promise.all([
    bEnv.POLL.get(`score:${email}`),
    bEnv.POLL.get(`score:${anonEmail}`),
  ]);
  const existingScore = safeParseKv<WebScore>(existingRaw, "identify_score_parse_error", email);
  const incomingScore = safeParseKv<WebScore>(incomingRaw, "identify_score_parse_error", anonEmail);
  const mergedScore = mergeWebScores(existingScore, incomingScore, name);
  await bEnv.POLL.put(`score:${email}`, JSON.stringify(mergedScore));

  // Migra o índice MENSAL (score-by-month:{slug}:{email}) — só quando o
  // cliente informou uma edição representativa da sessão (sempre presente no
  // fluxo real, ver identityFormScript/jogar.ts; ausente = migração só
  // global, sem efeito imediato no leaderboard público até o próximo voto
  // já identificado gravar a entry mensal normalmente via handleVote).
  if (edition) {
    const monthSlug = editionToMonthSlug(edition);
    if (monthSlug) {
      const monthKeyExisting = `score-by-month:${monthSlug}:${email}`;
      const monthKeyIncoming = `score-by-month:${monthSlug}:${anonEmail}`;
      const [monthExistingRaw, monthIncomingRaw] = await Promise.all([
        bEnv.POLL.get(monthKeyExisting),
        bEnv.POLL.get(monthKeyIncoming),
      ]);
      const monthExisting = safeParseKv<WebScoreByMonth>(monthExistingRaw, "identify_score_month_parse_error", email);
      const monthIncoming = safeParseKv<WebScoreByMonth>(monthIncomingRaw, "identify_score_month_parse_error", anonEmail);
      if (monthExisting || monthIncoming) {
        const mergedMonth = mergeWebScoreByMonth(monthExisting, monthIncoming, name);
        await bEnv.POLL.put(monthKeyExisting, JSON.stringify(mergedMonth));
        // Invalida (não upsert) — snapshot pode ainda não existir (skip-on-
        // missing, mesmo padrão de upsertOwnEntryInSnapshot); mais simples e
        // seguro deixar o próximo GET /leaderboard* recomputar do zero, já
        // filtrando a entrada anônima via isAnonymousWebIdentity.
        await invalidateSnapshot(bEnv, monthSlug);
      }
    }
  }

  // #3996: marca o par como confiável — próximas chamadas (re-sync
  // silencioso do MESMO device, ou re-identificação explícita) não caem
  // mais em `hasOrphanHistory` pra este par específico.
  await markIdentifyLinked(bEnv, email, anonEmail);
}

/**
 * #3996: caminho de histórico órfão — `email` já tem `score:{email}`
 * existente sob um token diferente, nunca confirmado. Em vez de mergear na
 * hora, cria (ou reusa, se já houver um link vivo) um token de confirmação
 * e manda e-mail transacional via Brevo com o link `/confirm-merge`.
 *
 * Resposta sempre `{ ok: true, pending: true }` — tanto quando o e-mail
 * acabou de ser enviado quanto quando um link anterior ainda está vivo
 * (`hasPendingMerge`) ou o rate-limit de envio foi atingido
 * (`checkMagicLinkSendRateLimit`): nenhum desses 3 motivos é diferenciado
 * na resposta (ver rationale de enumeração de e-mail no header de
 * magic-link.ts).
 */
async function handleOrphanIdentify(
  request: Request,
  bEnv: Env,
  input: { email: string; anonEmail: string; name: string; edition: string },
  fetchImpl: typeof fetch,
): Promise<Response> {
  const { email, anonEmail, name } = input;

  const alreadyPending = await hasPendingMerge(bEnv, email, anonEmail);
  if (alreadyPending) return json({ ok: true, pending: true }, 200, bEnv);

  const rl = await checkMagicLinkSendRateLimit(bEnv.POLL, anonEmail, email);
  if (!rl.allowed) return json({ ok: true, pending: true }, 200, bEnv);

  const token = await createPendingMerge(bEnv, input);
  const confirmUrl = buildConfirmMergeUrl(request.url, token);
  const result = await sendMagicLinkEmail(bEnv, { name, email, confirmUrl }, fetchImpl);
  if (!result.ok) {
    // #3996 (item 6): nunca logar token/e-mail/confirmUrl — só o motivo
    // estruturado do lado Brevo (reason/status), igual ao fail-soft de
    // handleJogarSubscribe/subscribeToBeehiiv (identify_subscribe_failed).
    console.error(JSON.stringify({ event: "magiclink_send_failed", reason: result.reason, status: result.status }));
  }

  return json({ ok: true, pending: true }, 200, bEnv);
}

/**
 * Handler `POST /jogar/identify` (#3975, Fase B #3996). `bEnv` já deve vir
 * branded pro brand `web` (client sempre chama com `?brand=web`, ver rota em
 * index.ts) — todo acesso a `score:*`/`score-by-month:*` aqui usa `bEnv.POLL`
 * diretamente (sem prefixo manual), igual ao resto do brand namespacing
 * (#1905).
 *
 * Fluxo: parse → valida → rate-limit → `hasOrphanHistory` decide entre:
 *   (a) SEM histórico órfão → `performIdentifyMerge` direto (comportamento
 *       original da Fase A, sem fricção) → assina a Diar.ia se `optin`
 *       (best-effort, nunca bloqueia a identificação).
 *   (b) COM histórico órfão (#3996) → `handleOrphanIdentify` — NÃO mergeia
 *       na hora, dispara e-mail de confirmação (link mágico).
 *
 * Respostas:
 *   - 200 `{ ok: true, subscribed }` — identificado na hora (caminho a;
 *     subscribed reflete só o opt-in, sempre `false` quando `optin` não foi
 *     marcado)
 *   - 200 `{ ok: true, pending: true }` — merge diferido, aguardando
 *     confirmação por e-mail (caminho b, #3996)
 *   - 400 `{ ok: false, error }` — e-mail/anonEmail inválidos
 *   - 429 `{ ok: false, error: "rate_limited" }` — abuso por IP
 */
export async function handleJogarIdentify(
  request: Request,
  bEnv: Env,
  deps: IdentifyDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  const parsed = parseIdentifyBody(raw, request.headers.get("Content-Type") ?? "");
  const v = validateIdentifyInput(parsed);
  if (!v.ok) {
    // Honeypot: 200 fake-success — não revela ao bot que foi pego (mesmo
    // padrão de handleJogarSubscribe).
    if (v.error === "honeypot") return json({ ok: true }, 200, bEnv);
    return json({ ok: false, error: v.error }, v.status, bEnv);
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "";
  const rl = await checkIdentifyRateLimit(bEnv.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, bEnv);

  const { email, anonEmail, name, edition } = v;

  // #3996: histórico identificado pré-existente sob um token DIFERENTE do
  // atual, nunca confirmado — desvia pro fluxo de link mágico em vez de
  // mergear sem verificação.
  //
  // GATE CRÍTICO (achado de self-review — regressão descoberta rodando a
  // suíte existente de #3975): só checa `hasOrphanHistory` quando `name` é
  // NÃO-vazio, ou seja, uma submissão EXPLÍCITA do form de identidade (o
  // form client-side exige `name` via `required`, ver renderIdentityFormBlock/
  // jogar.ts). `name === ""` é EXCLUSIVAMENTE o re-sync SILENCIOSO
  // (`window.__jogarIdentify.sync`, identityFormScript/jogar.ts) — disparado
  // automaticamente a cada rodada jogada por um browser que JÁ tem
  // `eia_web_identified_email` no localStorage (ou seja, JÁ passou por uma
  // identificação bem-sucedida NESTE MESMO device/token antes, seja antes
  // ou depois do deploy do #3996).
  //
  // Sem este gate, TODO usuário já identificado ANTES do #3996 ir ao ar
  // (cujo par email/anonEmail nunca foi gravado em `identify-linked` — essa
  // chave não existia antes desta issue) teria o PRÓXIMO re-sync silencioso
  // classificado como "órfão" na primeira chamada pós-deploy — e como
  // `sync()` é fire-and-forget (ignora a resposta, nunca mostra nada ao
  // jogador), o resultado seria uma quebra SILENCIOSA e permanente: o score
  // desse jogador parava de ser creditado à identidade (ninguém percebe que
  // precisa clicar num link de confirmação que nunca pediu). Regressão pior
  // que a que #3996 resolve. `name` vazio continua confiando no MESMO nível
  // de verificação zero que a Fase A já tinha (ver header do arquivo) — não
  // é uma superfície de ataque NOVA (um script malicioso já podia chamar
  // este endpoint com `name: ""` e qualquer par email/anonEmail mesmo antes
  // do #3996). O que #3996 fecha é o caminho REALISTA descrito na issue: um
  // HUMANO preenchendo o form de identidade (name obrigatório) em um device
  // diferente pra reivindicar histórico de um e-mail que já tem ranking
  // estabelecido alhures.
  const orphan = name.trim() !== "" && (await hasOrphanHistory(bEnv, email, anonEmail));
  if (orphan) {
    return handleOrphanIdentify(request, bEnv, { email, anonEmail, name, edition: edition ?? "" }, fetchImpl);
  }

  await performIdentifyMerge(bEnv, { email, anonEmail, name, edition });

  let subscribed = false;
  if (v.optin) {
    try {
      const result = await subscribeToBeehiiv(bEnv, { name, email }, fetchImpl);
      subscribed = result.ok;
    } catch (e) {
      console.error(JSON.stringify({ event: "identify_subscribe_failed", error: String(e) }));
      // subscribed permanece false — identificação já commitada acima, o
      // opt-in de newsletter é best-effort e nunca desfaz o merge de score.
    }
  }

  return json({ ok: true, subscribed }, 200, bEnv);
}
