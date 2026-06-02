/**
 * poll — Cloudflare Worker (#469)
 *
 * Sistema de votação É IA? com leaderboard.
 *
 * Endpoints:
 *   GET  /vote?email=X&edition=AAMMDD&choice=A|B&sig=HMAC  → grava voto
 *   GET  /stats?edition=AAMMDD                             → { total, correct_pct, voted_a, voted_b }
 *   GET  /leaderboard                                      → HTML público com ranking
 *   POST /admin/correct?edition=AAMMDD&answer=A|B&sig=S   → define resposta correta
 *
 * KV schema:
 *   vote:{edition}:{email}   = { choice, ts, correct }
 *   score:{email}            = { total, correct, streak, last_edition }
 *   correct:{edition}        = "A" | "B"
 *
 * Secrets (via wrangler secret put):
 *   POLL_SECRET   → HMAC key para assinar/verificar URLs de votação
 *   ADMIN_SECRET  → HMAC key para endpoint admin
 */

import { rankEntries, type LeaderboardEntry } from "./leaderboard";
import {
  currentMonthSlugBrt,
  editionToMonthSlug,
  monthSlugCompare,
  parseMonthSlug,
  MONTH_NAMES_PT,
} from "./lib";

export interface Env {
  POLL: KVNamespace;
  POLL_SECRET: string;
  ADMIN_SECRET: string;
  ALLOWED_ORIGINS: string;
}

// ── HMAC helpers ─────────────────────────────────────────────────────────────

async function hmacSign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacVerify(secret: string, message: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  // Constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGINS ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(env ? corsHeaders(env) : {}) },
  });
}

// ── Secrets guard (#1420) ─────────────────────────────────────────────────────

/**
 * #1420: declara quais secrets cada rota precisa (path + method tuple).
 * Quando uma rota sensível é chamada sem o secret correspondente, retorna
 * 503 com diagnóstico em vez de deixar o handler crashar com 500 + error
 * 1101 do Cloudflare (sem stack).
 *
 * Method-aware (não só path) pra evitar regressão de mensagem em método
 * errado — GET /admin/correct continua caindo no fallback 404, não 503.
 *
 * Rotas públicas (não listadas aqui) — `/img`, `/stats`, `/leaderboard*` —
 * continuam funcionando mesmo sem secrets.
 */
export function requiredSecretsForRoute(
  path: string,
  method: string,
): Array<"POLL_SECRET" | "ADMIN_SECRET"> {
  if (path === "/vote" && method === "GET") return ["POLL_SECRET"];
  if (path === "/set-name" && method === "GET") return ["POLL_SECRET"];
  if (path === "/admin/correct" && method === "POST") return ["ADMIN_SECRET"];
  return [];
}

/**
 * #1420: retorna lista de secrets faltando pra atender (path, method). Vazio = OK.
 * Trata string vazia como missing (deploy esquecido de `wrangler secret put`
 * vs accidentalmente set como `""`).
 */
export function missingSecretsForRoute(env: Env, path: string, method: string): string[] {
  const required = requiredSecretsForRoute(path, method);
  return required.filter((name) => {
    const v = env[name];
    return typeof v !== "string" || v.length === 0;
  });
}

// #1083: helpers puros extraídos pra `./lib.ts` pra ficarem testáveis em
// Node sem mock do Worker runtime. Re-exportados aqui pra back-compat de
// consumers externos (se algum dia houver) e pra leitura linear do código.
import {
  formatEditionDate,
  htmlEscape,
  parseValidEditions,
  isValidEdition,
  redirectTargetForTrailingSlash,
  classify403Reason,
} from "./lib";
export { formatEditionDate, htmlEscape, parseValidEditions, isValidEdition, redirectTargetForTrailingSlash, classify403Reason } from "./lib";

// ── /vote ─────────────────────────────────────────────────────────────────────

async function handleVote(url: URL, env: Env): Promise<Response> {
  // #1083: Beehiiv não URL-encoda `{{ subscriber.email }}`; URLSearchParams
  // converte `+` em ` `. Restaurar antes de qualquer uso (HMAC, KV key).
  const emailRaw = url.searchParams.get("email")?.toLowerCase().trim();
  const email = emailRaw ? emailRaw.replace(/ /g, "+") : emailRaw;
  const edition = url.searchParams.get("edition");
  const choice = url.searchParams.get("choice")?.toUpperCase();
  // sig ausente = merge-tag mode: Beehiiv substitui {{ subscriber.email }} no envio
  const sig = url.searchParams.get("sig");
  // #1236: ?test=1 valida tudo (gate + sig + dedup) mas NÃO escreve em KV.
  // Útil pra smoke test / debug em prod sem poluir leaderboard.
  const testMode = url.searchParams.get("test") === "1";

  if (!email || !edition || !choice) {
    return new Response(votePageHtml("Link inválido — parâmetros ausentes.", false), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  if (!["A", "B"].includes(choice)) {
    return new Response(votePageHtml("Escolha inválida.", false), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // #1083 / #1086: gate de edições válidas. Se key `valid_editions` setada e
  // edition não estiver no set, rejeita. Vazia/ausente/corrupted → aceita
  // qualquer (compat + fail-open). Corrupted loga console.error.
  const validSet = parseValidEditions(await env.POLL.get("valid_editions"));
  if (!isValidEdition(validSet, edition)) {
    return new Response(votePageHtml("Essa edição não aceita mais votos.", false), {
      status: 410, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // #1083: sig agora pode ser email-only (permanente) OU email:edition (legacy).
  // Tenta novo formato primeiro; fallback pro legacy. Ausente = merge-tag mode.
  if (sig !== null) {
    const newValid = await hmacVerify(env.POLL_SECRET, email, sig);
    const legacyValid = newValid
      ? true
      : await hmacVerify(env.POLL_SECRET, `${email}:${edition}`, sig);
    if (!newValid && !legacyValid) {
      // #1468: log estruturado pra distinguir sig_empty (subscriber sem
      // poll_sig populado — cenário do #1186) de sig_invalid (HMAC mismatch).
      // Cloudflare Logs filtra por reason. email_domain só pra detectar
      // bot/spam pattern, evita vazar PII completa em log retention.
      const reason = classify403Reason(sig);
      console.log(JSON.stringify({
        event: "poll_vote_403",
        reason,
        edition,
        email_domain: email.split("@")[1] ?? "unknown",
      }));
      return new Response(votePageHtml("Link inválido ou expirado.", false), {
        status: 403, headers: { "Content-Type": "text/html;charset=utf-8" }
      });
    }
  }

  // Verificar se já votou
  const voteKey = `vote:${edition}:${email}`;
  const existing = await env.POLL.get(voteKey);
  if (existing) {
    const prev = JSON.parse(existing);
    return new Response(votePageHtml(`Você já votou na edição de ${formatEditionDate(edition)} (escolha: ${prev.choice}).`, false, null, null, editionToMonthSlug(edition)), {
      status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // Gravar voto
  const correctRaw = await env.POLL.get(`correct:${edition}`);
  const correct = correctRaw ? choice === correctRaw : null;

  // #1236: test mode — short-circuit antes de qualquer KV write. Mantém
  // validação completa (gate, sig, dedup) acima pra que o test reflita
  // request real. Resposta indica claramente que não foi gravado.
  if (testMode) {
    const testMsg = correct === true
      ? "✅ [TEST] Acertou! Era a imagem gerada por IA. (não gravado em KV)"
      : correct === false
      ? "❌ [TEST] Não foi dessa vez — era a foto real. (não gravado em KV)"
      : "[TEST] Voto recebido. (não gravado em KV — gabarito ainda não definido)";
    return new Response(votePageHtml(testMsg, true), {
      status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // #1657: timestamp único reusado no voteKey + no vote-log (mesma fonte).
  const voteTs = new Date().toISOString();
  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: voteTs, correct }));

  // Atualizar counter agregado (evita N+1 reads no /stats)
  await updateStatsCounter(env, edition, choice as "A" | "B", correct);

  // #1080: sempre atualizar score, mesmo sem gabarito ainda. Sem isso, votos
  // antes do admin setar `correct:{edition}` ficam sem score → leaderboard
  // vazio + nickname form falha com "Vote primeiro".
  await updateScore(env, email, edition, correct);

  // #1345: também atualizar score-by-month, indexado pela publication date
  // da edição (não pela data do vote). Voto na edição 260531 conta em Maio
  // 2026 mesmo se chegou em 02/jun.
  await updateScoreByMonth(env, email, edition, correct);

  // #1657: log de voto pra analytics. SECUNDÁRIO — try/catch pra nunca quebrar
  // o voto do leitor se a escrita do log falhar. Só roda em voto novo (dup
  // retorna acima; test mode short-circuita antes do put).
  try {
    await recordVoteLog(env, email, edition, choice as "A" | "B", correct, voteTs);
  } catch (e) {
    console.error(JSON.stringify({ event: "vote_log_failed", edition, error: String(e) }));
  }

  const msg = correct === true
    ? "✅ Acertou! Era a imagem gerada por IA."
    : correct === false
    ? "❌ Não foi dessa vez — era a foto real."
    : "Voto registrado! O resultado sai na próxima edição.";

  // #1078 — primeiro voto: oferecer nickname pra leaderboard. Checa se já tem
  // nickname salvo no score; se não, gera HMAC sig pra form de set-name.
  const scoreRaw = await env.POLL.get(`score:${email}`);
  const scoreObj = scoreRaw ? JSON.parse(scoreRaw) : null;
  const needsNickname = !scoreObj?.nickname;
  let nicknameForm: { email: string; sig: string } | null = null;
  if (needsNickname) {
    const sig = await hmacSign(env.POLL_SECRET, `setname:${email}`);
    nicknameForm = { email, sig };
  }

  // #1351: mostrar as duas imagens (A e B) na página de resultado.
  // Highlight da que o leitor clicou + label "🤖 IA" e "📷 Real" pra que é
  // qual. Só aparece quando temos gabarito (correct ∈ {true, false}).
  // Sem gabarito (correct === null), pular — leitor verá só msg.
  const showImages = correct !== null;
  const images: { choice: "A" | "B"; isAi: boolean; isClicked: boolean } | null = null;
  // correctRaw armazena qual lado é IA — usar direto.
  const aiSide: "A" | "B" | null = showImages && correctRaw
    ? (correctRaw as "A" | "B")
    : null;
  const resultImages = showImages && aiSide
    ? {
        edition,
        aiSide,
        clickedSide: choice as "A" | "B",
      }
    : null;

  return new Response(votePageHtml(msg, true, nicknameForm, resultImages, editionToMonthSlug(edition)), {
    status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
  });
}

/** Mantém counter agregado stats:{edition} — evita N+1 reads no /stats. */
async function updateStatsCounter(
  env: Env,
  edition: string,
  choice: "A" | "B",
  correct: boolean | null,
): Promise<void> {
  const statsKey = `stats:${edition}`;
  const raw = await env.POLL.get(statsKey);
  const stats = raw ? JSON.parse(raw) : { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
  stats.total += 1;
  if (choice === "A") stats.voted_a += 1;
  if (choice === "B") stats.voted_b += 1;
  if (correct === true) stats.correct_count += 1;
  await env.POLL.put(statsKey, JSON.stringify(stats));
}

/**
 * #1345: corrige score-by-month quando admin define gabarito retroativamente.
 * Apenas incrementa `correct` — `total` já foi contado em updateScoreByMonth
 * quando o vote chegou. Chamado de handleAdminCorrect.
 */
async function adjustScoreByMonthCorrect(
  env: Env,
  email: string,
  edition: string,
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return;
  const key = `score-by-month:${monthSlug}:${email}`;
  const raw = await env.POLL.get(key);
  if (!raw) return; // sem entry, vote era pré-#1345 — ignore
  const entry = JSON.parse(raw);
  entry.correct = (entry.correct ?? 0) + 1;
  await env.POLL.put(key, JSON.stringify(entry));
  // #1348: invalidate snapshot — próximo leaderboard read recompute fresh.
  await invalidateSnapshot(env, monthSlug);
}

/**
 * #1345: incrementa `score-by-month:{YYYY-MM}:{email}` onde YYYY-MM vem da
 * publication date da edição. Esse é o índice canônico do leaderboard
 * mensal — `/leaderboard/{YYYY-MM}` lê só este prefix.
 *
 * Nickname é copiado de `score:{email}` (source-of-truth global). Pode ficar
 * stale se nickname mudar pós-vote — handleSetName propaga (#1345).
 */
async function updateScoreByMonth(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return; // edition malformado — não corrompe schema

  const key = `score-by-month:${monthSlug}:${email}`;
  const raw = await env.POLL.get(key);
  const entry = raw
    ? JSON.parse(raw)
    : { total: 0, correct: 0, last_edition: null, nickname: null };

  entry.total += 1;
  if (correct === true) entry.correct += 1;
  entry.last_edition = edition;
  // #1383: timestamp do voto pra tiebreaker no leaderboard. Voto mais recente
  // vence empate de (correct, total). Sobrescreve a cada vote (não acumula).
  entry.last_vote_ts = new Date().toISOString();

  // Pull nickname from global score key. handleSetName propaga em writes
  // subsequentes, mas o snapshot no momento do vote já é capturado aqui.
  if (entry.nickname === null) {
    const scoreRaw = await env.POLL.get(`score:${email}`);
    if (scoreRaw) {
      const scoreObj = JSON.parse(scoreRaw);
      entry.nickname = scoreObj.nickname ?? null;
    }
  }

  await env.POLL.put(key, JSON.stringify(entry));
  // #1348: invalidate snapshot — próximo leaderboard read recompute fresh.
  await invalidateSnapshot(env, monthSlug);
}

/**
 * #1657: entrada do log de votos pra analytics de comportamento (latência
 * envio→voto, hora-do-dia, recorrência, acerto×latência). `email_hash` é um
 * HMAC domain-separado (`votelog:{email}`) — id estável de coorte SEM PII crua.
 * Review: NÃO reusar o poll_sig (HMAC do email cru) — ele viaja no `?sig=` das
 * URLs de voto; se uma URL vazar, o dump do log permitiria re-identificar o
 * histórico. O prefixo `votelog:` desacopla o id de coorte do sig de auth.
 */
export interface VoteLogEntry {
  ts: string;
  edition: string;
  month_slug: string;
  email_hash: string;
  choice: "A" | "B";
  correct: boolean | null;
}

/** Pure (#1657): monta a entrada do vote-log. Exportada pra teste. */
export function buildVoteLogEntry(args: {
  ts: string;
  edition: string;
  monthSlug: string;
  emailHash: string;
  choice: "A" | "B";
  correct: boolean | null;
}): VoteLogEntry {
  return {
    ts: args.ts,
    edition: args.edition,
    month_slug: args.monthSlug,
    email_hash: args.emailHash,
    choice: args.choice,
    correct: args.correct,
  };
}

/**
 * #1657: grava 1 entrada por voto em key PRÓPRIA — race-free, sem
 * read-modify-write (votos concorrentes logo após o envio não se sobrescrevem,
 * que é justamente a janela que a análise de latência quer medir).
 * Key: `vote-log:{month}:{edition}:{email_hash}` — listável por mês.
 * `monthSlug` null (edition malformado) → skip silencioso.
 */
export async function recordVoteLog(
  env: Env,
  email: string,
  edition: string,
  choice: "A" | "B",
  correct: boolean | null,
  ts: string,
): Promise<void> {
  const monthSlug = editionToMonthSlug(edition);
  if (monthSlug === null) return;
  // Review #1736: domain-separado (`votelog:`) — NÃO é o poll_sig (HMAC do email
  // cru, que vaza no ?sig= das URLs). Mantém estabilidade por coorte sem permitir
  // re-identificação cruzando log + sig vazado.
  const emailHash = await hmacSign(env.POLL_SECRET, `votelog:${email}`);
  const entry = buildVoteLogEntry({ ts, edition, monthSlug, emailHash, choice, correct });
  await env.POLL.put(
    `vote-log:${monthSlug}:${edition}:${emailHash}`,
    JSON.stringify(entry),
  );
}

async function updateScore(
  env: Env,
  email: string,
  edition: string,
  correct: boolean | null,
): Promise<void> {
  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  const score = raw
    ? JSON.parse(raw)
    : { total: 0, correct: 0, streak: 0, last_edition: null, nickname: null };

  score.total += 1;
  // correct === null → gabarito ainda não definido: incrementa total mas não
  // mexe em correct/streak (preserva estado pra reconciliação futura).
  if (correct === true) {
    score.correct += 1;
    score.streak = (score.streak || 0) + 1;
  } else if (correct === false) {
    score.streak = 0;
  }
  score.last_edition = edition;
  // Preserve nickname if already set (don't overwrite)
  if (score.nickname === undefined) score.nickname = null;

  await env.POLL.put(scoreKey, JSON.stringify(score));
}

// ── /stats ────────────────────────────────────────────────────────────────────

async function handleStats(url: URL, env: Env): Promise<Response> {
  const edition = url.searchParams.get("edition");
  if (!edition) return json({ error: "missing edition" }, 400, env);

  // Lê counter agregado (2 reads em vez de N+1)
  const [statsRaw, correctRaw] = await Promise.all([
    env.POLL.get(`stats:${edition}`),
    env.POLL.get(`correct:${edition}`),
  ]);

  const stats = statsRaw ? JSON.parse(statsRaw) : { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
  const total = stats.total as number;

  return json({
    edition,
    total,
    voted_a: stats.voted_a,
    voted_b: stats.voted_b,
    correct_answer: correctRaw,
    correct_count: stats.correct_count,
    correct_pct: total > 0 ? Math.round((stats.correct_count / total) * 100) : null,
  }, 200, env);
}

// ── /leaderboard/top1 (#1160) ────────────────────────────────────────────────

/**
 * Pure (#1160): retorna apenas os subscribers em 1º lugar (com tie support).
 * Empates compartilham a posição 1 (dense rank). Sem entries = []. Sem score
 * com nickname = []. Privacy: só nickname, nunca email cru.
 *
 * Threshold mínimo: pelo menos 1 voto. Subscribers que ainda não votaram
 * (mesmo que tenham nickname seedado) não aparecem.
 *
 * Output shape compatível com `render-newsletter-html.ts` integration plan
 * (#1160 follow-up).
 */
export interface LeaderTop1Entry {
  nickname: string;
  pct: number;
  correct: number;
  total: number;
}

export function computeTop1(
  scores: Array<{ email: string; nickname: string | null; correct: number; total: number }>,
): LeaderTop1Entry[] {
  const withNickname = scores
    .filter((s) => s.nickname && s.nickname.trim().length > 0)
    .filter((s) => s.total > 0)
    .map((s) => ({
      nickname: s.nickname!,
      correct: s.correct,
      total: s.total,
      pct: Math.round((s.correct / s.total) * 100),
    }));
  if (withNickname.length === 0) return [];

  // Tiebreaker: nickname ASC (estável + previsível pra cache)
  withNickname.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.nickname.localeCompare(b.nickname);
  });

  const top = withNickname[0];
  return withNickname.filter((s) => s.pct === top.pct && s.correct === top.correct);
}

/**
 * Pure (#1160 followup): retorna leitores nos ranks 1, 2 e 3 do leaderboard
 * mensal, na mesma ordem do leaderboard público (dense rank, tiebreaker
 * nickname ASC). Critério de rank: `rankEntries` em ./leaderboard (correct
 * DESC, total DESC, nickname ASC).
 *
 * Entries sem nickname são incluídas com email mascarado (`user@***`) —
 * mesma política do leaderboard público (renderLeaderboardHtml). Issue #1353
 * é o follow-up pra incentivar leitores a definir nickname.
 *
 * Output: array de `{ nickname, rank }` em ordem de exibição. Campo
 * `nickname` é o display final (nickname real OU email mascarado).
 * Ranks empatados compartilham número (dense): 1, 1, 2, 3, 3 é válido.
 *
 * Caso 6+ pessoas em rank 1: retorna todas (renderer decide cap visual).
 */
export interface PodiumEntry {
  nickname: string;
  rank: number;
}

function maskEmail(email: string): string {
  return email.replace(/@.*/, "@***");
}

export function computePodium(
  scores: Array<{ email: string; nickname: string | null; correct: number; total: number }>,
): PodiumEntry[] {
  // Reusa rankEntries com shape LeaderboardEntry (precisa pct + streak).
  const eligible = scores
    .filter((s) => s.total > 0)
    .map((s) => {
      const hasNickname = s.nickname && s.nickname.trim().length > 0;
      const display = hasNickname ? s.nickname!.trim() : maskEmail(s.email);
      return {
        email: s.email,
        nickname: display,
        correct: s.correct,
        total: s.total,
        pct: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
        streak: 0,
      };
    });
  if (eligible.length === 0) return [];
  const ranked = rankEntries(eligible);
  return ranked
    .filter((e) => e.rank <= 3)
    .map((e) => ({ nickname: e.nickname!, rank: e.rank }));
}

async function handleLeaderboardTop1(url: URL, env: Env): Promise<Response> {
  // #1345: ?period=YYYY-MM filtra mês específico via score-by-month index;
  // omitted = mês corrente. Default mantém compat com clientes existentes.
  const periodParam = url.searchParams.get("period");
  const monthSlug = periodParam ?? currentMonthSlugBrt(new Date());
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return json({ error: "period inválido — use YYYY-MM" }, 400, env);
  }

  // #1348: usa snapshot pré-computado em vez de list+gets inline.
  const scores = await getOrComputeSnapshot(env, monthSlug);
  const top1 = computeTop1(scores);
  // #1160 followup: podium (ranks 1-3) pra newsletter. Mantém top1 pra
  // back-compat com clientes existentes; podium é o campo novo recomendado.
  const podium = computePodium(scores);
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  return json({ top1, podium, period: periodLabel, period_slug: monthSlug }, 200, env);
}

// ── Snapshot key (#1348) ──────────────────────────────────────────────────

/**
 * Entry shape no snapshot — mesma estrutura usada em handlers e em
 * scoreByMonthEntriesToLeaderboard. Persistido como JSON em
 * `leaderboard-snapshot:{slug}`.
 */
export interface SnapshotEntry {
  email: string;
  nickname: string | null;
  correct: number;
  total: number;
}

interface SnapshotPayload {
  entries: SnapshotEntry[];
  computed_at: string;
}

/**
 * #1348: lê snapshot pré-computado de `leaderboard-snapshot:{slug}` se existir,
 * senão recompute via `computeSnapshotEntries` (list + parallel gets) e
 * persiste. Lazy compute pattern — write-time invalidate, read-time refresh.
 *
 * Reduz subrequest budget de ~500 (1 list + N gets) pra 1 KV get no hot path.
 * Cold path (após invalidate) paga compute uma vez, próximos reads hit cache.
 */
export async function getOrComputeSnapshot(
  env: Env,
  slug: string,
): Promise<SnapshotEntry[]> {
  const snapKey = `leaderboard-snapshot:${slug}`;
  const cached = await env.POLL.get(snapKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as SnapshotPayload;
      if (Array.isArray(parsed.entries)) return parsed.entries;
    } catch {
      // Corrupted snapshot — fall through pra recompute
    }
  }
  const entries = await computeSnapshotEntries(env, slug);
  // #1666: não persistir snapshot VAZIO. handleLeaderboardByMonth precisa ler
  // entries mesmo pra mês futuro (o gate "ainda não começou" depende de
  // entries.length por causa do D+1 que acumula votos antes do slug virar), mas
  // um GET /leaderboard/{mês-futuro} sem votos (rota não-autenticada;
  // parseMonthSlug aceita anos 2000-2099) gravava um snapshot vazio por slug →
  // write amplification. Sem votos não há o que cachear; o 1º voto invalida e
  // reinicia o ciclo normal (o list de checagem segue cheap p/ prefix vazio).
  if (entries.length === 0) return entries;
  const payload: SnapshotPayload = {
    entries,
    computed_at: new Date().toISOString(),
  };
  // #1349 review fix D: TTL 24h como safety net. Se algum write path
  // futuro esquecer de invalidar, snapshot reseta sozinho em 24h ao invés
  // de ficar stale forever. Custo: re-compute diário mesmo sem invalidação.
  await env.POLL.put(snapKey, JSON.stringify(payload), { expirationTtl: 86400 });
  return entries;
}

/**
 * #1348: deleta snapshot do slug. Chamado de write-paths
 * (updateScoreByMonth, adjustScoreByMonthCorrect, propagateNicknameByMonth).
 *
 * Race: 2 votes concorrentes ambos deletam, ambos vão computar no próximo
 * read. Idempotent — última escrita do snapshot é a correta no momento.
 */
async function invalidateSnapshot(env: Env, slug: string): Promise<void> {
  await env.POLL.delete(`leaderboard-snapshot:${slug}`);
}

/**
 * #1348 (C): compute path — lista todas as `score-by-month:{slug}:*` keys
 * e fetcha values em batches paralelos. Reduz latência cold-path de ~15s
 * (500 gets sequenciais) pra ~750ms (25 batches × 30ms).
 *
 * batchSize=20 escolhido pra ficar dentro do limite subrequest do Worker
 * (free tier 50/req; paid 1000/req). Conservador — pode subir pra 50
 * se necessário.
 */
const SNAPSHOT_GET_BATCH_SIZE = 20;

export async function computeSnapshotEntries(
  env: Env,
  slug: string,
): Promise<SnapshotEntry[]> {
  const prefix = `score-by-month:${slug}:`;
  const keys: string[] = [];
  for await (const k of listAllKeys(env, prefix)) keys.push(k);

  const entries: SnapshotEntry[] = [];
  for (let i = 0; i < keys.length; i += SNAPSHOT_GET_BATCH_SIZE) {
    const batch = keys.slice(i, i + SNAPSHOT_GET_BATCH_SIZE);
    const values = await Promise.all(batch.map((k) => env.POLL.get(k)));
    for (let j = 0; j < batch.length; j++) {
      const raw = values[j];
      if (!raw) continue;
      // #1349 review fix A: try/catch evita que 1 entry corrompida derrube
      // o compute inteiro. Entry malformada é skipada e logada.
      let entry: { nickname?: string | null; correct?: number; total?: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        console.error(`[snapshot] skip corrupted entry: ${batch[j]}`);
        continue;
      }
      entries.push({
        email: batch[j].replace(prefix, ""),
        nickname: entry.nickname ?? null,
        correct: entry.correct ?? 0,
        total: entry.total ?? 0,
      });
    }
  }
  return entries;
}

/**
 * #1345 followup: iterator paginado de KV list. Cloudflare KV list retorna
 * no máximo 1000 keys por call — sem cursor handling, entries silenciosamente
 * desaparecem em escala. Yield names um por um pra caller iterar.
 *
 * Exported pra ser testável (#1347): caller passa mock env com `POLL.list`
 * que simula resposta multi-page.
 */
export async function* listAllKeys(env: Env, prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const result: KVNamespaceListResult<unknown, string> = await env.POLL.list({ prefix, cursor });
    for (const key of result.keys) yield key.name;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

// ── /leaderboard/{YYYY-MM} (#1345) ───────────────────────────────────────────

/**
 * Pure (#1345): extrai entries de `score-by-month:{slug}:*` em
 * shape LeaderboardEntry pra alimentar rankEntries + render.
 *
 * Caller fornece o array já materializado (pra ser testável sem KV mock).
 * Entries sem `total` (corrompidas) viram pct=0; entries sem nickname
 * caem no fallback de email masked igual ao /leaderboard atual.
 */
export function scoreByMonthEntriesToLeaderboard(
  entries: Array<{
    email: string;
    nickname: string | null;
    correct: number;
    total: number;
    last_vote_ts?: string;
  }>,
): LeaderboardEntry[] {
  return entries.map((e) => {
    const pct = e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0;
    return {
      email: e.email,
      nickname: e.nickname,
      correct: e.correct,
      total: e.total,
      pct,
      streak: 0, // streak é per-edition; não tracked no índice mensal (out of scope)
      // #1383: propaga last_vote_ts pro rankEntries usar como tiebreaker
      last_vote_ts: e.last_vote_ts,
    };
  });
}

/**
 * Pure (260601): decide se mostra a tela "ainda não começou" pro mês pedido.
 * Só quando o mês é estritamente futuro (`slugCmp > 0`) E não há nenhum voto
 * registrado ainda (`entryCount === 0`). Edição D+1 publica no dia 1º e já
 * acumula votos no bucket do mês antes de `currentMonthSlugBrt` virar — então
 * um mês "futuro" com votos deve renderizar a leaderboard, não a mensagem.
 */
export function shouldShowMonthNotStarted(slugCmp: number, entryCount: number): boolean {
  return slugCmp > 0 && entryCount === 0;
}

/**
 * Handler `/leaderboard/{YYYY-MM}` — lê apenas score-by-month:{slug}:* e
 * renderiza o mesmo HTML do leaderboard atual. Cache header diferente
 * conforme mês passado (immutable) vs corrente (1h).
 */
async function handleLeaderboardByMonth(
  monthSlug: string,
  env: Env,
): Promise<Response> {
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return new Response(votePageHtml("Mês inválido. Use formato YYYY-MM (ex: 2026-05).", false), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const currentSlug = currentMonthSlugBrt(new Date());
  const slugCmp = monthSlugCompare(monthSlug, currentSlug);

  // #1348: usa snapshot pré-computado em vez de list+gets inline.
  const entries = await getOrComputeSnapshot(env, monthSlug);
  const scores = scoreByMonthEntriesToLeaderboard(entries);

  // "Ainda não começou" só quando o mês é futuro E não há votos ainda.
  // Edição D+1 (publica dia 1º) já acumula votos no bucket do mês antes de
  // `currentMonthSlugBrt` virar — sem o `entries.length === 0`, o leitor que
  // votou via o link e via "ainda não começou" em vez do próprio voto (260601).
  if (shouldShowMonthNotStarted(slugCmp, entries.length)) {
    return new Response(votePageHtml(
      `O leaderboard de ${MONTH_NAMES_PT[parsed.month - 1]} de ${parsed.year} ainda não começou.`,
      false,
    ), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  const isPast = slugCmp < 0;
  // #1345 followup: cache curto pro mês corrente — votos atualizam em real-time
  // e cache de 1h fazia leitor ver leaderboard stale por ~1h após votar.
  // 60s é suficiente pra absorver pico de tráfego sem mascarar updates.
  const cacheControl = isPast
    ? "public, max-age=2592000, immutable" // 30d, mês fechado nunca muda
    : "public, max-age=60"; // 60s pro mês corrente

  return renderLeaderboardHtml(scores, periodLabel, parsed.year, cacheControl);
}

/** Pure render — separado pra ser reusado por `/leaderboard` (corrente) + `/leaderboard/{YYYY-MM}`. */
function renderLeaderboardHtml(
  scores: LeaderboardEntry[],
  periodLabel: string,
  year: number,
  cacheControl: string,
): Response {
  // #1092 + #1256: dense ranking — leitores empatados em (correct, total)
  // ocupam o mesmo número e o próximo grupo é +1 (1, 1, 2 — não 1, 1, 3).
  const ranked = rankEntries(scores).slice(0, 50);

  const rows = ranked.map((s) => {
    const display = s.nickname || s.email.replace(/@.*/, "@***");
    const escaped = display.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
    const trClass = s.rank === 1 ? ' class="leader"' : '';
    return `<tr${trClass}>
      <td>${s.medal}</td>
      <td>${escaped}</td>
      <td>${s.correct}/${s.total}</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderboard de ${periodLabel} de ${year} | Diar.ia</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  p.sub { color: #666; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #eee; font-size: 0.8rem; color: #666; text-transform: uppercase; }
  td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; }
  tr.leader td { font-weight: bold; }
  a { color: #0066cc; }
</style>
</head>
<body>
<h1 style="margin-bottom:4px;">Leaderboard de ${periodLabel} de ${year}</h1>
<h2 style="font-size:1.1rem;font-weight:500;color:#666;margin:0 0 12px 0;">É IA?</h2>
<p class="sub">Quem mais acertou esse mês qual imagem foi gerada por IA na <a href="https://diar.ia.br">Diar.ia</a>.</p>
<table>
<thead><tr><th>#</th><th>Leitor(a)</th><th>Acertos</th></tr></thead>
<tbody>${rows || "<tr><td colspan=3 style='color:#999;text-align:center;padding:20px'>Ainda sem votos.</td></tr>"}</tbody>
</table>
<p style="margin-top:30px;font-size:0.8rem;color:#999">Critérios: acertos absolutos (1º); em caso de empate, mais tentativas vence (2º).</p>
<p style="margin-top:8px;font-size:0.8rem;color:#999">Atualizado em tempo real · Nicknames escolhidos pelos leitores · E-mails mascarados</p>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": cacheControl }
  });
}

// ── /leaderboard ──────────────────────────────────────────────────────────────

async function handleLeaderboard(env: Env): Promise<Response> {
  // #1345: /leaderboard agora delega pro slug do mês corrente. Schema único
  // (`score-by-month:*`) — `score:*` global continua mantido pra all-time
  // potencial mas não é mais lido pelo leaderboard.
  return handleLeaderboardByMonth(currentMonthSlugBrt(new Date()), env);
}

// ── /admin/correct ────────────────────────────────────────────────────────────

async function handleAdminCorrect(url: URL, env: Env): Promise<Response> {
  const edition = url.searchParams.get("edition");
  const answer = url.searchParams.get("answer")?.toUpperCase();
  const sig = url.searchParams.get("sig");

  if (!edition || !answer || !sig) return json({ error: "missing params" }, 400, env);
  if (!["A", "B"].includes(answer)) return json({ error: "answer must be A or B" }, 400, env);

  const valid = await hmacVerify(env.ADMIN_SECRET, `${edition}:${answer}`, sig);
  if (!valid) return json({ error: "invalid signature" }, 403, env);

  await env.POLL.put(`correct:${edition}`, answer);

  // Retroativamente atualizar scores dos votos já gravados.
  // #1345 followup: paginado via listAllKeys — em edição com >1000 votos,
  // sem cursor entries silenciosamente ficavam fora do backfill.
  const prefix = `vote:${edition}:`;
  let updated = 0;
  let correctCount = 0;

  for await (const keyName of listAllKeys(env, prefix)) {
    const raw = await env.POLL.get(keyName);
    if (!raw) continue;
    const vote = JSON.parse(raw);
    if (vote.correct === null || vote.correct === undefined) {
      const correct = vote.choice === answer;
      await env.POLL.put(keyName, JSON.stringify({ ...vote, correct }));
      const email = keyName.replace(prefix, "");
      await updateScore(env, email, edition, correct);
      // #1345: adjust correct count em score-by-month sem re-incrementar total
      // (total já foi contado quando handleVote chamou updateScoreByMonth com
      // correct=null). Só incrementa correct quando vote virou correct.
      if (correct) await adjustScoreByMonthCorrect(env, email, edition);
      if (correct) correctCount++;
      updated++;
    } else if (vote.correct === true) {
      correctCount++;
    }
  }

  // Actualizar counter agregado com correct_count real
  const statsRaw = await env.POLL.get(`stats:${edition}`);
  if (statsRaw) {
    const stats = JSON.parse(statsRaw);
    stats.correct_count = correctCount;
    await env.POLL.put(`stats:${edition}`, JSON.stringify(stats));
  }

  return json({ ok: true, edition, answer, updated_votes: updated }, 200, env);
}

// ── Vote page HTML ────────────────────────────────────────────────────────────

/**
 * #1351: imagens A/B no resultado do vote. Quando o gabarito existe
 * (correct ∈ {true, false}), mostrar as duas imagens com label "🤖 IA" /
 * "📷 Real" + highlight da que o leitor clicou.
 */
export interface VoteResultImages {
  edition: string;
  aiSide: "A" | "B";
  clickedSide: "A" | "B";
}

export function votePageHtml(
  message: string,
  success: boolean,
  nicknameForm?: { email: string; sig: string } | null,
  resultImages?: VoteResultImages | null,
  leaderboardSlug?: string | null,
): string {
  // #1083: htmlEscape no email (user-controlled) previne XSS via attribute
  // break. Sig é hex HMAC controlado pelo Worker — escape por consistência.
  // #1353: prompt recorrente até subscriber definir nickname.
  // handleVote já chama votePageHtml com nicknameForm sempre que
  // !scoreObj?.nickname — então este form aparece em CADA vote até ser
  // preenchido. Texto explícito sobre consequência (aparecer como email
  // mascarado no leaderboard) incentiva preenchimento.
  const formHtml = nicknameForm ? `
<div class="nick-box">
  <p style="font-size:0.95rem;margin:0 0 12px 0;font-weight:600;">Defina seu nickname pra aparecer no leaderboard mensal</p>
  <p style="font-size:0.85rem;color:#444;margin:0 0 12px 0;line-height:1.5;">Sem nickname você aparece como <code style="background:#fff;padding:1px 4px;border-radius:3px;">${htmlEscape(nicknameForm.email.replace(/@.*/, "@***"))}</code> no ranking público.</p>
  <form action="/set-name" method="GET" class="nick-form">
    <input type="hidden" name="email" value="${htmlEscape(nicknameForm.email)}">
    <input type="hidden" name="sig" value="${htmlEscape(nicknameForm.sig)}">
    <input type="text" name="name" placeholder="Seu nome" maxlength="40" required class="nick-input">
    <button type="submit" class="nick-save">Salvar</button>
  </form>
  <p style="font-size:0.75rem;color:#666;margin:10px 0 0 0;">Pode ser apelido. Mostrado publicamente.</p>
</div>` : "";

  // #1351: HTML pra mostrar imagens A e B com labels + highlight da clicada
  const imagesHtml = renderResultImagesHtml(resultImages);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? | Diar.ia</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: #1a1a1a; }
  .msg { font-size: 1.3rem; margin: 20px 0; }
  a { color: #0066cc; }
  .result-images { display: flex; gap: 12px; margin: 24px 0; justify-content: center; flex-wrap: wrap; }
  .result-image { box-sizing: border-box; flex: 1 1 240px; max-width: 260px; padding: 8px; border: 2px solid transparent; border-radius: 8px; background: #fff; }
  .result-image.clicked { border-color: #00A0A0; box-shadow: 0 0 0 2px rgba(0,160,160,.18); }
  .result-image img { width: 100%; height: auto; border-radius: 6px; display: block; }
  .result-image .label { font-size: 0.85rem; margin-top: 8px; color: #444; font-weight: 600; }
  .result-image .you { display: inline-block; padding: 2px 8px; background: #00A0A0; color: #fff; border-radius: 4px; font-size: 0.7rem; font-weight: 700; margin-left: 6px; }
  /* #1675: nickname form + links como classes pra media query mobile sobrepor. */
  .nick-box { margin: 30px auto; padding: 20px; background: #f5f5f5; border-radius: 8px; max-width: 380px; }
  .nick-form { display: flex; gap: 8px; }
  .nick-input { flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; }
  .nick-save { padding: 8px 16px; background: #00A0A0; color: #fff; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; }
  .footer-links a { display: inline-block; padding: 6px 4px; }
  /* #1675: tráfego majoritariamente mobile. Abaixo de 480px: menos margem topo,
     form empilhado, botão full-width, tap targets ~44px. */
  @media (max-width: 480px) {
    body { margin: 24px auto; padding: 0 16px; }
    .msg { font-size: 1.15rem; }
    /* Empilha A/B full-width: imagens GRANDES e legíveis (reclamação do editor
       era "pequenas") em vez de 2-up minúsculo; também preenche o vazio vertical. */
    .result-image { flex-basis: 100%; max-width: 100%; }
    .nick-form { flex-direction: column; }
    /* flex:none reseta o flex:1 do base — em coluna, flex-grow agiria no eixo
       vertical (input esticaria). Cross-axis stretch mantém largura total. */
    .nick-input { flex: none; padding: 12px; font-size: 1rem; }
    .nick-save { width: 100%; padding: 12px 16px; font-size: 1rem; }
    .footer-links a { padding: 12px 10px; }
  }
</style>
</head>
<body>
<p class="msg">${htmlEscape(message)}</p>
${imagesHtml}
${formHtml}
<p class="footer-links"><a href="https://diar.ia.br">← Voltar para a Diar.ia</a> &nbsp;|&nbsp; <a href="${leaderboardSlug ? `/leaderboard/${leaderboardSlug}` : "/leaderboard"}">Ver leaderboard</a></p>
</body>
</html>`;
}

/**
 * Pure (#1351): renderiza HTML das imagens A e B com labels e highlight da
 * clicada. Retorna "" quando `resultImages` é null/undefined (sem gabarito).
 *
 * Image URL pattern: poll.diaria.workers.dev/img/img-{AAMMDD}-01-eia-{A|B}.jpg
 * — mesma URL servida pelo handler /img que o newsletter HTML usa.
 *
 * Exportado pra teste.
 */
export function renderResultImagesHtml(resultImages: VoteResultImages | null | undefined): string {
  if (!resultImages) return "";
  const { edition, aiSide, clickedSide } = resultImages;
  const renderSide = (side: "A" | "B"): string => {
    const isAi = side === aiSide;
    const isClicked = side === clickedSide;
    const label = isAi ? "🤖 Gerada por IA" : "📷 Foto real";
    const youBadge = isClicked
      ? `<span class="you">Você clicou</span>`
      : "";
    const imgUrl = `/img/img-${edition}-01-eia-${side}.jpg`;
    return `<div class="result-image${isClicked ? " clicked" : ""}">
  <img src="${imgUrl}" alt="Imagem ${side}" loading="lazy">
  <div class="label">${label}${youBadge}</div>
</div>`;
  };
  return `<div class="result-images">
${renderSide("A")}
${renderSide("B")}
</div>`;
}

// ── /set-name — leitor escolhe nickname pra leaderboard (#1078) ─────────────

async function handleSetName(url: URL, env: Env): Promise<Response> {
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const name = url.searchParams.get("name")?.trim();
  const sig = url.searchParams.get("sig");

  if (!email || !name || !sig) {
    return new Response(votePageHtml("Link inválido — parâmetros ausentes.", false), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const valid = await hmacVerify(env.POLL_SECRET, `setname:${email}`, sig);
  if (!valid) {
    return new Response(votePageHtml("Link inválido ou expirado.", false), {
      status: 403, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // Sanitize name: max 40 chars, strip HTML
  const cleanName = name.slice(0, 40).replace(/[<>]/g, "");
  if (!cleanName) {
    return new Response(votePageHtml("Nome vazio — tente novamente.", false), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  if (!raw) {
    return new Response(votePageHtml("Vote primeiro antes de definir nickname.", false), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const score = JSON.parse(raw);
  score.nickname = cleanName;
  await env.POLL.put(scoreKey, JSON.stringify(score));

  // #1345: propaga nickname em todas as `score-by-month:*:{email}` keys.
  // Sem isso, leaderboard mensal mostra nickname antigo (ou null) até nova
  // vote criar entry com nickname atualizado.
  await propagateNicknameByMonth(env, email, cleanName);

  return new Response(votePageHtml(`Pronto, ${cleanName}! Você aparece assim no ranking.`, true), {
    status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
  });
}

/**
 * #1345: lista todas as `score-by-month:*:{email}` keys do subscriber e
 * atualiza nickname em cada. Costo: 1 list + N gets + N puts (N = meses
 * em que o subscriber votou). Volume baixo na prática (~12 meses/ano).
 */
async function propagateNicknameByMonth(
  env: Env,
  email: string,
  nickname: string,
): Promise<void> {
  // KV não suporta suffix filter; precisa listar todas as score-by-month:*
  // e filtrar pelo email. Em escala pequena (≤12 meses × 1 email) é OK.
  // #1345 followup: list paginado via listAllKeys pra cobrir caso >1000 keys.
  const suffix = `:${email}`;
  const slugsTouched = new Set<string>();
  for await (const keyName of listAllKeys(env, "score-by-month:")) {
    if (!keyName.endsWith(suffix)) continue;
    const raw = await env.POLL.get(keyName);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    if (entry.nickname === nickname) continue; // no-op
    entry.nickname = nickname;
    await env.POLL.put(keyName, JSON.stringify(entry));
    // Extrair slug pra invalidar snapshot correspondente. Key formato:
    // "score-by-month:{slug}:{email}" — split em 3 partes (limit não
    // confiável pq email pode ter ":").
    const slugMatch = keyName.match(/^score-by-month:(\d{4}-\d{2}):/);
    if (slugMatch) slugsTouched.add(slugMatch[1]);
  }
  // #1348: invalidate snapshot de cada slug afetado. Próximo read recompute fresh.
  for (const slug of slugsTouched) {
    await invalidateSnapshot(env, slug);
  }
}

// ── /img/{key} — serve imagens armazenadas no KV ─────────────────────────────

export async function handleImage(path: string, env: Env): Promise<Response> {
  // CORS: imagens são públicas — emitir Access-Control-Allow-Origin em todos
  // os paths (200 e 404). #1132 P2.4: pre-check de CORS faz probe contra key
  // que pode não existir; com CORS apenas em 200, pre-check produzia falso
  // negativo. Padrão consistente.
  const corsHeaders = { "Access-Control-Allow-Origin": "*" };

  const key = decodeURIComponent(path.slice("/img/".length));
  if (!key) {
    return new Response("not found", { status: 404, headers: corsHeaders });
  }

  const value = await env.POLL.get(key, "arrayBuffer");
  if (!value) {
    return new Response("not found", { status: 404, headers: corsHeaders });
  }

  // Imagens do È IA? são sempre JPEG. TTL 1h (#1242): permite regenerar imagem
  // com mesmo key sem ficar presa em cache do Gmail Image Proxy / Beehiiv preview
  // por 1 ano. Volume baixo (~6 imgs × ~500 subs/edição) sustenta cache miss.
  return new Response(value, {
    headers: {
      ...corsHeaders,
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
// #1239: /html/{key} handlers moved to dedicated Worker `draft` (deployed
// at https://draft.diaria.workers.dev/{edition}). Removed here pós grace
// period — todos URLs antigos com TTL 12h já expiraram. Keys no KV ainda
// existem mas inacessíveis via Worker (KV TTL eventually expira sozinho).

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // #1319: trailing slash → 301 redirect pra versão canonical.
    // Router usa strict equality, então `/leaderboard/` dava 404. Lógica pura
    // em lib.ts pra ser testável.
    const stripped = redirectTargetForTrailingSlash(path);
    if (stripped !== null) {
      const target = new URL(request.url);
      target.pathname = stripped;
      return Response.redirect(target.toString(), 301);
    }

    // #1420: fail-loud com 503 quando secrets ausentes (em vez de 500
    // generic crash). Diagnóstico explícito facilita debug pós-deploy
    // sem secrets re-setados (#1415). Method-aware pra não regredir
    // mensagem de 404 → 503 em métodos errados (ex: GET /admin/correct).
    const missingSecrets = missingSecretsForRoute(env, path, request.method);
    if (missingSecrets.length > 0) {
      return json({
        error: "server_misconfigured",
        missing_secrets: missingSecrets,
        action: `Re-set secrets via: cd workers/poll && wrangler secret put ${missingSecrets[0]}`,
      }, 503, env);
    }

    if (path === "/vote" && request.method === "GET") return handleVote(url, env);
    if (path === "/stats" && request.method === "GET") return handleStats(url, env);
    if (path === "/leaderboard" && request.method === "GET") return handleLeaderboard(env);
    if (path === "/leaderboard/top1" && request.method === "GET") return handleLeaderboardTop1(url, env);
    // #1345: /leaderboard/{YYYY-MM} — URL única por mês de publicação
    if (path.startsWith("/leaderboard/") && request.method === "GET") {
      const monthMatch = path.match(/^\/leaderboard\/(\d{4}-\d{2})$/);
      if (monthMatch) return handleLeaderboardByMonth(monthMatch[1], env);
    }
    if (path === "/set-name" && request.method === "GET") return handleSetName(url, env);
    if (path === "/admin/correct" && request.method === "POST") return handleAdminCorrect(url, env);
    if (path.startsWith("/img/") && request.method === "GET") return handleImage(path, env);
    // #1239: /html/{key} migrado pra Worker draft (https://draft.diaria.workers.dev/{edition})

    return json({ error: "not found", endpoints: ["/vote", "/stats", "/leaderboard", "/leaderboard/{YYYY-MM}", "/leaderboard/top1", "/set-name", "/admin/correct", "/img/{key}"] }, 404, env);
  },
  // #1077 → #1345: cron de reset mensal removido. Leaderboard agora é
  // indexado por publication date (score-by-month:{YYYY-MM}:{email}); reset
  // não é mais necessário — meses são naturalmente isolados.
};
