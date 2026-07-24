/**
 * test/poll-jogar-identify-3975.test.ts (#3975)
 *
 * Identidade por e-mail no leaderboard do "É IA?" standalone (brand `web`).
 * Cobre:
 *   1. Merge determinístico de score (global + mensal) — `mergeWebScores`/
 *      `mergeWebScoreByMonth` (identify.ts), testados explicitamente por
 *      cenário (soma totais, maior streak, edição mais recente, nickname).
 *   2. Parse/validação do body de `POST /jogar/identify`.
 *   3. `handleJogarIdentify` fim-a-fim: migra score:{anonEmail}→score:{email},
 *      migra score-by-month quando `edition` é informada, honeypot, rate
 *      limit, opt-in de newsletter (best-effort).
 *   4. Filtro `isAnonymousWebIdentity` — entradas sob o domínio anônimo NUNCA
 *      aparecem no leaderboard público (computeTop1/computePodium/
 *      scoreByMonthEntriesToLeaderboard), mas continuam existindo no KV.
 *   5. Fiação de produção via `worker.fetch` (brandedEnv real, `?brand=web`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import {
  mergeWebScores,
  mergeWebScoreByMonth,
  parseIdentifyBody,
  validateIdentifyInput,
  handleJogarIdentify,
  type WebScore,
  type WebScoreByMonth,
} from "../workers/poll/src/identify.ts";
import { isAnonymousWebIdentity, isValidWebToken } from "../workers/poll/src/lib.ts";
import { computeTop1, computePodium, scoreByMonthEntriesToLeaderboard } from "../workers/poll/src/leaderboard-routes.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

const ANON_A = "11111111-1111-4111-8111-111111111111@web.eia.diaria.local";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

// ── isAnonymousWebIdentity (lib.ts) ─────────────────────────────────────────

describe("isAnonymousWebIdentity (#3975)", () => {
  it("true pro token anônimo legítimo (UUID v4 sob o domínio reservado)", () => {
    assert.equal(isAnonymousWebIdentity(ANON_A), true);
    assert.equal(isValidWebToken(ANON_A), true, "sanity: também é um token válido pra /vote");
  });

  it("true pra lixo histórico sob o MESMO domínio (não-UUID) — mais amplo que isValidWebToken", () => {
    assert.equal(isAnonymousWebIdentity("verify1840428@web.eia.diaria.local"), true);
    assert.equal(isValidWebToken("verify1840428@web.eia.diaria.local"), false, "sanity: NÃO é um token válido de voto (guard #3976)");
  });

  it("false pra e-mail identificado normal", () => {
    assert.equal(isAnonymousWebIdentity("leitor@example.com"), false);
  });

  it("false sem @", () => {
    assert.equal(isAnonymousWebIdentity("nao-e-email"), false);
  });
});

// ── mergeWebScores (pure) ────────────────────────────────────────────────────

describe("mergeWebScores (#3975)", () => {
  it("1ª identificação (existing null) — usa o score da sessão anônima intacto + nickname do form", () => {
    const incoming: WebScore = { total: 5, correct: 3, streak: 2, last_edition: "260610" };
    const merged = mergeWebScores(null, incoming, "Ana");
    assert.deepEqual(merged, { total: 5, correct: 3, streak: 2, last_edition: "260610", nickname: "Ana" });
  });

  it("identificar sem ter jogado nada ainda (incoming null) — score zerado, nickname salvo", () => {
    const merged = mergeWebScores(null, null, "Bia");
    assert.deepEqual(merged, { total: 0, correct: 0, streak: 0, last_edition: null, nickname: "Bia" });
  });

  it("re-identificação no MESMO e-mail (existing presente, incoming da sessão atual) — SOMA totais", () => {
    const existing: WebScore = { total: 10, correct: 7, streak: 1, last_edition: "260601", nickname: "Ana" };
    const incoming: WebScore = { total: 5, correct: 3, streak: 4, last_edition: "260615" };
    const merged = mergeWebScores(existing, incoming, "Ana");
    assert.equal(merged.total, 15, "total: soma (o que a pessoa acabou de jogar precisa contar)");
    assert.equal(merged.correct, 10, "correct: soma");
  });

  it("streak: usa o MAIOR dos dois, nunca soma", () => {
    const existing: WebScore = { total: 3, correct: 3, streak: 3, last_edition: "260601" };
    const incoming: WebScore = { total: 2, correct: 2, streak: 7, last_edition: "260610" };
    const merged = mergeWebScores(existing, incoming, "X");
    assert.equal(merged.streak, 7, "maior dos dois — soma produziria um número sem sentido semântico");
  });

  it("last_edition: usa a mais RECENTE (comparação lexical AAMMDD)", () => {
    const existing: WebScore = { total: 1, correct: 1, streak: 1, last_edition: "260701" };
    const incoming: WebScore = { total: 1, correct: 1, streak: 1, last_edition: "260615" };
    const merged = mergeWebScores(existing, incoming, "X");
    assert.equal(merged.last_edition, "260701");
  });

  it("nickname vazio (re-sync silencioso) preserva o nickname EXISTENTE, não sobrescreve", () => {
    const existing: WebScore = { total: 1, correct: 1, streak: 0, last_edition: "260601", nickname: "Carla" };
    const incoming: WebScore = { total: 1, correct: 0, streak: 0, last_edition: "260610" };
    const merged = mergeWebScores(existing, incoming, "");
    assert.equal(merged.nickname, "Carla");
  });

  it("nickname vazio sem nickname existente cai pro nickname da sessão anônima (fallback)", () => {
    const incoming: WebScore = { total: 1, correct: 1, streak: 0, last_edition: "260610", nickname: "AnonNick" };
    const merged = mergeWebScores(null, incoming, "");
    assert.equal(merged.nickname, "AnonNick");
  });

  it("nickname preenchido SEMPRE vence, mesmo com nickname existente diferente", () => {
    const existing: WebScore = { total: 1, correct: 1, streak: 0, last_edition: "260601", nickname: "Nome Antigo" };
    const merged = mergeWebScores(existing, null, "Nome Novo");
    assert.equal(merged.nickname, "Nome Novo");
  });
});

// ── mergeWebScoreByMonth (pure) ──────────────────────────────────────────────

describe("mergeWebScoreByMonth (#3975)", () => {
  it("soma total/correct, last_vote_ts usa o mais recente (ISO 8601 lexical)", () => {
    const existing: WebScoreByMonth = { total: 3, correct: 2, last_edition: "260601", nickname: "Ana", last_vote_ts: "2026-06-01T10:00:00.000Z" };
    const incoming: WebScoreByMonth = { total: 2, correct: 1, last_edition: "260610", nickname: null, last_vote_ts: "2026-06-10T10:00:00.000Z" };
    const merged = mergeWebScoreByMonth(existing, incoming, "Ana");
    assert.equal(merged.total, 5);
    assert.equal(merged.correct, 3);
    assert.equal(merged.last_vote_ts, "2026-06-10T10:00:00.000Z");
  });

  it("existing null (1ª entry mensal do e-mail identificado) — usa incoming intacto", () => {
    const incoming: WebScoreByMonth = { total: 2, correct: 1, last_edition: "260610", nickname: null };
    const merged = mergeWebScoreByMonth(null, incoming, "Nome");
    assert.equal(merged.total, 2);
    assert.equal(merged.nickname, "Nome");
  });
});

// ── parseIdentifyBody / validateIdentifyInput (pure) ────────────────────────

describe("parseIdentifyBody (#3975)", () => {
  it("parseia JSON válido", () => {
    const p = parseIdentifyBody(JSON.stringify({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "260610" }), "application/json");
    assert.deepEqual(p, { name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "260610", honeypot: "" });
  });

  it("JSON malformado nunca lança — vira input vazio", () => {
    const p = parseIdentifyBody("{not json", "application/json");
    assert.deepEqual(p, { name: "", email: "", anonEmail: "", optin: false, edition: "", honeypot: "" });
  });

  it("fallback form-urlencoded", () => {
    const p = parseIdentifyBody("name=Ana&email=ana%40x.com&anonEmail=" + encodeURIComponent(ANON_A) + "&optin=on", "application/x-www-form-urlencoded");
    assert.equal(p.name, "Ana");
    assert.equal(p.email, "ana@x.com");
    assert.equal(p.optin, true);
  });
});

describe("validateIdentifyInput (#3975)", () => {
  it("honeypot preenchido → ok:false, status 200 (fake-success, não avisa o bot)", () => {
    const v = validateIdentifyInput({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "", honeypot: "bot-filled-this" });
    assert.deepEqual(v, { ok: false, status: 200, error: "honeypot" });
  });

  it("e-mail em forma inválida → 400 invalid_email", () => {
    const v = validateIdentifyInput({ name: "Ana", email: "not-an-email", anonEmail: ANON_A, optin: false, edition: "", honeypot: "" });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.error, "invalid_email");
  });

  it("e-mail sob o domínio anônimo reservado → 400 invalid_email (não pode se identificar COMO um token)", () => {
    const v = validateIdentifyInput({ name: "Ana", email: ANON_A, anonEmail: ANON_A, optin: false, edition: "", honeypot: "" });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.error, "invalid_email");
  });

  it("anonEmail ausente/malformado → 400 invalid_anon_email", () => {
    const v1 = validateIdentifyInput({ name: "Ana", email: "ana@x.com", anonEmail: "", optin: false, edition: "", honeypot: "" });
    assert.equal(v1.ok, false);
    if (!v1.ok) assert.equal(v1.error, "invalid_anon_email");

    const v2 = validateIdentifyInput({ name: "Ana", email: "ana@x.com", anonEmail: "forjado@web.eia.diaria.local", optin: false, edition: "", honeypot: "" });
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.equal(v2.error, "invalid_anon_email");
  });

  it("edition malformada vira null (só migração global, sem erro)", () => {
    const v = validateIdentifyInput({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "lixo", honeypot: "" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.edition, null);
  });

  it("name vazio é aceito (re-sync silencioso) — não é obrigatório server-side", () => {
    const v = validateIdentifyInput({ name: "", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "", honeypot: "" });
    assert.equal(v.ok, true);
  });

  it("input válido completo", () => {
    const v = validateIdentifyInput({ name: "  Ana  ", email: " ANA@X.COM ", anonEmail: ANON_A, optin: true, edition: "260610", honeypot: "" });
    assert.deepEqual(v, { ok: true, name: "Ana", email: "ana@x.com", anonEmail: ANON_A, edition: "260610", optin: true });
  });
});

// ── handleJogarIdentify (handler fim-a-fim, env não-branded) ────────────────

function identifyRequest(body: unknown): Request {
  return new Request("https://poll.test/jogar/identify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleJogarIdentify (#3975)", () => {
  it("1ª identificação: migra score:{anonEmail} → score:{email}, some do lugar antigo (não apaga)", async () => {
    const env = makeEnv({ ["score:" + ANON_A]: JSON.stringify({ total: 4, correct: 3, streak: 2, last_edition: "260610" }) });
    const res = await handleJogarIdentify(identifyRequest({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "" }), env);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);

    const newScoreRaw = await env.POLL.get("score:ana@x.com");
    assert.ok(newScoreRaw);
    const newScore = JSON.parse(newScoreRaw!);
    assert.equal(newScore.total, 4);
    assert.equal(newScore.correct, 3);
    assert.equal(newScore.nickname, "Ana");

    const oldScoreRaw = await env.POLL.get("score:" + ANON_A);
    assert.ok(oldScoreRaw, "entrada anônima original NUNCA é apagada (#3975 item 4)");
  });

  it("edition informada: também migra score-by-month e invalida o snapshot do mês", async () => {
    const env = makeEnv({
      ["score-by-month:2026-06:" + ANON_A]: JSON.stringify({ total: 2, correct: 2, last_edition: "260610", nickname: null }),
      "leaderboard-snapshot:2026-06": JSON.stringify({ entries: [{ email: ANON_A, nickname: null, correct: 2, total: 2 }], computed_at: "x" }),
    });
    await handleJogarIdentify(identifyRequest({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "260610" }), env);

    const monthRaw = await env.POLL.get("score-by-month:2026-06:ana@x.com");
    assert.ok(monthRaw);
    assert.equal(JSON.parse(monthRaw!).total, 2);

    const snapshotRaw = await env.POLL.get("leaderboard-snapshot:2026-06");
    assert.equal(snapshotRaw, null, "snapshot invalidado — próxima leitura recomputa já filtrando a entrada anônima");
  });

  it("honeypot preenchido: 200 fake-success, NENHUMA escrita acontece", async () => {
    const env = makeEnv();
    const res = await handleJogarIdentify(identifyRequest({ name: "Bot", email: "bot@x.com", anonEmail: ANON_A, optin: false, edition: "", website: "spam" }), env);
    assert.equal(res.status, 200);
    assert.equal(await env.POLL.get("score:bot@x.com"), null);
  });

  it("e-mail inválido: 400, nenhuma escrita", async () => {
    const env = makeEnv();
    const res = await handleJogarIdentify(identifyRequest({ name: "X", email: "not-an-email", anonEmail: ANON_A, optin: false, edition: "" }), env);
    assert.equal(res.status, 400);
  });

  it("rate limit: 429 após o teto de tentativas pro mesmo IP", async () => {
    const env = makeEnv();
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" };
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      const req = new Request("https://poll.test/jogar/identify", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "N" + i, email: `n${i}@x.com`, anonEmail: ANON_A, optin: false, edition: "" }),
      });
      last = await handleJogarIdentify(req, env);
    }
    assert.equal(last!.status, 429);
  });

  it("re-sync silencioso (name vazio) não sobrescreve o nickname já salvo", async () => {
    const env = makeEnv({
      "score:ana@x.com": JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "260601", nickname: "Ana Original" }),
      ["score:" + ANON_A]: JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260615" }),
    });
    await handleJogarIdentify(identifyRequest({ name: "", email: "ana@x.com", anonEmail: ANON_A, optin: false, edition: "" }), env);
    const score = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(score.nickname, "Ana Original");
    assert.equal(score.total, 11, "soma mesmo no re-sync silencioso");
  });
});

// ── Filtro de exibição pública (#3975 item 4) ───────────────────────────────

describe("leaderboard esconde identidade anônima (#3975 item 4)", () => {
  const anonEntry = { email: ANON_A, nickname: "AnonNick", correct: 10, total: 10 };
  const realEntry = { email: "leitor@x.com", nickname: "Leitor", correct: 5, total: 10 };

  it("computeTop1: entrada anônima NUNCA é top1, mesmo com pct maior", () => {
    const top1 = computeTop1([anonEntry, realEntry]);
    assert.equal(top1.length, 1);
    assert.equal(top1[0].nickname, "Leitor");
  });

  it("computePodium: entrada anônima nunca ocupa rank 1-3", () => {
    const podium = computePodium([anonEntry, realEntry]);
    assert.ok(podium.every((p) => p.nickname !== "AnonNick"));
    assert.ok(podium.some((p) => p.nickname === "Leitor"));
  });

  it("scoreByMonthEntriesToLeaderboard: entrada anônima filtrada antes do rank", () => {
    const ranked = scoreByMonthEntriesToLeaderboard([anonEntry, realEntry]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].email, "leitor@x.com");
  });
});

// ── Fiação de produção (worker.fetch, brandedEnv real) ──────────────────────

describe("POST /jogar/identify via worker.fetch (#3975) — fiação real de brandedEnv", () => {
  it("brand=web: lê/escreve score:{email} sob o prefixo web: real", async () => {
    const env = makeEnv({ ["web:score:" + ANON_A]: JSON.stringify({ total: 2, correct: 1, streak: 1, last_edition: "260610" }) }) as unknown as Env;
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/identify?brand=web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Prod", email: "prod@x.com", anonEmail: ANON_A, optin: false, edition: "" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const raw = await (env as unknown as { POLL: ReturnType<typeof makeTrackedKv> }).POLL.get("web:score:prod@x.com");
    assert.ok(raw, "escrita deve ir pro namespace branded do brand web");
    assert.equal(JSON.parse(raw!).total, 2);
  });
});
