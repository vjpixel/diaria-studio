/**
 * diar-ia-poll — Cloudflare Worker (#469)
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

// ── /vote ─────────────────────────────────────────────────────────────────────

async function handleVote(url: URL, env: Env): Promise<Response> {
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const edition = url.searchParams.get("edition");
  const choice = url.searchParams.get("choice")?.toUpperCase();
  // sig ausente = merge-tag mode: Beehiiv substitui {{ subscriber.email }} no envio
  const sig = url.searchParams.get("sig");

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

  // Se sig presente, verificar HMAC (backward compat com URLs assinadas via Kit).
  // Se sig ausente, confiar no email injetado pelo Beehiiv via merge tag.
  if (sig !== null) {
    const valid = await hmacVerify(env.POLL_SECRET, `${email}:${edition}`, sig);
    if (!valid) {
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
    return new Response(votePageHtml(`Você já votou na edição ${edition} (escolha: ${prev.choice}).`, false), {
      status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // Gravar voto
  const correctRaw = await env.POLL.get(`correct:${edition}`);
  const correct = correctRaw ? choice === correctRaw : null;

  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: new Date().toISOString(), correct }));

  // Atualizar counter agregado (evita N+1 reads no /stats)
  await updateStatsCounter(env, edition, choice as "A" | "B", correct);

  // Atualizar score individual se resposta correta já está definida
  if (correct !== null) {
    await updateScore(env, email, edition, correct);
  }

  const msg = correct === true
    ? "✅ Acertou! Era a imagem gerada por IA."
    : correct === false
    ? "❌ Não foi dessa vez — era a foto real."
    : "Voto registrado! O resultado sai na próxima edição.";

  return new Response(votePageHtml(msg, true), {
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

async function updateScore(env: Env, email: string, edition: string, correct: boolean): Promise<void> {
  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  const score = raw ? JSON.parse(raw) : { total: 0, correct: 0, streak: 0, last_edition: null };

  score.total += 1;
  if (correct) {
    score.correct += 1;
    score.streak = (score.streak || 0) + 1;
  } else {
    score.streak = 0;
  }
  score.last_edition = edition;

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

// ── /leaderboard ──────────────────────────────────────────────────────────────

async function handleLeaderboard(env: Env): Promise<Response> {
  const list = await env.POLL.list({ prefix: "score:" });
  const scores: Array<{ email: string; correct: number; total: number; pct: number; streak: number }> = [];

  for (const key of list.keys) {
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const score = JSON.parse(raw);
    const email = key.name.replace("score:", "");
    const pct = score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
    scores.push({ email, correct: score.correct, total: score.total, pct, streak: score.streak || 0 });
  }

  scores.sort((a, b) => b.correct - a.correct || b.pct - a.pct);

  const rows = scores.slice(0, 50).map((s, i) => {
    const masked = s.email.replace(/(.{2}).*(@.*)/, "$1***$2");
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    return `<tr>
      <td>${medal}</td>
      <td>${masked}</td>
      <td>${s.correct}/${s.total}</td>
      <td>${s.pct}%</td>
      <td>${s.streak > 1 ? `🔥 ${s.streak}` : s.streak}</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? — Leaderboard | Diar.ia</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  p.sub { color: #666; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #eee; font-size: 0.8rem; color: #666; text-transform: uppercase; }
  td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; }
  tr:first-child td { font-weight: bold; }
  a { color: #0066cc; }
</style>
</head>
<body>
<h1>🤔 É IA? — Leaderboard</h1>
<p class="sub">Quem mais acerta qual imagem foi gerada por IA na <a href="https://diar.ia.br">Diar.ia</a>.</p>
<table>
<thead><tr><th>#</th><th>Leitor</th><th>Acertos</th><th>%</th><th>Sequência</th></tr></thead>
<tbody>${rows || "<tr><td colspan=5 style='color:#999;text-align:center;padding:20px'>Ainda sem votos.</td></tr>"}</tbody>
</table>
<p style="margin-top:30px;font-size:0.8rem;color:#999">Atualizado em tempo real · E-mails mascarados por privacidade</p>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
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

function votePageHtml(message: string, success: boolean): string {
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
<p style="font-size:2rem">${success ? "✅" : "ℹ️"}</p>
<p class="msg">${message}</p>
<p><a href="https://diar.ia.br">← Voltar para a Diar.ia</a> &nbsp;|&nbsp; <a href="/leaderboard">Ver leaderboard</a></p>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (path === "/vote" && request.method === "GET") return handleVote(url, env);
    if (path === "/stats" && request.method === "GET") return handleStats(url, env);
    if (path === "/leaderboard" && request.method === "GET") return handleLeaderboard(env);
    if (path === "/admin/correct" && request.method === "POST") return handleAdminCorrect(url, env);

    return json({ error: "not found", endpoints: ["/vote", "/stats", "/leaderboard", "/admin/correct"] }, 404, env);
  },
};
