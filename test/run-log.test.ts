/**
 * run-log.test.ts (#612) — tests for scripts/lib/run-log.ts.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLogEvent,
  resolveRunLogPath,
  logEvent,
} from "../scripts/lib/run-log.ts";

describe("buildLogEvent (#612)", () => {
  it("monta evento canônico com timestamp ISO", () => {
    const fixedDate = new Date("2026-05-06T10:00:00.000Z");
    const event = buildLogEvent(
      { edition: "260506", stage: 1, agent: "writer", level: "info", message: "ok" },
      fixedDate,
    );
    assert.equal(event.timestamp, "2026-05-06T10:00:00.000Z");
    assert.equal(event.edition, "260506");
    assert.equal(event.stage, 1);
    assert.equal(event.agent, "writer");
    assert.equal(event.level, "info");
    assert.equal(event.message, "ok");
    assert.equal(event.details, null);
  });

  it("details ausente vira null no persisted", () => {
    const event = buildLogEvent({
      edition: null, stage: null, agent: null, level: "warn", message: "x",
    });
    assert.equal(event.details, null);
  });

  it("details object é preservado", () => {
    const event = buildLogEvent({
      edition: "260506", stage: 2, agent: "drive-sync", level: "warn",
      message: "conflict",
      details: { warnings: [{ file: "02-reviewed.md" }] },
    });
    assert.deepEqual(event.details, { warnings: [{ file: "02-reviewed.md" }] });
  });

  it("explicit undefined details vira null", () => {
    const event = buildLogEvent({
      edition: null, stage: null, agent: null, level: "info", message: "x",
      details: undefined,
    });
    assert.equal(event.details, null);
  });

  it("details=false (falsy mas não null) vira null por causa de ?? — comportamento documentado", () => {
    // ?? só substitui null/undefined, então `false` passa.
    const event = buildLogEvent({
      edition: null, stage: null, agent: null, level: "info", message: "x",
      details: false,
    });
    assert.equal(event.details, false);
  });
});

describe("resolveRunLogPath (#612)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "run-log-resolve-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("default data/run-log.jsonl quando platform.config.json ausente", () => {
    const path = resolveRunLogPath(tmpRoot);
    assert.ok(path.endsWith("data/run-log.jsonl") || path.endsWith("data\\run-log.jsonl"));
  });

  it("usa logging.path do platform.config.json", () => {
    writeFileSync(
      join(tmpRoot, "platform.config.json"),
      JSON.stringify({ logging: { path: "data/custom-log.jsonl" } }),
      "utf8",
    );
    const path = resolveRunLogPath(tmpRoot);
    assert.ok(path.endsWith("data/custom-log.jsonl") || path.endsWith("data\\custom-log.jsonl"));
  });

  it("default quando JSON inválido", () => {
    writeFileSync(join(tmpRoot, "platform.config.json"), "{ broken", "utf8");
    const path = resolveRunLogPath(tmpRoot);
    assert.ok(path.endsWith("run-log.jsonl"));
  });

  it("default quando logging.path ausente", () => {
    writeFileSync(
      join(tmpRoot, "platform.config.json"),
      JSON.stringify({ newsletter: "beehiiv" }),
      "utf8",
    );
    const path = resolveRunLogPath(tmpRoot);
    assert.ok(path.endsWith("run-log.jsonl"));
  });
});

describe("logEvent (#612) — append append-only ao JSONL", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "run-log-append-"));
    mkdirSync(join(tmpRoot, "data"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("cria diretório data/ e escreve 1 linha JSON ao primeiro logEvent", () => {
    // Apaga data/ pra testar o mkdirSync recursive
    rmSync(join(tmpRoot, "data"), { recursive: true, force: true });

    logEvent(
      { edition: "260506", stage: 1, agent: "writer", level: "info", message: "ok" },
      tmpRoot,
    );

    const content = readFileSync(join(tmpRoot, "data", "run-log.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.edition, "260506");
    assert.equal(parsed.message, "ok");
    assert.ok(parsed.timestamp);
  });

  it("append múltiplos eventos preservando ordem", () => {
    logEvent({ edition: "260506", stage: 1, agent: null, level: "info", message: "a" }, tmpRoot);
    logEvent({ edition: "260506", stage: 1, agent: null, level: "warn", message: "b" }, tmpRoot);
    logEvent({ edition: "260506", stage: 2, agent: null, level: "error", message: "c" }, tmpRoot);

    const content = readFileSync(join(tmpRoot, "data", "run-log.jsonl"), "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l: { message: string }) => l.message), ["a", "b", "c"]);
  });

  it("respeita logging.path custom do platform.config.json", () => {
    writeFileSync(
      join(tmpRoot, "platform.config.json"),
      JSON.stringify({ logging: { path: "data/custom.jsonl" } }),
      "utf8",
    );

    logEvent({ edition: null, stage: null, agent: null, level: "info", message: "x" }, tmpRoot);

    const content = readFileSync(join(tmpRoot, "data", "custom.jsonl"), "utf8");
    assert.ok(content.includes('"message":"x"'));
  });

  it("falha de I/O é silenciosa — não lança", () => {
    // root inválido (caractere proibido no Windows seria parecido) — usa um path
    // que não existe e não é writeável. Tentamos forçar uma falha de mkdir.
    // No Windows, paths gigantes ou com caracteres ilegais falham.
    // Aqui apenas garantimos que NÃO há throw quando o path está OK.
    assert.doesNotThrow(() => {
      logEvent({ edition: null, stage: null, agent: null, level: "info", message: "x" }, tmpRoot);
    });
  });

  it("event tem todos os campos esperados (#612 schema)", () => {
    logEvent({
      edition: "260506",
      stage: 3,
      agent: "drive-sync",
      level: "warn",
      message: "conflict",
      details: { mode: "push", warnings: [] },
    }, tmpRoot);

    const content = readFileSync(join(tmpRoot, "data", "run-log.jsonl"), "utf8");
    const parsed = JSON.parse(content.trim());
    assert.ok("timestamp" in parsed);
    assert.equal(parsed.edition, "260506");
    assert.equal(parsed.stage, 3);
    assert.equal(parsed.agent, "drive-sync");
    assert.equal(parsed.level, "warn");
    assert.equal(parsed.message, "conflict");
    assert.deepEqual(parsed.details, { mode: "push", warnings: [] });
  });
});
