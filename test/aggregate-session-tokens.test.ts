/**
 * test/aggregate-session-tokens.test.ts (#6445)
 *
 * Cobre `scripts/aggregate-session-tokens.ts` — agregação consolidada de
 * tokens por TIPO DE SESSÃO (edicao/overnight/develop/continuo), somando
 * `data/run-log.jsonl` (eventos `subagent_metrics`/`coordinator_tokens_estimate`/
 * `review_metrics`/`fleet_review_metrics`) com `aggregate-costs.ts`
 * (`_internal/stage-status.json` por edição). Isolado em tmpdir — nunca toca
 * `data/` real do repo (mesmo padrão de `test/continuo-cost-summary.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateRunLogByKindAndDay,
  editionCostsToKindDayTotals,
  computeAlarms,
  buildSessionTokensSummary,
  formatSessionTokensSummary,
  defaultSinceAammdd,
  roundDayFromEdition,
  mergeKindDayTotals,
  discoverSessionRounds,
  filterRoundDirs,
  findUninstrumentedRounds,
  type KindDayTotals,
} from "../scripts/aggregate-session-tokens.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "aggregate-session-tokens-"));
}

describe("aggregateRunLogByKindAndDay (#6445)", () => {
  it("soma por kind (overnight/develop/continuo) e por dia, categorizando coordinator/implementation/review", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 10000, source: "harness_usage" } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 50000, source: "harness_usage" } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "review_metrics", details: { review_tokens: 8000, source: "harness_usage" } }),
      JSON.stringify({ agent: "develop", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 3000, source: "harness_usage" } }),
      JSON.stringify({ agent: "develop", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 20000, source: "harness_usage" } }),
      JSON.stringify({ agent: "develop", edition: "260827", message: "fleet_review_metrics", details: { fleet_tokens: 15000, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 1000, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 2000, source: "harness_usage" } }),
    ];

    const rows = aggregateRunLogByKindAndDay(lines);
    const byKey = new Map(rows.map((r) => [`${r.kind}|${r.day}`, r]));

    const overnight = byKey.get("overnight|260827")!;
    assert.equal(overnight.totalTokens, 10000 + 50000 + 8000);
    assert.equal(overnight.categories.coordinator?.tokens, 10000);
    assert.equal(overnight.categories.implementation?.tokens, 50000);
    assert.equal(overnight.categories.review?.tokens, 8000);

    const develop = byKey.get("develop|260827")!;
    assert.equal(develop.totalTokens, 3000 + 20000 + 15000);
    // fleet_review_metrics do develop cai na MESMA categoria "review" que
    // review_metrics do overnight — são análogos por design (#4815).
    assert.equal(develop.categories.review?.tokens, 15000);

    const continuo = byKey.get("continuo|260827")!;
    assert.equal(continuo.totalTokens, 1000 + 2000);
    assert.equal(continuo.categories.review, undefined);
  });

  it("ignora agent fora de {overnight, develop, continuo} (ex: source-researcher, edições da pipeline)", () => {
    const lines = [
      JSON.stringify({ agent: "source-researcher", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 999 } }),
      JSON.stringify({ agent: null, edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 999 } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "overnight");
    assert.equal(rows[0].totalTokens, 100);
  });

  it("ignora mensagens fora do conjunto rastreado (ex: pulada, coordinator_model)", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260827", message: "pulada", details: { unidade: "#1" } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "coordinator_model", details: { model: "sonnet" } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 0);
  });

  it("tokens null/undefined (harness não expôs) → unavailableCount, NUNCA somado como 0 enganoso", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: null, source: "unavailable" } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 500, source: "harness_usage" } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 500);
    assert.equal(rows[0].categories.implementation?.unavailableCount, 1);
    assert.equal(rows[0].categories.implementation?.eventCount, 2);
  });

  it("respeita --since/--until (comparação lexicográfica AAMMDD)", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260810", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
      JSON.stringify({ agent: "overnight", edition: "260820", message: "subagent_metrics", details: { subagent_tokens: 200 } }),
      JSON.stringify({ agent: "overnight", edition: "260830", message: "subagent_metrics", details: { subagent_tokens: 300 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines, { since: "260815", until: "260825" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].day, "260820");
  });

  it("linhas malformadas (JSON inválido) são ignoradas silenciosamente, nunca lançam", () => {
    const lines = [
      "{ not json",
      "",
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 10 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 10);
  });
});

describe("editionCostsToKindDayTotals (#6445)", () => {
  it("converte EditionCost[] em KindDayTotals[] do kind edicao, preservando split in/out e custo", () => {
    const editions = [
      {
        edition: "260827",
        totals: { durationMs: 60000, costUsd: 1.23, costEstimated: true, tokensIn: 100000, tokensOut: 20000 },
      },
    ];
    const rows = editionCostsToKindDayTotals(editions);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "edicao");
    assert.equal(rows[0].day, "260827");
    assert.equal(rows[0].totalTokens, 120000);
    assert.equal(rows[0].tokensIn, 100000);
    assert.equal(rows[0].tokensOut, 20000);
    assert.equal(rows[0].costUsd, 1.23);
    assert.equal(rows[0].costEstimated, true);
  });
});

describe("computeAlarms (#6445 item 3)", () => {
  it("sinaliza kind que excede alarmPct% do total do dia", () => {
    const rows: KindDayTotals[] = [
      { kind: "overnight", day: "260827", rounds: ["260827"], totalTokens: 900000, categories: {} },
      { kind: "edicao", day: "260827", rounds: ["260827"], totalTokens: 100000, categories: {} },
    ];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].kind, "overnight");
    assert.ok(alarms[0].pct > 50);
  });

  it("não sinaliza nada quando a distribuição é equilibrada", () => {
    const rows: KindDayTotals[] = [
      { kind: "overnight", day: "260827", rounds: ["260827"], totalTokens: 50000, categories: {} },
      { kind: "edicao", day: "260827", rounds: ["260827"], totalTokens: 50000, categories: {} },
    ];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 0);
  });

  it("dia com total 0 não gera divisão por zero nem alarme", () => {
    const rows: KindDayTotals[] = [{ kind: "overnight", day: "260827", rounds: ["260827"], totalTokens: 0, categories: {} }];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 0);
  });

  it("único kind no dia nunca alarma (100% de si mesmo não é desequilíbrio, é a única sessão do dia)", () => {
    const rows: KindDayTotals[] = [{ kind: "overnight", day: "260827", rounds: ["260827"], totalTokens: 500000, categories: {} }];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 0);
  });
});

describe("buildSessionTokensSummary — integração fim-a-fim com fixtures em tmpdir (#6445, regressão #633)", () => {
  it("agrega os 3 tipos de sessão overnight/develop/continuo + edicao a partir de fixtures sintéticas", () => {
    const root = tmpRoot();
    try {
      // run-log.jsonl sintético cobrindo os 3 kinds de sessão autônoma.
      mkdirSync(join(root, "data"), { recursive: true });
      const logLines = [
        { agent: "overnight", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 40000, source: "harness_usage" } },
        { agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 300000, source: "harness_usage" } },
        { agent: "overnight", edition: "260827", message: "review_metrics", details: { review_tokens: 60000, source: "harness_usage" } },
        { agent: "develop", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 10000, source: "harness_usage" } },
        { agent: "develop", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 80000, source: "harness_usage" } },
        { agent: "continuo", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 5000, source: "harness_usage" } },
        { agent: "continuo", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 15000, source: "harness_usage" } },
        // ruído: sessão interativa comum, deve ser ignorado.
        { agent: "source-researcher", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 999999 } },
      ];
      writeFileSync(join(root, "data", "run-log.jsonl"), logLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

      // stage-status.json sintético pra 1 edição (kind "edicao").
      const editionDir = join(root, "data", "editions", "2608", "260827", "_internal");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(
        join(editionDir, "stage-status.json"),
        JSON.stringify({
          edition: "260827",
          rows: [
            { stage: 1, status: "done", duration_ms: 600000, cost_usd: 2.5, tokens_in: 200000, tokens_out: 30000, models: ["haiku"] },
          ],
        }),
        "utf8",
      );

      const summary = buildSessionTokensSummary({ rootDir: root, alarmPct: 50 });

      const overnight = summary.rows.find((r) => r.kind === "overnight" && r.day === "260827")!;
      assert.equal(overnight.totalTokens, 40000 + 300000 + 60000);

      const develop = summary.rows.find((r) => r.kind === "develop" && r.day === "260827")!;
      assert.equal(develop.totalTokens, 10000 + 80000);

      const continuo = summary.rows.find((r) => r.kind === "continuo" && r.day === "260827")!;
      assert.equal(continuo.totalTokens, 5000 + 15000);

      const edicao = summary.rows.find((r) => r.kind === "edicao" && r.day === "260827")!;
      assert.equal(edicao.totalTokens, 200000 + 30000);
      assert.equal(edicao.tokensIn, 200000);
      assert.equal(edicao.tokensOut, 30000);

      // Overnight (400k) domina o dia (720k total combinado) → alarme.
      const alarm = summary.alarms.find((a) => a.kind === "overnight" && a.day === "260827");
      assert.ok(alarm, "esperava alarme para overnight no dia 260827");

      // markdown não lança e menciona os 4 kinds.
      const md = formatSessionTokensSummary(summary);
      assert.match(md, /Overnight/);
      assert.match(md, /Develop/);
      assert.match(md, /Contínuo/);
      assert.match(md, /Edição/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run-log.jsonl ausente e data/editions/ ausente → summary vazio, nunca lança (fail-soft)", () => {
    const root = tmpRoot();
    try {
      const summary = buildSessionTokensSummary({ rootDir: root });
      assert.deepEqual(summary.rows, []);
      assert.deepEqual(summary.alarms, []);
      const md = formatSessionTokensSummary(summary);
      assert.match(md, /Sem dados/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("defaultSinceAammdd (#6445 — janela default do painel /painel/tokens)", () => {
  it("subtrai N dias e formata como AAMMDD", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    assert.equal(defaultSinceAammdd(now, 14), "260814");
  });

  it("cruza virada de mês/ano corretamente", () => {
    const now = new Date("2026-01-05T12:00:00Z");
    assert.equal(defaultSinceAammdd(now, 14), "251222");
  });

  it("days=0 retorna a própria data de now", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    assert.equal(defaultSinceAammdd(now, 0), "260828");
  });
});

describe("roundDayFromEdition (#6638 — dia civil vs id de rodada)", () => {
  it("remove o sufixo de rotação da N-ésima rodada do dia", () => {
    assert.equal(roundDayFromEdition("260814b"), "260814");
    assert.equal(roundDayFromEdition("260814c"), "260814");
    assert.equal(roundDayFromEdition("260828g"), "260828");
  });

  it("AAMMDD sem sufixo passa intacto", () => {
    assert.equal(roundDayFromEdition("260814"), "260814");
  });

  it("id fora do formato passa INTACTO — nunca colapsa num dia inventado", () => {
    // Diretórios que convivem em data/editions/ e não são rodadas.
    assert.equal(roundDayFromEdition("replay-scorer-a"), "replay-scorer-a");
    assert.equal(roundDayFromEdition("2604"), "2604");
    assert.equal(roundDayFromEdition(""), "");
  });
});

describe("filterRoundDirs (#6634 Direction 2)", () => {
  it("filtra nomes que casam com ^\\d{6}[a-z]*$ e têm plan.json", () => {
    const entries = [
      { name: "260814", hasPlan: true },
      { name: "260814b", hasPlan: true },
      { name: "260814c", hasPlan: false }, // sem plan.json → filtrado
      { name: "not-a-round", hasPlan: true }, // formato inválido → filtrado
      { name: "260814backup", hasPlan: true }, // formato inválido → filtrado
      { name: ".tmp", hasPlan: true }, // formato inválido → filtrado
    ];
    assert.deepEqual(filterRoundDirs(entries), ["260814", "260814b"]);
  });

  it("ordena lexicograficamente (= cronológico em AAMMDD)", () => {
    const entries = [
      { name: "260814c", hasPlan: true },
      { name: "260813", hasPlan: true },
      { name: "260814b", hasPlan: true },
      { name: "260814", hasPlan: true },
    ];
    assert.deepEqual(filterRoundDirs(entries), ["260813", "260814", "260814b", "260814c"]);
  });

  it("empty entries → empty array", () => {
    assert.deepEqual(filterRoundDirs([]), []);
  });
});

describe("findUninstrumentedRounds (#6634 Direction 2 — invisible rounds)", () => {
  it("rodada cujo dia NÃO está nos instrumentedDays → uninstrumented", () => {
    const result = findUninstrumentedRounds(
      ["260814", "260814c"],
      ["260813"],
    );
    assert.deepEqual(result, ["260814", "260814c"]);
  });

  it("rodada cujo dia ESTÁ nos instrumentedDays → filtrada", () => {
    const result = findUninstrumentedRounds(
      ["260814", "260814b", "260814c"],
      ["260814"],
    );
    assert.deepEqual(result, []);
  });

  it("rodada b/c cujo dia a está instrumentado → ambas filtradas (dia recebeu dado)", () => {
    const result = findUninstrumentedRounds(
      ["260814b", "260814c"],
      ["260814"],
    );
    assert.deepEqual(result, []);
  });

  it("empty discovered → empty result", () => {
    assert.deepEqual(findUninstrumentedRounds([], ["260814"]), []);
  });

  it("empty instrumentedDays → todas as discovered são uninstrumented", () => {
    assert.deepEqual(findUninstrumentedRounds(["260814", "260814b"], []), ["260814", "260814b"]);
  });
});

describe("discoverSessionRounds (#6634 Direction 2 — filesystem scan)", () => {
  it("continuo: lista dirs AAMMDD com plan.json, ordenados", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data", "continuo", "260814", "_internal"), { recursive: true });
      mkdirSync(join(root, "data", "continuo", "260813", "_internal"), { recursive: true });
      mkdirSync(join(root, "data", "continuo", "260815", "_internal"), { recursive: true });
      // plan.json marca um dir como rodada válida
      for (const d of ["260813", "260814", "260815"]) {
        writeFileSync(join(root, "data", "continuo", d, "plan.json"), "{}", "utf8");
      }
      // dir sem plan.json → não conta
      mkdirSync(join(root, "data", "continuo", "260816"), { recursive: true });

      const rounds = discoverSessionRounds(root, "continuo");
      assert.deepEqual(rounds, ["260813", "260814", "260815"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overnight: lista dirs AAMMDD+suffix com plan.json, ordenados", () => {
    const root = tmpRoot();
    try {
      for (const d of ["260814", "260814b", "260814c", "260813"]) {
        mkdirSync(join(root, "data", "overnight", d, "_internal"), { recursive: true });
        writeFileSync(join(root, "data", "overnight", d, "plan.json"), "{}", "utf8");
      }
      // sufixo inválido → skip
      mkdirSync(join(root, "data", "overnight", "260814backup"), { recursive: true });

      const rounds = discoverSessionRounds(root, "overnight");
      assert.deepEqual(rounds, ["260813", "260814", "260814b", "260814c"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dir inexistente → retorna [] (never lança)", () => {
    const root = tmpRoot();
    try {
      const rounds = discoverSessionRounds(root, "develop");
      assert.deepEqual(rounds, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("aggregateRunLogByKindAndDay — dia civil (#6638, regressão #633)", () => {
  it("rodadas do mesmo dia (260814, 260814b, 260814c) somam numa linha só, com rounds preservado", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260814", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
      JSON.stringify({ agent: "overnight", edition: "260814c", message: "subagent_metrics", details: { subagent_tokens: 20 } }),
      JSON.stringify({ agent: "overnight", edition: "260814b", message: "review_metrics", details: { review_tokens: 3 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].day, "260814");
    assert.equal(rows[0].totalTokens, 123);
    assert.deepEqual(rows[0].rounds, ["260814", "260814b", "260814c"]);
    assert.equal(rows[0].categories.implementation?.tokens, 120);
    assert.equal(rows[0].categories.review?.tokens, 3);
  });

  it("kinds diferentes no mesmo dia continuam em linhas separadas", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260814b", message: "subagent_metrics", details: { subagent_tokens: 10 } }),
      JSON.stringify({ agent: "develop", edition: "260814", message: "subagent_metrics", details: { subagent_tokens: 20 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines);
    assert.equal(rows.length, 2);
    assert.deepEqual([...new Set(rows.map((r) => r.day))], ["260814"]);
  });

  it("--until AAMMDD inclui as rodadas sufixadas do PRÓPRIO dia (antes do #6638 a comparação de string as descartava)", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260814", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
      JSON.stringify({ agent: "overnight", edition: "260814c", message: "subagent_metrics", details: { subagent_tokens: 50 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines, { until: "260814" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 150);
  });

  it("--since AAMMDD não perde a 1ª rodada do dia de corte por causa do sufixo", () => {
    const lines = [
      JSON.stringify({ agent: "develop", edition: "260813b", message: "subagent_metrics", details: { subagent_tokens: 999 } }),
      JSON.stringify({ agent: "develop", edition: "260814b", message: "subagent_metrics", details: { subagent_tokens: 7 } }),
    ];
    const rows = aggregateRunLogByKindAndDay(lines, { since: "260814" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 7);
  });
});

describe("mergeKindDayTotals (#6638)", () => {
  it("funde linhas de mesmo (kind, dia) somando tokens, custo, categorias e unindo rounds", () => {
    const merged = mergeKindDayTotals([
      {
        kind: "overnight",
        day: "260814",
        rounds: ["260814"],
        totalTokens: 100,
        costUsd: 1.5,
        categories: { implementation: { tokens: 100, eventCount: 1, unavailableCount: 0 } },
      },
      {
        kind: "overnight",
        day: "260814",
        rounds: ["260814b"],
        totalTokens: 50,
        costUsd: 0.5,
        costEstimated: true,
        categories: { implementation: { tokens: 50, eventCount: 1, unavailableCount: 2 } },
      },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].totalTokens, 150);
    assert.equal(merged[0].costUsd, 2);
    // Estimado se QUALQUER parcela for — nunca apresentar como medido.
    assert.equal(merged[0].costEstimated, true);
    assert.deepEqual(merged[0].rounds, ["260814", "260814b"]);
    assert.equal(merged[0].categories.implementation?.tokens, 150);
    assert.equal(merged[0].categories.implementation?.eventCount, 2);
    assert.equal(merged[0].categories.implementation?.unavailableCount, 2);
  });

  it("não muta as CATEGORIAS da entrada ao fundir (aliasing: cópia rasa deixaria CategoryTotals compartilhado)", () => {
    const first: KindDayTotals = {
      kind: "overnight",
      day: "260814",
      rounds: ["260814"],
      totalTokens: 100,
      categories: { implementation: { tokens: 100, eventCount: 1, unavailableCount: 0 } },
    };
    const input: KindDayTotals[] = [
      first,
      {
        kind: "overnight",
        day: "260814",
        rounds: ["260814b"],
        totalTokens: 50,
        categories: { implementation: { tokens: 50, eventCount: 1, unavailableCount: 0 } },
      },
    ];
    const merged = mergeKindDayTotals(input);
    assert.equal(merged[0].categories.implementation?.tokens, 150);
    // A linha de entrada continua valendo 100 — senão uma 2ª chamada de merge
    // (ou qualquer leitura posterior de logRows) contaria em dobro.
    assert.equal(first.categories.implementation?.tokens, 100);
    assert.equal(first.categories.implementation?.eventCount, 1);
    // Idempotência: re-fundir o resultado não muda nada.
    assert.equal(mergeKindDayTotals(merged)[0].categories.implementation?.tokens, 150);
  });

  it("não funde kinds diferentes nem dias diferentes, e não muta a entrada", () => {
    const input: KindDayTotals[] = [
      { kind: "overnight", day: "260814", rounds: ["260814"], totalTokens: 10, categories: {} },
      { kind: "develop", day: "260814", rounds: ["260814"], totalTokens: 20, categories: {} },
      { kind: "overnight", day: "260815", rounds: ["260815"], totalTokens: 30, categories: {} },
    ];
    const merged = mergeKindDayTotals(input);
    assert.equal(merged.length, 3);
    assert.equal(input[0].totalTokens, 10);
    assert.deepEqual(input[0].rounds, ["260814"]);
  });
});

describe("formatSessionTokensSummary — marcação de rodadas fundidas (#6638)", () => {
  it("dia com N rodadas do mesmo kind mostra ×N; dia com 1 rodada não mostra sufixo", () => {
    const md = formatSessionTokensSummary({
      generatedAt: "2026-08-28T00:00:00.000Z",
      since: null,
      until: null,
      alarmPct: 50,
      rows: [
        { kind: "overnight", day: "260814", rounds: ["260814", "260814b", "260814c"], totalTokens: 3_000_000, categories: {} },
        { kind: "develop", day: "260815", rounds: ["260815"], totalTokens: 1_000_000, categories: {} },
      ],
      alarms: [],
    });
    assert.match(md, /\| 260814 \| Overnight ×3 \|/);
    assert.match(md, /\| 260815 \| Develop \|/);
    assert.doesNotMatch(md, /Develop ×/);
  });
});

describe("buildSessionTokensSummary — invisible rounds (#6634 Direction 2)", () => {
  it("dia com dir mas sem eventos no run-log → linha placeholder com uninstrumentedRounds", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "data", "run-log.jsonl"), "", "utf8");

      // continuo day 260828 existe no filesystem mas NÃO tem eventos no run-log
      mkdirSync(join(root, "data", "continuo", "260828", "_internal"), { recursive: true });
      writeFileSync(join(root, "data", "continuo", "260828", "plan.json"), "{}", "utf8");

      const summary = buildSessionTokensSummary({ rootDir: root });

      const row = summary.rows.find((r) => r.kind === "continuo" && r.day === "260828");
      assert.ok(row, "esperava linha placeholder para dia 260828 sem eventos");
      assert.deepEqual(row.uninstrumentedRounds, ["260828"]);
      assert.equal(row.totalTokens, 0);

      // markdown menciona o aviso de invisible rounds
      const md = formatSessionTokensSummary(summary);
      assert.match(md, /⚠ 1 rodada/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dia instrumentado parcialmente (260814b sem evento, 260814c com evento) → 260814b em uninstrumentedRounds", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });

      const logLines = [
        // 260814 e 260814c emitiram eventos; 260814b NÃO
        JSON.stringify({ agent: "overnight", edition: "260814", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
        JSON.stringify({ agent: "overnight", edition: "260814c", message: "subagent_metrics", details: { subagent_tokens: 50 } }),
      ];
      writeFileSync(join(root, "data", "run-log.jsonl"), logLines.join("\n") + "\n", "utf8");

      // 3 dirs de rodada pra este dia
      for (const d of ["260814", "260814b", "260814c"]) {
        mkdirSync(join(root, "data", "overnight", d, "_internal"), { recursive: true });
        writeFileSync(join(root, "data", "overnight", d, "plan.json"), "{}", "utf8");
      }

      const summary = buildSessionTokensSummary({ rootDir: root });

      const row = summary.rows.find((r) => r.kind === "overnight" && r.day === "260814");
      assert.ok(row, "esperava linha para dia 260814");
      assert.deepEqual(row.rounds, ["260814", "260814c"]); // event-contributing IDs
      assert.deepEqual(row.uninstrumentedRounds, ["260814b"]); // descoberto mas sem evento
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dia 100% instrumentado → uninstrumentedRounds undefined (não aparece na saída)", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });

      const logLines = [
        JSON.stringify({ agent: "overnight", edition: "260814", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
        JSON.stringify({ agent: "overnight", edition: "260814b", message: "subagent_metrics", details: { subagent_tokens: 50 } }),
      ];
      writeFileSync(join(root, "data", "run-log.jsonl"), logLines.join("\n") + "\n", "utf8");

      for (const d of ["260814", "260814b"]) {
        mkdirSync(join(root, "data", "overnight", d, "_internal"), { recursive: true });
        writeFileSync(join(root, "data", "overnight", d, "plan.json"), "{}", "utf8");
      }

      const summary = buildSessionTokensSummary({ rootDir: root });
      const row = summary.rows.find((r) => r.kind === "overnight" && r.day === "260814");
      assert.ok(row);
      assert.equal(row.uninstrumentedRounds, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--since/--until filtra dias uninstrumentados fora da janela", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "data", "run-log.jsonl"), "", "utf8");

      // 260813 e 260815 existem mas sem eventos; janela 260814-260814
      for (const d of ["260813", "260815"]) {
        mkdirSync(join(root, "data", "continuo", d, "_internal"), { recursive: true });
        writeFileSync(join(root, "data", "continuo", d, "plan.json"), "{}", "utf8");
      }

      const summary = buildSessionTokensSummary({ rootDir: root, since: "260814", until: "260814" });
      assert.equal(summary.rows.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edições (kind=edicao) nunca recebem uninstrumentedRounds (usam stage-status, não run-log)", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, "data", "editions", "2608", "260827", "_internal"), { recursive: true });
      writeFileSync(
        join(root, "data", "editions", "2608", "260827", "_internal", "stage-status.json"),
        JSON.stringify({ edition: "260827", rows: [{ stage: 1, status: "done", duration_ms: 600000, cost_usd: 1.0, tokens_in: 100, tokens_out: 20, models: ["haiku"] }] }),
        "utf8",
      );

      const summary = buildSessionTokensSummary({ rootDir: root });
      const edicaoRow = summary.rows.find((r) => r.kind === "edicao");
      assert.ok(edicaoRow);
      assert.equal(edicaoRow.uninstrumentedRounds, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
