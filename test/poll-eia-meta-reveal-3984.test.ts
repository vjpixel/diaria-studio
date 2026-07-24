/**
 * test/poll-eia-meta-reveal-3984.test.ts (#3984)
 *
 * Descrição + crédito da imagem real do par "É IA?" na revelação:
 *   1. `renderEiaMetaHtml` (index.ts, pure) — bloco `#jogar-eia-meta`.
 *   2. `POST /admin/eiameta` (handleAdminEiaMeta) — grava `eiameta:{edition}`
 *      (KV compartilhado, sem prefixo de brand), sig HMAC sobre o CONTEÚDO
 *      inteiro (não só edition).
 *   3. `handleVote`/fast-path (vote.ts) — repassa `eiameta:{edition}` pro
 *      cliente SÓ quando `correct !== null` (anti-spoiler), fallback
 *      silencioso quando ausente.
 *   4. jogar.ts — extração do bloco `#jogar-eia-meta` no par único
 *      (`renderJogarPageHtml`) e na sequência (`renderJogarSequencePageHtml`,
 *      reveal por rodada).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { renderEiaMetaHtml, hmacSign } from "../workers/poll/src/index.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";
import { handleVote } from "../workers/poll/src/vote.ts";
import { renderJogarPageHtml, renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

// ── renderEiaMetaHtml (pure) ─────────────────────────────────────────────────

describe("renderEiaMetaHtml (#3984, pure)", () => {
  it("null/undefined → string vazia (fallback silencioso)", () => {
    assert.equal(renderEiaMetaHtml(null), "");
    assert.equal(renderEiaMetaHtml(undefined), "");
  });

  it("description e credit ambos vazios → string vazia", () => {
    assert.equal(renderEiaMetaHtml({ description: "", credit: "" }), "");
  });

  it("renderiza description + credit com id jogar-eia-meta, htmlEscaped", () => {
    const html = renderEiaMetaHtml({ description: "Uma <ponte> no Japão.", credit: "Foto: Fulano <de tal>" });
    assert.match(html, /id="jogar-eia-meta"/);
    assert.match(html, /class="eia-meta-description">Uma &lt;ponte&gt; no Japão\.<\/p>/);
    assert.match(html, /class="eia-meta-credit">Foto: Fulano &lt;de tal&gt;<\/p>/);
  });

  it("só description (credit vazio) — renderiza só o parágrafo presente", () => {
    const html = renderEiaMetaHtml({ description: "Descrição.", credit: "" });
    assert.match(html, /eia-meta-description/);
    assert.doesNotMatch(html, /eia-meta-credit/);
  });
});

// ── POST /admin/eiameta ──────────────────────────────────────────────────────

describe("POST /admin/eiameta (#3984)", () => {
  const secret = "admin-secret";

  function sig(edition: string, description: string, credit: string): Promise<string> {
    return hmacSign(secret, `eiameta:${edition}:${description}:${credit}`);
  }

  it("grava eiameta:{edition} sem prefixo de brand (KV compartilhado)", async () => {
    const env = makeEnv() as unknown as Env;
    const s = await sig("260610", "Uma ponte.", "Foto: Fulano");
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260610", description: "Uma ponte.", credit: "Foto: Fulano", sig: s }),
    }), env);
    assert.equal(res.status, 200);
    const raw = await (env as unknown as { POLL: ReturnType<typeof makeTrackedKv> }).POLL.get("eiameta:260610");
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw!), { description: "Uma ponte.", credit: "Foto: Fulano" });
  });

  it("sig inválida → 403, nada gravado", async () => {
    const env = makeEnv() as unknown as Env;
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260610", description: "X", credit: "Y", sig: "sig-errada" }),
    }), env);
    assert.equal(res.status, 403);
    assert.equal(await (env as unknown as { POLL: ReturnType<typeof makeTrackedKv> }).POLL.get("eiameta:260610"), null);
  });

  it("sig assinada pra um conteúdo NÃO valida com conteúdo diferente (integridade — #3118 item 8)", async () => {
    const env = makeEnv() as unknown as Env;
    const s = await sig("260610", "Descrição ORIGINAL", "Y");
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260610", description: "Descrição TROCADA", credit: "Y", sig: s }),
    }), env);
    assert.equal(res.status, 403);
  });

  it("params ausentes (sem description/credit) → 400", async () => {
    const env = makeEnv() as unknown as Env;
    const s = await sig("260610", "", "");
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260610", description: "", credit: "", sig: s }),
    }), env);
    assert.equal(res.status, 400);
  });

  it("edition em forma inválida → 400", async () => {
    const env = makeEnv() as unknown as Env;
    const s = await sig("lixo-invalido", "X", "Y");
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "lixo-invalido", description: "X", credit: "Y", sig: s }),
    }), env);
    assert.equal(res.status, 400);
  });

  it("JSON malformado → 400, sem 500", async () => {
    const env = makeEnv() as unknown as Env;
    const res = await worker.fetch(new Request("https://poll.test/admin/eiameta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }), env);
    assert.equal(res.status, 400);
  });
});

// ── handleVote repassa eiaMeta (anti-spoiler + fallback silencioso) ─────────

const voteUrl = (email: string, edition: string, choice: string, brand?: string): URL => {
  const u = new URL("https://poll.test/vote");
  u.searchParams.set("email", email);
  u.searchParams.set("edition", edition);
  u.searchParams.set("choice", choice);
  if (brand) u.searchParams.set("brand", brand);
  return u;
};

describe("handleVote — eiameta na revelação (#3984, caminho síncrono legado)", () => {
  it("correct !== null + eiameta presente → bloco #jogar-eia-meta na resposta", async () => {
    const env = makeEnv({
      "correct:260610": "A",
      "eiameta:260610": JSON.stringify({ description: "Uma ponte no Japão.", credit: "Foto: Fulano" }),
    });
    const res = await handleVote(voteUrl("a@x.com", "260610", "A"), env, "diaria", env);
    const html = await res.text();
    assert.match(html, /id="jogar-eia-meta"/);
    assert.match(html, /Uma ponte no Japão\./);
    assert.match(html, /Foto: Fulano/);
  });

  it("eiameta AUSENTE → fallback silencioso, resposta normal sem o bloco", async () => {
    const env = makeEnv({ "correct:260610": "A" });
    const res = await handleVote(voteUrl("a@x.com", "260610", "A"), env, "diaria", env);
    const html = await res.text();
    assert.doesNotMatch(html, /id="jogar-eia-meta"/);
    assert.match(html, /✅ Acertou/);
  });

  it("anti-spoiler: gabarito AINDA não fechado (correct===null) → eiameta NUNCA repassado mesmo se presente no KV", async () => {
    const env = makeEnv({
      "eiameta:260610": JSON.stringify({ description: "Vazaria o gabarito indiretamente", credit: "X" }),
    });
    const res = await handleVote(voteUrl("a@x.com", "260610", "A"), env, "diaria", env);
    const html = await res.text();
    assert.doesNotMatch(html, /id="jogar-eia-meta"/);
  });
});

describe("handleVote fast-path — eiameta na revelação (#3984, ctx real)", () => {
  function makeRealCtx(): { ctx: ExecutionContext; scheduled: Promise<unknown>[] } {
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) { scheduled.push(p); },
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    return { ctx, scheduled };
  }

  it("fast-path também repassa eiameta (rawEnv threadeado corretamente)", async () => {
    const env = makeEnv({
      "correct:260610": "A",
      "eiameta:260610": JSON.stringify({ description: "Descrição fast-path", credit: "Crédito fast-path" }),
    });
    const { ctx } = makeRealCtx();
    const res = await handleVote(voteUrl("fastpath@x.com", "260610", "A"), env, "diaria", env, ctx);
    const html = await res.text();
    assert.match(html, /id="jogar-eia-meta"/);
    assert.match(html, /Descrição fast-path/);
  });
});

// ── jogar.ts — extração do bloco na revelação (par único + sequência) ──────

describe("jogar.ts — extração de #jogar-eia-meta na revelação (#3984)", () => {
  it("renderJogarPageHtml (par único): script extrai #jogar-eia-meta da resposta de /vote", () => {
    const html = renderJogarPageHtml({ edition: "260610", revealed: true });
    assert.match(html, /var eiaMetaEl = parsed\.querySelector\("#jogar-eia-meta"\);/);
    assert.match(html, /if \(eiaMetaEl\) out \+= eiaMetaEl\.outerHTML;/);
  });

  it("renderJogarSequencePageHtml: voteAndReveal extrai eiaMetaHtml e renderRoundResult injeta no reveal por rodada", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /var eiaMetaEl = parsed\.querySelector\("#jogar-eia-meta"\);/);
    assert.match(html, /eiaMetaHtml: eiaMetaEl \? eiaMetaEl\.outerHTML : ""/);
    assert.match(html, /result\.eiaMetaHtml \|\| ""/);
  });
});
