/**
 * test/brevo-dashboard-link-content-4053.test.ts (#4053)
 *
 * "Links mais clicados" indexava por URL completa (drill-down) ou por origin
 * (agregado, #2263) — nenhuma das duas é "conteúdo". Caso concreto: a
 * enquete "É IA?" tem 2 links por edição (`?...&choice=A` e `?...&choice=B`,
 * mesmo conteúdo, resposta diferente) que caíam em 2 linhas com metade dos
 * cliques cada, afundando o item no ranking.
 *
 * Cobre:
 *  - classifyLinkContent (módulo puro novo, workers/brevo-dashboard/src/link-content.ts)
 *  - parseLinksStats (drill-down por campanha) agrupando por conteúdo
 *  - aggregateLinksAcrossCampaigns (agregado do período) agrupando por conteúdo
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLinkContent,
  normalizeUrlForContent,
} from "../workers/brevo-dashboard/src/link-content.ts";
import {
  parseLinksStats,
  aggregateLinksAcrossCampaigns,
  type BrevoLinksStats,
} from "../workers/brevo-dashboard/src/index.ts";

// ─── classifyLinkContent ──────────────────────────────────────────────────

describe("classifyLinkContent (#4053)", () => {
  test("enquete É IA?: choice=A e choice=B classificam pro MESMO conteúdo, variant distinto", () => {
    const a = classifyLinkContent("https://eia.diar.ia.br/vote?email=x@y.com&edition=260726&choice=A&sig=abc");
    const b = classifyLinkContent("https://eia.diar.ia.br/vote?email=x@y.com&edition=260726&choice=B&sig=abc");
    assert.equal(a.content, "É IA? (voto)");
    assert.equal(b.content, "É IA? (voto)");
    assert.equal(a.content, b.content, "A e B devem cair no mesmo rótulo de conteúdo");
    assert.equal(a.variant, "A");
    assert.equal(b.variant, "B");
  });

  test("enquete É IA?: host legado poll.diaria.workers.dev também classifica (retrocompat)", () => {
    const r = classifyLinkContent("https://poll.diaria.workers.dev/vote?choice=A&edition=260726");
    assert.equal(r.content, "É IA? (voto)");
    assert.equal(r.variant, "A");
  });

  test("Clarice afiliado (?via=diaria) classifica como 'Clarice'", () => {
    const r = classifyLinkContent("https://clarice.ai/precos-planos?via=diaria&utm_source=diaria");
    assert.equal(r.content, "Clarice");
  });

  test("Clarice SEM via=diaria não cai na regra 2 (vira fallback normalizado)", () => {
    const r = classifyLinkContent("https://clarice.ai/precos-planos");
    assert.notEqual(r.content, "Clarice");
  });

  test("superfícies próprias por host: livros, cursos, leaderboard, home", () => {
    assert.equal(classifyLinkContent("https://livros.diar.ia.br/algum-livro").content, "Curadoria de livros");
    assert.equal(classifyLinkContent("https://cursos.diar.ia.br/curso-x").content, "Cursos");
    assert.equal(classifyLinkContent("https://eia.diar.ia.br/leaderboard/2026?brand=clarice").content, "Leaderboard É IA?");
    assert.equal(classifyLinkContent("https://diar.ia.br/").content, "Diar.ia (home)");
    assert.equal(classifyLinkContent("https://diar.ia.br").content, "Diar.ia (home)");
  });

  test("home com path não-raiz NÃO é 'Diar.ia (home)' (cai no fallback normalizado)", () => {
    const r = classifyLinkContent("https://diar.ia.br/edicao/260726");
    assert.notEqual(r.content, "Diar.ia (home)");
  });

  test("fallback: UTM variants da mesma URL colapsam pro mesmo conteúdo normalizado", () => {
    const a = classifyLinkContent("https://openai.com/blog/gpt-5?utm_source=diaria&utm_medium=email");
    const b = classifyLinkContent("https://openai.com/blog/gpt-5?utm_source=newsletter&utm_campaign=x");
    const c = classifyLinkContent("https://openai.com/blog/gpt-5");
    assert.equal(a.content, b.content, "UTMs diferentes, mesmo destino → mesmo conteúdo");
    assert.equal(a.content, c.content, "com/sem UTM, mesmo destino → mesmo conteúdo");
  });

  test("fallback: paths diferentes do mesmo host NÃO colapsam (não é agrupamento por origin)", () => {
    const a = classifyLinkContent("https://techcrunch.com/2026/06/12/ai-funding");
    const b = classifyLinkContent("https://techcrunch.com/2026/06/13/other-story");
    assert.notEqual(a.content, b.content, "artigos diferentes do mesmo domínio são conteúdos diferentes");
  });

  test("fallback: URL malformada não crasha, retorna a própria string como conteúdo", () => {
    assert.doesNotThrow(() => classifyLinkContent("not a url at all"));
    const r = classifyLinkContent("not a url at all");
    assert.equal(r.content, "not a url at all");
    assert.equal(r.variant, undefined);
  });

  test("fallback: rótulo nunca é uma URL crua (sem esquema/query, path vira texto legível)", () => {
    const r = classifyLinkContent("https://openai.com/blog/gpt-5-launch?utm_source=diaria");
    assert.equal(r.content, "gpt 5 launch (openai.com)");
    assert.ok(!/^https?:\/\//.test(r.content), "não deve começar com esquema");
    assert.ok(!r.content.includes("?"), "não deve conter query string");
  });

  test("fallback: URL sem path (home de domínio desconhecido) usa só o host como rótulo", () => {
    const r = classifyLinkContent("https://exemplo-parceiro.com/");
    assert.equal(r.content, "exemplo-parceiro.com");
  });

  test("/vote fora do host do poll não é classificado como enquete", () => {
    const r = classifyLinkContent("https://example.com/vote?choice=A");
    assert.notEqual(r.content, "É IA? (voto)");
  });
});

describe("normalizeUrlForContent (#4053)", () => {
  test("remove utm_* e trailing slash, lowercase host", () => {
    assert.equal(
      normalizeUrlForContent("https://EXAMPLE.com/page/?utm_source=x&utm_medium=y"),
      "https://example.com/page",
    );
  });

  test("preserva query params não-tracking", () => {
    assert.equal(
      normalizeUrlForContent("https://example.com/page?id=42&utm_source=x"),
      "https://example.com/page?id=42",
    );
  });

  test("URL malformada retorna a própria string (sem crash)", () => {
    assert.equal(normalizeUrlForContent("://not-a-url"), "://not-a-url");
  });
});

// ─── parseLinksStats: drill-down por campanha agrupado por conteúdo ───────

describe("parseLinksStats agrupa por conteúdo (#4053)", () => {
  test("É IA? A+B colapsam numa linha só com cliques somados corretamente", () => {
    const linksStats: BrevoLinksStats = {
      "https://eia.diar.ia.br/vote?email=x@y.com&edition=260726&choice=A&sig=1": 30,
      "https://eia.diar.ia.br/vote?email=x@y.com&edition=260726&choice=B&sig=1": 22,
      "https://openai.com/blog/gpt-5": 10,
    };
    const rows = parseLinksStats(linksStats);
    const poll = rows.find((r) => r.content === "É IA? (voto)")!;
    assert.ok(poll, "linha da enquete deve existir");
    assert.equal(poll.clicks, 30 + 22, "cliques de A e B somados");
    assert.equal(poll.variantCount, 2, "2 URLs (A e B) colapsadas");
    assert.ok(poll.variants, "split A/B disponível como detalhe secundário");
    assert.equal(poll.variants!.length, 2);
    const variantA = poll.variants!.find((v) => v.label === "A")!;
    const variantB = poll.variants!.find((v) => v.label === "B")!;
    assert.equal(variantA.clicks, 30);
    assert.equal(variantB.clicks, 22);

    // A enquete some no ranking sem o fix (30 ou 22 cai atrás de outros
    // links maiores); com o fix, 52 > 10 (openai) — deve vir primeiro.
    assert.equal(rows[0].content, "É IA? (voto)", "enquete deve liderar o ranking pós-soma");
  });

  test("UTM variants da mesma URL colapsam numa linha só (fallback normalizado)", () => {
    const linksStats: BrevoLinksStats = {
      "https://openai.com/blog/gpt-5?utm_source=diaria": 15,
      "https://openai.com/blog/gpt-5?utm_source=newsletter": 9,
    };
    const rows = parseLinksStats(linksStats);
    assert.equal(rows.length, 1, "UTM variants devem colapsar numa única linha");
    assert.equal(rows[0].clicks, 15 + 9);
    assert.equal(rows[0].variantCount, 2);
  });

  test("link não-classificado (não bate nenhuma regra especial) cai no fallback sem crashar", () => {
    const linksStats: BrevoLinksStats = {
      "https://random-blog.example/2026/some-post": 7,
    };
    assert.doesNotThrow(() => parseLinksStats(linksStats));
    const rows = parseLinksStats(linksStats);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clicks, 7);
    assert.equal(rows[0].url, "https://random-blog.example/2026/some-post");
  });

  test("ordenação por clicks agregados (pós-agrupamento) é DESC", () => {
    const linksStats: BrevoLinksStats = {
      "https://eia.diar.ia.br/vote?choice=A&edition=1": 5,
      "https://eia.diar.ia.br/vote?choice=B&edition=1": 3,
      "https://anthropic.com/news/claude-4": 20,
      "https://github.com/features/copilot": 1,
    };
    const rows = parseLinksStats(linksStats);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].clicks >= rows[i].clicks, `linha ${i - 1} deve ter clicks >= linha ${i}`);
    }
    assert.equal(rows[0].url, "https://anthropic.com/news/claude-4", "maior clique individual lidera quando > soma da enquete (20 > 8)");
  });
});

// ─── aggregateLinksAcrossCampaigns: agregado do período por conteúdo ─────

describe("aggregateLinksAcrossCampaigns agrupa por conteúdo (#4053)", () => {
  const makeCampaignWithLinks = (id: number, sentDate: string, links: Record<string, number>) => ({
    id,
    name: `Diaria d${id}`,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id] },
    statistics: { globalStats: { sent: 100 } as any, linksStats: links },
  });

  test("É IA? A+B de campanhas diferentes colapsam numa linha só, cliques somados", () => {
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://eia.diar.ia.br/vote?choice=A&edition=260701": 12,
        "https://eia.diar.ia.br/vote?choice=B&edition=260701": 8,
      }),
      makeCampaignWithLinks(2, "2026-07-02T09:00:00Z", {
        "https://eia.diar.ia.br/vote?choice=A&edition=260702": 5,
        "https://eia.diar.ia.br/vote?choice=B&edition=260702": 3,
      }),
    ]);
    const poll = rows.find((r) => r.content === "É IA? (voto)")!;
    assert.ok(poll, "linha da enquete agregada deve existir");
    assert.equal(poll.totalClicks, 12 + 8 + 5 + 3, "soma A+B das 2 campanhas");
  });

  test("campaignCount conta 1× por CAMPANHA por conteúdo, não por variante de URL (#4053, mesma classe de bug que #2263 já evitava a nível de origin)", () => {
    // Uma única campanha com A+B (2 URLs do mesmo conteúdo) deve contar
    // campaignCount=1 pra esse conteúdo — não 2.
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://eia.diar.ia.br/vote?choice=A&edition=260701": 12,
        "https://eia.diar.ia.br/vote?choice=B&edition=260701": 8,
      }),
    ]);
    const poll = rows.find((r) => r.content === "É IA? (voto)")!;
    assert.equal(poll.campaignCount, 1, "1 campanha, mesmo com 2 URLs (A/B) do mesmo conteúdo");
    assert.equal(poll.variantCount, 2, "2 URLs distintas colapsadas");
  });

  test("UTM variants da mesma URL, mesma campanha: campaignCount=1, cliques somados", () => {
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://openai.com/blog/gpt-5?utm_source=a": 4,
        "https://openai.com/blog/gpt-5?utm_source=b": 6,
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalClicks, 10);
    assert.equal(rows[0].campaignCount, 1);
  });

  test("sorting por totalClicks agregado é DESC pós-agrupamento", () => {
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://eia.diar.ia.br/vote?choice=A&edition=1": 2,
        "https://eia.diar.ia.br/vote?choice=B&edition=1": 1,
        "https://anthropic.com/news/claude-4": 50,
      }),
    ]);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].totalClicks >= rows[i].totalClicks);
    }
    assert.equal(rows[0].content, "claude 4 (anthropic.com)");
  });

  test("link não-classificado cai no fallback sem crashar, sem perder o link", () => {
    assert.doesNotThrow(() => {
      aggregateLinksAcrossCampaigns([
        makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
          "https://random-blog.example/story": 3,
        }),
      ]);
    });
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://random-blog.example/story": 3,
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalClicks, 3);
  });

  test("links de sistema continuam filtrados", () => {
    const rows = aggregateLinksAcrossCampaigns([
      makeCampaignWithLinks(1, "2026-07-01T09:00:00Z", {
        "https://r.brevo.com/links/unsubscribe/abc": 40,
        "https://anthropic.com/news/claude-4": 5,
      }),
    ]);
    assert.ok(!rows.some((r) => /unsubscribe/.test(r.url)));
    assert.equal(rows.length, 1);
  });
});
