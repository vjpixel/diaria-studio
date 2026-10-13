/**
 * test/clarice-toggle-audit-halt.test.ts (#10096, #10105)
 *
 * - `parseToggleCli`: `--set` dos kill switches da Clarice exige `--reason`
 *   (#10105 — a reativação de 01/10/2026 não deixou motivo nem máquina).
 * - `clarice-envio-halt.ts`: parada durável por fila insuficiente (#10096).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildToggleChangeEvent, parseToggleCli, resolveToggleAudit } from "../scripts/lib/clarice-toggle-audit.ts";
import {
  clearClariceEnvioHalt,
  CLARICE_ENVIO_HALT_MAX_AGE_DAYS,
  describeHaltForReport,
  evaluateHaltStaleness,
  HALT_STALE_REPORT_SUFFIX,
  readClariceEnvioHalt,
  writeClariceEnvioHalt,
  type ClariceEnvioHalt,
} from "../scripts/lib/clarice-envio-halt.ts";
import { classifyEnvioReportId } from "../scripts/lib/clarice-envio-alarm.ts";

describe("parseToggleCli (#10105)", () => {
  it("sem args => leitura", () => {
    assert.deepEqual(parseToggleCli([], "clarice-envio-enabled"), { kind: "read" });
  });
  it("--set enabled SEM --reason => erro (nunca escreve)", () => {
    const r = parseToggleCli(["--set", "enabled"], "clarice-envio-enabled");
    assert.equal(r.kind, "error");
    if (r.kind === "error") assert.match(r.message, /exige --reason/);
  });
  it("--set disabled --reason vazio => erro", () => {
    assert.equal(parseToggleCli(["--set", "disabled", "--reason", "  "], "clarice-novos-enabled").kind, "error");
  });
  it("--set sem valor => erro, não leitura", () => {
    assert.equal(parseToggleCli(["--set", "--reason", "x"], "clarice-envio-enabled").kind, "error");
  });
  it("--set valor inválido => erro", () => {
    assert.equal(parseToggleCli(["--set", "on", "--reason", "x"], "clarice-envio-enabled").kind, "error");
  });
  it("--set enabled --reason \"...\" => escrita com motivo", () => {
    assert.deepEqual(parseToggleCli(["--set", "enabled", "--reason", "decisão em #8099"], "clarice-envio-enabled"), {
      kind: "set",
      enabled: true,
      reason: "decisão em #8099",
    });
  });
});

describe("resolveToggleAudit / buildToggleChangeEvent (#10105)", () => {
  it("sessionId vem do env; vazio vira null", () => {
    assert.equal(resolveToggleAudit({ machine: "m", env: { CLAUDE_CODE_SESSION_ID: "abc" } }).sessionId, "abc");
    assert.equal(resolveToggleAudit({ machine: "m", env: { CLAUDE_CODE_SESSION_ID: " " } }).sessionId, null);
    assert.equal(resolveToggleAudit({ machine: "m", env: {} }).sessionId, null);
  });
  it("evento: warn ao ligar, info ao pausar; detalhes carregam proveniência", () => {
    const on = buildToggleChangeEvent("clarice-envio-enabled", { enabled: true, updatedAt: "t", machine: "neo", sessionId: null, reason: "r" });
    assert.equal(on.level, "warn");
    assert.match(on.message, /máquina: neo/);
    const off = buildToggleChangeEvent("clarice-envio-enabled", { enabled: false, updatedAt: "t", machine: null, sessionId: null, reason: null });
    assert.equal(off.level, "info");
    assert.match(off.message, /motivo: não informado/);
  });
});

const HALT: ClariceEnvioHalt = {
  kind: "fila-insuficiente",
  since: "2026-10-11T22:10:00.000Z",
  reportId: "envio-261011",
  cycle: "2609-10",
  queueAvailable: 5794,
  desiredVolume: 44283,
  baseVolume: 40257,
};

describe("clarice-envio-halt (#10096)", () => {
  it("ausente => halted:false; escrita => leitura devolve a parada", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-halt-"));
    assert.deepEqual(readClariceEnvioHalt(root), { halted: false });
    writeClariceEnvioHalt(root, HALT);
    assert.deepEqual(readClariceEnvioHalt(root), { halted: true, invalid: false, halt: HALT });
    rmSync(root, { recursive: true, force: true });
  });

  it("arquivo ilegível ou com shape errado => parada ATIVA (fail-safe)", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-halt-bad-"));
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(resolve(root, "data", "clarice-envio-halt.json"), "{{", "utf8");
    const a = readClariceEnvioHalt(root);
    assert.equal(a.halted, true);
    assert.ok(a.halted && a.invalid);
    writeFileSync(resolve(root, "data", "clarice-envio-halt.json"), JSON.stringify({ kind: "outra" }), "utf8");
    const b = readClariceEnvioHalt(root);
    assert.ok(b.halted && b.invalid);
    rmSync(root, { recursive: true, force: true });
  });

  it("clear remove a parada e registra evento no run-log; sem parada devolve false", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-halt-clear-"));
    assert.equal(clearClariceEnvioHalt(root, "x", { logRunEvent: false }), false);
    writeClariceEnvioHalt(root, HALT);
    assert.equal(clearClariceEnvioHalt(root, "fila do ciclo novo comporta", { machine: "300" }), true);
    assert.deepEqual(readClariceEnvioHalt(root), { halted: false });
    const ev = JSON.parse(readFileSync(resolve(root, "data", "run-log.jsonl"), "utf8").trim());
    assert.equal(ev.agent, "clarice-envio-halt");
    assert.equal(ev.details.reason, "fila do ciclo novo comporta");
    assert.equal(ev.details.halt.cycle, "2609-10");
    rmSync(root, { recursive: true, force: true });
  });

  it("relatório: cita o comando de --clear e avisa quando o ciclo mudou", () => {
    const same = describeHaltForReport({ halted: true, invalid: false, halt: HALT }, "2609-10");
    assert.match(same, /--clear --reason/);
    assert.doesNotMatch(same, /ciclo mudou/);
    const changed = describeHaltForReport({ halted: true, invalid: false, halt: HALT }, "2610-11");
    assert.match(changed, /ciclo mudou desde a parada \(2609-10 → 2610-11\)/);
  });
});

describe("evaluateHaltStaleness (#10118)", () => {
  const since = Date.parse(HALT.since);
  const at = (days: number) => new Date(since + days * 86_400_000);

  it("limite nomeado é 3 dias", () => {
    assert.equal(CLARICE_ENVIO_HALT_MAX_AGE_DAYS, 3);
  });
  it("dentro do limite e mesmo ciclo => não vencida (pausa legítima)", () => {
    assert.deepEqual(evaluateHaltStaleness(HALT, at(1), "2609-10"), { stale: false });
    assert.deepEqual(evaluateHaltStaleness(HALT, at(3), "2609-10"), { stale: false }, "exatamente no limite ainda vale");
  });
  it("passou do limite => vencida, com a idade no motivo", () => {
    const r = evaluateHaltStaleness(HALT, at(3.5), "2609-10");
    assert.ok(r.stale);
    if (r.stale) assert.deepEqual(r.reasons, [`parada há mais de 3 dias (desde ${HALT.since})`]);
  });
  it("ciclo mudou => vencida mesmo no 1º dia", () => {
    const r = evaluateHaltStaleness(HALT, at(0.5), "2610-11");
    assert.ok(r.stale);
    if (r.stale) assert.match(r.reasons.join(), /ciclo mudou desde a parada \(2609-10 → 2610-11\)/);
  });
  it("ciclo atual desconhecido (null) só desliga o critério de ciclo", () => {
    assert.deepEqual(evaluateHaltStaleness(HALT, at(1), null), { stale: false });
    assert.equal(evaluateHaltStaleness(HALT, at(5), null).stale, true);
  });
  it("since ilegível => vencida (fail-toward-alarming)", () => {
    const r = evaluateHaltStaleness({ ...HALT, since: "ontem" }, at(0), "2609-10");
    assert.ok(r.stale);
    if (r.stale) assert.match(r.reasons[0], /ilegível/);
  });
  it("limite injetável", () => {
    assert.equal(evaluateHaltStaleness(HALT, at(2), "2609-10", 1).stale, true);
  });
  it("sufixo do relatório vencido NÃO é pausa legítima pro alarme", () => {
    assert.equal(classifyEnvioReportId(`envio-261015${HALT_STALE_REPORT_SUFFIX}`, "261015"), "alarm");
    assert.equal(classifyEnvioReportId("envio-261015-fila-insuficiente-pendente", "261015"), "ok");
  });
});
