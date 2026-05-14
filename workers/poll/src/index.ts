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

import { rankEntries, type LeaderboardEntry } from "./leaderboard";

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
} from "./lib";
export { formatEditionDate, htmlEscape, parseValidEditions, isValidEdition } from "./lib";

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

  await env.POLL.put(voteKey, JSON.stringify({ choice, ts: new Date().toISOString(), correct }));

  // Atualizar counter agregado (evita N+1 reads no /stats)
  await updateStatsCounter(env, edition, choice as "A" | "B", correct);

  // #1080: sempre atualizar score, mesmo sem gabarito ainda. Sem isso, votos
  // antes do admin setar `correct:{edition}` ficam sem score → leaderboard
  // vazio + nickname form falha com "Vote primeiro".
  await updateScore(env, email, edition, correct);

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

// ── /leaderboard ──────────────────────────────────────────────────────────────

async function handleLeaderboard(env: Env): Promise<Response> {
  const list = await env.POLL.list({ prefix: "score:" });
  const scores: LeaderboardEntry[] = [];

  for (const key of list.keys) {
    const raw = await env.POLL.get(key.name);
    if (!raw) continue;
    const score = JSON.parse(raw);
    const email = key.name.replace("score:", "");
    const pct = score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
    scores.push({ email, nickname: score.nickname || null, correct: score.correct, total: score.total, pct, streak: score.streak || 0 });
  }

  // #1092: competition ranking — leitores com mesmo (correct, pct) ocupam o
  // mesmo número (1, 1, 3 — não 1, 2, 3 nem dense 1, 1, 2). Tiebreaker
  // dentro do empate: nickname/email ASC (estável).
  const ranked = rankEntries(scores).slice(0, 50);

  const rows = ranked.map((s) => {
    // #1078 / #1081 — usa nickname se setado; senão mostra local-part inteiro
    // do email + "@***" (privacidade do domínio, mantém local-part legível).
    const display = s.nickname || s.email.replace(/@.*/, "@***");
    const escaped = display.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
    const trClass = s.rank === 1 ? ' class="leader"' : '';
    return `<tr${trClass}>
      <td>${s.medal}</td>
      <td>${escaped}</td>
      <td>${s.correct}/${s.total}</td>
    </tr>`;
  }).join("\n");

  // #1081: período atual hardcoded como "Teste" enquanto o leaderboard estiver
  // em validação. Voltar pra mês dinâmico (MONTH_NAMES_PT[...]) antes de
  // divulgar pros leitores.
  const periodLabel = "Teste";

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderboard de ${periodLabel} | Diar.ia</title>
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
<h1 style="margin-bottom:4px;">Leaderboard de ${periodLabel}</h1>
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

  return new Response(votePageHtml(`Pronto, ${cleanName}! Você aparece assim no ranking.`, true), {
    status: 200, headers: { "Content-Type": "text/html;charset=utf-8" }
  });
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

    if (path === "/vote" && request.method === "GET") return handleVote(url, env);
    if (path === "/stats" && request.method === "GET") return handleStats(url, env);
    if (path === "/leaderboard" && request.method === "GET") return handleLeaderboard(env);
    if (path === "/set-name" && request.method === "GET") return handleSetName(url, env);
    if (path === "/admin/correct" && request.method === "POST") return handleAdminCorrect(url, env);
    if (path.startsWith("/img/") && request.method === "GET") return handleImage(path, env);
    // #1239: /html/{key} migrado pra Worker draft (https://draft.diaria.workers.dev/{edition})

    return json({ error: "not found", endpoints: ["/vote", "/stats", "/leaderboard", "/set-name", "/admin/correct", "/img/{key}"] }, 404, env);
  },
};
