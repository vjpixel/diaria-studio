/**
 * test/circle-stack.test.ts (#10904)
 *
 * Publicador semanal no Circle da Stack: payload da Admin API v2, fallback
 * de esquema de auth (Token → Bearer só em 401), render do post a partir da
 * seleção semanal e resolução de config/ciclo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCreatePostPayload,
  createCirclePost,
  parsePostResponse,
  parseSpacesResponse,
} from "../scripts/lib/circle-api.ts";
import {
  renderCircleStackPost,
  circleStackTitle,
  buildCircleStackUrl,
  DEFAULT_CIRCLE_STACK_OPENING,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { resolveCircleStackConfig, resolveCycleArg } from "../scripts/publish-circle-stack.ts";

const selection: CircleStackSelection = {
  cycle: "26w42",
  contentWindow: ["261012", "261013", "261014", "261015", "261016"],
  headlines: [
    {
      editionDate: "261013",
      url: "https://cloud.google.com/blog/x",
      title: "Gemini vira colega com e-mail & agenda",
      body: "Parágrafo um.\n\nParágrafo dois.",
      why: "Porque sim.",
    },
    { editionDate: "261099", url: "https://ex.com/a", title: "Sem edição", body: "Corpo.", why: "" },
  ],
  useMelhor: { editionDate: "261015", url: "https://ex.com/um", title: "Curso grátis", body: "Descrição." },
  weeklyEditions: [
    { editionDate: "261013", url: "https://diar.ia.br/p/gemini", destaques: ["A", "B", "C"] },
  ],
};

describe("buildCreatePostPayload", () => {
  it("monta o corpo mínimo e omite opcionais não definidos", () => {
    const p = buildCreatePostPayload({ spaceId: 42, name: "T", html: "<p>x</p>", status: "draft" });
    assert.deepEqual(p, { space_id: 42, name: "T", body: "<p>x</p>", status: "draft" });
  });

  it("inclui autor, comentários e notificações quando definidos", () => {
    const p = buildCreatePostPayload({
      spaceId: 1, name: "T", html: "<p>x</p>", status: "published",
      userEmail: "a@b.c", isCommentsEnabled: false, skipNotifications: true,
    });
    assert.equal(p.user_email, "a@b.c");
    assert.equal(p.is_comments_enabled, false);
    assert.equal(p.skip_notifications, true);
  });

  it("recusa space_id ausente, corpo vazio e agendado sem data", () => {
    assert.throws(() => buildCreatePostPayload({ spaceId: 0, name: "T", html: "x", status: "draft" }), /space_id/);
    assert.throws(() => buildCreatePostPayload({ spaceId: 1, name: "T", html: "  ", status: "draft" }), /vazio/);
    assert.throws(() => buildCreatePostPayload({ spaceId: 1, name: "T", html: "x", status: "scheduled" }), /publishedAt/);
  });
});

describe("createCirclePost — esquema de auth", () => {
  function fakeFetch(statusByScheme: Record<string, number>, seen: string[]) {
    return (async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      seen.push(auth);
      const scheme = auth.split(" ")[0];
      const status = statusByScheme[scheme] ?? 500;
      return new Response(status === 200 ? JSON.stringify({ post: { id: 7, url: "https://u", status: "draft" } }) : "nope", { status });
    }) as unknown as typeof fetch;
  }
  const input = { spaceId: 1, name: "T", html: "<p>x</p>", status: "draft" as const };

  it("auto: tenta Token e cai pra Bearer só em 401", async () => {
    const seen: string[] = [];
    const r = await createCirclePost({ token: "k" }, input, fakeFetch({ Token: 401, Bearer: 200 }, seen));
    assert.deepEqual(seen, ["Token k", "Bearer k"]);
    assert.equal(r.id, 7);
  });

  it("auto: erro que não é 401 não troca de esquema", async () => {
    const seen: string[] = [];
    await assert.rejects(createCirclePost({ token: "k" }, input, fakeFetch({ Token: 422 }, seen)), /HTTP 422/);
    assert.deepEqual(seen, ["Token k"]);
  });

  it("esquema fixo não faz fallback", async () => {
    const seen: string[] = [];
    await assert.rejects(createCirclePost({ token: "k", authScheme: "Token" }, input, fakeFetch({ Token: 401 }, seen)), /HTTP 401/);
    assert.equal(seen.length, 1);
  });
});

describe("parsers de resposta", () => {
  it("parsePostResponse aceita post aninhado ou na raiz", () => {
    assert.equal(parsePostResponse({ post: { id: 3 } }).id, 3);
    assert.equal(parsePostResponse({ id: 4, url: "x" }).url, "x");
    assert.equal(parsePostResponse(null).id, null);
  });
  it("parseSpacesResponse lê records", () => {
    assert.deepEqual(parseSpacesResponse({ records: [{ id: 9, name: "Radar", slug: "radar" }, { name: "sem id" }] }), [
      { id: 9, name: "Radar", slug: "radar" },
    ]);
  });
});

describe("renderCircleStackPost", () => {
  const { title, html } = renderCircleStackPost(selection);

  it("título cobre segunda a sexta da semana de conteúdo", () => {
    assert.equal(title, "Radar de Notícias Stack — semana de 12/10 a 16/10");
    assert.equal(circleStackTitle(["261012"]), "Radar de Notícias Stack — semana de 12/10 a 12/10");
  });

  it("título do destaque literal (escapado) e abertura default", () => {
    assert.match(html, /<h2>Gemini vira colega com e-mail &amp; agenda<\/h2>/);
    assert.ok(html.includes(DEFAULT_CIRCLE_STACK_OPENING));
  });

  it("'Por que isso importa:' em parágrafo próprio, só quando há why", () => {
    assert.equal((html.match(/Por que isso importa:/g) ?? []).length, 1);
    assert.match(html, /<p><strong>Por que isso importa:<\/strong><\/p>\n<p>Porque sim.<\/p>/);
  });

  it("fonte sem UTM; edição e CTA com UTM stack/circle", () => {
    assert.ok(html.includes('href="https://cloud.google.com/blog/x"'));
    assert.ok(html.includes(buildCircleStackUrl("https://diar.ia.br/p/gemini", "26w42", "edicao").replace(/&/g, "&amp;")));
    assert.ok(html.includes("utm_content=cta-fim"));
    assert.ok(html.includes("utm_campaign=stack-26w42"));
  });

  it("destaque sem edição correspondente sai só com link da fonte", () => {
    assert.ok(!html.includes("Na edição de 99/10"));
  });

  it("nunca usa seta em link ou CTA (#9721)", () => {
    assert.ok(!/[→←]/.test(html));
  });

  it("subscribeUrl alternativo entra sem UTM adicionada", () => {
    const r = renderCircleStackPost(selection, { subscribeUrl: "https://go.pm3.com.br/x" });
    assert.ok(r.html.includes('href="https://go.pm3.com.br/x"'));
    assert.ok(!r.html.includes("utm_content=cta-fim"));
  });

  it("seleção sem manchetes é erro", () => {
    assert.throws(() => renderCircleStackPost({ ...selection, headlines: [] }), /sem manchetes/);
  });
});

describe("config e ciclo", () => {
  it("defaults conservadores: rascunho, auth auto", () => {
    const c = resolveCircleStackConfig({});
    assert.equal(c.status, "draft");
    assert.equal(c.authScheme, "auto");
    assert.equal(c.spaceId, null);
  });
  it("status inválido é erro", () => {
    assert.throws(() => resolveCircleStackConfig({ circle_stack: { status: "scheduled" } }), /status/);
  });
  it("ciclo via --cycle ou --publish-monday", () => {
    assert.equal(resolveCycleArg("26w42", undefined), "26w42");
    assert.equal(resolveCycleArg(undefined, "261019"), "26w42");
    assert.throws(() => resolveCycleArg(undefined, undefined), /--cycle/);
  });
});
