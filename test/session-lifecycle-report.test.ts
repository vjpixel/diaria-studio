/**
 * test/session-lifecycle-report.test.ts (#6624)
 *
 * Cobre o miolo PURO (`scripts/lib/session-lifecycle-report.ts`) que agrega
 * `data/session-lifecycle.jsonl` — a instrumentação que responde à pergunta
 * da issue: sessões coordenadoras terminam sem chamar `end` com que
 * frequência?
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionLifecycleLine,
  parseSessionLifecycleLog,
  summarizeSessionLifecycle,
} from "../scripts/lib/session-lifecycle-report.ts";

describe("parseSessionLifecycleLine", () => {
  it("parseia uma linha válida 'ended'", () => {
    const line = JSON.stringify({
      event: "ended",
      kind: "overnight",
      machineTag: "helios",
      sessionId: "s1",
      ts: "2026-08-28T12:00:00.000Z",
      ageMs: 3600000,
    });
    const parsed = parseSessionLifecycleLine(line);
    assert.ok(parsed);
    assert.equal(parsed!.event, "ended");
    assert.equal(parsed!.sessionId, "s1");
  });

  it("linha vazia/whitespace → null", () => {
    assert.equal(parseSessionLifecycleLine(""), null);
    assert.equal(parseSessionLifecycleLine("   "), null);
  });

  it("JSON inválido → null, nunca lança", () => {
    assert.equal(parseSessionLifecycleLine("{not valid json"), null);
  });

  it("shape inesperado (event fora do enum, kind ausente) → null", () => {
    assert.equal(parseSessionLifecycleLine(JSON.stringify({ event: "bogus", kind: "overnight", sessionId: "x" })), null);
    assert.equal(parseSessionLifecycleLine(JSON.stringify({ event: "ended", sessionId: "x" })), null);
    assert.equal(parseSessionLifecycleLine(JSON.stringify({ event: "ended", kind: "overnight" })), null);
  });
});

describe("parseSessionLifecycleLog", () => {
  it("parseia múltiplas linhas, descarta as inválidas silenciosamente", () => {
    const content = [
      JSON.stringify({ event: "ended", kind: "overnight", machineTag: "helios", sessionId: "a", ts: "2026-08-28T00:00:00.000Z" }),
      "{corrompida",
      JSON.stringify({ event: "gc-removed-without-end", kind: "develop", machineTag: "Neo", sessionId: "b", ts: "2026-08-28T01:00:00.000Z" }),
      "",
    ].join("\n");
    const events = parseSessionLifecycleLog(content);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.sessionId), ["a", "b"]);
  });

  it("conteúdo vazio → array vazio", () => {
    assert.deepEqual(parseSessionLifecycleLog(""), []);
  });
});

describe("summarizeSessionLifecycle", () => {
  it("sem eventos: totalEvents 0, ratio null (nunca NaN/Infinity)", () => {
    const summary = summarizeSessionLifecycle([]);
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.gcRemovedWithoutEndRatio, null);
    assert.deepEqual(summary.byKind, {});
  });

  it("agrega ended vs gc-removed-without-end, calcula a proporção certa", () => {
    const events = [
      { event: "ended" as const, kind: "overnight" as const, machineTag: "helios", sessionId: "a", ts: "t" },
      { event: "ended" as const, kind: "overnight" as const, machineTag: "helios", sessionId: "b", ts: "t" },
      { event: "gc-removed-without-end" as const, kind: "develop" as const, machineTag: "Neo", sessionId: "c", ts: "t" },
    ];
    const summary = summarizeSessionLifecycle(events);
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.endedCount, 2);
    assert.equal(summary.gcRemovedWithoutEndCount, 1);
    assert.equal(summary.gcRemovedWithoutEndRatio, 1 / 3);
  });

  it("decompõe por kind", () => {
    const events = [
      { event: "ended" as const, kind: "overnight" as const, machineTag: "helios", sessionId: "a", ts: "t" },
      { event: "gc-removed-without-end" as const, kind: "overnight" as const, machineTag: "helios", sessionId: "b", ts: "t" },
      { event: "ended" as const, kind: "continuo" as const, machineTag: "helios", sessionId: "c", ts: "t" },
    ];
    const summary = summarizeSessionLifecycle(events);
    assert.deepEqual(summary.byKind.overnight, { ended: 1, gcRemovedWithoutEnd: 1 });
    assert.deepEqual(summary.byKind.continuo, { ended: 1, gcRemovedWithoutEnd: 0 });
  });
});
