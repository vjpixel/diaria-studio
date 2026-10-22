/**
 * test/circle-stack.test.ts (#10904)
 *
 * Publicador semanal no Circle da Stack: payload da Admin API v2, fallback
 * de esquema de auth (Token → Bearer só em 401), render do post a partir da
 * seleção semanal e resolução de config/ciclo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStackPostPayload, sendStackPost } from "../scripts/lib/stack-webhook.ts";
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

describe("buildStackPostPayload", () => {
  it("monta titulo/corpo", () => {
    assert.deepEqual(buildStackPostPayload("T", "**x**"), { titulo: "T", corpo: "**x**" });
  });
  it("recusa vazio, HTML e imagem (o webhook remove/recusa)", () => {
    assert.throws(() => buildStackPostPayload(" ", "x"), /Título/);
    assert.throws(() => buildStackPostPayload("T", "<p>x</p>"), /HTML/);
    assert.throws(() => buildStackPostPayload("T", "![a](https://x/a.png)"), /imagem/);
  });
});

describe("sendStackPost", () => {
  const url = "https://n8n.example/webhook/x";
  function fake(status: number, body: string, seen: RequestInit[] = []) {
    return (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }
  const payload = { titulo: "T", corpo: "c" };

  it("200 com ok:true é sucesso e manda a chave no header", async () => {
    const seen: RequestInit[] = [];
    await sendStackPost(url, "k", payload, fake(200, '{"ok": true}', seen));
    assert.equal((seen[0].headers as Record<string, string>)["X-Webhook-Key"], "k");
    assert.deepEqual(JSON.parse(seen[0].body as string), payload);
  });
  it("200 sem ok:true não confirma publicação", async () => {
    await assert.rejects(sendStackPost(url, "k", payload, fake(200, "{}")), /não confirmada/);
    await assert.rejects(sendStackPost(url, "k", payload, fake(200, "aceito")), /não confirmada/);
  });
  it("502 vira erro do Circle; outro status vira HTTP", async () => {
    await assert.rejects(sendStackPost(url, "k", payload, fake(502, "")), /Circle recusou/);
    await assert.rejects(sendStackPost(url, "k", payload, fake(401, "")), /HTTP 401/);
  });
  it("sem URL, URL http ou sem chave não chama a rede", async () => {
    const seen: RequestInit[] = [];
    await assert.rejects(sendStackPost("", "k", payload, fake(200, '{"ok":true}', seen)), /STACK_WEBHOOK_URL/);
    await assert.rejects(sendStackPost("http://x", "k", payload, fake(200, '{"ok":true}', seen)), /https/);
    await assert.rejects(sendStackPost(url, "", payload, fake(200, '{"ok":true}', seen)), /STACK_WEBHOOK_KEY/);
    assert.equal(seen.length, 0);
  });
});

describe("renderCircleStackPost", () => {
  const { title, markdown: md } = renderCircleStackPost(selection);

  it("título cobre segunda a sexta da semana de conteúdo", () => {
    assert.equal(title, "Radar de Notícias Stack — semana de 12/10 a 16/10");
    assert.equal(circleStackTitle(["261012"]), "Radar de Notícias Stack — semana de 12/10 a 12/10");
  });

  it("sai em Markdown, sem nenhuma tag HTML", () => {
    assert.ok(!/<\/?[a-z][^>]*>/i.test(md));
    assert.doesNotThrow(() => buildStackPostPayload(title, md));
  });

  it("título do destaque literal e abertura default", () => {
    assert.ok(md.includes("### Gemini vira colega com e-mail & agenda"));
    assert.ok(md.includes(DEFAULT_CIRCLE_STACK_OPENING));
  });

  it("'Por que isso importa:' em parágrafo próprio, só quando há why", () => {
    assert.equal((md.match(/Por que isso importa:/g) ?? []).length, 1);
    assert.ok(md.includes("**Por que isso importa:**\n\nPorque sim."));
  });

  it("fonte sem UTM; edição e CTA com UTM stack/circle", () => {
    assert.ok(md.includes("[Leia na fonte](https://cloud.google.com/blog/x)"));
    assert.ok(md.includes(`(${buildCircleStackUrl("https://diar.ia.br/p/gemini", "26w42", "edicao")})`));
    assert.ok(md.includes("utm_content=cta-fim"));
  });

  it("destaque sem edição correspondente sai só com link da fonte", () => {
    assert.ok(!md.includes("Na edição de 99/10"));
  });

  it("nunca usa seta (#9721)", () => {
    assert.ok(!/[→←]/.test(md));
  });

  it("stackNote substitui a descrição no item de lista; seção vazia some", () => {
    assert.ok(md.includes("## Lançamentos e ferramentas\n\n- [Lovable 3](https://ex.com/l): Nota para builders."));
    assert.ok(!md.includes("## Radar"));
  });

  it("stackNote no destaque substitui o por que importa da edição", () => {
    const r = renderCircleStackPost({ ...selection, destaques: [item({ why: "Original.", stackNote: "Para quem constrói." })] });
    assert.ok(r.markdown.includes("Para quem constrói."));
    assert.ok(!r.markdown.includes("Original."));
  });

  it("colchetes no rótulo e parênteses na URL não quebram o link", () => {
    const r = renderCircleStackPost({ ...selection, lancamentos: [item({ title: "Modelo [beta]", url: "https://ex.com/a_(b)", body: "" })] });
    assert.ok(r.markdown.includes("- [Modelo (beta)](https://ex.com/a_%28b%29)"));
  });

  it("subscribeUrl alternativo entra sem UTM adicionada", () => {
    const r = renderCircleStackPost(selection, { subscribeUrl: "https://go.pm3.com.br/x" });
    assert.ok(r.markdown.includes("(https://go.pm3.com.br/x)"));
    assert.ok(!r.markdown.includes("utm_content=cta-fim"));
  });

  it("seleção sem destaques é erro", () => {
    assert.throws(() => renderCircleStackPost({ ...selection, destaques: [] }), /sem destaques/);
  });
});

describe("config", () => {
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
