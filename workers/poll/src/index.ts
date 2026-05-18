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

// #1083: helpers puros extraídos pra `./lib.ts` pra ficarem testáveis em
// Node sem mock do Worker runtime. Re-exportados aqui pra back-compat de
// consumers externos (se algum dia houver) e pra leitura linear do código.
import {
  formatEditionDate,
  htmlEscape,
  parseValidEditions,
  isValidEdition,
  redirectTargetForTrailingSlash,
} from "./lib";
export { formatEditionDate, htmlEscape, parseValidEditions, isValidEdition, redirectTargetForTrailingSlash } from "./lib";

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
    return new Response(votePageHtml(`Você já votou na edição de ${formatEditionDate(edition)} (escolha: ${prev.choice}).`, false), {
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

  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: new Date().toISOString(), correct }));

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

  return new Response(votePageHtml(msg, true, nicknameForm), {
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

async function handleLeaderboardTop1(url: URL, env: Env): Promise<Response> {
  // #1345: ?period=YYYY-MM filtra mês específico via score-by-month index;
  // omitted = mês corrente. Default mantém compat com clientes existentes.
  const periodParam = url.searchParams.get("period");
  const monthSlug = periodParam ?? currentMonthSlugBrt(new Date());
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return json({ error: "period inválido — use YYYY-MM" }, 400, env);
  }

  const prefix = `score-by-month:${monthSlug}:`;
  const list = await env.POLL.list({ prefix });
  const scores: Array<{ email: string; nickname: string | null; correct: number; total: number }> = [];
  for (const key of list.keys) {
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    scores.push({
      email: key.name.replace(prefix, ""),
      nickname: entry.nickname ?? null,
      correct: entry.correct ?? 0,
      total: entry.total ?? 0,
    });
  }
  const top1 = computeTop1(scores);
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  return json({ top1, period: periodLabel, period_slug: monthSlug }, 200, env);
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
  entries: Array<{ email: string; nickname: string | null; correct: number; total: number }>,
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
    };
  });
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
  if (slugCmp > 0) {
    return new Response(votePageHtml(
      `O leaderboard de ${MONTH_NAMES_PT[parsed.month - 1]} de ${parsed.year} ainda não começou.`,
      false,
    ), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const prefix = `score-by-month:${monthSlug}:`;
  const list = await env.POLL.list({ prefix });
  const entries: Array<{ email: string; nickname: string | null; correct: number; total: number }> = [];
  for (const key of list.keys) {
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    entries.push({
      email: key.name.replace(prefix, ""),
      nickname: entry.nickname ?? null,
      correct: entry.correct ?? 0,
      total: entry.total ?? 0,
    });
  }

  const scores = scoreByMonthEntriesToLeaderboard(entries);
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  const isPast = slugCmp < 0;
  const cacheControl = isPast
    ? "public, max-age=2592000, immutable" // 30d, mês fechado nunca muda
    : "public, max-age=3600"; // 1h pro mês corrente

  return renderLeaderboardHtml(scores, periodLabel, parsed.year, cacheControl, env);
}

/** Pure render — separado pra ser reusado por `/leaderboard` (corrente) + `/leaderboard/{YYYY-MM}`. */
function renderLeaderboardHtml(
  scores: LeaderboardEntry[],
  periodLabel: string,
  year: number,
  cacheControl: string,
  _env: Env,
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

  // Retroativamente atualizar scores dos votos já gravados
  const prefix = `vote:${edition}:`;
  const list = await env.POLL.list({ prefix });
  let updated = 0;
  let correctCount = 0;

  for (const key of list.keys) {
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const vote = JSON.parse(raw);
    if (vote.correct === null || vote.correct === undefined) {
      const correct = vote.choice === answer;
      await env.POLL.put(key.name, JSON.stringify({ ...vote, correct }));
      const email = key.name.replace(prefix, "");
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

function votePageHtml(
  message: string,
  success: boolean,
  nicknameForm?: { email: string; sig: string } | null,
): string {
  // #1083: htmlEscape no email (user-controlled) previne XSS via attribute
  // break. Sig é hex HMAC controlado pelo Worker — escape por consistência.
  const formHtml = nicknameForm ? `
<div style="margin:30px auto;padding:20px;background:#f5f5f5;border-radius:8px;max-width:380px;">
  <p style="font-size:0.95rem;margin:0 0 12px 0;font-weight:600;">Como você quer ser chamado no ranking?</p>
  <form action="/set-name" method="GET" style="display:flex;gap:8px;">
    <input type="hidden" name="email" value="${htmlEscape(nicknameForm.email)}">
    <input type="hidden" name="sig" value="${htmlEscape(nicknameForm.sig)}">
    <input type="text" name="name" placeholder="Seu nome" maxlength="40" required style="flex:1;padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-size:0.95rem;">
    <button type="submit" style="padding:8px 16px;background:#00A0A0;color:#fff;border:none;border-radius:4px;font-weight:600;cursor:pointer;">Salvar</button>
  </form>
  <p style="font-size:0.75rem;color:#666;margin:10px 0 0 0;">Pode ser apelido. Mostrado publicamente no leaderboard.</p>
</div>` : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? | Diar.ia</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #1a1a1a; }
  .msg { font-size: 1.3rem; margin: 20px 0; }
  a { color: #0066cc; }
</style>
</head>
<body>
<p class="msg">${htmlEscape(message)}</p>
${formHtml}
<p><a href="https://diar.ia.br">← Voltar para a Diar.ia</a> &nbsp;|&nbsp; <a href="/leaderboard">Ver leaderboard</a></p>
</body>
</html>`;
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
  const list = await env.POLL.list({ prefix: "score-by-month:" });
  const suffix = `:${email}`;
  for (const key of list.keys) {
    if (!key.name.endsWith(suffix)) continue;
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const entry = JSON.parse(raw);
    if (entry.nickname === nickname) continue; // no-op
    entry.nickname = nickname;
    await env.POLL.put(key.name, JSON.stringify(entry));
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
