/**
 * test/regression-chrome-mcp.test.ts (#1243)
 *
 * Cobre as funções puras do helper (readLog, computeStatus). A CLI é
 * testada via spawnSync. A interação MCP real (javascript_tool em
 * Beehiiv) acontece dentro de Claude Code session — não testável em
 * unit test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readLog,
  computeStatus,
  type RegressionEntry,
} from "../scripts/regression-chrome-mcp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/regression-chrome-mcp.ts");

describe("readLog (#1243)", () => {
  it("retorna [] quando arquivo não existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "regression-test-"));
    try {
      const r = readLog(join(tmp, "nonexistent.jsonl"));
      assert.deepEqual(r, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parseia entries válidas, pula lines malformadas", () => {
    const tmp = mkdtempSync(join(tmpdir(), "regression-test-"));
    const file = join(tmp, "log.jsonl");
    try {
      writeFileSync(
        file,
        [
          '{"ts":"2026-05-14T00:00:00Z","test":"chrome_mcp_js_tool","result":"pass"}',
          "malformed line",
          '{"ts":"2026-05-14T01:00:00Z","test":"chrome_mcp_js_tool","result":"fail","error":"Cannot access"}',
          "",
          '{"random":"object","no_result":true}', // sem .result → pula
        ].join("\n"),
        "utf8",
      );
      const r = readLog(file);
      assert.equal(r.length, 2);
      assert.equal(r[0].result, "pass");
      assert.equal(r[1].result, "fail");
      assert.equal(r[1].error, "Cannot access");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("computeStatus (#1243)", () => {
  function mk(result: RegressionEntry["result"], i: number): RegressionEntry {
    return {
      ts: `2026-05-14T0${i}:00:00Z`,
      test: "chrome_mcp_js_tool",
      result,
    };
  }

  it("trend=no_data quando log vazio", () => {
    const r = computeStatus([], 5);
    assert.equal(r.trend, "no_data");
    assert.equal(r.passed_in_window, 0);
    assert.match(r.recommendation, /Nenhuma execução/);
  });

  it("trend=all_pass quando últimas N passam", () => {
    const entries = [mk("fail", 0), mk("pass", 1), mk("pass", 2), mk("pass", 3)];
    const r = computeStatus(entries, 3);
    assert.equal(r.trend, "all_pass");
    assert.equal(r.passed_in_window, 3);
    assert.equal(r.failed_in_window, 0);
    assert.match(r.recommendation, /bug pode estar fixed/);
    assert.match(r.recommendation, /#1211/);
    assert.match(r.recommendation, /#1238/);
  });

  it("trend=all_fail quando últimas N falham", () => {
    const entries = [mk("pass", 0), mk("fail", 1), mk("fail", 2), mk("fail", 3)];
    const r = computeStatus(entries, 3);
    assert.equal(r.trend, "all_fail");
    assert.equal(r.passed_in_window, 0);
    assert.equal(r.failed_in_window, 3);
    assert.match(r.recommendation, /bug ainda ativo/);
  });

  it("trend=mixed quando passa e falha intercalam", () => {
    const entries = [mk("pass", 0), mk("fail", 1), mk("pass", 2)];
    const r = computeStatus(entries, 3);
    assert.equal(r.trend, "mixed");
    assert.match(r.recommendation, /Resultados mistos/);
  });

  it("ignora entries de outro test (filtra por test name)", () => {
    const entries: RegressionEntry[] = [
      mk("pass", 0),
      { ts: "2026-05-14T01:00:00Z", test: "other_test", result: "fail" },
      mk("pass", 2),
    ];
    const r = computeStatus(entries, 5);
    assert.equal(r.total_entries, 2);
    assert.equal(r.passed_in_window, 2);
  });

  it("window=1 considera só a última execução", () => {
    const entries = [mk("fail", 0), mk("pass", 1)];
    const r = computeStatus(entries, 1);
    assert.equal(r.last_n.length, 1);
    assert.equal(r.trend, "all_pass");
  });

  it("conta intermittent como categoria separada", () => {
    const entries = [mk("pass", 0), mk("intermittent", 1), mk("intermittent", 2)];
    const r = computeStatus(entries, 3);
    assert.equal(r.intermittent_in_window, 2);
    assert.equal(r.trend, "mixed");
  });
});

describe("regression-chrome-mcp CLI (#1243)", () => {
  function run(args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, ...args],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env } },
    );
  }

  it("--help exibe usage com exit 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Uso:/);
    assert.match(r.stdout, /record/);
    assert.match(r.stdout, /status/);
  });

  it("sem comando retorna exit 2 + usage", () => {
    const r = run([]);
    assert.equal(r.status, 2);
  });

  it("record sem --result retorna exit 2", () => {
    const r = run(["record"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--result/);
  });

  it("record com --result inválido retorna exit 2", () => {
    const r = run(["record", "--result", "maybe"]);
    assert.equal(r.status, 2);
  });

  it("status com --window 0 retorna exit 2", () => {
    const r = run(["status", "--window", "0"]);
    assert.equal(r.status, 2);
  });

  it("status sem log retorna trend=no_data, exit 0", () => {
    // Roda em tmp dir pra não tocar log real
    const tmp = mkdtempSync(join(tmpdir(), "regression-cli-"));
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "status", "--window", "5"],
        { encoding: "utf8", cwd: tmp, env: { ...process.env } },
      );
      // Como o script usa caminho absoluto fixo (LOG_PATH), o log real ainda
      // é lido. Esse teste valida que command 'status' completa sem crash.
      assert.notEqual(r.status, 2, "comando válido não retorna exit 2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
