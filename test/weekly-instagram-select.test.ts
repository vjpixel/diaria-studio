/**
 * weekly-instagram-select.test.ts (#4483)
 *
 * Cobre a seleção por clique do post semanal do Instagram, sucessora de
 * `selectWeeklyD1` (#4101): fixture sintética cobrindo
 *   - item fora do D1 (D2) vencendo por taxa de clique;
 *   - filtro de exclusão (Divulgação/afiliados/propriedade própria)
 *     removendo um candidato de taxa mais alta;
 *   - desempate editorial quando a diferença entre candidatos é menor que o
 *     valor de 1 clique.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractInstagramCandidates,
  matchPostsToWindow,
  identifyInstagramPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  toRankedCandidate,
  selectInstagramWeekly,
  dedupeCandidatesByUrl,
  isCommercialOrOwnLink,
  hasSuspiciousCommercialLanguage,
  withinClickNoise,
  type BeehiivCachePost,
  type InstagramRankedCandidate,
} from "../scripts/lib/weekly-instagram-select.ts";

function makeReviewedMd(destaques: { n: 1 | 2 | 3; title: string; url: string; category?: string }[]): string {
  return destaques
    .map(
      (d) =>
        `DESTAQUE ${d.n} | ${d.category ?? "Notícias"}\n${d.title}\n${d.url}\n\nCorpo do destaque.\n\nPor que isso importa:\nExplicação.`,
    )
    .join("\n\n---\n\n");
}

function epochFor(aammdd: string): number {
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return Math.floor(new Date(2000 + yy, mm - 1, dd, 8, 0, 0).getTime() / 1000);
}

describe("extractInstagramCandidates", () => {
  it("extrai só destaques com URL — D1/D2/D3, todos elegíveis (nunca só D1)", () => {
    const md = makeReviewedMd([
      { n: 1, title: "Título D1", url: "https://exemplo.com/d1" },
      { n: 2, title: "Título D2", url: "https://exemplo.com/d2" },
      { n: 3, title: "Título D3", url: "https://exemplo.com/d3" },
    ]);
    const candidates = extractInstagramCandidates(md, "260727");
    assert.equal(candidates.length, 3);
    assert.deepEqual(
      candidates.map((c) => c.destaqueNumber),
      [1, 2, 3],
    );
    assert.ok(candidates.every((c) => c.editionDate === "260727"));
    assert.ok(candidates.every((c) => c.kind === "destaque"));
  });

  it("pula destaque sem URL, sem lançar", () => {
    const md = "DESTAQUE 1 | Notícias\nTítulo sem URL\n\nCorpo sem link.";
    assert.deepEqual(extractInstagramCandidates(md, "260727"), []);
  });

  it("extrai itens de RADAR além dos destaques (#4513 — card 4:5 gerado sob demanda quando vencem o ranking)", () => {
    const md = [
      "DESTAQUE 1 | Notícias",
      "Título D1",
      "https://exemplo.com/d1",
      "",
      "Corpo do D1.",
      "",
      "Por que isso importa:",
      "Explicação D1.",
      "",
      "---",
      "",
      "**RADAR**",
      "",
      "**[Item de Radar bem clicado](https://exemplo.com/radar-item)**",
      "Descrição do item de radar.",
      "",
    ].join("\n");
    const candidates = extractInstagramCandidates(md, "260727");
    assert.equal(candidates.length, 2, "destaque + item de radar");

    const destaque = candidates.find((c) => c.url === "https://exemplo.com/d1")!;
    assert.equal(destaque.kind, "destaque");
    assert.equal(destaque.destaqueNumber, 1);
    assert.equal(destaque.section, undefined);

    const radar = candidates.find((c) => c.url === "https://exemplo.com/radar-item")!;
    assert.ok(radar, "item de RADAR deveria ser extraído");
    assert.equal(radar.kind, "section");
    assert.equal(radar.section, "radar");
    assert.equal(radar.destaqueNumber, undefined, "item de seção nunca tem destaqueNumber — resolve card sob demanda");
    assert.equal(radar.title, "Item de Radar bem clicado");
    assert.match(radar.body, /Descrição do item de radar/);
  });

  it("NUNCA extrai itens de USE MELHOR (#5319, 260814 — decisão do editor: post semanal é sobre notícia clicada, não tutorial/ferramenta; regra permanente, superscede a inclusão do #4513)", () => {
    const md = [
      "DESTAQUE 1 | Notícias",
      "Título D1",
      "https://exemplo.com/d1",
      "",
      "Corpo do D1.",
      "",
      "Por que isso importa:",
      "Explicação D1.",
      "",
      "---",
      "",
      "**USE MELHOR**",
      "",
      "**[Tutorial de Use Melhor](https://exemplo.com/use-melhor-item)**",
      "Descrição do tutorial.",
      "",
    ].join("\n");
    const candidates = extractInstagramCandidates(md, "260727");
    assert.equal(candidates.length, 1, "só o destaque — USE MELHOR nunca compete no Instagram");
    assert.ok(!candidates.some((c) => c.url === "https://exemplo.com/use-melhor-item"));
  });

  it("NUNCA extrai itens de LANÇAMENTOS/VÍDEOS (fora do escopo do #4513 — só RADAR compete além de destaques, USE MELHOR excluído pelo #5319)", () => {
    const md = [
      "DESTAQUE 1 | Notícias",
      "Título D1",
      "https://exemplo.com/d1",
      "",
      "Corpo do D1.",
      "",
      "Por que isso importa:",
      "Explicação D1.",
      "",
      "---",
      "",
      "**LANÇAMENTOS**",
      "",
      "**[Lançamento X](https://exemplo.com/lancamento-x)**",
      "Descrição do lançamento.",
      "",
      "---",
      "",
      "**VÍDEOS**",
      "",
      "**[Vídeo Y](https://exemplo.com/video-y)**",
      "Descrição do vídeo.",
      "",
    ].join("\n");
    const candidates = extractInstagramCandidates(md, "260727");
    assert.equal(candidates.length, 1, "só o destaque — LANÇAMENTOS/VÍDEOS nunca competem no Instagram");
    assert.ok(!candidates.some((c) => c.url === "https://exemplo.com/lancamento-x" || c.url === "https://exemplo.com/video-y"));
  });
});

describe("dedupeCandidatesByUrl (#4513)", () => {
  function rankedForDedup(
    overrides: Partial<InstagramRankedCandidate> & Pick<InstagramRankedCandidate, "title" | "url" | "editionDate" | "kind">,
  ): InstagramRankedCandidate {
    return {
      body: "",
      why: "",
      category: "NOTÍCIAS",
      uniqueVerifiedClicks: 0,
      webUniqueClicks: 0,
      opens: 100,
      ratePct: 0,
      excluded: false,
      hasClickData: true,
      ...overrides,
    };
  }

  it("mesma URL como destaque E como item de seção — prioriza kind:destaque (corpo completo)", () => {
    const candidates: InstagramRankedCandidate[] = [
      rankedForDedup({ title: "Versão de seção", url: "https://exemplo.com/x", editionDate: "260727", kind: "section", section: "radar" }),
      rankedForDedup({ title: "Versão de destaque", url: "https://exemplo.com/x", editionDate: "260727", kind: "destaque", destaqueNumber: 1 }),
    ];
    const result = dedupeCandidatesByUrl(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Versão de destaque");
    assert.equal(result[0].kind, "destaque");
  });
});

describe("isCommercialOrOwnLink", () => {
  it("exclui afiliados, propriedade própria e domínio nu", () => {
    assert.equal(isCommercialOrOwnLink("https://www.amazon.com.br/produto"), true);
    assert.equal(isCommercialOrOwnLink("https://cursos.diar.ia.br/curso-x"), true);
    assert.equal(isCommercialOrOwnLink("https://apoia.se/diaria"), true);
    assert.equal(isCommercialOrOwnLink("https://diar.ia.br"), true);
    assert.equal(isCommercialOrOwnLink("https://exemplo.com/materia-normal"), false);
  });
});

describe("hasSuspiciousCommercialLanguage", () => {
  it("sinaliza vocabulário de parceria/patrocínio sem bloquear", () => {
    assert.equal(hasSuspiciousCommercialLanguage("Cupom especial em parceria com fornecedor"), true);
    assert.equal(hasSuspiciousCommercialLanguage("Notícia normal sobre modelo de IA"), false);
  });
});

function rankedFixture(
  overrides: Partial<InstagramRankedCandidate> & Pick<InstagramRankedCandidate, "title" | "url" | "editionDate" | "destaqueNumber">,
): InstagramRankedCandidate {
  return {
    body: "",
    why: "",
    category: "NOTÍCIAS",
    kind: "destaque",
    uniqueVerifiedClicks: 0,
    webUniqueClicks: 0,
    opens: 100,
    ratePct: 0,
    excluded: false,
    hasClickData: true,
    ...overrides,
  };
}

describe("selectInstagramWeekly — item fora do D1 vencendo por clique", () => {
  it("D2 com taxa maior vence D1 da mesma edição (issue #4483: 'de qualquer posição — D1, D2, D3')", () => {
    const candidates: InstagramRankedCandidate[] = [
      rankedFixture({ title: "D1 pouco clicado", url: "https://exemplo.com/d1", editionDate: "260727", destaqueNumber: 1, opens: 179, ratePct: 2.23 }),
      rankedFixture({ title: "D2 muito clicado", url: "https://exemplo.com/d2", editionDate: "260727", destaqueNumber: 2, opens: 179, ratePct: 2.79 }),
    ];
    const result = selectInstagramWeekly(candidates, 5);
    assert.equal(result.selected[0].title, "D2 muito clicado");
    assert.equal(result.selected[1].title, "D1 pouco clicado");
  });
});

describe("selectInstagramWeekly — filtro de exclusão comercial/própria", () => {
  it("candidato comercial/próprio de taxa MAIS ALTA é excluído — não vence só por causa disso", () => {
    const candidates: InstagramRankedCandidate[] = [
      rankedFixture({ title: "Divulgação parceira", url: "https://cursos.diar.ia.br/x", editionDate: "260727", destaqueNumber: 1, opens: 100, ratePct: 6.0, excluded: true }),
      rankedFixture({ title: "Matéria editorial normal", url: "https://exemplo.com/materia", editionDate: "260727", destaqueNumber: 2, opens: 100, ratePct: 3.0, excluded: false }),
    ];
    const result = selectInstagramWeekly(candidates, 5);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].title, "Matéria editorial normal");
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].title, "Divulgação parceira");
  });
});

describe("selectInstagramWeekly — desempate editorial dentro do ruído de 1 clique", () => {
  it("diferença menor que 1 clique não desempata por número — ângulo Brasil vence", () => {
    // opens=100 → 1 clique = 1 ponto percentual. Diferença de 0.5pp está dentro do ruído.
    const candidates: InstagramRankedCandidate[] = [
      rankedFixture({
        title: "Guardian cobre IA no mundo",
        url: "https://exemplo.com/guardian",
        editionDate: "260713",
        destaqueNumber: 1,
        opens: 100,
        ratePct: 3.0,
        category: "NOTÍCIAS",
      }),
      rankedFixture({
        title: "Itaú lança ferramenta de IA no Brasil",
        url: "https://exemplo.com/itau",
        editionDate: "260728",
        destaqueNumber: 1,
        opens: 100,
        ratePct: 3.5,
        category: "MERCADO",
      }),
    ];
    assert.equal(withinClickNoise(candidates[0], candidates[1]), true, "assunção do teste: diferença deveria estar dentro do ruído");
    const result = selectInstagramWeekly(candidates, 5);
    assert.equal(result.selected[0].title, "Itaú lança ferramenta de IA no Brasil", "ângulo Brasil deveria vencer o desempate, não a taxa numericamente maior por si só");
    assert.ok(result.warnings.some((w) => /Empate por clique/.test(w)));
  });
});

describe("selectInstagramWeekly — limite de itens e insuficiência", () => {
  it("respeita maxItems mesmo com mais candidatos elegíveis disponíveis", () => {
    const candidates: InstagramRankedCandidate[] = Array.from({ length: 7 }, (_, i) =>
      rankedFixture({ title: `Matéria ${i}`, url: `https://exemplo.com/m${i}`, editionDate: "260727", destaqueNumber: ((i % 3) + 1) as 1 | 2 | 3, opens: 100, ratePct: 7 - i }),
    );
    const result = selectInstagramWeekly(candidates, 5);
    assert.equal(result.selected.length, 5);
    assert.equal(result.selected[0].title, "Matéria 0");
  });

  it("warning quando o pool elegível é menor que maxItems", () => {
    const candidates: InstagramRankedCandidate[] = [
      rankedFixture({ title: "Única matéria", url: "https://exemplo.com/unica", editionDate: "260727", destaqueNumber: 1, opens: 100, ratePct: 1.0 }),
    ];
    const result = selectInstagramWeekly(candidates, 5);
    assert.equal(result.selected.length, 1);
    assert.ok(result.warnings.some((w) => /1\/5 candidatos elegíveis/.test(w)));
  });
});

describe("cache de cliques Beehiiv — matchPostsToWindow / clickCountsForUrl / uniqueOpensOf", () => {
  const posts: BeehiivCachePost[] = [
    {
      id: "post_1",
      title: "Edição 260727",
      status: "confirmed",
      publish_date: epochFor("260727"),
      stats: {
        email: { clicks: 10, unique_opens: 179 },
        clicks: [
          { url: "https://exemplo.com/d1", base_url: "https://exemplo.com/d1", email: { unique_verified_clicks: 4 }, web: { total_unique_clicked: 0 } },
          { url: "https://exemplo.com/d2", base_url: "https://exemplo.com/d2", email: { unique_verified_clicks: 5 }, web: { total_unique_clicked: 1 } },
        ],
      },
    },
    // post NÃO confirmado — nunca entra na janela.
    { id: "post_2", status: "draft", publish_date: epochFor("260728"), stats: {} },
  ];

  it("matchPostsToWindow só inclui posts confirmed dentro da janela", () => {
    const windowPosts = matchPostsToWindow(posts, ["260727", "260728", "260729"]);
    assert.equal(windowPosts.size, 1);
    assert.ok(windowPosts.has("260727"));
    assert.ok(!windowPosts.has("260728"));
  });

  it("clickCountsForUrl soma email verificado + web por URL normalizada", () => {
    const post = matchPostsToWindow(posts, ["260727"]).get("260727");
    const counts = clickCountsForUrl("https://exemplo.com/d2", post?.stats?.clicks);
    assert.equal(counts.uniqueVerifiedClicks, 5);
    assert.equal(counts.webUniqueClicks, 1);
  });

  it("uniqueOpensOf lê unique_opens do post; 0 quando ausente", () => {
    const post = matchPostsToWindow(posts, ["260727"]).get("260727");
    assert.equal(uniqueOpensOf(post), 179);
    assert.equal(uniqueOpensOf(undefined), 0);
  });

  it("identifyInstagramPostsNeedingClicks sinaliza post com email.clicks>0 mas stats.clicks vazio", () => {
    const windowPosts = new Map<string, BeehiivCachePost>([
      ["260727", { id: "post_x", title: "X", status: "confirmed", publish_date: epochFor("260727"), stats: { email: { clicks: 5, unique_opens: 100 }, clicks: [] } }],
    ]);
    const manifest = identifyInstagramPostsNeedingClicks(windowPosts);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, "post_x");
  });
});

describe("toRankedCandidate", () => {
  it("computa ratePct = (verified+web)/opens*100, marca excluded via isCommercialOrOwnLink", () => {
    const raw = { editionDate: "260727", url: "https://exemplo.com/materia", title: "T", body: "", why: "", destaqueNumber: 1 as const, category: "NOTÍCIAS", kind: "destaque" as const };
    const ranked = toRankedCandidate(raw, { uniqueVerifiedClicks: 4, webUniqueClicks: 1 }, 100, true);
    assert.equal(ranked.ratePct, 5);
    assert.equal(ranked.excluded, false);

    const rawOwn = { ...raw, url: "https://apoia.se/diaria" };
    const rankedOwn = toRankedCandidate(rawOwn, { uniqueVerifiedClicks: 10, webUniqueClicks: 0 }, 100, true);
    assert.equal(rankedOwn.excluded, true);
  });

  it("ratePct é 0 quando opens é 0 (nunca divide por zero)", () => {
    const raw = { editionDate: "260727", url: "https://exemplo.com/materia", title: "T", body: "", why: "", destaqueNumber: 1 as const, category: "NOTÍCIAS", kind: "destaque" as const };
    const ranked = toRankedCandidate(raw, { uniqueVerifiedClicks: 4, webUniqueClicks: 0 }, 0, true);
    assert.equal(ranked.ratePct, 0);
  });
});
