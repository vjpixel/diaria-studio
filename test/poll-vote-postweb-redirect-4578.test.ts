/**
 * test/poll-vote-postweb-redirect-4578.test.ts (#4578)
 *
 * "Botão de voto do 'É IA?' é dead end na versão WEB da edição" — clicar no
 * botão de voto na página web de um post (onde a merge tag `{{email}}`/
 * `{{poll_token}}` nunca é resolvida — ela só é substituída no ENVIO do
 * e-mail, não na página web hospedada) caía sempre num 400 "Link inválido —
 * abra o voto pelo botão no email", sem nenhum caminho de volta pro jogo.
 *
 * Escopo mínimo confirmado pelo editor (260804), 3 partes:
 *   1. `handleVote` (vote.ts): guard `isUnsubstitutedMergeTag` passa a
 *      redirecionar (302) pro jogo anônimo `/jogar?edition=...&from=post-web`
 *      em vez de 400 — o log `poll_vote_unsubstituted_merge_tag` (#4520)
 *      continua sendo emitido (cobertura própria em
 *      test/vote-unsubstituted-merge-tag-log-4520.test.ts, atualizada nesta
 *      mesma unidade pro novo status 302).
 *   2. `handleJogarPage`/`renderJogarPageHtml` (jogar.ts): quando a request
 *      chega com `?from=post-web`, o pós-voto revela a CAIXA UNIFICADA do
 *      gate (`renderJogarGateBoxBlock`/`jogarGateBoxScript`, web-gate.ts,
 *      id `jogar-gate-box`) em vez do form de identidade padrão (#3975,
 *      `jogar-identity-form`) — o CTA-link (#3518, `jogar-subscribe-cta`)
 *      continua como fallback secundário nos dois casos. SEM `from=post-web`,
 *      comportamento pré-#4578 100% intacto.
 *   3. UTM próprio (`JOGAR_POSTWEB_UTM`) pro cadastro feito nessa caixa —
 *      cobertura em test/utm-registry-4041.test.ts; aqui só o wiring real
 *      (`handleJogarGateSubscribe` aceita `source` do corpo do POST).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";
import { renderJogarPageHtml } from "../workers/poll/src/jogar.ts";
import { renderJogarGateBoxBlock, jogarGateBoxScript } from "../workers/poll/src/web-gate.ts";

const EDITION = "260801";

// ── 1. handleVote: 302 em vez de 400 ────────────────────────────────────────

describe("#4578 item 1 — /vote com merge tag não-substituída redireciona pro /jogar", () => {
  it("email={{email}} + edition válida → 302 com Location /jogar?edition={edition}&from=post-web", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 302);
    const location = res.headers.get("Location");
    assert.ok(location, "deve ter header Location");
    const target = new URL(location!, "https://poll.test");
    assert.equal(target.pathname, "/jogar");
    assert.equal(target.searchParams.get("edition"), EDITION);
    assert.equal(target.searchParams.get("from"), "post-web");
  });

  it("email={{ subscriber.email }} (Beehiiv, com espaços) também redireciona — mesmo guard isUnsubstitutedMergeTag", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{ subscriber.email }}")}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get("Location")!, "https://poll.test");
    assert.equal(target.searchParams.get("from"), "post-web");
  });

  it("brand=clarice (Brevo mensal) com merge tag também redireciona pro MESMO /jogar (brand web) — mesma classe de bug (ver corpo da issue)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{ contact.POLL_TOKEN }}")}&edition=${EDITION}&choice=A&brand=clarice`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get("Location")!, "https://poll.test");
    assert.equal(target.pathname, "/jogar");
    assert.equal(target.searchParams.get("from"), "post-web");
  });

  it("Location NUNCA carrega o Cache-Control público, sempre no-store (redirect não pode ser cacheado)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  it("edition malformada + merge tag não-substituída → NÃO compõe redirect, continua 400 (comportamento seguro pré-#4578)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=${encodeURIComponent("2607-08:evil")}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400, "edition inválida nunca deve virar parte de uma URL de redirect");
    assert.equal(res.headers.get("Location"), null);
  });

  it("edition vazia + merge tag → 400 pelo gate de parâmetros ausentes (nem chega no guard de merge tag)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("Location"), null);
  });

  it("log poll_vote_unsubstituted_merge_tag continua sendo emitido no novo caminho (302)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const originalConsoleLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => { logs.push(msg); };
    let res: Response;
    try {
      res = await worker.fetch(
        new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=${EDITION}&choice=A`),
        env,
        {} as ExecutionContext,
      );
    } finally {
      console.log = originalConsoleLog;
    }
    assert.equal(res.status, 302);
    const parsed = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const found = parsed.find((p) => p?.event === "poll_vote_unsubstituted_merge_tag");
    assert.ok(found, `log deve continuar sendo emitido mesmo no caminho de redirect. logs: ${JSON.stringify(logs)}`);
    assert.equal(found.edition, EDITION);
  });

  it("e-mail normal (sem merge tag) NUNCA redireciona — comportamento pré-existente intacto", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=leitor@example.com&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.notEqual(res.status, 302);
  });
});

// ── 2. renderJogarPageHtml / handleJogarPage: caixa unificada do gate ──────

describe("#4578 item 2 — /jogar?from=post-web revela a caixa unificada do gate no pós-voto", () => {
  it("postWeb=true: renderiza #jogar-gate-box (hidden por padrão) no lugar de #jogar-identity-form", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    assert.match(html, /<form id="jogar-gate-box" class="signup-form" hidden novalidate>/);
    assert.doesNotMatch(html, /id="jogar-identity-form"/, "form de identidade padrão não deve aparecer neste caminho");
  });

  it("postWeb=true: #jogar-signup-form (form standalone #3580) nunca aparece — nem apareceria sem postWeb (não é deste template)", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    assert.doesNotMatch(html, /id="jogar-signup-form"/);
  });

  it("postWeb=true: CTA-link (#3518, jogar-subscribe-cta) continua presente como fallback secundário", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    assert.match(html, /id="jogar-subscribe-cta"/);
  });

  it("postWeb=true: script de reveal observa #jogar-gate-box, não #jogar-identity-form", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    assert.match(html, /var identityForm = document\.getElementById\("jogar-gate-box"\);/);
    assert.doesNotMatch(html, /var identityForm = document\.getElementById\("jogar-identity-form"\);/);
  });

  it("postWeb=true: os 2 pontos que revelam a caixa (já votou + voto novo) usam a MESMA variável — paridade automática entre os 2 caminhos", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    const matches = html.match(/if \(identityForm && !isIdentifiedLocally\(\)\) identityForm\.hidden = false;/g) ?? [];
    assert.equal(matches.length, 2, "esperado 1x no branch 'já votou' + 1x no callback de voto novo (mesma paridade do #3975)");
  });

  it("postWeb=true: injeta jogarGateBoxScript() (wiring verify→subscribe→identify), não identityFormScript()", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: true });
    assert.match(html, /\/jogar\/gate\/verify/);
    assert.match(html, /\/jogar\/gate\/subscribe/);
    assert.match(html, /source:\s*"jogar-postweb"/);
  });

  it("postWeb=false (default): comportamento pré-#4578 100% intacto — #jogar-identity-form presente, #jogar-gate-box ausente", () => {
    const html = renderJogarPageHtml({ edition: EDITION, revealed: false });
    assert.match(html, /id="jogar-identity-form"/);
    assert.doesNotMatch(html, /id="jogar-gate-box"/);
    assert.match(html, /var identityForm = document\.getElementById\("jogar-identity-form"\);/);
  });

  it("postWeb=false explícito: mesmo resultado que omitir o campo (default seguro)", () => {
    const withField = renderJogarPageHtml({ edition: EDITION, revealed: false, postWeb: false });
    const omitted = renderJogarPageHtml({ edition: EDITION, revealed: false });
    assert.equal(withField, omitted);
  });

  it("disciplina anti-spoiler: a caixa do gate nasce com o atributo hidden (nunca visível antes do resultado do voto)", () => {
    const html = renderJogarGateBoxBlock();
    assert.match(html, /<form id="jogar-gate-box" class="signup-form" hidden novalidate>/);
  });

  it("fim-a-fim via handleJogarPage: GET /jogar?edition=X&from=post-web serve a caixa do gate", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar?edition=${EDITION}&from=post-web`),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="jogar-gate-box"/);
    assert.doesNotMatch(html, /id="jogar-identity-form"/);
  });

  it("fim-a-fim via handleJogarPage: GET /jogar?edition=X (SEM from=post-web) serve o form de identidade padrão — regressão", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar?edition=${EDITION}`),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="jogar-identity-form"/);
    assert.doesNotMatch(html, /id="jogar-gate-box"/);
  });

  it("fim-a-fim: o redirect de /vote leva a uma URL que handleJogarPage de fato serve com a caixa do gate (integração completa do fluxo)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const voteRes = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("{{email}}")}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(voteRes.status, 302);
    const location = voteRes.headers.get("Location")!;

    const jogarRes = await worker.fetch(new Request(`https://poll.test${new URL(location, "https://poll.test").pathname}${new URL(location, "https://poll.test").search}`), env);
    assert.equal(jogarRes.status, 200);
    const html = await jogarRes.text();
    assert.match(html, /id="jogar-gate-box"/, "a página servida no destino do redirect deve mostrar a caixa unificada do gate");
  });
});

// ── 3. UTM próprio (JOGAR_POSTWEB_UTM) — wiring real do handler ────────────

describe("#4578 item 3 — POST /jogar/gate/subscribe aceita source e resolve o UTM certo", () => {
  function subReq(body: unknown) {
    return new Request("https://poll.test/jogar/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      POLL: makeTrackedKv() as unknown as KVNamespace,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      COOKIE_HMAC_SECRET: "cookie-secret",
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
      ...overrides,
    };
  }

  it("source: 'jogar-postweb' → Beehiiv recebe utm_medium/utm_campaign de JOGAR_POSTWEB_UTM (distinto de jogar-gate)", async () => {
    const env = makeEnv();
    let body: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "postweb@example.com", name: "Fulano", optin: true, source: "jogar-postweb" }), env);
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(body, "deve ter chamado a Beehiiv");
    assert.equal(body!.utm_medium, "jogar-postweb");
    assert.equal(body!.utm_campaign, "eia-jogar-postweb-signup");
    assert.equal(body!.referring_site, "jogar-postweb-gate");
  });

  it("REGRESSÃO: sem 'source' no corpo (tela de gate por rodada, comportamento pré-#4578) continua caindo em jogar-gate, não no default genérico 'jogar'", async () => {
    const env = makeEnv();
    let body: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: { id: "sub_2" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "gate@example.com", name: "Beltrano", optin: true }), env);
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(body);
    assert.equal(body!.utm_medium, "jogar-gate", "sem source explícito, deve preservar o default pré-#4578 (jogar-gate)");
    assert.equal(body!.utm_campaign, "eia-jogar-gate-signup");
  });

  it("jogarGateBoxScript() manda source: \"jogar-postweb\" no POST /jogar/gate/subscribe (wiring client-side)", () => {
    const script = jogarGateBoxScript();
    assert.match(script, /source:\s*"jogar-postweb"/);
  });
});
