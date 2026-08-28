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
      { kind: "overnight", day: "260827", totalTokens: 900000, categories: {} },
      { kind: "edicao", day: "260827", totalTokens: 100000, categories: {} },
    ];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].kind, "overnight");
    assert.ok(alarms[0].pct > 50);
  });

  it("não sinaliza nada quando a distribuição é equilibrada", () => {
    const rows: KindDayTotals[] = [
      { kind: "overnight", day: "260827", totalTokens: 50000, categories: {} },
      { kind: "edicao", day: "260827", totalTokens: 50000, categories: {} },
    ];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 0);
  });

  it("dia com total 0 não gera divisão por zero nem alarme", () => {
    const rows: KindDayTotals[] = [{ kind: "overnight", day: "260827", totalTokens: 0, categories: {} }];
    const alarms = computeAlarms(rows, 50);
    assert.equal(alarms.length, 0);
  });

  it("único kind no dia nunca alarma (100% de si mesmo não é desequilíbrio, é a única sessão do dia)", () => {
    const rows: KindDayTotals[] = [{ kind: "overnight", day: "260827", totalTokens: 500000, categories: {} }];
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
