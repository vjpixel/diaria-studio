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
 * Fase B (documentada como follow-up, NÃO implementada aqui — ver issue de
 * follow-up referenciada no PR): merge de score anônimo→e-mail preexistente
 * vindo de OUTRO device/sessão sem re-jogar. O merge determinístico abaixo já
 * cobre "mesmo e-mail identificado 2x" (idempotente, soma incremental) — o
 * que falta é uma superfície pra reconciliar retroativamente contas
 * anônimas de sessões passadas SEM o token original em mãos, o que exigiria
 * ou (a) um índice reverso email→tokens históricos (não existe hoje) ou
 * (b) confirmação de posse do e-mail (link mágico) antes de aceitar
 * qualquer merge não-determinístico — ambos fora do escopo desta entrega.
 *
 * Segurança: a "identificação" NÃO verifica posse do e-mail (mesmo nível de
 * confiança que o nickname já tem hoje — zero verificação, ver
 * `handleSetName` em index.ts). Isto não é uma regressão: `/vote` continua
 * SÓ aceitando o token anônimo UUID como identidade de escrita (#3976) — o
 * e-mail aqui é só um RÓTULO de exibição atribuído pelo dono do token atual
 * (quem controla o localStorage deste browser), nunca uma credencial de
 * autorização de voto. Alguém pode identificar o PRÓPRIO score anônimo sob
 * qualquer e-mail (mesmo de terceiro) sem confirmação — mesma classe de
 * risco que digitar qualquer nickname hoje, não uma classe nova.
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

/**
 * Handler `POST /jogar/identify` (#3975). `bEnv` já deve vir branded pro
 * brand `web` (client sempre chama com `?brand=web`, ver rota em index.ts) —
 * todo acesso a `score:*`/`score-by-month:*` aqui usa `bEnv.POLL`
 * diretamente (sem prefixo manual), igual ao resto do brand namespacing
 * (#1905).
 *
 * Fluxo: parse → valida → rate-limit → migra `score:{email}` (merge com
 * `score:{anonEmail}`) → migra `score-by-month:{slug}:{email}` quando
 * `edition` foi informada (invalida o snapshot do mês pra refletir na
 * próxima leitura) → assina a Diar.ia se `optin` (best-effort, nunca
 * bloqueia a identificação — mesmo fail-soft de `subscribeToBeehiiv`).
 *
 * Respostas:
 *   - 200 `{ ok: true, subscribed }` — identificado (subscribed reflete só o
 *     opt-in; sempre `false` quando `optin` não foi marcado)
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
