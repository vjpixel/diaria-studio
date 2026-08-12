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

describe("votePageHtml — link 'Ver ranking' carrega email+sig quando falta nickname (#4232)", () => {
  it("nicknameForm presente (diaria) → link carrega email+sig (URL-encoded)", async () => {
    const html = votePageHtml("Já votou", false, { email: "user@x.com", sig: "abc123" }, null, "2026-07", "diaria");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver ranking<\/a>/);
    assert.ok(match, "link 'Ver ranking' deve existir");
    const href = match![1];
    assert.match(href, /[?&]email=user%40x\.com/);
    assert.match(href, /[?&]sig=abc123/);
  });

  it("nicknameForm ausente (já tem nickname) → link NÃO carrega email/sig", () => {
    const html = votePageHtml("Acertou!", true, null, null, "2026-07", "diaria");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver ranking<\/a>/);
    assert.ok(match);
    assert.doesNotMatch(match![1], /email=/);
    assert.doesNotMatch(match![1], /sig=/);
  });

  it("brand 'web' → link NÃO carrega email/sig mesmo com nicknameForm presente (escopo #4232 — web usa identidade local)", () => {
    const html = votePageHtml("Já votou", false, { email: "anon-token@web.local", sig: "abc123" }, null, null, "web");
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver ranking<\/a>/);
    assert.ok(match);
    assert.doesNotMatch(match![1], /email=/);
    assert.doesNotMatch(match![1], /sig=/);
  });

  it("cacheBusterTs + nicknameForm combinam com '&' (não quebram o primeiro '?')", () => {
    const html = votePageHtml(
      "Já votou", false, { email: "user@x.com", sig: "abc123" }, null, "2026-07", "diaria", "1700000000000",
    );
    const match = html.match(/<a href="([^"]*\/leaderboard[^"]*)">Ver ranking<\/a>/);
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

  // #4250 (regressão): fast-path de /vote (#3983) responde ANTES de
  // runVoteBookkeeping gravar score:{email} em background. Um votante de
  // primeira vez que acessa este endpoint (ou um prefetch do navegador)
  // antes dessa escrita terminar via, sem o retry, um falso "sem voto
  // registrado" — o form some justo pra quem ele foi feito. Fix: 1 retry
  // curto quando a 1ª leitura vem vazia (ver NICKNAME_FORM_SCORE_RETRY_MS em
  // leaderboard-routes.ts).
  it("#4250: 1ª leitura vazia (race do fast-path em voo) + retry já resolvido → CTA aparece (não perde o form pra quem acabou de votar)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    let calls = 0;
    const env: Env = {
      POLL: {
        get: async (key: string) => {
          if (key !== `score:${email}`) return null;
          calls++;
          // 1ª leitura: bookkeeping em background ainda não gravou (race).
          // 2ª leitura (retry): já gravou — mesmo timing real que o
          // ctx.waitUntil converge em produção.
          return calls === 1 ? null : JSON.stringify({ total: 1, correct: 1, nickname: null });
        },
      } as unknown as Env["POLL"],
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.deepEqual(result, { email, sig }, "#4250: retry deve recuperar o score gravado em voo e liberar o form");
    assert.equal(calls, 2, "deve ter tentado 2x: 1ª leitura vazia + retry");
  });

  it("#4250: score continua ausente mesmo após o retry → null (fail-closed preservado, sem regressão no caminho sem voto de verdade)", async () => {
    const email = "nunca-votou-de-verdade@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    let calls = 0;
    const env: Env = {
      POLL: {
        get: async () => {
          calls++;
          return null;
        },
      } as unknown as Env["POLL"],
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.equal(result, null, "#4250: sem score mesmo após o retry continua fail-closed, nunca expõe o form indevidamente");
    assert.equal(calls, 2, "o retry acontece mesmo quando o resultado final é null — não dá pra saber de antemão que é definitivo");
  });

  it("#4250: score já presente na 1ª leitura → NUNCA dispara o retry (caminho comum sem atraso extra)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    let calls = 0;
    const env: Env = {
      POLL: {
        get: async () => {
          calls++;
          return JSON.stringify({ total: 1, correct: 1, nickname: null });
        },
      } as unknown as Env["POLL"],
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
    assert.deepEqual(result, { email, sig });
    assert.equal(calls, 1, "#4250: sem race (score já presente), o retry nunca deve disparar — sem atraso extra no caminho comum");
  });

  it("brand 'web' → sempre null, mesmo com sig válida (defesa em profundidade — escopo #4232)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "web");
    assert.equal(result, null);
  });

  it("KV.get lança (achado do review consolidado #4232) → null, NÃO propaga a exceção", async () => {
    // `env.POLL.get` é uma chamada de rede real (KV) e pode lançar (erro
    // interno, rate-limit) — sem o try/catch em resolveLeaderboardNicknameForm,
    // isso derrubaria a página inteira do leaderboard por causa de um form
    // opcional/decorativo (achado do silent-failure-hunter no review
    // consolidado do PR). Fail-closed real: a exceção nunca escapa.
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env: Env = {
      POLL: { get: async () => { throw new Error("kv boom"); } } as unknown as Env["POLL"],
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardNicknameForm(url, env, "diaria");
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
    // #4232 (achado do review consolidado — code-reviewer): página com
    // nicknameForm carrega e-mail+sig sensíveis (mesmo par que autoriza
    // /set-name) — nunca pode sair com Cache-Control público, senão um cache
    // intermediário serviria o e-mail+sig de um leitor pra outro dentro do
    // TTL (mesmo racional do no-store já aplicado em voteHtmlResponse).
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("sig inválida → nick-box NÃO renderiza (e Cache-Control volta a ser o público normal do período)", async () => {
    const email = "reader@x.com";
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=lixo`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
    // "2020-01" é mês PASSADO (closedPeriodCacheControl) relativo a qualquer
    // data real de execução do teste — sem nicknameForm válido, cache público
    // normal do período (não o no-store forçado do caso com form).
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600", "sem form válido, cache público normal do período");
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

  it("KV.get de score:{email} lança → página inteira ainda renderiza 200 (sem nick-box), NÃO propaga 500 (achado do review consolidado #4232)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const trackedKv = makeTrackedKv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    // `score:{email}` (lido só por resolveLeaderboardNicknameForm) lança;
    // demais keys (score-by-month:*, usada por getOrComputeSnapshot pro
    // ranking em si) seguem funcionando normalmente via o KV tracked real.
    const env: Env & { POLL: ReturnType<typeof makeTrackedKv> } = {
      POLL: {
        ...trackedKv,
        get: async (key: string) => {
          if (key === `score:${email}`) throw new Error("kv boom");
          return trackedKv.get(key);
        },
      } as unknown as ReturnType<typeof makeTrackedKv>,
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    assert.equal(res.status, 200, "página do leaderboard não deve 500 por causa do form opcional de nickname");
    const html = await res.text();
    assert.match(html, /Ana/, "ranking em si continua renderizando normalmente");
    assert.doesNotMatch(html, /<div class="nick-box">/, "form de nickname fica de fora (fail-closed), não quebra a página");
  });
});

describe("handleLeaderboardByYear — mesmo mecanismo, brand clarice (ranking anual, #4232)", () => {
  it("sig válida + sem nickname → nick-box renderiza no leaderboard anual, com hidden inputs corretos", async () => {
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
    assert.match(html, /<form action="\/set-name" method="GET" class="nick-form">/);
    assert.match(html, new RegExp(`name="email" value="${email.replace(".", "\\.")}"`));
    assert.match(html, new RegExp(`name="sig" value="${sig}"`));
    // #4232 (achado do review consolidado — code-reviewer): página com
    // nicknameForm carrega e-mail+sig sensíveis, não pode sair `public`.
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("sig inválida → nick-box NÃO renderiza (mesma cobertura negativa do mensal)", async () => {
    const email = "reader@x.com";
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard/2026?email=${encodeURIComponent(email)}&sig=lixo`);
    const res = await handleLeaderboardByYear("2026", env, "clarice", url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });

  it("sem `url` → nick-box NÃO renderiza — back-compat", async () => {
    const env = makeEnv({
      "score-by-month:2026-05:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByYear("2026", env, "clarice");
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });

  it("votante já com nickname (mesmo com sig válida) → nick-box NÃO renderiza", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: "JaTemNick" }) });
    const url = new URL(`https://poll.example/leaderboard/2026?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByYear("2026", env, "clarice", url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });

  it("brand 'web' fim-a-fim → nick-box NUNCA renderiza mesmo com sig válida (index.ts roteia /leaderboard/{YYYY} pra QUALQUER brand, não só clarice)", async () => {
    // #4232 (achado do review consolidado — pr-test-analyzer): a rota
    // `/leaderboard/{YYYY}` em index.ts despacha handleLeaderboardByYear pra
    // "ambas as marcas" (comentário no router), não só clarice — então o guard
    // brand==="web" dentro de resolveLeaderboardNicknameForm precisa provar
    // que se sustenta no handler INTEIRO, não só isolado (já coberto em
    // resolveLeaderboardNicknameForm acima).
    const email = "anon-token@web.local";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ [`score:${email}`]: JSON.stringify({ total: 3, correct: 2, nickname: null }) });
    const url = new URL(`https://poll.example/leaderboard/2026?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByYear("2026", env, "web", url);
    const html = await res.text();
    assert.doesNotMatch(html, /<div class="nick-box">/);
  });
});
