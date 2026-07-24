/**
 * test/poll-magic-link-3996.test.ts (#3996 — Fase B do #3975)
 *
 * Migração de score anônimo→e-mail CROSS-DEVICE/CROSS-SESSÃO via link mágico
 * de confirmação. Cobre:
 *   1. `isValidMagicLinkToken`/`generateMagicLinkToken` — forma do token.
 *   2. `hasOrphanHistory` / `isIdentifyLinked` / `markIdentifyLinked` — a
 *      detecção que decide entre caminho rápido (Fase A, sem fricção) e
 *      caminho de confirmação (Fase B).
 *   3. `checkMagicLinkSendRateLimit` — teto de envio por par.
 *   4. `createPendingMerge`/`consumePendingMerge`/`hasPendingMerge` — ciclo
 *      de vida do token: TTL, one-time-use (replay sempre falha), dedup de
 *      envio.
 *   5. `buildConfirmMergeUrl` — pure, deriva do host da request atual.
 *   6. `sendMagicLinkEmail` — chamada à Brevo SEMPRE mockada (`fetchImpl`
 *      injetado, NUNCA rede real, guard do overnight/#633) — not_configured,
 *      sucesso, erro HTTP, erro de rede.
 *   7. `confirmMergeHtmlResponse`/`handleConfirmMerge` fim-a-fim — token
 *      ausente/malformado/inexistente/expirado/já usado, e o caminho feliz
 *      (dispara `performIdentifyMerge`, idêntico ao caminho imediato).
 *   8. `handleJogarIdentify` (identify.ts) integrado: histórico órfão desvia
 *      pro link mágico (sem merge imediato, sem duplicar e-mail em
 *      re-tentativas), e o caminho SEM histórico órfão permanece sem
 *      fricção (Fase A intocada).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import {
  isValidMagicLinkToken,
  generateMagicLinkToken,
  hasOrphanHistory,
  isIdentifyLinked,
  markIdentifyLinked,
  checkMagicLinkSendRateLimit,
  createPendingMerge,
  consumePendingMerge,
  hasPendingMerge,
  buildConfirmMergeUrl,
  sendMagicLinkEmail,
  confirmMergeHtmlResponse,
  handleConfirmMerge,
  MAGIC_LINK_TTL_SEC,
  MAGIC_LINK_SEND_RATE_LIMIT,
  type PendingMerge,
} from "../workers/poll/src/magic-link.ts";
import { handleJogarIdentify, performIdentifyMerge } from "../workers/poll/src/identify.ts";
import type { Env } from "../workers/poll/src/index.ts";

const ANON_A = "11111111-1111-4111-8111-111111111111@web.eia.diaria.local";
const ANON_B = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";

function makeEnv(seed: Record<string, string> = {}, extra: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ...extra,
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

/** Fake fetch — NUNCA rede real (#633, guard do overnight). Registra chamadas. */
function makeFakeFetch(impl?: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (impl) return impl(String(url), init);
    return new Response(JSON.stringify({ messageId: "fake" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ── isValidMagicLinkToken / generateMagicLinkToken ──────────────────────────

describe("isValidMagicLinkToken (#3996)", () => {
  it("aceita UUID gerado por crypto.randomUUID()", () => {
    const token = generateMagicLinkToken();
    assert.equal(isValidMagicLinkToken(token), true);
  });

  it("rejeita formas malformadas", () => {
    assert.equal(isValidMagicLinkToken(""), false);
    assert.equal(isValidMagicLinkToken("not-a-uuid"), false);
    assert.equal(isValidMagicLinkToken("11111111-1111-4111-8111"), false, "truncado");
    assert.equal(isValidMagicLinkToken("'; DROP TABLE--"), false, "injection-shaped garbage");
  });
});

// ── hasOrphanHistory / isIdentifyLinked / markIdentifyLinked ────────────────

describe("hasOrphanHistory (#3996)", () => {
  it("false quando score:{email} nunca existiu (1ª identificação, qualquer device)", async () => {
    const env = makeEnv();
    assert.equal(await hasOrphanHistory(env, "ana@x.com", ANON_A), false);
  });

  it("true quando score:{email} existe e o par (email, anonEmail) nunca foi confirmado", async () => {
    const env = makeEnv({ "score:ana@x.com": JSON.stringify({ total: 5, correct: 3, streak: 1, last_edition: "260601", nickname: "Ana" }) });
    assert.equal(await hasOrphanHistory(env, "ana@x.com", ANON_B), true);
  });

  it("false quando score:{email} existe MAS o par já foi confirmado antes (markIdentifyLinked)", async () => {
    const env = makeEnv({ "score:ana@x.com": JSON.stringify({ total: 5, correct: 3, streak: 1, last_edition: "260601", nickname: "Ana" }) });
    await markIdentifyLinked(env, "ana@x.com", ANON_B);
    assert.equal(await hasOrphanHistory(env, "ana@x.com", ANON_B), false);
  });

  it("isIdentifyLinked reflete exatamente o que markIdentifyLinked gravou", async () => {
    const env = makeEnv();
    assert.equal(await isIdentifyLinked(env, "x@y.com", ANON_A), false);
    await markIdentifyLinked(env, "x@y.com", ANON_A);
    assert.equal(await isIdentifyLinked(env, "x@y.com", ANON_A), true);
    // Par DIFERENTE (mesmo email, outro anonEmail) continua não-linkado.
    assert.equal(await isIdentifyLinked(env, "x@y.com", ANON_B), false);
  });
});

// ── checkMagicLinkSendRateLimit ──────────────────────────────────────────────

describe("checkMagicLinkSendRateLimit (#3996)", () => {
  it("permite até o teto, bloqueia depois — por PAR (anonEmail, email)", async () => {
    const env = makeEnv();
    for (let i = 0; i < MAGIC_LINK_SEND_RATE_LIMIT; i++) {
      const r = await checkMagicLinkSendRateLimit(env.POLL, ANON_A, "ana@x.com");
      assert.equal(r.allowed, true, `tentativa ${i + 1} deveria passar`);
    }
    const blocked = await checkMagicLinkSendRateLimit(env.POLL, ANON_A, "ana@x.com");
    assert.equal(blocked.allowed, false);
  });

  it("par diferente (outro anonEmail OU outro email) tem teto independente", async () => {
    const env = makeEnv();
    for (let i = 0; i < MAGIC_LINK_SEND_RATE_LIMIT; i++) {
      await checkMagicLinkSendRateLimit(env.POLL, ANON_A, "ana@x.com");
    }
    const otherAnon = await checkMagicLinkSendRateLimit(env.POLL, ANON_B, "ana@x.com");
    assert.equal(otherAnon.allowed, true, "anonEmail diferente não compartilha o balde");
    const otherEmail = await checkMagicLinkSendRateLimit(env.POLL, ANON_A, "bia@x.com");
    assert.equal(otherEmail.allowed, true, "email diferente não compartilha o balde");
  });

  it("grava com expirationTtl (janela real, não permanente)", async () => {
    const env = makeEnv();
    await checkMagicLinkSendRateLimit(env.POLL, ANON_A, "ana@x.com", 3, 3600);
    const put = env.POLL.puts.find((p) => p.key === `rl:magiclink:${ANON_A}:ana@x.com`);
    assert.ok(put);
    assert.equal(put!.opts?.expirationTtl, 3600);
  });
});

// ── createPendingMerge / consumePendingMerge / hasPendingMerge ──────────────

describe("createPendingMerge / consumePendingMerge (#3996)", () => {
  const pending: PendingMerge = { email: "ana@x.com", anonEmail: ANON_B, name: "Ana", edition: "260610" };

  it("cria token com TTL e índice secundário (pending-for) com o MESMO TTL", async () => {
    const env = makeEnv();
    const token = await createPendingMerge(env, pending);
    assert.equal(isValidMagicLinkToken(token), true);

    const primaryPut = env.POLL.puts.find((p) => p.key === `magiclink:${token}`);
    assert.ok(primaryPut);
    assert.equal(primaryPut!.opts?.expirationTtl, MAGIC_LINK_TTL_SEC);
    assert.deepEqual(JSON.parse(primaryPut!.value), pending);

    const secondaryPut = env.POLL.puts.find((p) => p.key === `pending-for:ana@x.com:${ANON_B}`);
    assert.ok(secondaryPut);
    assert.equal(secondaryPut!.opts?.expirationTtl, MAGIC_LINK_TTL_SEC);
    assert.equal(secondaryPut!.value, token);
  });

  it("consumePendingMerge retorna o payload e DELETA a chave — one-time use", async () => {
    const env = makeEnv();
    const token = await createPendingMerge(env, pending);

    const consumed = await consumePendingMerge(env, token);
    assert.deepEqual(consumed, pending);

    assert.equal(await env.POLL.get(`magiclink:${token}`), null, "chave primária apagada após 1º uso");
    assert.equal(await env.POLL.get(`pending-for:ana@x.com:${ANON_B}`), null, "índice secundário também limpo");
  });

  it("replay do MESMO token (2ª chamada) retorna null — nunca mergeia 2x", async () => {
    const env = makeEnv();
    const token = await createPendingMerge(env, pending);
    await consumePendingMerge(env, token);
    const secondAttempt = await consumePendingMerge(env, token);
    assert.equal(secondAttempt, null);
  });

  it("token nunca criado / já expirado (ausente no KV) retorna null", async () => {
    const env = makeEnv();
    const result = await consumePendingMerge(env, generateMagicLinkToken());
    assert.equal(result, null);
  });

  it("hasPendingMerge: true logo após create, false após consume, false se nunca criado", async () => {
    const env = makeEnv();
    assert.equal(await hasPendingMerge(env, "ana@x.com", ANON_B), false);
    const token = await createPendingMerge(env, pending);
    assert.equal(await hasPendingMerge(env, "ana@x.com", ANON_B), true);
    await consumePendingMerge(env, token);
    assert.equal(await hasPendingMerge(env, "ana@x.com", ANON_B), false);
  });
});

// ── buildConfirmMergeUrl (pure) ──────────────────────────────────────────────

describe("buildConfirmMergeUrl (#3996)", () => {
  it("deriva do host/protocolo da request atual, sempre com brand=web", () => {
    const url = buildConfirmMergeUrl("https://eia.diar.ia.br/jogar/identify?brand=web", "tok-123");
    assert.equal(url, "https://eia.diar.ia.br/confirm-merge?token=tok-123&brand=web");
  });

  it("descarta query string anterior da request (nunca herda params estranhos)", () => {
    const url = buildConfirmMergeUrl("https://poll.test/jogar/identify?brand=web&foo=bar", "tok-abc");
    assert.equal(url, "https://poll.test/confirm-merge?token=tok-abc&brand=web");
  });
});

// ── sendMagicLinkEmail (Brevo, SEMPRE mockado) ──────────────────────────────

describe("sendMagicLinkEmail (#3996) — fetchImpl NUNCA real (#633)", () => {
  it("not_configured quando BREVO_API_KEY ausente", async () => {
    const env = makeEnv();
    const { fn, calls } = makeFakeFetch();
    const result = await sendMagicLinkEmail(env, { name: "Ana", email: "ana@x.com", confirmUrl: "https://x/confirm" }, fn);
    assert.deepEqual(result, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(calls.length, 0, "nunca chama a Brevo sem secret configurado");
  });

  it("not_configured quando BREVO_SENDER_EMAIL ausente (mesmo com API key presente)", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "key-123" });
    const { fn, calls } = makeFakeFetch();
    const result = await sendMagicLinkEmail(env, { name: "Ana", email: "ana@x.com", confirmUrl: "https://x/confirm" }, fn);
    assert.equal(result.reason, "not_configured");
    assert.equal(calls.length, 0);
  });

  it("configurado: chama api.brevo.com/v3/smtp/email com header api-key + payload correto", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "key-123", BREVO_SENDER_EMAIL: "editor@diar.ia.br", BREVO_SENDER_NAME: "Diar.ia" });
    const { fn, calls } = makeFakeFetch();
    const result = await sendMagicLinkEmail(env, { name: "Ana", email: "ana@x.com", confirmUrl: "https://eia.diar.ia.br/confirm-merge?token=abc&brand=web" }, fn);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["api-key"], "key-123");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.sender.email, "editor@diar.ia.br");
    assert.equal(body.sender.name, "Diar.ia");
    assert.equal(body.to[0].email, "ana@x.com");
    assert.match(body.htmlContent, /confirm-merge\?token=abc&(?:amp;)?brand=web/);
  });

  it("resposta HTTP de erro da Brevo (ex: 401) vira ok:false reason brevo_error", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "bad-key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" });
    const { fn } = makeFakeFetch(() => new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }));
    const result = await sendMagicLinkEmail(env, { name: "", email: "ana@x.com", confirmUrl: "https://x/confirm" }, fn);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "brevo_error");
    assert.equal(result.status, 401);
  });

  it("erro de REDE (fetch lança) vira ok:false status 502 — nunca propaga a exceção", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" });
    const fn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const result = await sendMagicLinkEmail(env, { name: "", email: "ana@x.com", confirmUrl: "https://x/confirm" }, fn);
    assert.deepEqual(result, { ok: false, status: 502, reason: "brevo_error" });
  });

  it("nome vazio: greeting genérico, sem 'name' no destinatário", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" });
    const { fn, calls } = makeFakeFetch();
    await sendMagicLinkEmail(env, { name: "", email: "ana@x.com", confirmUrl: "https://x/confirm" }, fn);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.to[0].name, undefined);
    assert.match(body.htmlContent, /^<p>Oi!<\/p>/);
  });
});

// ── confirmMergeHtmlResponse (pure) ──────────────────────────────────────────

describe("confirmMergeHtmlResponse (#3996)", () => {
  it("ok=true → status 200, escapa a mensagem", async () => {
    const res = confirmMergeHtmlResponse(true, "Pronto! <script>alert(1)</script>");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("ok=false → status 400", async () => {
    const res = confirmMergeHtmlResponse(false, "Link inválido.");
    assert.equal(res.status, 400);
  });

  it("nunca cacheável (Cache-Control: no-store)", () => {
    const res = confirmMergeHtmlResponse(true, "ok");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

// ── handleConfirmMerge fim-a-fim ─────────────────────────────────────────────

describe("handleConfirmMerge (#3996)", () => {
  function confirmUrl(token: string): URL {
    return new URL(`https://eia.diar.ia.br/confirm-merge?token=${encodeURIComponent(token)}&brand=web`);
  }

  it("token ausente → 400 genérico", async () => {
    const env = makeEnv();
    const res = await handleConfirmMerge(new URL("https://eia.diar.ia.br/confirm-merge?brand=web"), env);
    assert.equal(res.status, 400);
  });

  it("token malformado (forma não-UUID) → 400 SEM ler o KV", async () => {
    const env = makeEnv();
    const res = await handleConfirmMerge(confirmUrl("'; DROP TABLE votes--"), env);
    assert.equal(res.status, 400);
    assert.equal(env.POLL.puts.length, 0, "nenhuma escrita — rejeitado antes de qualquer leitura/escrita de KV");
  });

  it("token bem-formado mas inexistente/expirado → 400 genérico (mesma mensagem de 'já usado')", async () => {
    const env = makeEnv();
    const res = await handleConfirmMerge(confirmUrl(generateMagicLinkToken()), env);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /inválido, expirado ou já usado/);
  });

  it("caminho feliz: mergeia via performIdentifyMerge (score global + linked) e retorna 200", async () => {
    const env = makeEnv({
      "score:ana@x.com": JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "260601", nickname: "Ana Original" }),
      [`score:${ANON_B}`]: JSON.stringify({ total: 2, correct: 1, streak: 1, last_edition: "260615" }),
    });
    const token = await createPendingMerge(env, { email: "ana@x.com", anonEmail: ANON_B, name: "Ana Nova", edition: "260615" });

    const res = await handleConfirmMerge(confirmUrl(token), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Pronto! Seu histórico foi migrado/);
    assert.match(html, /ana@x\.com/);

    const merged = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(merged.total, 12, "soma (10 + 2), mesma disciplina de mergeWebScores");
    assert.equal(merged.correct, 9);
    assert.equal(await isIdentifyLinked(env, "ana@x.com", ANON_B), true, "par marcado como confirmado pós-merge");
  });

  it("replay do mesmo link (2º clique) → 400, NÃO re-mergeia (sem duplicar soma)", async () => {
    const env = makeEnv({
      "score:ana@x.com": JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "260601", nickname: "Ana" }),
      [`score:${ANON_B}`]: JSON.stringify({ total: 2, correct: 1, streak: 1, last_edition: "260615" }),
    });
    const token = await createPendingMerge(env, { email: "ana@x.com", anonEmail: ANON_B, name: "Ana", edition: "" });
    await handleConfirmMerge(confirmUrl(token), env);
    const secondClick = await handleConfirmMerge(confirmUrl(token), env);
    assert.equal(secondClick.status, 400);

    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 12, "não duplicou — permanece 10+2, não 10+2+2");
  });
});

// ── handleJogarIdentify integrado (identify.ts) — desvio pro link mágico ────

describe("handleJogarIdentify com histórico órfão (#3996)", () => {
  function identifyRequest(body: unknown): Request {
    return new Request("https://eia.diar.ia.br/jogar/identify?brand=web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("score:{email} pré-existente sob OUTRO token → NÃO mergeia na hora, responde pending:true", async () => {
    const env = makeEnv(
      { "score:ana@x.com": JSON.stringify({ total: 20, correct: 15, streak: 5, last_edition: "260601", nickname: "Ana" }) },
      { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" },
    );
    const { fn, calls } = makeFakeFetch();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "Ana", email: "ana@x.com", anonEmail: ANON_B, optin: false, edition: "260615" }),
      env,
      { fetchImpl: fn },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; pending?: boolean; subscribed?: boolean };
    assert.deepEqual(body, { ok: true, pending: true });

    // Score NÃO foi alterado ainda — merge diferido até confirmação.
    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 20, "merge não acontece antes da confirmação");

    // E-mail de confirmação foi disparado (mockado).
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  });

  it("re-tentativas rápidas do MESMO par não disparam um 2º e-mail (link ainda vivo)", async () => {
    const env = makeEnv(
      { "score:ana@x.com": JSON.stringify({ total: 20, correct: 15, streak: 5, last_edition: "260601", nickname: "Ana" }) },
      { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" },
    );
    const { fn, calls } = makeFakeFetch();
    const payload = { name: "Ana", email: "ana@x.com", anonEmail: ANON_B, optin: false, edition: "260615" };
    await handleJogarIdentify(identifyRequest(payload), env, { fetchImpl: fn });
    await handleJogarIdentify(identifyRequest(payload), env, { fetchImpl: fn });
    await handleJogarIdentify(identifyRequest(payload), env, { fetchImpl: fn });
    assert.equal(calls.length, 1, "3 chamadas (ex: sync() a cada rodada) só disparam 1 e-mail — link ainda pendente");
  });

  it("sem BREVO configurado: mecanismo continua fail-closed (pending, sem merge) mesmo sem enviar e-mail de fato", async () => {
    const env = makeEnv({ "score:ana@x.com": JSON.stringify({ total: 20, correct: 15, streak: 5, last_edition: "260601", nickname: "Ana" }) });
    const { fn, calls } = makeFakeFetch();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "Ana", email: "ana@x.com", anonEmail: ANON_B, optin: false, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    const body = await res.json() as { ok: boolean; pending?: boolean };
    assert.deepEqual(body, { ok: true, pending: true });
    assert.equal(calls.length, 0, "sendMagicLinkEmail nunca chega a chamar fetch sem secret (not_configured)");
    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 20, "merge continua NÃO acontecendo — fail-closed, não fail-open");
  });

  it("par JÁ confirmado antes (markIdentifyLinked) → caminho rápido, SEM e-mail, merge imediato", async () => {
    const env = makeEnv(
      {
        "score:ana@x.com": JSON.stringify({ total: 20, correct: 15, streak: 5, last_edition: "260601", nickname: "Ana" }),
        [`score:${ANON_B}`]: JSON.stringify({ total: 3, correct: 2, streak: 1, last_edition: "260620" }),
      },
      { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" },
    );
    await markIdentifyLinked(env, "ana@x.com", ANON_B);
    const { fn, calls } = makeFakeFetch();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "", email: "ana@x.com", anonEmail: ANON_B, optin: false, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    const body = await res.json() as { ok: boolean; subscribed?: boolean; pending?: boolean };
    assert.equal(body.pending, undefined, "caminho rápido não usa a chave pending");
    assert.equal(body.ok, true);
    assert.equal(calls.length, 0, "par já confiável — nunca dispara link mágico");

    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 23, "merge imediato aconteceu (20 + 3)");
  });

  it("REGRESSÃO CRÍTICA (achado de self-review): re-sync SILENCIOSO (name vazio) NUNCA aciona o link mágico, mesmo com histórico pré-existente NÃO-linkado — evita quebrar silenciosamente o re-sync automático de todo jogador identificado ANTES do #3996 (identify-linked não existia pra eles)", async () => {
    const env = makeEnv(
      {
        "score:ana@x.com": JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "260601", nickname: "Ana Original" }),
        [`score:${ANON_A}`]: JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260615" }),
      },
      { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" },
    );
    // Nota: `identify-linked:ana@x.com:{ANON_A}` NUNCA foi gravado — simula
    // exatamente o estado de um jogador identificado antes do #3996 existir.
    const { fn, calls } = makeFakeFetch();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    const body = await res.json() as { ok: boolean; subscribed?: boolean; pending?: boolean };
    assert.equal(body.pending, undefined, "NUNCA deve virar pending — sync silencioso não pode ficar preso esperando confirmação que o jogador não sabe que precisa dar");
    assert.equal(calls.length, 0, "nenhum e-mail de confirmação disparado por um re-sync automático");

    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 11, "merge imediato aconteceu — soma 10+1, mesmo comportamento da Fase A original (#3975)");
    assert.equal(score.nickname, "Ana Original", "nickname preservado (name vazio não sobrescreve)");
  });

  it("SEM histórico prévio (1ª identificação, qualquer device) — Fase A intocada: merge imediato, sem link mágico", async () => {
    const env = makeEnv({}, { BREVO_API_KEY: "key", BREVO_SENDER_EMAIL: "editor@diar.ia.br" });
    const { fn, calls } = makeFakeFetch();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "Bia", email: "bia@x.com", anonEmail: ANON_A, optin: false, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    const body = await res.json() as { ok: boolean; subscribed?: boolean; pending?: boolean };
    assert.deepEqual(body, { ok: true, subscribed: false });
    assert.equal(calls.length, 0, "sem conflito — nunca envolve a Brevo");
    assert.ok(await env.POLL.get("score:bia@x.com"), "merge imediato de qualquer forma aconteceu");
  });
});

// ── performIdentifyMerge exportado (regressão: refactor não pode mudar comportamento) ─

describe("performIdentifyMerge (#3996 — extraído do corpo de handleJogarIdentify)", () => {
  it("continua marcando o par como linked após o merge (novo — antes do #3996 não existia)", async () => {
    const env = makeEnv({ [`score:${ANON_A}`]: JSON.stringify({ total: 4, correct: 3, streak: 2, last_edition: "260610" }) });
    await performIdentifyMerge(env, { email: "ana@x.com", anonEmail: ANON_A, name: "Ana", edition: null });
    assert.equal(await isIdentifyLinked(env, "ana@x.com", ANON_A), true);
    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.total, 4);
  });
});
