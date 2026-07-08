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
  validateNickname,
  normalizeNickname,
  type Brand,
  BRAND_INFO,
  parseBrandParam,
  brandKvPrefix,
  leaderboardHref,
} from "./lib";
// #3111: tokens do DS canônico gerados por scripts/generate-worker-tokens.ts a
// partir de scripts/lib/shared/design-tokens.ts — nunca hardcodear valores de
// cor/fonte inline aqui (ver test/poll-ds-tokens.test.ts para a trava).
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";
export { VoteDedup } from "./vote-dedup";
export { StatsCounter } from "./stats-counter";

export interface Env {
  POLL: KVNamespace;
  /** #2187: Durable Object namespace para serialização de dedup de voto por email.
   * Opcional para compat com testes que não passam o binding (falha graciosamente
   * para KV-only dedup quando VOTE_DEDUP não está disponível). */
  VOTE_DEDUP?: DurableObjectNamespace;
  /** #2223: Durable Object namespace para serialização do contador stats edition-wide.
   * Opcional para compat com testes sem binding (fallback para KV read-modify-write
   * quando STATS_COUNTER não está disponível — mantém comportamento anterior).
   *
   * Instanciado por `{brand}:{edition}` — brand incluído para isolamento entre
   * diaria×clarice (mesmo padrão do VOTE_DEDUP). */
  STATS_COUNTER?: DurableObjectNamespace;
  POLL_SECRET: string;
  ADMIN_SECRET: string;
  ALLOWED_ORIGINS: string;
  /** #3116: origin da request atual (`request.headers.get("Origin")`),
   * extraído 1x no entrypoint `fetch()` e propagado via spread de `env` (e
   * `brandedEnv`, que também espalha `env`) por toda a árvore de handlers que
   * termina em `corsHeaders()`/`json()` sem precisar re-threadear `request`
   * por cada assinatura (handleVote, handleStats, handleAdminCorrect, etc.).
   * Runtime-only — nunca setado por `wrangler secret`/vars; opcional pra não
   * quebrar fixtures de teste existentes que constroem `Env` sem esse campo
   * (nesse caso corsHeaders() trata como request sem Origin). */
  _requestOrigin?: string | null;
}

// ── Brand namespacing (#1905) ─────────────────────────────────────────────────

/**
 * #1905: embrulha `env.POLL` prefixando TODA chave com `prefix` (ex: `clarice:`).
 * Prefix vazio (diaria) retorna o KV original — chaves legadas 100% intactas.
 *
 * `list()` injeta o prefixo na query E o stripa dos `name`s retornados — assim
 * a lógica dos handlers (que faz `key.replace(localPrefix, "")` e
 * `env.POLL.get(key)` com o name listado) continua byte-idêntica, sem precisar
 * conhecer o brand. Threading do brand fica isolado à camada de acesso ao KV.
 */
export function brandedNamespace(kv: KVNamespace, prefix: string): KVNamespace {
  if (!prefix) return kv;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const wrapped = {
    get: (key: string, opts?: any) => kv.get(prefix + key, opts),
    getWithMetadata: (key: string, opts?: any) => kv.getWithMetadata(prefix + key, opts),
    put: (key: string, value: any, opts?: any) => kv.put(prefix + key, value, opts),
    delete: (key: string) => kv.delete(prefix + key),
    list: async (opts?: any) => {
      const res = await kv.list({ ...opts, prefix: prefix + (opts?.prefix ?? "") });
      return {
        ...res,
        keys: res.keys.map((k: any) => ({ ...k, name: k.name.slice(prefix.length) })),
      };
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return wrapped as unknown as KVNamespace;
}

/** #1905: env com `POLL` embrulhado no namespace do brand. */
function brandedEnv(env: Env, brand: Brand): Env {
  return { ...env, POLL: brandedNamespace(env.POLL, brandKvPrefix(brand)) };
}

// ── HMAC helpers ─────────────────────────────────────────────────────────────

export async function hmacSign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacVerify(secret: string, message: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  // Constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ── CORS helper ───────────────────────────────────────────────────────────────

/**
 * #3116: `Access-Control-Allow-Origin` só aceita UM valor (ou `*`) pela spec de
 * CORS — ecoar `ALLOWED_ORIGINS` (`"https://diar.ia.br,https://diaria.beehiiv.com"`,
 * ver `wrangler.toml`) inteiro como string concatenada por vírgula produz um
 * header inválido; navegadores tratam isso como mismatch e bloqueiam a resposta,
 * quebrando CORS exatamente pras origens que deveria permitir.
 *
 * Fix: split de `ALLOWED_ORIGINS` por vírgula; se a `Origin` da request
 * (`env._requestOrigin`, ver `Env`) estiver na lista, ecoa SOMENTE ela + `Vary:
 * Origin` (evita que caches intermediários sirvam a resposta de uma origem
 * pra outra). Se não estiver (ou a request não mandar `Origin`), omite o
 * header por completo — nunca vaza a allowlist nem ecoa uma origem arbitrária.
 *
 * `ALLOWED_ORIGINS` vazio ou `"*"` preserva o comportamento anterior de
 * allow-all (não há allowlist real a validar contra Origin).
 */
export function corsHeaders(env: Env): Record<string, string> {
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  const configured = (env.ALLOWED_ORIGINS ?? "").trim();
  if (configured === "" || configured === "*") {
    return { "Access-Control-Allow-Origin": "*", ...base };
  }

  const allowed = configured.split(",").map((o) => o.trim()).filter(Boolean);
  const origin = env._requestOrigin;
  if (origin && allowed.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", ...base };
  }

  return base;
}

export function json(data: unknown, status = 200, env?: Env): Response {
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
  isUnsubstitutedMergeTag,
  redirectTargetForTrailingSlash,
  classify403Reason,
} from "./lib";
export { formatEditionDate, htmlEscape, parseValidEditions, isValidEdition, isUnsubstitutedMergeTag, redirectTargetForTrailingSlash, classify403Reason } from "./lib";

// ── /vote ─────────────────────────────────────────────────────────────────────

/**
 * #1805: TODA resposta do /vote sai com `Cache-Control: no-store` (+ Pragma).
 * Voto é estado mutável por-usuário e os erros transitórios são cacheáveis por
 * padrão (HTTP 410/403 — RFC 7231 §6.5.9). Sem o header, o navegador do leitor
 * cacheia o 410/403 pra URL exata do voto e re-clicar o MESMO link serve a
 * resposta stale — sem nem bater no worker (incident 260604). Centralizar aqui
 * garante que nenhum dos ramos (400/403/410/200) escape do no-store.
 */
export function voteHtmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    },
  });
}

export * from "./vote";
export * from "./leaderboard-routes";
import {
  handleVote,
  handleStats,
  adjustScoreCorrectOnly,
  adjustScoreByMonthCorrectOnly,
} from "./vote";
import {
  handleLeaderboard,
  handleLeaderboardTop1,
  handleLeaderboardByMonth,
  handleLeaderboardByMonthJson,
  handleLeaderboardByYear,
  handleLeaderboardArchive,
  handleArchiveVotePage,
  invalidateSnapshot,
  listAllKeys,
} from "./leaderboard-routes";

// ── /admin/correct ────────────────────────────────────────────────────────────

async function handleAdminCorrect(url: URL, env: Env, brand: Brand = "diaria"): Promise<Response> {
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
  // #2202: re-avalia TODAS as entradas (null, undefined, false E true) contra
  // o novo gabarito. O guard anterior `else if (vote.correct === true)` só
  // contava, nunca re-pontuava — quando gabarito muda A→B, quem escolheu A
  // (antes correct=true) ficava com score errado permanentemente.
  // Usa adjustScoreCorrectOnly (não updateScore) para NÃO re-incrementar total/streak.
  const prefix = `vote:${edition}:`;
  let updated = 0;
  let correctCount = 0;

  for await (const keyName of listAllKeys(env, prefix)) {
    const raw = await env.POLL.get(keyName);
    if (!raw) continue;
    const vote = JSON.parse(raw);
    const prevCorrect = vote.correct ?? null;
    const newCorrect = vote.choice === answer;

    // Re-avalia sempre: cobre null→true, false→true, true→false, true→true.
    // Só escreve e conta updated_votes quando o valor realmente muda.
    const changed = prevCorrect !== newCorrect;
    if (changed) {
      await env.POLL.put(keyName, JSON.stringify({ ...vote, correct: newCorrect }));
      const email = keyName.replace(prefix, "");
      // #2202: adjustScoreCorrectOnly — ajusta apenas `correct`, NUNCA total/streak.
      await adjustScoreCorrectOnly(env, email, prevCorrect, newCorrect);
      // #2206: adjustScoreByMonthCorrectOnly — espelha a bidirecionalidade no mensal.
      // Decrementa em true→false (antes era increment-only, causando acerto fantasma).
      await adjustScoreByMonthCorrectOnly(env, email, edition, prevCorrect, newCorrect);
      updated++;
    }
    if (newCorrect) correctCount++;
  }

  // #1348: invalida snapshot do mês UMA vez após o loop — todos os votos acima
  // pertencem à mesma edição (mesmo monthSlug). N× invalidações dentro do loop
  // são no-op deletes; uma única após o loop economiza subrequests free-tier.
  // (adjustScoreByMonthCorrectOnly não chama mais invalidateSnapshot internamente.)
  const monthSlugForEdition = editionToMonthSlug(edition);
  if (monthSlugForEdition !== null && updated > 0) {
    await invalidateSnapshot(env, monthSlugForEdition);
  }

  // Fix #2: atualizar correct_count no DO StatsCounter (fonte autoritativa do /stats)
  // ANTES de atualizar o KV espelho. Sem isso, /stats lê do DO e retorna o valor
  // stale pré-correção, mesmo após o admin definir o gabarito correto.
  //
  // Consistência DO×KV: DO é atualizado primeiro; falha do DO é logada mas não
  // bloqueia o update do KV espelho (melhor ter KV correto e DO stale do que nenhum).
  if (env.STATS_COUNTER) {
    try {
      const doId = env.STATS_COUNTER.idFromName(`${brand}:${edition}`);
      const doStub = env.STATS_COUNTER.get(doId);
      const doResp = await doStub.fetch("https://internal/adjust-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correct_count: correctCount }),
      });
      if (!doResp.ok) {
        console.error(JSON.stringify({ event: "stats_counter_adjust_correct_error", status: doResp.status, edition }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "stats_counter_adjust_correct_error", edition, error: String(e) }));
    }
  }

  // Actualizar counter agregado KV com correct_count real (espelho para compat)
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
  brand: Brand = "diaria",
  /** #2113(a): cache-buster timestamp pro link "Ver leaderboard" logo após o voto.
   * Quando fornecido, apêndice `&v={cacheBusterTs}` só neste link — quebra o
   * cache do navegador que cacheou a página de leaderboard antes do voto.
   * Só passado por handleVote no resultado do voto (não afeta tráfego orgânico). */
  cacheBusterTs?: string | null,
): string {
  // #1083: htmlEscape no email (user-controlled) previne XSS via attribute
  // break. Sig é hex HMAC controlado pelo Worker — escape por consistência.
  // #1353: prompt recorrente até subscriber definir nickname.
  // handleVote já chama votePageHtml com nicknameForm sempre que
  // !scoreObj?.nickname — então este form aparece em CADA vote até ser
  // preenchido. Texto explícito sobre consequência (aparecer como email
  // mascarado no leaderboard) incentiva preenchimento.
  // #3109: "mensal" estava hardcoded mesmo pro brand clarice, cujo leaderboard
  // é ANUAL (BRAND_INFO.clarice.leaderboardPeriod === "year"). Deriva do
  // mesmo campo já usado em vote.ts (#2061) — um 3º brand anual herda o
  // texto correto sem tocar aqui.
  const leaderboardPeriodWord = BRAND_INFO[brand].leaderboardPeriod === "year" ? "anual" : "mensal";
  const formHtml = nicknameForm ? `
<div class="nick-box">
  <p class="nick-title">Defina seu nickname pra aparecer no leaderboard ${leaderboardPeriodWord}</p>
  <p class="nick-explain">Sem nickname você aparece como <code>${htmlEscape(nicknameForm.email.replace(/@.*/, "@***"))}</code> no ranking público.</p>
  <form action="/set-name" method="GET" class="nick-form">
    <input type="hidden" name="email" value="${htmlEscape(nicknameForm.email)}">
    <input type="hidden" name="sig" value="${htmlEscape(nicknameForm.sig)}">
    ${brand === "diaria" ? "" : `<input type="hidden" name="brand" value="${htmlEscape(brand)}">`}
    <input type="text" name="name" placeholder="Seu nome" maxlength="40" required class="nick-input">
    <button type="submit" class="nick-save">Salvar</button>
  </form>
  <p class="nick-note">Pode ser apelido. Mostrado publicamente.</p>
</div>` : "";

  // #1351: HTML pra mostrar imagens A e B com labels + highlight da clicada
  const imagesHtml = renderResultImagesHtml(resultImages);

  // #2113(a): link do leaderboard com cache-buster quando vindo do resultado do voto.
  const leaderboardBase = leaderboardHref(brand, leaderboardSlug);
  const leaderboardLink = cacheBusterTs
    ? `${leaderboardBase}${leaderboardBase.includes("?") ? "&" : "?"}v=${cacheBusterTs}`
    : leaderboardBase;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? | ${BRAND_INFO[brand].name}</title>
<style>
  /* #1936: design system canônico — papel + tinta + serif Georgia + sans Geist +
     acento teal, importados de ds-tokens.generated.ts (#3111 — antes hardcoded
     inline aqui). #3111 também removeu o @import do webfont Geist (Google
     Fonts): Cursos/Livros (as outras 2 páginas do mesmo DS) já não carregavam
     o arquivo da fonte — cai pra system sans nas 3 igual, sem 3ª origem
     externa/latência extra no worker de maior tráfego. */
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  .msg { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; line-height: 1.4; margin: 20px 0; letter-spacing: -0.01em; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .result-images { display: flex; gap: 12px; margin: 24px 0; justify-content: center; flex-wrap: wrap; }
  .result-image { box-sizing: border-box; flex: 1 1 240px; max-width: 260px; padding: 8px; border: 2px solid transparent; border-radius: 8px; background: ${DS_COLORS.paper}; }
  /* #1894: accent verde da marca (--brand-bright) — sinal da imagem clicada. */
  .result-image.clicked { border-color: ${DS_COLORS.brand}; box-shadow: 0 0 0 2px rgba(0,160,160,.28); }
  .result-image img { width: 100%; height: auto; border-radius: 6px; display: block; }
  /* #3113 item 6: cinza via opacity (rgba) abolido do DS — texto secundário
     é ink com hierarquia por tamanho/peso, não opacity (design-tokens.ts). */
  .result-image .label { font-family: ${DS_FONTS.sans}; font-size: 0.95rem; margin-top: 8px; color: ${DS_COLORS.ink}; font-weight: 600; }
  /* #3110: fundo ink em vez de teal — teal+onInk dava
     ~3:1 de contraste (abaixo de AA 4.5:1); ink+onInk dá ~15:1. Teal é SÓ
     texto no design system (design-tokens.ts) — botões/badges cheios usam ink. */
  .result-image .you { display: inline-block; padding: 2px 8px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 4px; font-size: 0.75rem; font-weight: 700; margin-left: 6px; }
  /* #1675/#1779: nickname form + textos como classes (eram inline → media query
     não conseguia ampliar; causa do "texto miúdo no mobile"). */
  .nick-box { margin: 30px auto; padding: 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 380px; }
  .nick-title { font-size: 1.1rem; margin: 0 0 12px 0; font-weight: 600; }
  .nick-explain { font-size: 0.95rem; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; line-height: 1.5; }
  .nick-explain code { background: ${DS_COLORS.paper}; padding: 1px 4px; border-radius: 3px; }
  .nick-note { font-size: 0.85rem; color: ${DS_COLORS.ink}; margin: 10px 0 0 0; }
  .nick-form { display: flex; gap: 8px; }
  .nick-input { flex: 1; padding: 8px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  /* #3110: fundo ink, não teal — botão cheio em teal reprovava
     contraste AA (~3:1 vs mínimo 4.5:1). Ink+onInk dá ~15:1. */
  .nick-save { padding: 8px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-family: ${DS_FONTS.sans}; }
  .footer-links { font-size: 0.95rem; }
  .footer-links a { display: inline-block; padding: 6px 4px; }
  /* #1675: tráfego majoritariamente mobile. Abaixo de 480px: menos margem topo,
     form empilhado, botão full-width, tap targets ~44px. */
  /* #1779: tráfego majoritariamente mobile. Breakpoint 600px cobre celulares
     grandes/landscape também. Aqui AMPLIAMOS texto/elementos (a queixa do editor
     era "miúdo") — antes o #1675 encolhia .msg (1.3→1.15), contraproducente. */
  @media (max-width: 600px) {
    body { margin: 24px auto; padding: 0 16px; font-size: 18px; }
    .msg { font-size: 1.5rem; }
    /* Empilha A/B full-width: imagens GRANDES e legíveis em vez de 2-up minúsculo. */
    .result-image { flex-basis: 100%; max-width: 100%; }
    .result-image .label { font-size: 1.05rem; }
    .nick-box { max-width: 100%; padding: 20px 18px; }
    .nick-title { font-size: 1.15rem; }
    .nick-explain { font-size: 1rem; }
    .nick-note { font-size: 0.9rem; }
    .nick-form { flex-direction: column; }
    /* flex:none reseta o flex:1 do base — em coluna, flex-grow agiria no eixo
       vertical (input esticaria). Cross-axis stretch mantém largura total. */
    .nick-input { flex: none; padding: 14px; font-size: 1.1rem; }
    .nick-save { width: 100%; padding: 14px 16px; font-size: 1.1rem; }
    .footer-links { font-size: 1.05rem; }
    .footer-links a { padding: 12px 10px; }
  }
</style>
</head>
<body>
<p class="msg">${htmlEscape(message)}</p>
${imagesHtml}
${formHtml}
<p class="footer-links"><a href="${BRAND_INFO[brand].siteUrl}">← Voltar para a ${BRAND_INFO[brand].name}</a> &nbsp;|&nbsp; <a href="${leaderboardLink}">Ver leaderboard</a></p>
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

export async function handleSetName(url: URL, env: Env, brand: Brand = "diaria"): Promise<Response> {
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const name = url.searchParams.get("name")?.trim();
  const sig = url.searchParams.get("sig");

  if (!email || !name || !sig) {
    return new Response(votePageHtml("Link inválido — parâmetros ausentes.", false, null, null, null, brand), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const valid = await hmacVerify(env.POLL_SECRET, `setname:${email}`, sig);
  if (!valid) {
    return new Response(votePageHtml("Link inválido ou expirado.", false, null, null, null, brand), {
      status: 403, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // Sanitize name: max 40 chars, strip HTML
  const cleanName = name.slice(0, 40).replace(/[<>]/g, "");
  if (!cleanName) {
    return new Response(votePageHtml("Nome vazio — tente novamente.", false, null, null, null, brand), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // Form de re-tentativa: o sig recebido já passou no hmacVerify acima, então
  // pode ser reusado pra re-renderizar o input e o leitor corrigir o apelido
  // sem voltar pro email (#1758 review #1774 — senão rejeição vira beco sem saída).
  const retryForm = { email, sig };

  // #1758: rejeita apelido vazio-de-conteúdo (emoji-only) ou na blacklist ("eu").
  const validationError = validateNickname(cleanName);
  if (validationError) {
    return new Response(votePageHtml(validationError, false, retryForm, null, null, brand), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const scoreKey = `score:${email}`;
  const raw = await env.POLL.get(scoreKey);
  if (!raw) {
    return new Response(votePageHtml("Vote primeiro antes de definir nickname.", false, null, null, null, brand), {
      status: 400, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  // #1758/#3117: sem apelidos duplicados — outro email já usando o mesmo
  // apelido (comparação normalizada, case/acento-insensitive) → rejeita.
  // Dedup via índice `nickname:{normalizado}` → email (1 get), NÃO mais um
  // scan de score:* (era O(N) sobre todo votante all-time — já ~60+ hoje,
  // na zona de estouro do teto de 50 subrequests/request do Workers free
  // plan; ver #3117). O índice precisa ser populado 1x via
  // scripts/migrate-nickname-index.ts antes deste código ir ao ar — sem
  // isso o dedup fica cego pros nicknames já existentes (índice vazio).
  const targetNorm = normalizeNickname(cleanName);
  const indexKey = `nickname:${targetNorm}`;
  const existingOwner = await env.POLL.get(indexKey);
  if (existingOwner && existingOwner !== email) {
    return new Response(
      votePageHtml("Esse apelido já está em uso. Escolha outro.", false, retryForm, null, null, brand),
      { status: 409, headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  }

  const score = JSON.parse(raw);
  const oldNickname: string | null | undefined = score.nickname;
  score.nickname = cleanName;
  await env.POLL.put(scoreKey, JSON.stringify(score));

  // Libera o índice do apelido antigo (se houver e for diferente do novo) —
  // senão o apelido anterior fica "preso" pra sempre, impedindo outro leitor
  // de usá-lo mesmo após este usuário trocar de nickname.
  //
  // Self-review #3117 (finding #2): checa ownership antes do delete — não
  // basta "oldNickname != targetNorm", precisa confirmar que o índice antigo
  // AINDA aponta pro `email` atual. Se entre a leitura do score (linha acima)
  // e este ponto outro leitor já reivindicou esse mesmo apelido normalizado
  // (race: outro /set-name concorrente passou pelo dedup-check antes deste
  // `put` acontecer), o índice já pertence a esse terceiro — deletar às cegas
  // apagaria a reivindicação legítima dele, reabrindo o apelido pra reuso
  // indevido. Só deleta se o dono ainda for este mesmo email.
  if (oldNickname && normalizeNickname(oldNickname) !== targetNorm) {
    const oldIndexKey = `nickname:${normalizeNickname(oldNickname)}`;
    const oldIndexOwner = await env.POLL.get(oldIndexKey);
    if (oldIndexOwner === email) {
      await env.POLL.delete(oldIndexKey);
    }
  }
  await env.POLL.put(indexKey, email);

  // #1345: propaga nickname em todas as `score-by-month:*:{email}` keys.
  // Sem isso, leaderboard mensal mostra nickname antigo (ou null) até nova
  // vote criar entry com nickname atualizado.
  await propagateNicknameByMonth(env, email, cleanName);

  return new Response(votePageHtml(`Pronto, ${cleanName}! Você aparece assim no ranking.`, true, null, null, null, brand), {
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

    // #3116: extrai a Origin da request 1x aqui e anexa a `env` (spread) —
    // corsHeaders()/json() downstream (chamados por handleVote, handleStats,
    // handleAdminCorrect etc., nenhum dos quais recebe `request`) conseguem
    // ecoar o valor exato sem re-threadear `request` por toda a árvore.
    env = { ...env, _requestOrigin: request.headers.get("Origin") };

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

    // #1905: brand isola o leaderboard (diaria diário vs clarice mensal). `env`
    // embrulhado prefixa as chaves KV; handlers de display recebem o brand.
    // Imagens (/img) usam o `env` original — keys de imagem são compartilhadas.
    const brand = parseBrandParam(url.searchParams.get("brand"));
    const bEnv = brandedEnv(env, brand);

    if (path === "/vote" && request.method === "GET") return handleVote(url, bEnv, brand);
    if (path === "/stats" && request.method === "GET") return handleStats(url, bEnv, brand);
    if (path === "/leaderboard" && request.method === "GET") {
      // #2006/#2018: período canônico do leaderboard vem de BRAND_INFO.leaderboardPeriod.
      // "year" → visão anual (clarice: 1 voto/mês, faz sentido agregar ano inteiro).
      // "month" → visão mensal (diária: votos diários, ranking mês corrente).
      if (BRAND_INFO[brand].leaderboardPeriod === "year") {
        return handleLeaderboardByYear(currentMonthSlugBrt(new Date()).slice(0, 4), bEnv, brand);
      }
      return handleLeaderboard(bEnv, brand);
    }
    if (path === "/leaderboard/top1" && request.method === "GET") return handleLeaderboardTop1(url, bEnv);
    // #1345: /leaderboard/{YYYY-MM} — URL única por mês de publicação
    if (path.startsWith("/leaderboard/") && request.method === "GET") {
      // #2867: /leaderboard/{YYYY}/arquivo[/{AAMMDD}] — arquivo retroativo do
      // ano. Checado ANTES do monthMatch/yearMatch abaixo (regex mais específica).
      const archiveVoteMatch = path.match(/^\/leaderboard\/(\d{4})\/arquivo\/(\d{6})$/);
      if (archiveVoteMatch) return handleArchiveVotePage(archiveVoteMatch[1], archiveVoteMatch[2], bEnv, brand);
      const archiveListMatch = path.match(/^\/leaderboard\/(\d{4})\/arquivo$/);
      if (archiveListMatch) return handleLeaderboardArchive(archiveListMatch[1], bEnv, brand);

      const monthMatch = path.match(/^\/leaderboard\/(\d{4}-\d{2})$/);
      // #2114(b): auto-heal: links mensais já enviados com leaderboardPeriod="year"
      // redirecionam pra URL canônica anual. Antes renderizava in-place
      // (barra de endereço mostrava /leaderboard/2026-05 com título "Leaderboard
      // de 2026" — inconsistente). Com redirect, emails antigos também ficam corrigidos.
      // #2123: 302 (não 301) — leaderboardPeriod pode mudar em brands futuros e
      // a URL canônica do mês não é permanentemente inválida, apenas não-canônica
      // para brands com period="year". Um 301 é cacheado permanentemente pelos
      // navegadores; se o brand mudar de "year" pra "month", leitores com cache
      // 301 ficariam presos na URL anual indefinidamente sem nenhuma forma de
      // autocorreção. 302 (temporário) permite que o Worker altere o redirect
      // futuramente sem quebrar leitores já cacheados.
      if (monthMatch && BRAND_INFO[brand].leaderboardPeriod === "year") {
        const yearStr = monthMatch[1].slice(0, 4);
        const target = new URL(request.url);
        target.pathname = `/leaderboard/${yearStr}`;
        // #2130: Cache-Control: no-store evita que proxies/link-preview cacheiem o
        // redirect e sirvam destino stale se leaderboardPeriod mudar no futuro.
        // Response.redirect() não aceita headers — usamos Response manual com 302.
        return new Response(null, {
          status: 302,
          headers: { Location: target.toString(), "Cache-Control": "no-store" },
        });
      }
      const jsonMonthMatch = path.match(/^\/leaderboard\/(\d{4}-\d{2})\.json$/);
      if (jsonMonthMatch) return handleLeaderboardByMonthJson(jsonMonthMatch[1], bEnv, brand);
      if (monthMatch) return handleLeaderboardByMonth(monthMatch[1], bEnv, brand);
      const yearMatch = path.match(/^\/leaderboard\/(\d{4})$/); // #2006: rota anual explícita (ambas as marcas)
      if (yearMatch) return handleLeaderboardByYear(yearMatch[1], bEnv, brand);
    }
    if (path === "/set-name" && request.method === "GET") return handleSetName(url, bEnv, brand);
    if (path === "/admin/correct" && request.method === "POST") return handleAdminCorrect(url, bEnv, brand);
    // #HEAD: clientes que fazem preflight HEAD antes de baixar a imagem (ex: Make.com/LinkedIn
    // ao validar a URL antes do upload) recebiam 404 aqui mesmo com o GET retornando 200 —
    // a rota só aceitava GET. O runtime do Workers descarta o body automaticamente em respostas
    // a HEAD, então basta aceitar o método na guarda; handleImage não precisa mudar.
    if (path.startsWith("/img/") && (request.method === "GET" || request.method === "HEAD")) return handleImage(path, env);
    // #1239: /html/{key} migrado pra Worker draft (https://draft.diaria.workers.dev/{edition})

    return json({ error: "not found", endpoints: ["/vote", "/stats", "/leaderboard", "/leaderboard/{YYYY-MM}", "/leaderboard/{YYYY-MM}.json", "/leaderboard/{YYYY}/arquivo", "/leaderboard/{YYYY}/arquivo/{AAMMDD}", "/leaderboard/top1", "/set-name", "/admin/correct", "/img/{key}"] }, 404, env);
  },
  // #1077 → #1345: cron de reset mensal removido. Leaderboard agora é
  // indexado por publication date (score-by-month:{YYYY-MM}:{email}); reset
  // não é mais necessário — meses são naturalmente isolados.
};
