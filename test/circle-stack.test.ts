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
  type CircleStackItem,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { scoreCandidate, selectCircleStack, parseInterestProfile } from "../scripts/lib/circle-stack-select.ts";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";
import { resolveCircleStackConfig } from "../scripts/publish-circle-stack.ts";

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261013", url: "https://ex.com/x", title: "T", body: "Corpo.", why: "", ...over,
});

const selection: CircleStackSelection = {
  cycle: "26w42",
  contentWindow: ["261012", "261013", "261014", "261015", "261016"],
  destaques: [
    item({ url: "https://cloud.google.com/blog/x", title: "Gemini vira colega com e-mail & agenda", body: "Parágrafo um.\n\nParágrafo dois.", why: "Porque sim." }),
    item({ editionDate: "261099", url: "https://ex.com/a", title: "Sem edição" }),
  ],
  lancamentos: [item({ url: "https://ex.com/l", title: "Lovable 3", body: "Lançou.", stackNote: "Nota para builders." })],
  useMelhor: [item({ url: "https://ex.com/um", title: "Curso grátis", body: "Descrição." })],
  radar: [],
  weeklyEditions: [{ editionDate: "261013", url: "https://diar.ia.br/p/gemini", destaques: ["A", "B", "C"] }],
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
    assert.match(html, /<h3>Gemini vira colega com e-mail &amp; agenda<\/h3>/);
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

  it("stackNote substitui a descrição no item de lista; seção vazia some", () => {
    assert.ok(html.includes('<h2>Lançamentos e ferramentas</h2>\n<ul>\n<li><a href="https://ex.com/l">Lovable 3</a><br>Nota para builders.</li>'));
    assert.ok(!html.includes("<h2>Radar</h2>"));
  });

  it("stackNote no destaque substitui o por que importa da edição", () => {
    const r = renderCircleStackPost({ ...selection, destaques: [item({ why: "Original.", stackNote: "Para quem constrói." })] });
    assert.ok(r.html.includes("<p>Para quem constrói.</p>"));
    assert.ok(!r.html.includes("Original."));
  });

  it("seleção sem destaques é erro", () => {
    assert.throws(() => renderCircleStackPost({ ...selection, destaques: [] }), /sem destaques/);
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
  it("interests do config substituem o perfil default; inválido é erro", () => {
    const c = resolveCircleStackConfig({ circle_stack: { interests: [{ pattern: "foo", weight: 1 }] } });
    assert.deepEqual(c.interests, [{ label: "foo", pattern: "foo", weight: 1 }]);
    assert.throws(() => parseInterestProfile([{ pattern: "x" }]), /weight/);
    assert.throws(() => parseInterestProfile([]), /não vazia/);
  });
});

const cand = (over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261013", url: `https://ex.com/${Math.random()}`, title: "Título neutro", body: "Corpo neutro.",
  why: "", kind: "section", category: "RADAR", section: "radar", ...over,
});

describe("scoreCandidate", () => {
  it("título pesa em dobro e registra os termos casados", () => {
    const s = scoreCandidate(cand({ title: "Lovable lança agentes", body: "" }));
    assert.equal(s.score, 4 * 2 + 3 * 2);
    assert.deepEqual(s.matchedTerms, ["Lovable", "agentes"]);
  });
  it("respeita borda de palavra (apple não casa app; cursorial não casa cursor)", () => {
    assert.equal(scoreCandidate(cand({ title: "Apple e o cursorial", body: "" })).score, 0);
  });
  it("bônus de seção prática", () => {
    assert.equal(scoreCandidate(cand({ section: "lancamentos" })).score, 2);
  });
});

describe("selectCircleStack", () => {
  it("prioriza destaques aderentes e completa o mínimo mesmo sem aderência", () => {
    const picks = selectCircleStack([
      cand({ kind: "destaque", section: "destaque", title: "Eleição e TSE" }),
      cand({ kind: "destaque", section: "destaque", title: "Cursor ganha agentes" }),
    ]);
    assert.equal(picks.destaques.length, 2);
    assert.equal(picks.destaques[0].title, "Cursor ganha agentes");
  });
  it("seções exigem aderência acima do bônus; URL nunca repete; links próprios saem", () => {
    const picks = selectCircleStack([
      cand({ url: "https://a.com/1", kind: "destaque", section: "destaque", title: "n8n 2.0" }),
      cand({ url: "https://a.com/1", section: "radar", title: "n8n 2.0" }),
      cand({ section: "lancamentos", title: "Modelo de imagem" }),
      cand({ section: "lancamentos", title: "Replit Agent" }),
      cand({ url: "https://diar.ia.br/p/x", section: "radar", title: "Claude Code" }),
    ]);
    assert.deepEqual(picks.lancamentos.map((c) => c.title), ["Replit Agent"]);
    assert.equal(picks.radar.length, 0);
    assert.equal(picks.destaques[0].title, "n8n 2.0");
  });
});
