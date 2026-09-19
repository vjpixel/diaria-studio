import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assemble,
  applyNegativeImpactBackstop,
  applyPlaceholderTitleBackstop,
  applyClusterSourcesBackstop,
  applyExplorationQuotaBackstop,
  editionFromPath,
  type Selection,
  type AllScoredFile,
  type AssembledOutput,
} from "../scripts/assemble-scored.ts";
import type { FinalistLike } from "../scripts/lib/negative-impact-promotion.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AudienceSignals } from "../scripts/lib/audience-affinity.ts";
import {
  emptyExplorationState,
  readExplorationState,
  recordExplorationDecision,
  writeExplorationState,
} from "../scripts/lib/exploration-quota.ts";

const ALL: AllScoredFile = {
  all_scored: [
    { url: "a", score: 90 },
    { url: "b", score: 80 },
    { url: "c", score: 70 },
  ],
};

describe("assemble", () => {
  it("combina seleção + all_scored no contrato tmp-scored", () => {
    const sel: Selection = {
      highlights: [
        { score: 90, bucket: "noticias", reason: "r1", article: { url: "a" } },
        { score: 80, bucket: "pesquisa", reason: "r2", article: { url: "b" } },
      ],
      runners_up: [{ score: 70, article: { url: "c" } }],
    };
    const out = assemble(sel, ALL);
    assert.equal(out.highlights.length, 2);
    assert.equal(out.runners_up.length, 1);
    assert.equal(out.all_scored.length, 3);
    assert.deepEqual(out.all_scored, ALL.all_scored);
  });

  it("re-numera ranks 1..N preservando ordem editorial do array", () => {
    const sel: Selection = {
      highlights: [
        { score: 50, article: { url: "x" } }, // ordem editorial decidida pelo agent
        { score: 99, article: { url: "y" } },
      ],
    };
    const out = assemble(sel, ALL);
    assert.deepEqual(out.highlights.map((h) => h.rank), [1, 2]);
    // ordem do array preservada (não reordena por score)
    assert.deepEqual(out.highlights.map((h) => h.article?.url), ["x", "y"]);
  });

  it("campos ausentes viram arrays vazios", () => {
    const out = assemble({}, {});
    assert.deepEqual(out.highlights, []);
    assert.deepEqual(out.runners_up, []);
    assert.deepEqual(out.all_scored, []);
  });

  it("propaga warning_pool_too_small", () => {
    const out = assemble({ warning_pool_too_small: true }, ALL);
    assert.equal(out.warning_pool_too_small, true);
  });

  it("não inclui warning_pool_too_small quando ausente", () => {
    const out = assemble({ highlights: [] }, ALL);
    assert.ok(!("warning_pool_too_small" in out));
  });

  // #3916/#3918 — promoção de destaque de impacto-negativo
  it("propaga negative_impact_promoted quando presente", () => {
    const sel: Selection = {
      highlights: [{ score: 90, article: { url: "a" } }],
      negative_impact_promoted: {
        promoted_url: "https://x.com/harm",
        demoted_url: "https://y.com/low-score",
        reason: "nenhum dos top-6 tinha negative_impact:true",
      },
    };
    const out = assemble(sel, ALL);
    assert.deepEqual(out.negative_impact_promoted, sel.negative_impact_promoted);
  });

  it("não inclui negative_impact_promoted quando ausente", () => {
    const out = assemble({ highlights: [] }, ALL);
    assert.ok(!("negative_impact_promoted" in out));
  });
});

// #3916/#3918 — backstop determinístico invocado após a seleção do agent
describe("applyNegativeImpactBackstop", () => {
  const finalists: FinalistLike[] = [
    { url: "a", score: 90, bucket: "radar", article: { url: "a" } },
    { url: "harm", score: 60, bucket: "radar", article: { url: "harm", negative_impact: true } },
  ];

  it("no-op quando o assembled já tem ≥1 highlight tagueado", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90, negative_impact: true }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyNegativeImpactBackstop(assembled, finalists);
    assert.equal(out, assembled, "deve retornar a MESMA referência quando não promove (no-op)");
  });

  it("promove e seta negative_impact_promoted quando o agent não cumpriu a regra", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90 }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyNegativeImpactBackstop(assembled, finalists);
    assert.ok(out.negative_impact_promoted, "backstop deve ter promovido");
    assert.equal(out.negative_impact_promoted!.promoted_url, "harm");
    assert.equal(out.highlights[0].url, "harm");
  });

  it("no-op quando nenhum finalista tem a tag (pool sem candidato)", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90 }],
      runners_up: [],
      all_scored: [],
    };
    const noTagFinalists: FinalistLike[] = [{ url: "a", score: 90, article: { url: "a" } }];
    const out = applyNegativeImpactBackstop(assembled, noTagFinalists);
    assert.equal(out, assembled);
    assert.equal(out.negative_impact_promoted, undefined);
  });
});

// #4102 — backstop determinístico: nenhum highlight final pode ter título placeholder
describe("applyPlaceholderTitleBackstop", () => {
  const finalists: FinalistLike[] = [
    { url: "https://yc.com/placeholder-item", score: 119, bucket: "radar", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    { url: "https://real.com/good-article", score: 95, bucket: "radar", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
  ];

  it("no-op quando nenhum highlight tem título placeholder", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "https://real.com/good-article", score: 95, article: { url: "https://real.com/good-article", title: "Um título real e bom" } }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyPlaceholderTitleBackstop(assembled, finalists);
    assert.equal(out, assembled, "deve retornar a MESMA referência quando não demove (no-op)");
    assert.equal(out.placeholder_title_demoted, undefined);
  });

  it("CASO REAL 260727: highlight com título '(newsletter:...)' e score 119 (o mais alto do pool) é substituído", () => {
    const assembled: AssembledOutput = {
      highlights: [
        {
          rank: 1,
          url: "https://yc.com/placeholder-item",
          score: 119,
          article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' },
        },
      ],
      runners_up: [],
      all_scored: [],
    };
    const out = applyPlaceholderTitleBackstop(assembled, finalists);
    assert.ok(out.placeholder_title_demoted, "backstop deve ter demovido");
    assert.equal(out.placeholder_title_demoted!.length, 1);
    assert.equal(out.placeholder_title_demoted![0].demoted_url, "https://yc.com/placeholder-item");
    assert.equal(out.placeholder_title_demoted![0].promoted_url, "https://real.com/good-article");
    assert.equal(out.highlights[0].url, "https://real.com/good-article");
  });

  it("roda DEPOIS do negative-impact backstop no fluxo main() — última palavra, mesmo se o outro backstop reintroduzir o ofensor", () => {
    // Cenário adversarial: o candidato de MAIOR score do pool é SIMULTANEAMENTE
    // o único highlight com título placeholder E o único finalista fora dos
    // highlights com negative_impact:true e MAIOR score entre os tagueados.
    // Se rodássemos placeholder-backstop ANTES, o negative-impact backstop
    // (que não sabe filtrar por título) reintroduziria o mesmo ofensor —
    // exatamente o bug que a ordem "negative-impact primeiro, placeholder por
    // último" evita: o placeholder backstop tem a palavra final.
    const finalistsWithNegImpact: FinalistLike[] = [
      { url: "https://yc.com/placeholder-item", score: 119, bucket: "radar", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")', negative_impact: true } },
      { url: "https://real.com/good-article", score: 95, bucket: "radar", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
    ];
    let assembled: AssembledOutput = {
      highlights: [
        { rank: 1, url: "https://yc.com/placeholder-item", score: 119, article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")', negative_impact: true } },
      ],
      runners_up: [],
      all_scored: [],
    };
    // 1) negative-impact backstop primeiro: highlights já tem 1 tagueado → no-op.
    assembled = applyNegativeImpactBackstop(assembled, finalistsWithNegImpact);
    assert.equal(assembled.highlights[0].url, "https://yc.com/placeholder-item", "no-op esperado (já satisfaz a regra)");
    // 2) placeholder backstop por último: título placeholder NUNCA sobrevive,
    //    mesmo que isso derrube a regra de negative-impact (warning-only, #3916/#3918).
    assembled = applyPlaceholderTitleBackstop(assembled, finalistsWithNegImpact);
    assert.equal(assembled.highlights[0].url, "https://real.com/good-article");
    assert.ok(
      !isPlaceholderTitleOf(assembled.highlights[0]),
      "nenhum highlight final pode ter título placeholder, mesmo custando a regra de negative-impact",
    );
  });
});

function isPlaceholderTitleOf(h: { article?: { title?: string } }): boolean {
  const t = (h.article?.title ?? "").trim();
  return t === "" || /^\((?:inbox|no title|sem t[ií]tulo|newsletter:.*)\)$/i.test(t);
}

// #4838 — backstop determinístico: cluster_sources[] do highlight final tem
// que bater com o cluster_sources[] que o dedup atribuiu no finalist.
describe("applyClusterSourcesBackstop", () => {
  const clusterSources = [
    { url: "https://theverge.com/x", title: "Cobertura The Verge", source: "The Verge" },
    { url: "https://techcrunch.com/x", title: "Cobertura TechCrunch", source: "TechCrunch" },
  ];
  const finalists: FinalistLike[] = [
    { url: "a", score: 90, bucket: "radar", article: { url: "a", title: "Destaque com cluster", cluster_sources: clusterSources } },
    { url: "b", score: 80, bucket: "radar", article: { url: "b", title: "Destaque de fonte única" } },
  ];

  it("no-op quando o highlight já preserva cluster_sources intacto", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90, article: { url: "a", title: "Destaque com cluster", cluster_sources: clusterSources } }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyClusterSourcesBackstop(assembled, finalists);
    assert.equal(out, assembled, "deve retornar a MESMA referência quando não restaura (no-op)");
    assert.equal(out.cluster_sources_restored, undefined);
  });

  it("no-op quando o finalist não tem cluster (destaque de fonte única, comportamento idêntico ao de hoje)", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "b", score: 80, article: { url: "b", title: "Destaque de fonte única" } }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyClusterSourcesBackstop(assembled, finalists);
    assert.equal(out, assembled);
  });

  it("CASO REAL (#4838): scorer-select copiou o article mas 'esqueceu' cluster_sources — backstop restaura", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90, article: { url: "a", title: "Destaque com cluster" } }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyClusterSourcesBackstop(assembled, finalists);
    assert.ok(out.cluster_sources_restored, "backstop deve ter restaurado");
    assert.equal(out.cluster_sources_restored!.length, 1);
    assert.equal(out.cluster_sources_restored![0].url, "a");
    assert.equal(out.cluster_sources_restored![0].restored_count, 2);
    assert.deepEqual(out.highlights[0].article?.cluster_sources, clusterSources);
  });
});

// ─── #8370 Peça 2: cota semanal de exploração ──────────────────────────────

describe("applyExplorationQuotaBackstop (#8370 Peça 2)", () => {
  /**
   * Sinais de audiência fabricados: a categoria "Treinamento" tem CTR
   * relativo alto, então um item que a menciona sai endógeno (affinity acima
   * do teto) e um que não menciona nada conhecido sai exógeno.
   */
  const signals: AudienceSignals = {
    ctrByCategory: new Map([["Treinamento", 6.0]]),
    avgCtr: 0.01,
    surveyTools: new Set(["chatgpt"]),
    source: "ctr+survey",
    loaded: true,
  };

  function assembledFixture(): AssembledOutput {
    return {
      highlights: [
        { rank: 1, score: 95, url: "https://a", article: { url: "https://a", title: "Treinamento com ChatGPT" } },
        { rank: 2, score: 90, url: "https://b", article: { url: "https://b", title: "Treinamento novo" } },
        { rank: 3, score: 85, url: "https://c", article: { url: "https://c", title: "Treinamento de times" } },
      ],
      runners_up: [],
      all_scored: [],
    };
  }

  const exogenousFinalists: FinalistLike[] = [
    {
      url: "https://exogeno",
      score: 80,
      bucket: "noticias",
      article: { url: "https://exogeno", title: "Anatel abre consulta sobre uso de IA" },
    },
  ];

  function withTmpDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(resolve(tmpdir(), "assemble-exploration-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("marca exploracao:true no highlight e registra a decisão da semana", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const out = applyExplorationQuotaBackstop(assembledFixture(), exogenousFinalists, "260919", {
        signals,
        statePath,
        log: () => {},
      });

      assert.ok(out.exploracao_promoted, "esperava promoção de exploração");
      assert.equal(out.exploracao_promoted!.promoted_url, "https://exogeno");
      assert.equal(out.exploracao_promoted!.week, "2026-W38");
      // O campo chega ao highlight — é ele que a Peça 3 mede.
      const marked = out.highlights.filter((h) => h.exploracao === true);
      assert.equal(marked.length, 1);
      assert.equal(marked[0].article?.url, "https://exogeno");
      // D1 intacto: a cota nunca derruba o melhor candidato do dia.
      assert.equal(out.highlights[0].article?.url, "https://a");

      const state = readExplorationState(statePath).state;
      assert.equal(state.editions["260919"].exploracao, true);
      assert.equal(state.editions["260919"].week, "2026-W38");
    });
  });

  it("não estoura a cota: com a semana cheia, a edição sai sem exploração", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      let state = emptyExplorationState();
      for (const edition of ["260914", "260915", "260916", "260917"]) {
        state = recordExplorationDecision(state, edition, {
          week: "2026-W38",
          exploracao: true,
          decided_at: "2026-09-17T00:00:00.000Z",
        });
      }
      writeExplorationState(statePath, state);

      const out = applyExplorationQuotaBackstop(assembledFixture(), exogenousFinalists, "260919", {
        signals,
        statePath,
        log: () => {},
      });

      assert.equal(out.exploracao_promoted, undefined);
      assert.equal(out.highlights.filter((h) => h.exploracao === true).length, 0);
      // A edição é registrada como sem exploração — "medido e deu zero".
      assert.equal(readExplorationState(statePath).state.editions["260919"].exploracao, false);
    });
  });

  it("sem sinais de audiência (sem data/) não marca nem registra nada", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const out = applyExplorationQuotaBackstop(assembledFixture(), exogenousFinalists, "260919", {
        signals: { ctrByCategory: new Map(), avgCtr: 0, surveyTools: new Set(), source: "none", loaded: false },
        statePath,
        log: () => {},
      });
      assert.equal(out.exploracao_promoted, undefined);
      assert.deepEqual(readExplorationState(statePath).state, emptyExplorationState());
    });
  });

  it("edição inválida é pulada com aviso, sem tocar no estado", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const logs: string[] = [];
      const out = applyExplorationQuotaBackstop(assembledFixture(), exogenousFinalists, "nao-e-data", {
        signals,
        statePath,
        log: (m) => logs.push(m),
      });
      assert.equal(out.exploracao_promoted, undefined);
      assert.match(logs.join("\n"), /não é um AAMMDD válido/);
      assert.deepEqual(readExplorationState(statePath).state, emptyExplorationState());
    });
  });

  it("título placeholder (#4102) não vira exploração — wiring real de isPlaceholderHighlightTitle", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const placeholder: FinalistLike[] = [
        {
          url: "https://exogeno",
          score: 80,
          bucket: "noticias",
          article: { url: "https://exogeno", title: '(newsletter:"Lenny\'s Newsletter")' },
        },
      ];
      const out = applyExplorationQuotaBackstop(assembledFixture(), placeholder, "260919", {
        signals,
        statePath,
        log: () => {},
      });
      assert.equal(out.exploracao_promoted, undefined);
      assert.equal(readExplorationState(statePath).state.editions["260919"].exploracao, false);
    });
  });

  it("estado corrompido não vira cota zerada: pula a edição e NÃO regrava o arquivo", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      writeFileSync(statePath, "{ arquivo pela metade", "utf8");
      const logs: string[] = [];
      const out = applyExplorationQuotaBackstop(assembledFixture(), exogenousFinalists, "260919", {
        signals,
        statePath,
        log: (m) => logs.push(m),
      });
      assert.equal(out.exploracao_promoted, undefined);
      assert.match(logs.join("\n"), /contador semanal está perdido/);
      // Arquivo intocado — regravar apagaria o registro das outras edições.
      assert.equal(readFileSync(statePath, "utf8"), "{ arquivo pela metade");
    });
  });

  it("marca do scorer-select não debitada é limpa do output (nunca exploração fantasma)", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const marked = assembledFixture();
      marked.highlights[1] = { ...marked.highlights[1], exploracao: true };
      const out = applyExplorationQuotaBackstop(marked, [], "260919", {
        signals: { ctrByCategory: new Map(), avgCtr: 0, surveyTools: new Set(), source: "none", loaded: false },
        statePath,
        log: () => {},
      });
      assert.equal(out.highlights.filter((h) => h.exploracao === true).length, 0);
    });
  });

  it("editionFromPath deriva o AAMMDD do --out, e devolve null fora da convenção", () => {
    assert.equal(editionFromPath("data/editions/260919/_internal/tmp-scored.json"), "260919");
    assert.equal(editionFromPath("/tmp/qualquer/tmp-scored.json"), null);
  });
});
