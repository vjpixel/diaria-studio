/**
 * test/poll-vote-page-merge-boxes-4418.test.ts (#4418, #4420)
 *
 * Reescrita da tela de resultado do voto do "É IA?" (marca clarice): a caixa
 * de apelido (leaderboard) e a caixa de assinatura da diar.ia.br viram UMA
 * caixa só, que sobe pra cima do card de compartilhamento. Cobertura desta
 * suíte:
 *
 *   §1  — ordem dos blocos em votePageHtml.
 *   §2  — Caixa A (fundida): título/copy/checkbox, sem nick-note, sem campo
 *         de e-mail, botão nomeia o destino.
 *   §2b — matriz A/B/nada (resolveVoteIdentityBoxKind + rendering e2e),
 *         Caixa B (assinatura), escaping, sem-JS.
 *   §2c — /set-name redireciona no sucesso; self-highlight server-side no
 *         leaderboard; cadastro fail-soft (sucesso e falha).
 *   §3  — telas de erro do /set-name nunca redirecionam nem mostram caixa
 *         (exceto o form de retry mínimo, #1774); faixa de confirmação.
 *   #4420 — botão do link de arquivo (tratamento visual).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { hmacSign, votePageHtml, handleSetName, type Env } from "../workers/poll/src/index.ts";
import {
  renderNicknameFormHtml,
  renderSubscribeBoxHtml,
  resolveVoteIdentityBoxKind,
  resolveSetNameConfirmationBanner,
  currentMonthSlugBrt,
} from "../workers/poll/src/lib.ts";
import {
  handleLeaderboardByMonth,
  resolveLeaderboardViewerEmail,
  resolveLeaderboardSubscribeBox,
} from "../workers/poll/src/leaderboard-routes.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const SECRET = "test-secret";

/** Remove o bloco `<style>...</style>` — comentários de CSS (ex: "#1675/#1779:
 * nickname form...") não são texto VISÍVEL pro leitor; checagens de copy
 * devem olhar só o que sobra fora do `<style>`. */
function stripStyleBlock(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, "");
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: makeTrackedKv() as unknown as KVNamespace,
    POLL_SECRET: SECRET,
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

function voteReq(brand: string | null, email: string, choice: string, edition = "260801"): Request {
  const b = brand ? `&brand=${brand}` : "";
  return new Request(`https://poll.test/vote?email=${encodeURIComponent(email)}&edition=${edition}&choice=${choice}${b}`);
}

// ── §1 — ordem dos blocos em votePageHtml ───────────────────────────────────

describe("§1 — ordem: caixa fundida ANTES do share card (#4418)", () => {
  it("clarice: nick-box (com checkbox) vem antes de #jogar-share-card", () => {
    const shareCard = { token: "tok", payload: { edition: "260801", correct: true as boolean | null } };
    const html = votePageHtml(
      "Acertou!", true,
      { email: "a@x.com", sig: "sig" }, null, null, "clarice",
      null, shareCard, null, null, true,
    );
    const nickBoxIdx = html.indexOf('<div class="nick-box">');
    const optinIdx = html.indexOf('name="optin"');
    const shareIdx = html.indexOf('id="jogar-share-card"');
    assert.ok(nickBoxIdx >= 0, "nick-box deve existir");
    assert.ok(optinIdx >= 0, "checkbox de opt-in deve existir");
    assert.ok(shareIdx >= 0, "share card deve existir");
    assert.ok(nickBoxIdx < optinIdx, "checkbox deve estar DENTRO do nick-box");
    assert.ok(optinIdx < shareIdx, "caixa fundida deve vir ANTES do share card");
  });

  it("diaria: nick-box vem antes de #jogar-share-card, SEM checkbox", () => {
    const shareCard = { token: "tok", payload: { edition: "260801", correct: true as boolean | null } };
    const html = votePageHtml(
      "Acertou!", true,
      { email: "a@x.com", sig: "sig" }, null, null, "diaria",
      null, shareCard,
    );
    const nickBoxIdx = html.indexOf('<div class="nick-box">');
    const shareIdx = html.indexOf('id="jogar-share-card"');
    assert.ok(nickBoxIdx >= 0 && shareIdx >= 0);
    assert.ok(nickBoxIdx < shareIdx);
    assert.doesNotMatch(html, /name="optin"/);
  });
});

// ── §2 — Caixa A (fundida) ───────────────────────────────────────────────────

describe("§2 — Caixa A fundida: sem e-mail, checkbox desmarcado por default (#4418)", () => {
  it("clarice: sem <input type=\"email\">, checkbox presente e NÃO marcado", () => {
    const html = renderNicknameFormHtml({ email: "a@x.com", sig: "sig" }, "clarice", true);
    assert.doesNotMatch(html, /<input type="email"/);
    assert.match(html, /<input type="checkbox" name="optin" value="on">/);
    assert.doesNotMatch(html, /type="checkbox" name="optin" value="on" checked/);
  });

  it("diaria: showOptIn=false (default) → sem checkbox nenhum", () => {
    const html = renderNicknameFormHtml({ email: "a@x.com", sig: "sig" }, "diaria");
    assert.doesNotMatch(html, /type="checkbox"/);
  });
});

describe("§2 — título deriva de BRAND_INFO.leaderboardPeriod, sem anglicismo 'nickname' (#4418)", () => {
  it("clarice → 'Entre no leaderboard anual'; palavra 'nickname' ausente do texto visível", () => {
    const html = votePageHtml("Acertou!", true, { email: "a@x.com", sig: "sig" }, null, null, "clarice");
    assert.match(html, /Entre no leaderboard anual/);
    assert.doesNotMatch(html, /Defina seu nickname/);
    assert.doesNotMatch(stripStyleBlock(html), /nickname/i);
  });

  it("diaria → 'Entre no leaderboard mensal'; palavra 'nickname' ausente do texto visível", () => {
    const html = votePageHtml("Acertou!", true, { email: "a@x.com", sig: "sig" }, null, null, "diaria");
    assert.match(html, /Entre no leaderboard mensal/);
    assert.doesNotMatch(html, /Defina seu nickname/);
    assert.doesNotMatch(stripStyleBlock(html), /nickname/i);
  });
});

describe("§2 — nota de rodapé .nick-note removida em TODAS as superfícies; .nick-explain permanece (#4418)", () => {
  it("votePageHtml clarice", () => {
    const html = votePageHtml("Acertou!", true, { email: "a@x.com", sig: "sig" }, null, null, "clarice");
    assert.doesNotMatch(html, /nick-note/);
    assert.match(html, /nick-explain/);
  });

  it("votePageHtml diaria", () => {
    const html = votePageHtml("Acertou!", true, { email: "a@x.com", sig: "sig" }, null, null, "diaria");
    assert.doesNotMatch(html, /nick-note/);
    assert.match(html, /nick-explain/);
  });

  it("leaderboard (renderNicknameFormHtml via handleLeaderboardByMonth)", async () => {
    const email = "reader@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ POLL: makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: null }) }) as unknown as KVNamespace });
    const url = new URL(`https://poll.example/leaderboard/2020-01?email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria", undefined, url);
    const html = await res.text();
    assert.doesNotMatch(html, /nick-note/);
    assert.match(html, /nick-explain/);
  });
});

describe("§2c — rótulos de botão nomeiam o destino (#4418)", () => {
  it("Caixa A: botão diz 'Salvar e ver o leaderboard', nunca só 'Salvar'", () => {
    const html = renderNicknameFormHtml({ email: "a@x.com", sig: "sig" }, "clarice", true);
    assert.match(html, /<button type="submit" class="nick-save">Salvar e ver o leaderboard<\/button>/);
    assert.doesNotMatch(html, />Salvar<\/button>/);
  });

  it("Caixa B: botão primário diz 'Assinar e ver o leaderboard'", () => {
    const html = renderSubscribeBoxHtml({ email: "a@x.com", sig: "sig", nickname: "Ana" }, "clarice");
    assert.match(html, /class="nick-save nick-save-primary">Assinar e ver o leaderboard<\/button>/);
  });
});

// ── §2b — matriz A / B / nada ────────────────────────────────────────────────

describe("§2b — resolveVoteIdentityBoxKind: matriz A/B/nada (pure, #4418)", () => {
  it("sem apelido (qualquer brand) → 'nickname' (Caixa A)", () => {
    assert.equal(resolveVoteIdentityBoxKind(null, "clarice"), "nickname");
    assert.equal(resolveVoteIdentityBoxKind({ nickname: null }, "diaria"), "nickname");
    assert.equal(resolveVoteIdentityBoxKind(undefined, "web"), "nickname");
  });

  it("clarice com apelido, sem opt-in → 'subscribe' (Caixa B)", () => {
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Mariana" }, "clarice"), "subscribe");
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Mariana", optin: false }, "clarice"), "subscribe");
  });

  it("clarice com apelido + opt-in → 'none'", () => {
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Mariana", optin: true }, "clarice"), "none");
  });

  it("diaria com apelido, independente de opt-in → 'none' (não há assinatura a oferecer)", () => {
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Pedro" }, "diaria"), "none");
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Pedro", optin: true }, "diaria"), "none");
  });

  it("web com apelido → 'none' (mesmo racional de diaria)", () => {
    assert.equal(resolveVoteIdentityBoxKind({ nickname: "Web" }, "web"), "none");
  });
});

describe("§2b — matriz A/B/nada, rendering e2e via /vote (#4418)", () => {
  it("clarice sem apelido → Caixa A (com checkbox), NUNCA Caixa B", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq("clarice", "novato@example.com", "A"), env);
    const html = await res.text();
    assert.match(html, /<div class="nick-box">/);
    assert.match(html, /name="optin"/);
    // #4418: CSS estático (renderNicknameFormStyles) sempre declara a regra
    // `.nick-box.nick-sub-box` — checar o MARKUP (div com as 2 classes,
    // separadas por espaço), não a string crua "nick-sub-box" (que a CSS
    // sempre contém, independente do que renderiza no <body>).
    assert.doesNotMatch(html, /<div class="nick-box nick-sub-box">/);
  });

  it("clarice com apelido, sem opt-in → Caixa B: sem campo de nome, sem checkbox, kicker com o apelido (não o e-mail mascarado)", async () => {
    const kv = makeTrackedKv({
      "clarice:score:comnick@example.com": JSON.stringify({ total: 1, correct: 1, streak: 1, nickname: "Mariana" }),
    });
    const env = makePollEnv(kv);
    const res = await worker.fetch(voteReq("clarice", "comnick@example.com", "A"), env);
    const html = await res.text();
    assert.match(html, /<div class="nick-box nick-sub-box">/);
    assert.doesNotMatch(html, /<input type="text" name="name"/);
    assert.doesNotMatch(html, /type="checkbox"/);
    assert.match(html, /<p class="nick-kicker">Você está no ranking como Mariana\.<\/p>/);
    assert.doesNotMatch(html, /nick-kicker">[^<]*@/, "kicker não deve mostrar e-mail mascarado");
    assert.match(html, /class="nick-secondary"[^>]*>Ver o leaderboard<\/a>/);
  });

  it("Caixa B descreve o produto: newsletter, de graça, 5 minutos, segunda a sexta (não só isca+botão)", () => {
    const html = renderSubscribeBoxHtml({ email: "a@x.com", sig: "sig", nickname: "Ana" }, "clarice");
    assert.match(html, /newsletter/i);
    assert.match(html, /de graça|gratuita/i);
    assert.match(html, /5 minutos/);
    assert.match(html, /segunda a sexta/);
  });

  it("clarice com apelido + opt-in → nenhuma caixa", async () => {
    const kv = makeTrackedKv({
      "clarice:score:optedin@example.com": JSON.stringify({ total: 2, correct: 1, nickname: "Bruno", optin: true }),
    });
    const env = makePollEnv(kv);
    const res = await worker.fetch(voteReq("clarice", "optedin@example.com", "A"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /class="nick-box/);
  });

  it("diaria com apelido → nenhuma caixa, independente de opt-in", async () => {
    const kv = makeTrackedKv({
      "score:diariacom@example.com": JSON.stringify({ total: 2, correct: 1, nickname: "Carla" }),
    });
    const env = makePollEnv(kv);
    const res = await worker.fetch(voteReq(null, "diariacom@example.com", "A"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /class="nick-box/);
  });

  it("tela de 'já votou' (clarice) com apelido salvo e sem opt-in TAMBÉM mostra Caixa B (mesma regra do voto fresco)", async () => {
    const kv = makeTrackedKv({
      "clarice:score:javotoucomnick@example.com": JSON.stringify({ total: 1, correct: 1, nickname: "Já Votou" }),
    });
    const env = makePollEnv(kv);
    await worker.fetch(voteReq("clarice", "javotoucomnick@example.com", "A"), env);
    const res2 = await worker.fetch(voteReq("clarice", "javotoucomnick@example.com", "B"), env);
    const html = await res2.text();
    assert.match(html, /já votou/i);
    assert.match(html, /<div class="nick-box nick-sub-box">/);
  });
});

describe("§2b — Caixa B escapa o apelido (XSS, #4418)", () => {
  it("apelido com <, & e aspas sai escapado, nunca como HTML cru", () => {
    const html = renderSubscribeBoxHtml({ email: "a@x.com", sig: "sig", nickname: `<script>alert("x")</script>&` }, "clarice");
    assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;x&quot;/);
    assert.match(html, /&amp;/);
  });
});

describe("§2b — Caixa B funciona sem JS (#4418)", () => {
  it("form GET /set-name, optin=on fixo, apelido em hidden; secundário é link puro", () => {
    const html = renderSubscribeBoxHtml({ email: "a@x.com", sig: "sig", nickname: "Ana" }, "clarice");
    assert.match(html, /<form action="\/set-name" method="GET" class="nick-sub-form">/);
    assert.match(html, /<input type="hidden" name="optin" value="on">/);
    assert.match(html, /<input type="hidden" name="name" value="Ana">/);
    assert.doesNotMatch(html, /fetch\(/);
    assert.match(html, /<a class="nick-secondary" href="[^"]+">Ver o leaderboard<\/a>/);
  });
});

// ── §2c — /set-name redireciona no sucesso; erro nunca redireciona ─────────

describe("§2c/§3 — /set-name: sucesso 302 pro leaderboard da marca (#4418)", () => {
  it("sucesso: 302, email+sig preservados na URL de destino, Cache-Control no-store", async () => {
    const email = "sucesso@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({ [`clarice:score:${email}`]: JSON.stringify({ total: 1, nickname: null }) });
    const env = makePollEnv(kv);
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Nome Novo");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 302);
    const loc = res.headers.get("Location") ?? "";
    assert.match(loc, /\/leaderboard\?brand=clarice/);
    assert.match(loc, /email=sucesso%40example\.com/);
    assert.match(loc, new RegExp(`sig=${sig}`));
    assert.match(loc, /saved=1/);
    assert.match(loc, /#self-row$/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

describe("§3 — telas de erro do /set-name NUNCA redirecionam nem mostram caixa (exceto retry mínimo do #1774)", () => {
  it("'Link inválido ou expirado' (sig inválida, 403): 200 HTML, sem nick-box", async () => {
    const env = makeEnv();
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", "erro@example.com");
    url.searchParams.set("name", "Nome");
    url.searchParams.set("sig", "sig-invalida");
    const res = await handleSetName(url, env);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.doesNotMatch(html, /class="nick-box/);
  });

  it("'Vote primeiro antes de definir nickname' (sem score, 400): sem nick-box", async () => {
    const email = "semvoto@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv();
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Nome");
    url.searchParams.set("sig", sig);
    const res = await handleSetName(url, env);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.doesNotMatch(html, /class="nick-box/);
  });

  it("'Nome vazio' (400): sem nick-box", async () => {
    const email = "nomevazio@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv();
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "<>");
    url.searchParams.set("sig", sig);
    const res = await handleSetName(url, env);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.doesNotMatch(html, /class="nick-box/);
  });

  it("'Esse apelido já está em uso' (409): form de retry mínimo (#1774) SEM checkbox nem Caixa B", async () => {
    const email = "retry@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({
      "score:bruna@x.com": JSON.stringify({ total: 5, nickname: "Bruna" }),
      "nickname:bruna": "bruna@x.com",
      [`score:${email}`]: JSON.stringify({ total: 1, nickname: null }),
    });
    const env = makePollEnv(kv);
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Bruna");
    url.searchParams.set("sig", sig);
    const res = await handleSetName(url, env);
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.match(html, /<div class="nick-box">/, "form de retry (#1774) continua disponível");
    assert.doesNotMatch(html, /<div class="nick-box nick-sub-box">/, "Caixa B nunca aparece em tela de erro");
    assert.doesNotMatch(html, /name="optin"/, "checkbox de opt-in não reabre em retry de erro");
  });
});

// ── §2c — cadastro fail-soft (sucesso e falha) ──────────────────────────────

describe("§2c — cadastro na Beehiiv é fail-soft: apelido persiste, tela reporta o erro (#4418)", () => {
  it("Beehiiv NÃO configurada (secrets ausentes) → apelido persiste, signup=failed no redirect, faixa reporta o erro", async () => {
    const email = "falha@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({ [`clarice:score:${email}`]: JSON.stringify({ total: 1, nickname: null }) });
    const env = makePollEnv(kv);
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Falhou");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    url.searchParams.set("optin", "on");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 302);
    const loc = res.headers.get("Location") ?? "";
    assert.match(loc, /signup=failed/);

    const score = JSON.parse((await kv.get(`clarice:score:${email}`))!);
    assert.equal(score.nickname, "Falhou", "apelido nunca se perde por causa do cadastro");
    assert.notEqual(score.optin, true);

    const bannerUrl = new URL(loc, "https://poll.test");
    const bannerRes = await worker.fetch(new Request(bannerUrl.toString()), env, {} as ExecutionContext);
    const bannerHtml = await bannerRes.text();
    assert.match(bannerHtml, /não completou/, "faixa deve reportar o erro do cadastro");
  });

  it("Beehiiv sucesso (mock) → score.optin=true, signup=subscribed no redirect, faixa confirma a assinatura", async () => {
    const email = "sucesso-beehiiv@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({ [`clarice:score:${email}`]: JSON.stringify({ total: 1, nickname: null }) });
    const env = makePollEnv(kv);
    env.BEEHIIV_API_KEY = "test-key";
    env.BEEHIIV_PUBLICATION_ID = "pub_test";
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Sucesso");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    url.searchParams.set("optin", "on");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    let loc = "";
    try {
      const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
      assert.equal(res.status, 302);
      loc = res.headers.get("Location") ?? "";
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.match(loc, /signup=subscribed/);

    const score = JSON.parse((await kv.get(`clarice:score:${email}`))!);
    assert.equal(score.nickname, "Sucesso");
    assert.equal(score.optin, true);

    const bannerUrl = new URL(loc, "https://poll.test");
    const bannerRes = await worker.fetch(new Request(bannerUrl.toString()), env, {} as ExecutionContext);
    const bannerHtml = await bannerRes.text();
    assert.match(bannerHtml, /diar\.ia\.br começa a chegar amanhã/);
  });

  it("brand diaria: optin=on é ignorado (sem checkbox nessa marca) — nunca chama a Beehiiv", async () => {
    const email = "diaria-optin@example.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: null }) });
    const env = makePollEnv(kv);
    env.BEEHIIV_API_KEY = "test-key";
    env.BEEHIIV_PUBLICATION_ID = "pub_test";
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", "Leitora Diária"); // "Diaria" sozinho está na blacklist de apelidos (lib.ts)
    url.searchParams.set("sig", sig);
    url.searchParams.set("optin", "on"); // sem &brand= → default diaria

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("não deveria ser chamado — brand diaria não oferece assinatura aqui");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
      assert.equal(res.status, 302);
      assert.doesNotMatch(res.headers.get("Location") ?? "", /signup=/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(called, false);
  });
});

// ── §3 — faixa de confirmação no leaderboard ────────────────────────────────

describe("§3 — resolveSetNameConfirmationBanner (pure, #4418)", () => {
  it("saved=1 + signup=subscribed → menciona o nome e a diar.ia.br chegando amanhã", () => {
    const url = new URL("https://poll.example/leaderboard?saved=1&name=Ana&signup=subscribed");
    const banner = resolveSetNameConfirmationBanner(url);
    assert.match(banner ?? "", /Pronto, Ana!/);
    assert.match(banner ?? "", /diar\.ia\.br começa a chegar amanhã/);
  });

  it("saved=1 + signup=failed → apelido salvo, cadastro não completou", () => {
    const url = new URL("https://poll.example/leaderboard?saved=1&name=Ana&signup=failed");
    const banner = resolveSetNameConfirmationBanner(url);
    assert.match(banner ?? "", /Apelido salvo/);
    assert.match(banner ?? "", /não completou/);
  });

  it("saved=1 sem signup → frase original inalterada ('Pronto, {nome}! Você aparece assim no ranking.')", () => {
    const url = new URL("https://poll.example/leaderboard?saved=1&name=Ana");
    assert.equal(resolveSetNameConfirmationBanner(url), "Pronto, Ana! Você aparece assim no ranking.");
  });

  it("sem saved=1 → null (visita normal nunca mostra a faixa)", () => {
    assert.equal(resolveSetNameConfirmationBanner(new URL("https://poll.example/leaderboard")), null);
  });

  it("escapa o nome (XSS)", () => {
    const url = new URL("https://poll.example/leaderboard?saved=1");
    url.searchParams.set("name", "<b>x</b>");
    const banner = resolveSetNameConfirmationBanner(url);
    assert.doesNotMatch(banner ?? "", /<b>x<\/b>/);
    assert.match(banner ?? "", /&lt;b&gt;/);
  });
});

describe("§3 — faixa de confirmação renderiza de fato no HTML do leaderboard (e2e, #4418)", () => {
  it("opt-in OK: faixa aparece no topo", async () => {
    const env = makeEnv();
    const url = new URL("https://poll.test/leaderboard?brand=clarice&saved=1&name=Ana&signup=subscribed");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    assert.match(html, /class="confirm-banner"/);
    assert.match(html, /Pronto, Ana!/);
  });

  it("opt-in com falha de cadastro: faixa reporta o erro", async () => {
    const env = makeEnv();
    const url = new URL("https://poll.test/leaderboard?brand=clarice&saved=1&name=Ana&signup=failed");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    assert.match(html, /class="confirm-banner"/);
    assert.match(html, /não completou/);
  });

  it("sem opt-in: faixa com a frase original", async () => {
    const env = makeEnv();
    const url = new URL("https://poll.test/leaderboard?brand=clarice&saved=1&name=Ana");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    assert.match(html, /class="confirm-banner"/);
    assert.match(html, /Pronto, Ana! Você aparece assim no ranking\.</);
  });
});

// ── §2c — self-highlight server-side (diaria/clarice) ───────────────────────

describe("§2c — self-highlight server-side no leaderboard da clarice (#4418)", () => {
  it("email+sig válidos marcam a linha daquele e-mail e só ela", async () => {
    const email = "self@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const monthSlug = currentMonthSlugBrt(new Date());
    const kv = makeTrackedKv({
      [`clarice:score-by-month:${monthSlug}:self@x.com`]: JSON.stringify({ nickname: "Self", correct: 1, total: 1 }),
      [`clarice:score-by-month:${monthSlug}:other@x.com`]: JSON.stringify({ nickname: "Other", correct: 1, total: 1 }),
    });
    const env = makePollEnv(kv);
    const url = new URL(`https://poll.test/leaderboard?brand=clarice&email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    const trMatches = [...html.matchAll(/<tr class="[^"]*self-row[^"]*"/g)];
    assert.equal(trMatches.length, 1, "só a própria linha deve ser marcada");
    assert.match(html, /id="self-row"/);
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("sem par assinado, nenhuma linha marcada e cache normal", async () => {
    const monthSlug = currentMonthSlugBrt(new Date());
    const kv = makeTrackedKv({
      [`clarice:score-by-month:${monthSlug}:self@x.com`]: JSON.stringify({ nickname: "Self", correct: 1, total: 1 }),
    });
    const env = makePollEnv(kv);
    const url = new URL("https://poll.test/leaderboard?brand=clarice");
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    // #4418: CSS estático (`tr.self-row td { ... }`) sempre declara a regra —
    // checar o MARKUP (linha com a classe), não a string crua "self-row"
    // (que o CSS sempre contém, independente de alguma linha estar marcada).
    assert.doesNotMatch(html, /<tr class="[^"]*self-row[^"]*"/);
    assert.doesNotMatch(html, /id="self-row"/);
    assert.notEqual(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("data-uid continua NÃO emitido fora do brand web, mesmo com self-highlight ativo (guard #4162 intacto)", async () => {
    const email = "self@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const monthSlug = currentMonthSlugBrt(new Date());
    const kv = makeTrackedKv({
      [`clarice:score-by-month:${monthSlug}:self@x.com`]: JSON.stringify({ nickname: "Self", correct: 1, total: 1 }),
    });
    const env = makePollEnv(kv);
    const url = new URL(`https://poll.test/leaderboard?brand=clarice&email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    assert.doesNotMatch(html, /data-uid=/);
  });

  it("resolveLeaderboardViewerEmail: brand web sempre null (usa identidade local, não link assinado)", async () => {
    const email = "self@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv();
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    assert.equal(await resolveLeaderboardViewerEmail(url, env, "web"), null);
  });
});

// ── §2b — resolveLeaderboardSubscribeBox (leaderboard, #4418) ───────────────

describe("§2b — resolveLeaderboardSubscribeBox: Caixa B trazida pro leaderboard (#4418, 'Recomendação: levar')", () => {
  // Nota: `resolveLeaderboardSubscribeBox`, assim como `resolveLeaderboardNicknameForm`
  // (padrão preexistente #4232), NÃO aplica `brandedNamespace` internamente —
  // quem chama a função diretamente (fora do router de index.ts) é
  // responsável por já passar um `env` branded se quiser simular o brand.
  // Aqui testamos a função pura em isolamento com chaves CRUAS (mesmo padrão
  // do describe "resolveLeaderboardNicknameForm" em
  // poll-leaderboard-nickname-cta-4232.test.ts); a integração real com o
  // prefixo `clarice:` é coberta pelo teste e2e (via worker.fetch) logo abaixo.
  it("clarice, apelido salvo, sem opt-in, sig válida → retorna a Caixa B", async () => {
    const email = "leaderboard-sub@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ POLL: makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: "Leo" }) }) as unknown as KVNamespace });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    const result = await resolveLeaderboardSubscribeBox(url, env, "clarice");
    assert.deepEqual(result, { email, sig, nickname: "Leo" });
  });

  it("clarice, já com opt-in → null (não reoferece)", async () => {
    const email = "ja-optin@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ POLL: makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: "Leo", optin: true }) }) as unknown as KVNamespace });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    assert.equal(await resolveLeaderboardSubscribeBox(url, env, "clarice"), null);
  });

  it("diaria → sempre null (não oferece assinatura)", async () => {
    const email = "diaria-nosub@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const env = makeEnv({ POLL: makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: "Leo" }) }) as unknown as KVNamespace });
    const url = new URL(`https://poll.example/leaderboard?email=${encodeURIComponent(email)}&sig=${sig}`);
    assert.equal(await resolveLeaderboardSubscribeBox(url, env, "diaria"), null);
  });

  it("leaderboard e2e: clarice com apelido salvo, sem opt-in → Caixa B renderiza de fato", async () => {
    const email = "leaderboard-sub-e2e@x.com";
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({
      [`clarice:score:${email}`]: JSON.stringify({ total: 1, nickname: "Leo" }),
    });
    const env = makePollEnv(kv);
    const url = new URL(`https://poll.test/leaderboard?brand=clarice&email=${encodeURIComponent(email)}&sig=${sig}`);
    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    const html = await res.text();
    assert.match(html, /<div class="nick-box nick-sub-box">/);
    assert.match(html, /Você está no ranking como Leo\./);
  });
});
