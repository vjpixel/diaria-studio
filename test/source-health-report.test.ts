/**
 * source-health-report.test.ts (#5191)
 *
 * Cobre a lógica pura de scripts/source-health-report.ts — o que
 * `/diaria-source-health` fazia por interpretação de prosa antes desta
 * issue. `computeFailureStreak` em si já é testado exaustivamente em
 * test/source-runs.test.ts; aqui o foco é a integração fim-a-fim
 * (HealthFile → linhas de status → classificação → tabela) e a leitura do
 * log individual por fonte, incluindo a regra crítica #1576/#1665: uma
 * entrada `empty` (fetch OK, zero artigos) NÃO conta como falha dura e
 * ENCERRA o streak — tanto no meio de uma sequência quanto nas bordas.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSourceHealthRows,
  sortRowsBySeverity,
  formatOverviewTable,
  readSourceLog,
  tailSourceLog,
  formatSourceDetail,
  type SourceLogEntry,
} from "../scripts/source-health-report.ts";
import { classifySourceStatus, type HealthFile, type SourceEntry } from "../scripts/lib/source-runs.ts";

function entry(recent: SourceEntry["recent_outcomes"], overrides: Partial<SourceEntry> = {}): SourceEntry {
  return {
    attempts: recent.length,
    successes: recent.filter((r) => r.outcome === "ok").length,
    failures: recent.filter((r) => r.outcome === "fail").length,
    timeouts: recent.filter((r) => r.outcome === "timeout").length,
    last_success_iso: null,
    last_failure_iso: null,
    last_duration_ms: null,
    recent_outcomes: recent,
    total_articles: 0,
    ...overrides,
  };
}

describe("classifySourceStatus (#5191, extraído de build-diaria-dashboard-data.ts)", () => {
  it("verde: success_rate >= 80 e streak 0", () => {
    assert.equal(classifySourceStatus(80, 0), "verde");
    assert.equal(classifySourceStatus(100, 0), "verde");
  });

  it("verde vira amarelo se houver QUALQUER streak, mesmo com rate alta", () => {
    assert.equal(classifySourceStatus(95, 1), "amarelo");
  });

  it("amarelo: rate >= 50 E streak <= 2 (AND, finding #3 do #2132)", () => {
    assert.equal(classifySourceStatus(60, 2), "amarelo");
    assert.equal(classifySourceStatus(50, 0), "amarelo");
  });

  it("vermelho: rate alta mas streak >= 3 (AND — rate sozinha não salva)", () => {
    assert.equal(classifySourceStatus(90, 3), "vermelho");
    assert.equal(classifySourceStatus(90, 10), "vermelho");
  });

  it("vermelho: rate < 50", () => {
    assert.equal(classifySourceStatus(49, 0), "vermelho");
    assert.equal(classifySourceStatus(0, 0), "vermelho");
  });
});

describe("buildSourceHealthRows (#5191)", () => {
  it("computa success_rate_pct e consecutive_failures por fonte", () => {
    const health: HealthFile = {
      sources: {
        Boa: entry([{ outcome: "ok", timestamp: "t1" }, { outcome: "ok", timestamp: "t2" }]),
        Ruim: entry([{ outcome: "fail", timestamp: "t1" }, { outcome: "timeout", timestamp: "t2" }]),
      },
    };
    const rows = buildSourceHealthRows(health);
    const boa = rows.find((r) => r.name === "Boa")!;
    const ruim = rows.find((r) => r.name === "Ruim")!;
    assert.equal(boa.success_rate_pct, 100);
    assert.equal(boa.consecutive_failures, 0);
    assert.equal(boa.status, "verde");
    assert.equal(ruim.success_rate_pct, 0);
    assert.equal(ruim.consecutive_failures, 2);
    assert.equal(ruim.status, "vermelho");
  });

  it("attempts=0 não divide por zero — success_rate_pct 0", () => {
    const health: HealthFile = { sources: { Nova: entry([]) } };
    const rows = buildSourceHealthRows(health);
    assert.equal(rows[0].success_rate_pct, 0);
    assert.equal(rows[0].consecutive_failures, 0);
  });

  it("#1576/#1665: empty NO MEIO da streak não conta e interrompe a contagem pra trás", () => {
    // Do mais antigo pro mais recente: fail, empty, fail, fail.
    // O streak conta só a partir do fim: as 2 últimas (fail, fail) são
    // falhas duras; o `empty` anterior a elas ENCERRA a busca — o `fail`
    // mais antigo (antes do empty) nunca é alcançado.
    const health: HealthFile = {
      sources: {
        X: entry([
          { outcome: "fail", timestamp: "t1" },
          { outcome: "empty", timestamp: "t2" },
          { outcome: "fail", timestamp: "t3" },
          { outcome: "fail", timestamp: "t4" },
        ]),
      },
    };
    const rows = buildSourceHealthRows(health);
    assert.equal(rows[0].consecutive_failures, 2);
  });

  it("#1576/#1665: empty na BORDA final zera o streak mesmo com falhas antes dela", () => {
    const health: HealthFile = {
      sources: {
        X: entry([
          { outcome: "fail", timestamp: "t1" },
          { outcome: "fail", timestamp: "t2" },
          { outcome: "empty", timestamp: "t3" },
        ]),
      },
    };
    const rows = buildSourceHealthRows(health);
    assert.equal(rows[0].consecutive_failures, 0);
    // success_rate_pct usa attempts/successes agregados do entry, não
    // recent_outcomes — aqui forçamos successes=0 via entry() helper
    // (nenhum outcome "ok"), então cai em vermelho por rate baixa, não por
    // streak — confirma que a regra empty realmente zerou o streak (senão
    // seria vermelho por streak=3 também, o que não provaria nada).
    assert.equal(rows[0].status, "vermelho");
  });

  it("#1576/#1665: empty na BORDA inicial (mais antiga) não afeta streak do fim", () => {
    const health: HealthFile = {
      sources: {
        X: entry([
          { outcome: "empty", timestamp: "t1" },
          { outcome: "fail", timestamp: "t2" },
          { outcome: "timeout", timestamp: "t3" },
        ]),
      },
    };
    const rows = buildSourceHealthRows(health);
    assert.equal(rows[0].consecutive_failures, 2);
  });
});

describe("sortRowsBySeverity (#5191)", () => {
  it("ordena vermelho > amarelo > verde", () => {
    const health: HealthFile = {
      sources: {
        Verde: entry([{ outcome: "ok", timestamp: "t1" }]),
        Vermelho: entry([{ outcome: "fail", timestamp: "t1" }, { outcome: "fail", timestamp: "t2" }, { outcome: "fail", timestamp: "t3" }]),
        Amarelo: entry([{ outcome: "fail", timestamp: "t1" }, { outcome: "ok", timestamp: "t2" }]),
      },
    };
    const rows = sortRowsBySeverity(buildSourceHealthRows(health));
    assert.deepEqual(rows.map((r) => r.name), ["Vermelho", "Amarelo", "Verde"]);
  });
});

describe("formatOverviewTable (#5191)", () => {
  it("lista vazia produz mensagem clara, não tabela quebrada", () => {
    const out = formatOverviewTable([]);
    assert.match(out, /nenhuma fonte registrada/i);
  });

  it("inclui nome, ícone de status e ratio de cada fonte", () => {
    const health: HealthFile = {
      sources: { "MIT Tech Review": entry([{ outcome: "ok", timestamp: "t1" }]) },
    };
    const out = formatOverviewTable(buildSourceHealthRows(health));
    assert.match(out, /MIT Tech Review/);
    assert.match(out, /🟢/);
    assert.match(out, /1\/1/);
  });
});

describe("readSourceLog / tailSourceLog (#5191)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "source-health-report-"));
    mkdirSync(join(tmp, "data/sources"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retorna [] quando o arquivo não existe (fail-soft, não lança)", () => {
    assert.deepEqual(readSourceLog(tmp, "inexistente"), []);
  });

  it("lê JSONL, ignora linhas malformadas", () => {
    const entries: SourceLogEntry[] = [
      { timestamp: "t1", source: "X", edition: "260418", outcome: "ok", duration_ms: 100, reason: null, query_used: "q", articles_count: 1, articles: [{ title: "A" }] },
      { timestamp: "t2", source: "X", edition: null, outcome: "fail", duration_ms: null, reason: "timeout_fetch", query_used: null, articles_count: 0, articles: [] },
    ];
    const lines = [JSON.stringify(entries[0]), "{ not json", JSON.stringify(entries[1]), ""].join("\n");
    writeFileSync(join(tmp, "data/sources/x.jsonl"), lines, "utf8");

    const result = readSourceLog(tmp, "x");
    assert.equal(result.length, 2);
    assert.equal(result[0].outcome, "ok");
    assert.equal(result[1].outcome, "fail");
  });

  it("tailSourceLog pega as últimas N em ordem cronológica reversa", () => {
    const entries: SourceLogEntry[] = Array.from({ length: 25 }, (_, i) => ({
      timestamp: `t${i}`,
      source: "X",
      edition: null,
      outcome: "ok",
      duration_ms: null,
      reason: null,
      query_used: null,
      articles_count: 0,
      articles: [],
    }));
    const tail = tailSourceLog(entries, 20);
    assert.equal(tail.length, 20);
    // mais recente (t24) primeiro
    assert.equal(tail[0].timestamp, "t24");
    assert.equal(tail[19].timestamp, "t5");
  });
});

describe("formatSourceDetail (#5191)", () => {
  it("sem entradas, mensagem clara", () => {
    const out = formatSourceDetail("AI Breakfast", []);
    assert.match(out, /nenhuma execução registrada/i);
  });

  it("formata entrada com query, artigos e reason", () => {
    const tail: SourceLogEntry[] = [
      {
        timestamp: "2026-04-17T14:22:00.000Z",
        source: "AI Breakfast",
        edition: "260417",
        outcome: "timeout",
        duration_ms: 180000,
        reason: "consecutive_fetch_errors",
        query_used: "site:aibreakfast.beehiiv.com AI",
        articles_count: 0,
        articles: [],
      },
    ];
    const out = formatSourceDetail("AI Breakfast", tail);
    assert.match(out, /timeout/);
    assert.match(out, /consecutive_fetch_errors/);
    assert.match(out, /site:aibreakfast\.beehiiv\.com/);
    assert.match(out, /260417/);
  });
});
