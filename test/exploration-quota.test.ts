/**
 * test/exploration-quota.test.ts (#8370, Peça 2)
 *
 * Cobre os 3 invariantes que a issue exige da cota de exploração:
 *   1. a cota SEMANAL é respeitada (nunca estoura N);
 *   2. item com `affinity < 0.1` e score-base competitivo é elegível;
 *   3. o campo `exploracao: true` chega ao output no formato que
 *      `measure-editorial-concentration.ts` (Peça 3) lê.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  applyExplorationQuota,
  countWeekUsage,
  editionIdToIsoDate,
  emptyExplorationState,
  explorationFlagsBySlug,
  explorationWeekOfEdition,
  isoWeekKey,
  readExplorationState,
  recordExplorationDecision,
  resolveExplorationConfig,
  writeExplorationState,
  EXPLORATION_CONFIG_DEFAULTS,
  EXPLORATION_DEFAULT_SLOTS_PER_WEEK,
  type ExplorationFinalistLike,
  type ExplorationHighlightLike,
  type ExplorationState,
} from "../scripts/lib/exploration-quota.ts";
import { aggregateByMonth, type PageSignal } from "../scripts/lib/editorial-concentration.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** 3 destaques endógenos (afinidade alta) — nenhum é exploração por si. */
function baseHighlights(): ExplorationHighlightLike[] {
  return [
    { score: 95, bucket: "lancamento", article: { url: "https://a", title: "A" } },
    { score: 88, bucket: "noticias", article: { url: "https://b", title: "B" } },
    { score: 84, bucket: "radar", article: { url: "https://c", title: "C" } },
  ];
}

const AFFINITY: Record<string, number> = {
  "https://a": 0.6,
  "https://b": 0.4,
  "https://c": 0.35,
  "https://exogeno": 0.02, // nunca exibido: CTR indefinido, afinidade ~0
  "https://exogeno-fraco": 0.01,
  "https://endogeno-pool": 0.5,
  "https://exogeno-use-melhor": 0.0,
  "https://exogeno-placeholder": 0.0,
};

const affinityOf = (item: { url?: string; article?: { url?: string } | undefined }): number | null => {
  const url = item.url ?? item.article?.url ?? "";
  return url in AFFINITY ? AFFINITY[url] : null;
};

function finalist(url: string, score: number, bucket = "noticias", title = "T"): ExplorationFinalistLike {
  return { url, score, bucket, article: { url, title } };
}

const BASE_OPTS = {
  config: EXPLORATION_CONFIG_DEFAULTS,
  week: "2026-W38",
  weekUsageBefore: 0,
  affinityOf,
};

// ─── Datas / semana ────────────────────────────────────────────────────────

describe("chave de semana", () => {
  it("converte AAMMDD em data ISO e rejeita lixo", () => {
    assert.equal(editionIdToIsoDate("260919"), "2026-09-19");
    assert.equal(editionIdToIsoDate("26091"), null);
    assert.equal(editionIdToIsoDate("261399"), null);
  });

  it("agrupa a semana pela segunda-feira (ISO-8601)", () => {
    // 2026-09-14 (seg) .. 2026-09-20 (dom) são a mesma semana ISO.
    assert.equal(isoWeekKey("2026-09-14"), isoWeekKey("2026-09-20"));
    // 2026-09-21 (seg seguinte) já é outra.
    assert.notEqual(isoWeekKey("2026-09-20"), isoWeekKey("2026-09-21"));
    assert.equal(explorationWeekOfEdition("260919"), isoWeekKey("2026-09-19"));
  });

  it("vira o ano ISO corretamente no fim de dezembro", () => {
    // 2026-12-31 é quinta — pertence à semana 53 de 2026.
    assert.equal(isoWeekKey("2026-12-31"), "2026-W53");
    // 2027-01-01 é sexta da MESMA semana ISO.
    assert.equal(isoWeekKey("2027-01-01"), "2026-W53");
  });
});

// ─── Elegibilidade ─────────────────────────────────────────────────────────

describe("elegibilidade de exploração", () => {
  it("promove item com affinity < 0.1 e score-base competitivo (invariante 2 da #8370)", () => {
    const highlights = baseHighlights();
    const finalists = [finalist("https://exogeno", 80)]; // 84 - 80 = 4 pts < gap 8
    const result = applyExplorationQuota(highlights, finalists, BASE_OPTS);

    assert.ok(result.promotion, `esperava promoção, veio: ${result.skipped}`);
    assert.equal(result.promotion?.promoted_url, "https://exogeno");
    assert.equal(result.promotion?.origin, "promoted");
    // Trocou o destaque mais fraco (C, 84), nunca o D1.
    assert.equal(result.promotion?.demoted_url, "https://c");
    assert.equal(result.highlights[0].article?.url, "https://a");
    assert.equal(result.highlights[2].exploracao, true);
  });

  it("não promove candidato exógeno fora da faixa competitiva", () => {
    const finalists = [finalist("https://exogeno", 40)]; // 84 - 40 = 44 pts >> gap
    const result = applyExplorationQuota(baseHighlights(), finalists, BASE_OPTS);
    assert.equal(result.promotion, undefined);
    assert.match(result.skipped ?? "", /nenhum finalista exógeno/);
  });

  it("não promove candidato competitivo mas endógeno", () => {
    const finalists = [finalist("https://endogeno-pool", 90)];
    const result = applyExplorationQuota(baseHighlights(), finalists, BASE_OPTS);
    assert.equal(result.promotion, undefined);
  });

  it("nunca promove use_melhor a destaque (#3436), mesmo exógeno e competitivo", () => {
    const finalists = [finalist("https://exogeno-use-melhor", 90, "use_melhor")];
    const result = applyExplorationQuota(baseHighlights(), finalists, BASE_OPTS);
    assert.equal(result.promotion, undefined);
  });

  it("respeita o filtro extra do caller (título placeholder, #4102)", () => {
    const finalists = [finalist("https://exogeno-placeholder", 90, "noticias", "(inbox)")];
    const result = applyExplorationQuota(baseHighlights(), finalists, {
      ...BASE_OPTS,
      isEligibleCandidate: (f) => f.article?.title !== "(inbox)",
    });
    assert.equal(result.promotion, undefined);
  });

  it("sem sinal de afinidade (sem data/) vira no-op — nunca inventa exploração", () => {
    const finalists = [finalist("https://sem-sinal", 90)];
    const result = applyExplorationQuota(baseHighlights(), finalists, {
      ...BASE_OPTS,
      affinityOf: () => null,
    });
    assert.equal(result.promotion, undefined);
    assert.deepEqual(result.highlights, baseHighlights());
  });

  it("marca sem trocar quando o pool já entregou exploração por mérito", () => {
    const highlights = baseHighlights();
    highlights[2] = { score: 84, bucket: "radar", article: { url: "https://exogeno", title: "E" } };
    const result = applyExplorationQuota(highlights, [finalist("https://exogeno-fraco", 83)], BASE_OPTS);
    assert.equal(result.promotion?.origin, "already-selected");
    assert.equal(result.promotion?.demoted_url, undefined);
    assert.equal(result.highlights[2].exploracao, true);
  });

  it("só olha os 3 primeiros slots — exploração no 5º não conta como cota cumprida", () => {
    const highlights = [
      ...baseHighlights(),
      { score: 70, bucket: "radar", article: { url: "https://exogeno-fraco", title: "F" } },
    ];
    const result = applyExplorationQuota(highlights, [finalist("https://exogeno", 80)], BASE_OPTS);
    assert.equal(result.promotion?.origin, "promoted");
    assert.equal(result.promotion?.promoted_url, "https://exogeno");
  });
});

// ─── Cota semanal ──────────────────────────────────────────────────────────

describe("cota semanal", () => {
  it("N default é a decisão do editor (#8370: 3-4/semana)", () => {
    assert.equal(EXPLORATION_DEFAULT_SLOTS_PER_WEEK, 4);
    assert.ok(EXPLORATION_DEFAULT_SLOTS_PER_WEEK >= 3 && EXPLORATION_DEFAULT_SLOTS_PER_WEEK <= 4);
  });

  it("não estoura N: no slot N+1 da semana a cota vira no-op (invariante 1 da #8370)", () => {
    const finalists = [finalist("https://exogeno", 80)];
    for (let usage = 0; usage < EXPLORATION_DEFAULT_SLOTS_PER_WEEK; usage++) {
      const r = applyExplorationQuota(baseHighlights(), finalists, { ...BASE_OPTS, weekUsageBefore: usage });
      assert.ok(r.promotion, `slot ${usage + 1} devia promover`);
    }
    const overflow = applyExplorationQuota(baseHighlights(), finalists, {
      ...BASE_OPTS,
      weekUsageBefore: EXPLORATION_DEFAULT_SLOTS_PER_WEEK,
    });
    assert.equal(overflow.promotion, undefined);
    assert.match(overflow.skipped ?? "", /cota semanal esgotada/);
  });

  it("uma semana cheia não impede a semana seguinte", () => {
    const state: ExplorationState = { editions: {} };
    let s = state;
    // 4 edições da semana W38 consumiram a cota.
    for (const edition of ["260914", "260915", "260916", "260917"]) {
      s = recordExplorationDecision(s, edition, {
        week: explorationWeekOfEdition(edition)!,
        exploracao: true,
        decided_at: "2026-09-19T00:00:00.000Z",
      });
    }
    assert.equal(countWeekUsage(s, explorationWeekOfEdition("260918")!), 4);
    assert.equal(countWeekUsage(s, explorationWeekOfEdition("260922")!), 0);
  });

  it("re-rodar a mesma edição não consome um slot novo (resume idempotente)", () => {
    let s = emptyExplorationState();
    s = recordExplorationDecision(s, "260919", {
      week: "2026-W38",
      exploracao: true,
      decided_at: "2026-09-19T00:00:00.000Z",
    });
    // Sem excluir a si mesma, o resume leria 1/4 já gasto e decidiria diferente.
    assert.equal(countWeekUsage(s, "2026-W38"), 1);
    assert.equal(countWeekUsage(s, "2026-W38", "260919"), 0);
    // Registrar de novo sobrescreve, nunca duplica.
    s = recordExplorationDecision(s, "260919", {
      week: "2026-W38",
      exploracao: true,
      decided_at: "2026-09-19T01:00:00.000Z",
    });
    assert.equal(Object.keys(s.editions).length, 1);
  });

  it("edição sem exploração não consome slot", () => {
    const s = recordExplorationDecision(emptyExplorationState(), "260919", {
      week: "2026-W38",
      exploracao: false,
      decided_at: "2026-09-19T00:00:00.000Z",
    });
    assert.equal(countWeekUsage(s, "2026-W38"), 0);
  });
});

// ─── Config ────────────────────────────────────────────────────────────────

describe("config", () => {
  it("o N vive em config, não hardcoded na lógica", () => {
    const cfg = resolveExplorationConfig({ slots_per_week: 2 });
    const finalists = [finalist("https://exogeno", 80)];
    const r = applyExplorationQuota(baseHighlights(), finalists, {
      ...BASE_OPTS,
      config: cfg,
      weekUsageBefore: 2,
    });
    assert.equal(r.promotion, undefined);
  });

  it("enabled:false desliga a cota; config ausente/ilegível cai nos defaults", () => {
    const off = applyExplorationQuota(baseHighlights(), [finalist("https://exogeno", 80)], {
      ...BASE_OPTS,
      config: resolveExplorationConfig({ enabled: false }),
    });
    assert.equal(off.promotion, undefined);
    assert.deepEqual(resolveExplorationConfig(undefined), EXPLORATION_CONFIG_DEFAULTS);
    assert.deepEqual(resolveExplorationConfig({ slots_per_week: "quatro" }), EXPLORATION_CONFIG_DEFAULTS);
  });
});

// ─── Estado em disco ───────────────────────────────────────────────────────

describe("estado em disco", () => {
  it("round-trip; arquivo ausente/corrompido degrada pra estado vazio", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "exploration-quota-"));
    try {
      const path = resolve(dir, "exploration-quota.json");
      assert.deepEqual(readExplorationState(path), emptyExplorationState());

      const state = recordExplorationDecision(emptyExplorationState(), "260919", {
        week: "2026-W38",
        exploracao: true,
        url: "https://exogeno",
        origin: "promoted",
        decided_at: "2026-09-19T00:00:00.000Z",
      });
      assert.equal(writeExplorationState(path, state), true);
      assert.deepEqual(readExplorationState(path), state);

      writeFileSync(path, "{ não é json", "utf8");
      assert.deepEqual(readExplorationState(path), emptyExplorationState());

      // Diretório inexistente (data/ ausente) → false, nunca lança.
      assert.equal(writeExplorationState(resolve(dir, "sem-data", "x.json"), state), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Contrato com a Peça 3 ─────────────────────────────────────────────────

describe("contrato com measure-editorial-concentration (Peça 3)", () => {
  const pages: PageSignal[] = [
    { slug: "edicao-a", items: ["OpenAI lança algo", "Google responde"] },
    { slug: "edicao-b", items: ["Anatel decide sobre IA no Brasil"] },
  ];
  const lastmodBySlug = new Map<string, string | undefined>([
    ["edicao-a", "2026-09-18"],
    ["edicao-b", "2026-09-19"],
  ]);

  it("explorationFlagsBySlug faz o join edição→slug pela data editorial", () => {
    let state = recordExplorationDecision(emptyExplorationState(), "260918", {
      week: "2026-W38",
      exploracao: false,
      decided_at: "2026-09-18T00:00:00.000Z",
    });
    state = recordExplorationDecision(state, "260919", {
      week: "2026-W38",
      exploracao: true,
      url: "https://exogeno",
      origin: "promoted",
      decided_at: "2026-09-19T00:00:00.000Z",
    });

    const flags = explorationFlagsBySlug(state, lastmodBySlug);
    assert.equal(flags.get("edicao-a"), false);
    assert.equal(flags.get("edicao-b"), true);

    // E o agregador da Peça 3 passa a devolver número em vez de null.
    const rows = aggregateByMonth(pages, lastmodBySlug, flags, new Map());
    const setembro = rows.find((r) => r.month === "2026-09");
    assert.ok(setembro);
    assert.equal(setembro?.exploracaoPct, 0.5);
    // CTR real continua sem fonte — `null`, não 0.
    assert.equal(setembro?.exploracaoCtr, null);
    assert.equal(setembro?.restCtr, null);
  });

  it("sem estado (data/ ausente), a coluna volta a degradar pra null", () => {
    const rows = aggregateByMonth(
      pages,
      lastmodBySlug,
      explorationFlagsBySlug(emptyExplorationState(), lastmodBySlug),
      new Map(),
    );
    assert.equal(rows.find((r) => r.month === "2026-09")?.exploracaoPct, null);
  });

  it("edição sem página no acervo não entra no mapa (sem falsear a série)", () => {
    const state = recordExplorationDecision(emptyExplorationState(), "260101", {
      week: explorationWeekOfEdition("260101")!,
      exploracao: true,
      decided_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(explorationFlagsBySlug(state, lastmodBySlug).size, 0);
  });
});
