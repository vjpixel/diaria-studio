/**
 * test/poll-leaderboard-nickname-cta-4232.test.ts (#4232)
 *
 * "É IA?": permitir definir nickname a partir do leaderboard, não só na tela
 * de resultado do voto.
 *
 * Antes: o form de nickname (`nick-box`) só renderizava em `votePageHtml`
 * (index.ts), condicionado a `!scoreObj?.nickname`. O link "Ver leaderboard"
 * dessa mesma página não carregava `email`/`sig` — quem clicava lá (ou
 * chegava direto no leaderboard) não tinha como definir nickname sem voltar
 * e votar de novo.
 *
 * Fix: reusa o esquema de link assinado (HMAC `email`+`sig`) que já protege
 * `/set-name` (handleSetName) — o link "Ver leaderboard" agora carrega
 * `email`+`sig` SÓ quando o leitor ainda não tem nickname, e
 * handleLeaderboardByMonth/handleLeaderboardByYear (leaderboard-routes.ts)
 * verificam essa sig e renderizam o mesmo bloco `nick-box` ali.
 *
 * Escopo: só brands com voto por e-mail assinado (diaria/clarice) — brand
 * "web" (`/jogar` standalone) resolve nickname via identidade local, não
 * por este mecanismo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hmacSign, votePageHtml } from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";
import {
  handleLeaderboardByMonth,
  handleLeaderboardByYear,
  resolveLeaderboardNicknameForm,
} from "../workers/poll/src/leaderboard-routes.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const SECRET = "poll-secret";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: SECRET,
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

describe("votePageHtml — link 'Ver leaderboard' carrega email+sig quando falta nickname (#4232)", () => {
  it("nicknameForm presente (diaria) → link carrega email+sig (URL-encoded)", async () => {
    const html = votePageHtml("Já votou", false, { email: "user@x.com", sig: "abc123" }, null, "2026-07", "diaria");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver leaderboard<\/a>/);
    assert.ok(match, "link 'Ver leaderboard' deve existir");
    const href = match![1];
    assert.match(href, /[?&]email=user%40x\.com/);
    assert.match(href, /[?&]sig=abc123/);
  });

  it("nicknameForm ausente (já tem nickname) → link NÃO carrega email/sig", () => {
    const html = votePageHtml("Acertou!", true, null, null, "2026-07", "diaria");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver leaderboard<\/a>/);
    assert.ok(match);
    assert.doesNotMatch(match![1], /email=/);
    assert.doesNotMatch(match![1], /sig=/);
  });

  it("brand 'web' → link NÃO carrega email/sig mesmo com nicknameForm presente (escopo #4232 — web usa identidade local)", () => {
    const html = votePageHtml("Já votou", false, { email: "anon-token@web.local", sig: "abc123" }, null, null, "web");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver leaderboard<\/a>/);
    assert.ok(match);
    assert.doesNotMatch(match![1], /email=/);
    assert.doesNotMatch(match![1], /sig=/);
  });

  it("cacheBusterTs + nicknameForm combinam com '&' (não quebram o primeiro '?')", () => {
    const html = votePageHtml(
      "Já votou", false, { email: "user@x.com", sig: "abc123" }, null, "2026-07", "diaria", "1700000000000",
    );
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver leaderboard<\/a>/);
    assert.ok(match);
    const href = match![1];
    assert.match(href, /\?v=1700000000000&email=user%40x\.com&sig=abc123/);
  });
});

describe("resolveLeaderboardNicknameForm (#4232)", () => {
  it("sig válida + votante sem nickname → retorna {email, sig}", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.deepEqual(result, { email, sig });
  });

  it("sig inválida → null (fail-closed)", async () => {
    const email = "reader@x.com";
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=totalmente-invalida`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.equal(result, null);
  });

  it("email/sig ausentes da query string → null", async () => {
    const env = makeEnv();
    const url = new URL("https://poll.example/leaderboard");
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.equal(result, null);
  });

  it("votante JÁ tem nickname → null (não reabre o form indevidamente)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: "JaTemNick" }) });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.equal(result, null);
  });

  it("email sem voto registrado (score:{email} ausente) → null", async () => {
    const email = "nunca-votou@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv();
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.equal(result, null);
  });

  it("brand 'web' → sempre null, mesmo com sig válida (defesa em profundidade — escopo #4232)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "web");
    assert.equal(result, null);
  });
});

describe("handleLeaderboardByMonth — renderiza nick-box com sig válida da query string (#4232)", () => {
  it("sig válida + sem nickname → nick-box renderiza com email/sig corretos nos hidden inputs", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
      [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }),
    });
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    const html = await res.text();
    assert.match(html, /<div class="nick-box">/);
    assert.match(html, /<form action="\/set-name" method="GET" class="nick-form">/);
    assert.match(html, new RegExp(`name="email" value="${email.replace(".", "\\.")}"`));
    assert.match(html, new RegExp(`name="sig" value="${sig}"`));
  });

  it("sig inválida → nick-box NÃO renderiza", async () => {
    const email = "reader@x.com";
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=lixo`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });

  it("sem `url` (chamadas pré-#4232, ex: testes existentes) → nick-box NÃO renderiza — back-compat", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });

  it("votante já com nickname (mesmo com sig válida) → nick-box NÃO renderiza", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: "JaTemNick" }) });
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });
});

describe("handleLeaderboardByYear — mesmo mecanismo, brand clarice (ranking anual, #4232)", () => {
  it("sig válida + sem nickname → nick-box renderiza no leaderboard anual", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({
      "score-by-month:2026-05:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
      [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }),
    });
    const url = new URL(`https://poll.example/leaderboard/2026?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByYear("2026", env, "clarice", url);
    const html = await res.text();
    assert.match(html, /<div class="nick-box">/);
  });
});
