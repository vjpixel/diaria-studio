/**
 * test/token-usage-summary.test.ts (#6445)
 *
 * Cobre `scripts/lib/token-usage-summary.ts` — agregação de token por dia e
 * tipo de sessão (edição/overnight/develop/continuo/interativa avulsa) a
 * partir das 3 fontes (stage-status.json, run-log.jsonl, transcripts
 * locais). Isolado em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sumRunLogAgentTokensForDay,
  sumEdicaoTokensForDay,
  sumLocalTranscriptTotalsForDay,
  dayBoundsIso,
  lastNDaysAammdd,
  computeDayTotals,
  computeTokenUsageSummary,
  formatTokenUsageSummary,
} from "../scripts/lib/token-usage-summary.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sumRunLogAgentTokensForDay (#6445)", () => {
  it("soma subagent_metrics + coordinator_tokens_estimate + review_metrics do agent/dia certos", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 1000 } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 2000 } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "review_metrics", details: { review_tokens: 500 } }),
      JSON.stringify({ agent: "develop", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 9999 } }),
      JSON.stringify({ agent: "overnight", edition: "260826", message: "subagent_metrics", details: { subagent_tokens: 9999 } }),
      JSON.stringify({ agent: "overnight", edition: "260827", message: "outra_coisa", details: { subagent_tokens: 9999 } }),
    ];
    const result = sumRunLogAgentTokensForDay(lines, "overnight", "260827");
    assert.equal(result.tokens, 3500);
    assert.equal(result.eventCount, 3);
  });

  it("evento com token null conta no eventCount mas soma 0, nunca lança", () => {
    const lines = [
      JSON.stringify({ agent: "develop", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: null } }),
    ];
    const result = sumRunLogAgentTokensForDay(lines, "develop", "260827");
    assert.equal(result.tokens, 0);
    assert.equal(result.eventCount, 1);
  });

  it("linha malformada é ignorada silenciosamente", () => {
    const lines = ["{ not json", "", "   "];
    const result = sumRunLogAgentTokensForDay(lines, "overnight", "260827");
    assert.equal(result.tokens, 0);
    assert.equal(result.eventCount, 0);
  });
});

describe("sumEdicaoTokensForDay (#6445)", () => {
  it("soma tokens_in/tokens_out de todos os stages de uma edição", () => {
    const dir = tmp("token-usage-edicao-");
    try {
      const editionDir = join(dir, "260827");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "stage-status.json"),
        JSON.stringify({
          edition: "260827",
          rows: [
            { stage: 1, status: "done", tokens_in: 1000, tokens_out: 200 },
            { stage: 2, status: "done", tokens_in: 3000, tokens_out: 400 },
          ],
        }),
        "utf8",
      );
      const result = sumEdicaoTokensForDay(dir, "260827");
      assert.deepEqual(result, { tokensIn: 4000, tokensOut: 600 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição inexistente retorna null, nunca {tokensIn:0, tokensOut:0}", () => {
    const dir = tmp("token-usage-edicao-missing-");
    try {
      assert.equal(sumEdicaoTokensForDay(dir, "260827"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dayBoundsIso (#6445)", () => {
  it("resolve os limites do dia civil em BRT (UTC-3)", () => {
    const { startIso, endIso } = dayBoundsIso("260827");
    assert.equal(startIso, new Date("2026-08-27T03:00:00.000Z").toISOString());
    assert.equal(endIso, new Date("2026-08-28T02:59:59.000Z").toISOString());
  });

  it("rejeita dia fora do formato AAMMDD", () => {
    assert.throws(() => dayBoundsIso("2026-08-27"));
  });
});

describe("lastNDaysAammdd (#6445)", () => {
  it("gera N dias ascendentes terminando em 'now'", () => {
    const now = new Date("2026-08-28T15:00:00-03:00");
    assert.deepEqual(lastNDaysAammdd(3, now), ["260826", "260827", "260828"]);
  });
});

describe("sumLocalTranscriptTotalsForDay (#6445)", () => {
  it("available:false quando o diretório de transcripts não existe", () => {
    const dir = tmp("token-usage-transcripts-missing-");
    try {
      const result = sumLocalTranscriptTotalsForDay(join(dir, "no-such-dir"), "260827");
      assert.equal(result.available, false);
      assert.equal(result.tokensIn, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("soma usage real de todas as sessões cujo turno cai no dia, incluindo cache_read", () => {
    const dir = tmp("token-usage-transcripts-");
    try {
      const sessionA = [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-27T15:00:00.000Z", // 12:00 BRT — dentro do dia 260827
          message: {
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5000 },
          },
        }),
      ].join("\n");
      const sessionB = [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-26T15:00:00.000Z", // outro dia — não deve entrar
          message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999 } },
        }),
      ].join("\n");
      writeFileSync(join(dir, "session-a.jsonl"), sessionA, "utf8");
      writeFileSync(join(dir, "session-b.jsonl"), sessionB, "utf8");

      const result = sumLocalTranscriptTotalsForDay(dir, "260827");
      assert.equal(result.available, true);
      assert.equal(result.tokensIn, 100 + 10 + 5000);
      assert.equal(result.tokensOut, 50);
      assert.equal(result.cacheReadTokens, 5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeDayTotals (#6445)", () => {
  function setup() {
    const root = tmp("token-usage-day-");
    const editionsDir = join(root, "editions");
    const transcriptsDir = join(root, "transcripts");
    mkdirSync(join(editionsDir, "260827", "_internal"), { recursive: true });
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(
      join(editionsDir, "260827", "_internal", "stage-status.json"),
      JSON.stringify({ edition: "260827", rows: [{ stage: 1, status: "done", tokens_in: 10_000, tokens_out: 2_000 }] }),
      "utf8",
    );
    return { root, editionsDir, transcriptsDir };
  }

  it("agrega os 4 kinds instrumentados + interativa por diferença", () => {
    const { root, editionsDir, transcriptsDir } = setup();
    try {
      writeFileSync(
        join(transcriptsDir, "s1.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-27T15:00:00.000Z",
          message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50_000, output_tokens: 10_000 } },
        }),
        "utf8",
      );
      const lines = [
        JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 3_000 } }),
      ];
      const day = computeDayTotals("260827", lines, editionsDir, transcriptsDir, 50);
      const byKind = Object.fromEntries(day.kinds.map((k) => [k.kind, k]));
      assert.equal(byKind.edicao.total, 12_000); // 10_000 + 2_000
      assert.equal(byKind.overnight.total, 3_000);
      assert.equal(byKind.develop.hasData, false);
      assert.equal(byKind.develop.total, 0);
      // total transcript = 60_000; atribuído = 12_000 (edicao) + 3_000 (overnight) = 15_000
      assert.equal(byKind.interativa.total, 45_000);
      assert.equal(day.total, 12_000 + 3_000 + 0 + 0 + 45_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clampa o remainder de 'interativa' em 0 quando a subtração dá negativo", () => {
    const { root, editionsDir, transcriptsDir } = setup();
    try {
      // Nenhum transcript local com volume suficiente — total transcript = 0, atribuído = 12_000.
      const day = computeDayTotals("260827", [], editionsDir, transcriptsDir, 50);
      const byKind = Object.fromEntries(day.kinds.map((k) => [k.kind, k]));
      assert.equal(byKind.interativa.hasData, true); // diretório existe, só sem volume
      assert.equal(byKind.interativa.total, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interativa sai hasData:false quando não há diretório de transcripts local (sessão cloud)", () => {
    const { root, editionsDir } = setup();
    try {
      const day = computeDayTotals("260827", [], editionsDir, join(root, "no-such-transcripts-dir"), 50);
      const interativa = day.kinds.find((k) => k.kind === "interativa")!;
      assert.equal(interativa.hasData, false);
      assert.equal(interativa.total, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dispara alarme quando um kind passa do threshold do dia", () => {
    const { root, editionsDir, transcriptsDir } = setup();
    try {
      // edicao = 12_000, sem mais nada → domina 100% do total do dia.
      const day = computeDayTotals("260827", [], editionsDir, transcriptsDir, 50);
      assert.equal(day.dominantKind, "edicao");
      assert.equal(day.dominantShare, 1);
      assert.equal(day.alarm, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dia sem nenhum dado em nenhum kind não dispara alarme (total 0)", () => {
    const root = tmp("token-usage-empty-");
    try {
      const editionsDir = join(root, "editions");
      const transcriptsDir = join(root, "transcripts");
      mkdirSync(editionsDir, { recursive: true });
      mkdirSync(transcriptsDir, { recursive: true });
      const day = computeDayTotals("260827", [], editionsDir, transcriptsDir, 50);
      assert.equal(day.total, 0);
      assert.equal(day.alarm, false);
      assert.equal(day.dominantKind, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeTokenUsageSummary + formatTokenUsageSummary (#6445)", () => {
  it("fail-soft: run-log/editions/transcripts todos ausentes → resumo zerado sem lançar", () => {
    const root = tmp("token-usage-fail-soft-");
    try {
      const result = computeTokenUsageSummary(root, 3, {}, new Date("2026-08-28T12:00:00-03:00"));
      assert.equal(result.days.length, 3);
      assert.deepEqual(
        result.days.map((d) => d.day),
        ["260826", "260827", "260828"],
      );
      for (const day of result.days) {
        assert.equal(day.total, 0);
      }
      const text = formatTokenUsageSummary(result);
      assert.match(text, /Monitoramento de tokens por tipo de sessão/);
      assert.match(text, /Nenhum dia passou de 50% de concentração/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formata a seção de Alarmes quando algum dia excedeu o threshold", () => {
    const root = tmp("token-usage-format-alarm-");
    try {
      mkdirSync(join(root, "data", "editions", "260827", "_internal"), { recursive: true });
      writeFileSync(
        join(root, "data", "editions", "260827", "_internal", "stage-status.json"),
        JSON.stringify({ edition: "260827", rows: [{ stage: 1, status: "done", tokens_in: 10_000, tokens_out: 2_000 }] }),
        "utf8",
      );
      const result = computeTokenUsageSummary(root, 1, {}, new Date("2026-08-27T12:00:00-03:00"));
      const text = formatTokenUsageSummary(result);
      assert.match(text, /AVISO: 260827/);
      assert.match(text, /Edição/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
