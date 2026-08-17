/**
 * test/overnight-watchdog.test.ts (#2688)
 *
 * Testes de regressão para a lógica de detecção de stall do watchdog externo.
 * Usa timestamps de fixture — sem depender do relógio real (#633).
 *
 * Cobre:
 *   - detectStall: caso positivo (>60 min) e negativo (atividade recente)
 *   - computeLastActivity: max(mtime, log-ts), ambos null, só um disponível
 *   - isDeduped: sem eventos, evento recente, evento antigo, evento já retomado
 *   - findActiveRun: plan.json sem report → ativo; com report → não ativo; dirs inválidos → ignorado
 *   - getLastRunLogActivity: filtra agent/edition, retorna max, ignora linhas malformadas
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  detectStall,
  computeLastActivity,
  isDeduped,
  findActiveRun,
  getLastRunLogActivity,
  isSelfInflictedPlanMtime,
  resolveRunActivity,
  diagnoseWatchdogActivity,
  readPlanForStallHandling,
  WATCHDOG_IO_TIMEOUT_MS,
  hasHealthyIdleSession,
  runAllWatchedKinds,
  WATCHED_KINDS,
  type StallEvent,
} from "../scripts/overnight-watchdog.ts";
import { registerSession, heartbeat } from "../scripts/lib/session-registry.ts";
import type { PlanFileReaders } from "../scripts/overnight-statusline.ts";

// ---------------------------------------------------------------------------
// detectStall
// ---------------------------------------------------------------------------

describe("detectStall (#2688)", () => {
  // "now" fixo: 2026-07-01T10:00:00Z = 1751364000000 ms
  const NOW = new Date("2026-07-01T10:00:00Z").getTime();
  const MIN = 60_000;

  it("detecta stall quando atividade > 60 min atrás (caso positivo)", () => {
    const lastActivity = NOW - 61 * MIN; // 61 min atrás
    assert.equal(detectStall(lastActivity, NOW, 60), true);
  });

  it("detecta stall exatamente no limiar (= 60 min)", () => {
    const lastActivity = NOW - 60 * MIN;
    assert.equal(detectStall(lastActivity, NOW, 60), true);
  });

  it("NÃO detecta stall quando atividade < 60 min atrás (caso negativo)", () => {
    const lastActivity = NOW - 59 * MIN; // 59 min atrás
    assert.equal(detectStall(lastActivity, NOW, 60), false);
  });

  it("NÃO detecta stall quando atividade foi há 1 min", () => {
    const lastActivity = NOW - 1 * MIN;
    assert.equal(detectStall(lastActivity, NOW, 60), false);
  });

  it("threshold customizado: 30 min", () => {
    const lastActivity = NOW - 31 * MIN;
    assert.equal(detectStall(lastActivity, NOW, 30), true);
  });

  it("threshold customizado: 30 min — caso negativo (29 min)", () => {
    const lastActivity = NOW - 29 * MIN;
    assert.equal(detectStall(lastActivity, NOW, 30), false);
  });

  it("lastActivityMs=0 (desconhecido) detecta como stall com now recente", () => {
    // 0 representa "sem dado", e NOW - 0 >> threshold → stall
    assert.equal(detectStall(0, NOW, 60), true);
  });
});

// ---------------------------------------------------------------------------
// computeLastActivity
// ---------------------------------------------------------------------------

describe("computeLastActivity (#2688)", () => {
  const T = new Date("2026-07-01T10:00:00Z").getTime();

  it("retorna plan.json mtime quando é mais recente", () => {
    const result = computeLastActivity(T, T - 5 * 60_000);
    assert.equal(result.ts, T);
    assert.equal(result.source, "plan.json mtime");
  });

  it("retorna run-log timestamp quando é mais recente", () => {
    const result = computeLastActivity(T - 5 * 60_000, T);
    assert.equal(result.ts, T);
    assert.equal(result.source, "run-log");
  });

  it("empate (iguais) → plan.json mtime", () => {
    const result = computeLastActivity(T, T);
    assert.equal(result.ts, T);
    assert.equal(result.source, "plan.json mtime");
  });

  it("ambos null → ts=0, source=nenhuma", () => {
    const result = computeLastActivity(null, null);
    assert.equal(result.ts, 0);
    assert.equal(result.source, "nenhuma");
  });

  it("só plan.json disponível (logTs=null) → usa plan.json", () => {
    const result = computeLastActivity(T, null);
    assert.equal(result.ts, T);
    assert.equal(result.source, "plan.json mtime");
  });

  it("só run-log disponível (planMtime=null) → usa run-log", () => {
    const result = computeLastActivity(null, T);
    assert.equal(result.ts, T);
    assert.equal(result.source, "run-log");
  });
});

// ---------------------------------------------------------------------------
// isDeduped
// ---------------------------------------------------------------------------

describe("isDeduped (#2688)", () => {
  const NOW = new Date("2026-07-01T10:00:00Z").getTime();
  const WIN = 30 * 60_000; // 30 min window

  it("lista vazia → não é duplicata", () => {
    assert.equal(isDeduped([], WIN, NOW), false);
  });

  it("último stall há 10 min (dentro da janela) → é duplicata", () => {
    const events: StallEvent[] = [
      { at: new Date(NOW - 10 * 60_000).toISOString(), reason: "unknown", resumed_at: null },
    ];
    assert.equal(isDeduped(events, WIN, NOW), true);
  });

  it("último stall há 35 min (fora da janela) → NÃO é duplicata", () => {
    const events: StallEvent[] = [
      { at: new Date(NOW - 35 * 60_000).toISOString(), reason: "unknown", resumed_at: null },
    ];
    assert.equal(isDeduped(events, WIN, NOW), false);
  });

  it("último stall já retomado (resumed_at presente) → NÃO é duplicata", () => {
    const events: StallEvent[] = [
      {
        at: new Date(NOW - 10 * 60_000).toISOString(),
        reason: "unknown",
        resumed_at: new Date(NOW - 5 * 60_000).toISOString(),
      },
    ];
    assert.equal(isDeduped(events, WIN, NOW), false);
  });

  it("múltiplos stalls — verifica só o último", () => {
    const events: StallEvent[] = [
      { at: new Date(NOW - 120 * 60_000).toISOString(), reason: "unknown", resumed_at: null },
      { at: new Date(NOW - 5 * 60_000).toISOString(), reason: "unknown", resumed_at: null },
    ];
    assert.equal(isDeduped(events, WIN, NOW), true);
  });
});

// ---------------------------------------------------------------------------
// findActiveRun
// ---------------------------------------------------------------------------

describe("findActiveRun (#2688)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-find-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("nenhum diretório overnight → null", () => {
    assert.equal(findActiveRun(tmpRoot), null);
  });

  it("plan.json sem report.md → rodada ativa detectada", () => {
    const dir = join(tmpRoot, "data", "overnight", "260701");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "2026-07-01T00:00:00Z", stall_events: [] }), "utf-8");

    const result = findActiveRun(tmpRoot);
    assert.notEqual(result, null);
    assert.equal(result!.aammdd, "260701");
  });

  it("plan.json COM report.md → rodada concluída, não detecta stall", () => {
    const dir = join(tmpRoot, "data", "overnight", "260701");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "2026-07-01T00:00:00Z", stall_events: [] }), "utf-8");
    writeFileSync(join(dir, "report.md"), "# relatório", "utf-8");

    const result = findActiveRun(tmpRoot);
    assert.equal(result, null);
  });

  it("diretório com nome não-YYMMDD é ignorado", () => {
    const dir = join(tmpRoot, "data", "overnight", "invalid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), "{}", "utf-8");

    const result = findActiveRun(tmpRoot);
    assert.equal(result, null);
  });

  it("escolhe a rodada mais recente quando há múltiplas ativas", () => {
    const d1 = join(tmpRoot, "data", "overnight", "260630");
    const d2 = join(tmpRoot, "data", "overnight", "260701");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, "plan.json"), "{}", "utf-8");
    writeFileSync(join(d2, "plan.json"), "{}", "utf-8");

    const result = findActiveRun(tmpRoot);
    assert.notEqual(result, null);
    assert.equal(result!.aammdd, "260701");
  });

  it("prefere rodada sem report.md quando a mais recente está concluída", () => {
    const d1 = join(tmpRoot, "data", "overnight", "260630");
    const d2 = join(tmpRoot, "data", "overnight", "260701");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, "plan.json"), "{}", "utf-8");
    writeFileSync(join(d2, "plan.json"), "{}", "utf-8");
    writeFileSync(join(d2, "report.md"), "done", "utf-8"); // 260701 concluída

    const result = findActiveRun(tmpRoot);
    assert.notEqual(result, null);
    assert.equal(result!.aammdd, "260630"); // volta pra 260630
  });
});

// ---------------------------------------------------------------------------
// getLastRunLogActivity
// ---------------------------------------------------------------------------

describe("getLastRunLogActivity (#2688)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-runlog-"));
    mkdirSync(join(tmpRoot, "data"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeLogs(events: object[]): void {
    writeFileSync(
      join(tmpRoot, "data", "run-log.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
  }

  it("arquivo ausente → null", () => {
    assert.equal(getLastRunLogActivity(tmpRoot, "260701"), null);
  });

  it("log sem eventos overnight → null", () => {
    writeLogs([
      { timestamp: "2026-07-01T02:00:00Z", agent: "writer", edition: "260701", level: "info", message: "ok", details: null },
    ]);
    assert.equal(getLastRunLogActivity(tmpRoot, "260701"), null);
  });

  it("retorna timestamp do único evento overnight matching", () => {
    writeLogs([
      { timestamp: "2026-07-01T02:00:00Z", agent: "overnight", edition: "260701", level: "info", message: "dispatch", details: null },
    ]);
    const result = getLastRunLogActivity(tmpRoot, "260701");
    assert.equal(result, new Date("2026-07-01T02:00:00Z").getTime());
  });

  it("retorna o MAIS RECENTE de múltiplos eventos overnight", () => {
    writeLogs([
      { timestamp: "2026-07-01T02:00:00Z", agent: "overnight", edition: "260701", level: "info", message: "dispatch", details: null },
      { timestamp: "2026-07-01T03:30:00Z", agent: "overnight", edition: "260701", level: "info", message: "merged", details: null },
      { timestamp: "2026-07-01T03:00:00Z", agent: "overnight", edition: "260701", level: "warn", message: "fix_iteration", details: null },
    ]);
    const result = getLastRunLogActivity(tmpRoot, "260701");
    assert.equal(result, new Date("2026-07-01T03:30:00Z").getTime());
  });

  it("ignora eventos de outra edição", () => {
    writeLogs([
      { timestamp: "2026-06-30T23:00:00Z", agent: "overnight", edition: "260630", level: "info", message: "merged", details: null },
    ]);
    assert.equal(getLastRunLogActivity(tmpRoot, "260701"), null);
  });

  it("ignora linhas malformadas sem crashar", () => {
    writeFileSync(
      join(tmpRoot, "data", "run-log.jsonl"),
      [
        "{ invalid json",
        JSON.stringify({ timestamp: "2026-07-01T04:00:00Z", agent: "overnight", edition: "260701", level: "info", message: "ok", details: null }),
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = getLastRunLogActivity(tmpRoot, "260701");
    assert.equal(result, new Date("2026-07-01T04:00:00Z").getTime());
  });

  it("ignora eventos overnight sem campo timestamp", () => {
    writeLogs([
      { agent: "overnight", edition: "260701", level: "info", message: "dispatch", details: null },
    ]);
    assert.equal(getLastRunLogActivity(tmpRoot, "260701"), null);
  });
});

// ---------------------------------------------------------------------------
// diagnoseWatchdogActivity (#2715 item 5)
// ---------------------------------------------------------------------------
//
// Antes do fix, o caminho `--dry-run` de `main()` era o PRIMEIRO branch —
// retornava antes de checar `lastActivityMs === 0`. Como `detectStall(0, ...)`
// sempre reporta stall (inatividade calculada contra epoch 1970), rodadas
// recém-iniciadas sem timestamp ainda disponível (mtime falhou por race
// write/stat) reportavam falsamente "STALL detectado" em dry-run — mesmo
// quando o caminho não-dry-run (que já checava `lastActivityMs === 0` antes)
// pularia corretamente. A lógica foi extraída para `diagnoseWatchdogActivity`
// justamente para eliminar essa divergência entre os dois caminhos.
describe("diagnoseWatchdogActivity (#2715 item 5)", () => {
  const nowMs = new Date("2026-07-01T10:00:00Z").getTime();

  it("dry-run + lastActivityMs=0 → skip_unknown_activity, NÃO reporta stall (regressão do bug)", () => {
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: true,
      lastActivityMs: 0,
      lastSource: "nenhuma",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "skip_unknown_activity");
    assert.ok(
      result.lines.some((l) => /sem timestamp de atividade/.test(l)),
      "deve explicar que não há timestamp disponível",
    );
    assert.ok(
      !result.lines.some((l) => /STALL detectado/.test(l)),
      "NÃO deve reportar 'STALL detectado' quando lastActivityMs=0 em dry-run — era o bug do #2715 item 5",
    );
  });

  it("não-dry-run + lastActivityMs=0 → skip_unknown_activity (comportamento pré-existente preservado)", () => {
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs: 0,
      lastSource: "nenhuma",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "skip_unknown_activity");
    assert.ok(!result.lines.some((l) => /STALL detectado/.test(l)));
  });

  it("dry-run + atividade recente (< threshold) → dry_run, 'sem stall'", () => {
    const lastActivityMs = nowMs - 10 * 60_000; // 10 min atrás
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: true,
      lastActivityMs,
      lastSource: "plan.json mtime",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "dry_run");
    assert.ok(result.lines.some((l) => /sem stall/.test(l) && !/STALL detectado/.test(l)));
  });

  it("dry-run + atividade real > threshold → dry_run, 'STALL detectado' (caso positivo genuíno, não falso-positivo)", () => {
    const lastActivityMs = nowMs - 90 * 60_000; // 90 min atrás, threshold 60
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: true,
      lastActivityMs,
      lastSource: "plan.json mtime",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "dry_run");
    assert.ok(result.lines.some((l) => /STALL detectado/.test(l)));
    // elapsed deve ser plausível (90 min), não o valor absurdo de décadas do bug original
    assert.ok(result.lines.some((l) => /Inatividade: 90 min/.test(l)));
    // #2781: elapsedMin agora é exposto no resultado — precisa bater com o
    // valor embutido na mensagem de diagnóstico acima (mesma fonte, sem
    // recomputação duplicada em main()).
    assert.equal(result.elapsedMin, 90);
  });

  it("não-dry-run + atividade > threshold → action=stall (dispara o bloco de tratamento em main())", () => {
    const lastActivityMs = nowMs - 90 * 60_000;
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs,
      lastSource: "run-log",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "stall");
    // #2781: main() usa diagnosis.elapsedMin no bloco STALL (emitRunLogEvent,
    // renderHaltBanner, alerta push) em vez de recomputar — precisa bater
    // com o elapsed real (90 min), não ser recalculado separadamente.
    assert.equal(result.elapsedMin, 90);
  });

  it("não-dry-run + atividade < threshold → no_stall", () => {
    const lastActivityMs = nowMs - 5 * 60_000;
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs,
      lastSource: "run-log",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "no_stall");
    assert.equal(result.elapsedMin, 5);
  });

  it("#2781: skip_unknown_activity ainda popula elapsedMin (não usado pelo caller neste branch, mas o campo é sempre presente no shape do retorno)", () => {
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs: 0,
      lastSource: "nenhuma",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: false,
    });
    assert.equal(result.action, "skip_unknown_activity");
    assert.equal(typeof result.elapsedMin, "number");
  });

  it("#5293 item 3: isHealthyIdle=true + atividade > threshold → healthy_idle, não stall", () => {
    const lastActivityMs = nowMs - 90 * 60_000;
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs,
      lastSource: "run-log",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: true,
    });
    assert.equal(result.action, "healthy_idle");
    assert.ok(result.lines.some((l) => /aguardando-resposta\/pausada/.test(l)));
    assert.equal(result.elapsedMin, 90);
  });

  it("#5293 item 3: isHealthyIdle=true mas SEM stall (atividade recente) → continua no_stall, não healthy_idle", () => {
    const lastActivityMs = nowMs - 5 * 60_000;
    const result = diagnoseWatchdogActivity({
      aammdd: "260701",
      dryRun: false,
      lastActivityMs,
      lastSource: "run-log",
      nowMs,
      thresholdMin: 60,
      isHealthyIdle: true,
    });
    assert.equal(result.action, "no_stall");
  });
});

// ---------------------------------------------------------------------------
// #5293 item 3: findActiveRun/getLastRunLogActivity generalizados por kind
// (continuo nunca escreve report.md — "ativa" é só "plan.json existe" no
// diretório mais recente).
// ---------------------------------------------------------------------------

describe("findActiveRun com kind=continuo (#5293 item 3)", () => {
  it("continuo: plan.json presente, SEM report.md → ativa (igual overnight)", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-watchdog-"));
    try {
      const runDir = join(dir, "data", "continuo", "260814");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "plan.json"), JSON.stringify({ started_at: "x", stall_events: [] }));
      const active = findActiveRun(dir, "continuo");
      assert.ok(active);
      assert.equal(active?.aammdd, "260814");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continuo: plan.json presente E report.md também presente → AINDA ativa (continuo nunca 'termina', ao contrário de overnight)", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-watchdog-"));
    try {
      const runDir = join(dir, "data", "continuo", "260814");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "plan.json"), JSON.stringify({ started_at: "x", stall_events: [] }));
      writeFileSync(join(runDir, "report.md"), "# nunca deveria existir para continuo, mas se existir não desativa");
      const active = findActiveRun(dir, "continuo");
      assert.ok(active, "continuo trata a rodada como ativa independente de report.md — diferente de overnight");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continuo: escolhe o AAMMDD mais recente entre múltiplos dias rotacionados", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-watchdog-"));
    try {
      for (const aammdd of ["260812", "260813", "260814"]) {
        const runDir = join(dir, "data", "continuo", aammdd);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "plan.json"), JSON.stringify({ started_at: "x", stall_events: [] }));
      }
      const active = findActiveRun(dir, "continuo");
      assert.equal(active?.aammdd, "260814");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kind default continua 'overnight' (compatibilidade — chamada sem 2º argumento)", () => {
    const dir = mkdtempSync(join(tmpdir(), "overnight-watchdog-default-"));
    try {
      const runDir = join(dir, "data", "overnight", "260814");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "plan.json"), JSON.stringify({ started_at: "x", stall_events: [] }));
      const active = findActiveRun(dir);
      assert.equal(active?.aammdd, "260814");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getLastRunLogActivity com agent=continuo (#5293 item 3)", () => {
  it("filtra por agent 'continuo', ignora eventos 'overnight' da mesma edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-runlog-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      const lines = [
        JSON.stringify({ agent: "overnight", edition: "260814", timestamp: "2026-08-14T10:00:00Z" }),
        JSON.stringify({ agent: "continuo", edition: "260814", timestamp: "2026-08-14T12:00:00Z" }),
      ];
      writeFileSync(join(dir, "data", "run-log.jsonl"), lines.join("\n") + "\n");
      const ts = getLastRunLogActivity(dir, "260814", "continuo");
      assert.equal(ts, new Date("2026-08-14T12:00:00Z").getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hasHealthyIdleSession (#5293 item 3)", () => {
  it("true quando há sessão continuo ativa com phase='aguardando-resposta'", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-idle-"));
    try {
      registerSession(dir, "continuo", "sess-idle", { tag: "host-a", startedAt: "2026-08-14T10:00:00.000Z" });
      heartbeat(dir, "continuo", "sess-idle", { phase: "aguardando-resposta" }, "host-a", "2026-08-14T10:05:00.000Z");
      const now = new Date("2026-08-14T10:10:00.000Z").getTime();
      assert.equal(hasHealthyIdleSession(dir, "continuo", now), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando phase='pausado-edicao' (guard de colisão editorial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-idle-"));
    try {
      registerSession(dir, "continuo", "sess-pausa", { tag: "host-a", startedAt: "2026-08-14T10:00:00.000Z" });
      heartbeat(dir, "continuo", "sess-pausa", { phase: "pausado-edicao" }, "host-a", "2026-08-14T10:05:00.000Z");
      const now = new Date("2026-08-14T10:10:00.000Z").getTime();
      assert.equal(hasHealthyIdleSession(dir, "continuo", now), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando a sessão existe mas a phase não é uma fase saudável conhecida", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-idle-"));
    try {
      registerSession(dir, "continuo", "sess-work", { tag: "host-a", startedAt: "2026-08-14T10:00:00.000Z" });
      heartbeat(dir, "continuo", "sess-work", { phase: "trabalhando" }, "host-a", "2026-08-14T10:05:00.000Z");
      const now = new Date("2026-08-14T10:10:00.000Z").getTime();
      assert.equal(hasHealthyIdleSession(dir, "continuo", now), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando não há nenhuma sessão registrada (data/sessions/ ausente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-idle-"));
    try {
      assert.equal(hasHealthyIdleSession(dir, "continuo", Date.now()), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filtra por kind — sessão overnight em phase saudável não conta pra kind continuo", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-idle-"));
    try {
      registerSession(dir, "overnight", "sess-other-kind", { tag: "host-a", startedAt: "2026-08-14T10:00:00.000Z" });
      heartbeat(dir, "overnight", "sess-other-kind", { phase: "aguardando-resposta" }, "host-a", "2026-08-14T10:05:00.000Z");
      const now = new Date("2026-08-14T10:10:00.000Z").getTime();
      assert.equal(hasHealthyIdleSession(dir, "continuo", now), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runAllWatchedKinds (#5293 fleet review achado 3)", () => {
  it("um kind lançar NÃO impede o outro de ser tentado — ambos são chamados", async () => {
    const attempted: string[] = [];
    const anyFailed = await runAllWatchedKinds(
      ["overnight", "continuo"],
      async (kind) => {
        attempted.push(kind);
        if (kind === "overnight") throw new Error("boom no overnight");
      },
      () => {}, // silencia o onError default (stderr) neste teste
    );
    assert.deepEqual(attempted, ["overnight", "continuo"], "os DOIS kinds devem ter sido tentados, na ordem");
    assert.equal(anyFailed, true);
  });

  it("nenhum kind falha → anyFailed=false", async () => {
    const anyFailed = await runAllWatchedKinds(["overnight", "continuo"], async () => {});
    assert.equal(anyFailed, false);
  });

  it("onError é chamado com o kind E o erro, um erro por kind que falhou", async () => {
    const errors: Array<{ kind: string; error: unknown }> = [];
    await runAllWatchedKinds(
      ["overnight", "continuo"],
      async (kind) => {
        throw new Error(`falha em ${kind}`);
      },
      (kind, error) => errors.push({ kind, error }),
    );
    assert.equal(errors.length, 2);
    assert.equal(errors[0].kind, "overnight");
    assert.equal(errors[1].kind, "continuo");
  });

  it("onError default escreve em stderr (nunca silencioso)", async () => {
    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrOutput += String(chunk);
      return true;
    };
    try {
      await runAllWatchedKinds(["continuo"], async () => {
        throw new Error("falha simulada");
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(stderrOutput, /kind=continuo/);
    assert.match(stderrOutput, /falha simulada/);
  });
});

describe("WATCHED_KINDS (#5390) — continuo removido da vigilância de produção", () => {
  it("contém só 'overnight' — 'continuo' não é mais vigiado", () => {
    assert.deepEqual(WATCHED_KINDS, ["overnight"]);
  });

  it("regressão: sessão continuo parada MUITO além do limiar de stall NÃO produz stall_event nem push — porque main() nunca a diagnostica (WATCHED_KINDS não inclui 'continuo')", async () => {
    // Antes do #5390 (WATCHED_KINDS = ["overnight", "continuo"]), esta mesma
    // simulação de main() diagnosticaria e agiria sobre 'continuo'. Prova
    // negativa: um runOne espião nunca é invocado com kind='continuo' quando
    // orquestrado com WATCHED_KINDS — logo nenhum stall_event é anexado ao
    // plan.json nem nenhum push é disparado para essa sessão, mesmo que ela
    // esteja parada há muito mais que o limiar de 60 min (simulado abaixo por
    // um plan.json com stall_events vazio e nenhuma atividade recente).
    const dir = mkdtempSync(join(tmpdir(), "watchdog-5390-"));
    try {
      // Sessão continuo genuinamente parada: plan.json com mtime "antigo" (o
      // teste não precisa manipular o relógio — o ponto é que runOne nunca é
      // chamado para 'continuo' independente do estado real do plan.json).
      const continuoDir = join(dir, "data", "continuo", "260814");
      mkdirSync(continuoDir, { recursive: true });
      writeFileSync(join(continuoDir, "plan.json"), JSON.stringify({ stall_events: [] }));

      const attempted: string[] = [];
      const anyFailed = await runAllWatchedKinds(WATCHED_KINDS, async (kind) => {
        attempted.push(kind);
      });

      assert.deepEqual(
        attempted,
        ["overnight"],
        "'continuo' nunca deveria ser tentado — WATCHED_KINDS não o inclui desde #5390",
      );
      assert.equal(anyFailed, false);

      // O plan.json da sessão continuo permanece intocado — nenhum stall_event
      // foi (nem poderia ter sido) anexado, porque runWatchdogForKind nunca
      // rodou para esse kind.
      const planAfter = JSON.parse(readFileSync(join(continuoDir, "plan.json"), "utf8"));
      assert.deepEqual(planAfter.stall_events, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ANTES do #5390 este teste teria falhado: WATCHED_KINDS incluindo 'continuo' faria runOne ser chamado para ele", async () => {
    // Reconstrói o comportamento pré-#5390 explicitamente (não lê o array de
    // produção) para provar que o teste acima é sensível à mudança real —
    // não passaria incondicionalmente independente do conteúdo de WATCHED_KINDS.
    const legacyWatchedKinds: readonly ("overnight" | "continuo")[] = ["overnight", "continuo"];
    const attempted: string[] = [];
    await runAllWatchedKinds(legacyWatchedKinds, async (kind) => {
      attempted.push(kind);
    });
    assert.deepEqual(attempted, ["overnight", "continuo"]);
  });
});

// ---------------------------------------------------------------------------
// timeouts do alerta push (#2958, canal e-mail #5341)
// ---------------------------------------------------------------------------
//
// #2958 (260704): a task Task Scheduler roda com ExecutionTimeLimit de 5 min;
// se o watchdog ficasse pendurado num I/O sem timeout, o Task Scheduler
// forçava o término (Last Result 267014). Dois pontos sem timeout: o fetch
// do alerta push (#5341 definiu o canal Gmail, `push-notify.ts`
// envolve a chamada inteira com `withTimeout`) e os execFileSync de
// render-halt-banner/log-event. A formatação/timeout do request HTTP em si
// (Gmail API) é testada em test/push-notify.test.ts e test/gmail-send.test.ts
// — aqui só o alias local que overnight-watchdog.ts reexporta.

describe("WATCHDOG_IO_TIMEOUT_MS (#2958, alias de PUSH_IO_TIMEOUT_MS desde #5341)", () => {
  it("é um valor finito e positivo (bounded, nunca 0/Infinity)", () => {
    assert.ok(Number.isFinite(WATCHDOG_IO_TIMEOUT_MS) && WATCHDOG_IO_TIMEOUT_MS > 0);
  });
});

describe("main() não roda como efeito colateral de importar o módulo (#2958)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(resolve(ROOT, "scripts/overnight-watchdog.ts"), "utf8");

  it("main() está atrás de um guard de CLI (isMainModule(import.meta.url), #2834)", () => {
    assert.match(
      source,
      /if \(isMainModule\(import\.meta\.url\)\) \{\s*\n\s*main\(\)/,
      "sem o guard, importar o módulo (como este próprio arquivo de teste faz) dispara main() e roda a lógica real do watchdog contra data/overnight/ de verdade",
    );
  });

  it("não sobrou um main() solto fora do guard (regressão: guard aplicado só a UM dos dois)", () => {
    const bareMainCalls = source.match(/^main\(\)\.catch/gm) ?? [];
    assert.equal(bareMainCalls.length, 0, "não deve haver chamada de main() fora do guard de CLI");
  });
});

describe("execFileSync de render-halt-banner/log-event usam timeout limitado (#2958)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(resolve(ROOT, "scripts/overnight-watchdog.ts"), "utf8");

  it("renderHaltBanner passa timeout: WATCHDOG_IO_TIMEOUT_MS ao execFileSync", () => {
    const rendererBlock = source.slice(
      source.indexOf("function renderHaltBanner"),
      source.indexOf("function emitRunLogEvent"),
    );
    assert.match(
      rendererBlock,
      /timeout:\s*WATCHDOG_IO_TIMEOUT_MS/,
      "execFileSync do render-halt-banner deve ter timeout limitado — sem isso, um hang no script filho trava o watchdog até o Task Scheduler matá-lo (#2958)",
    );
  });

  it("emitRunLogEvent passa timeout: WATCHDOG_IO_TIMEOUT_MS ao execFileSync", () => {
    const emitBlock = source.slice(source.indexOf("function emitRunLogEvent"));
    assert.match(
      emitBlock,
      /timeout:\s*WATCHDOG_IO_TIMEOUT_MS/,
      "execFileSync do log-event deve ter timeout limitado (#2958)",
    );
  });
});

// ---------------------------------------------------------------------------
// readPlanForStallHandling — retry em JSON truncado + escrita atômica (#3353)
// ---------------------------------------------------------------------------
//
// Bug: overnight-watchdog.ts era um SEGUNDO leitor de plan.json (além da
// statusline) que nunca ganhou o fix do #3264 — fazia `JSON.parse(readFileSync(
// ...))` cru e tratava "arquivo ausente" e "arquivo existe mas o parse falhou
// (escrita não-atômica em progresso)" de forma idêntica: ambos caíam no catch
// e `main()` retornava ANTES de gravar stall_events/emitir run-log/renderizar
// halt banner/alertar push — a notificação de stall inteira era perdida
// silenciosamente. Pior: o próprio watchdog gravava plan.json de volta via
// `writeFileSync` cru, podendo ser a ORIGEM da janela de truncamento.
//
// Fix: `readPlanForStallHandling` delega para `readPlanFromDir` (mesma função
// já testada em test/overnight-statusline.test.ts para o cenário de retry) e
// a escrita passou a usar `writeFileAtomic`. Os testes abaixo replicam a
// MESMA técnica de DI de leitores fake usada em #3264 (readFileSync retorna
// conteúdo truncado na 1ª chamada, válido na 2ª), agora no ponto de entrada
// que overnight-watchdog.ts de fato usa — confirmando que o retry recupera o
// plan e a notificação de stall NÃO é perdida.
describe("readPlanForStallHandling — retry em JSON truncado (#3353, mesma técnica do #3264)", () => {
  function makeReadersWithSequence(existsResult: boolean, readResults: (string | Error)[]): PlanFileReaders {
    let callIndex = 0;
    return {
      existsSync: (() => existsResult) as PlanFileReaders["existsSync"],
      readFileSync: ((..._args: unknown[]) => {
        const result = readResults[Math.min(callIndex, readResults.length - 1)];
        callIndex += 1;
        if (result instanceof Error) throw result;
        return result;
      }) as PlanFileReaders["readFileSync"],
    };
  }

  it("plan.json existe mas a 1ª leitura pega JSON truncado (escrita concorrente) → retry recupera stall_events intactos", () => {
    const validPlan = JSON.stringify({
      started_at: "2026-07-11T03:00:00.000Z",
      stall_events: [{ at: "2026-07-11T02:00:00.000Z", reason: "unknown", resumed_at: "2026-07-11T02:05:00.000Z" }],
    });
    const readers = makeReadersWithSequence(true, [
      '{"started_at": "2026-07-11T03:00:00.000Z", "stall', // truncado — JSON.parse falha
      validPlan, // completo — 2ª leitura (retry) recupera
    ]);

    const plan = readPlanForStallHandling("/fake/plan.json", readers);

    assert.ok(plan !== null, "retry deve recuperar o plan válido — sem isso a notificação de stall seria perdida");
    assert.equal(plan!.started_at, "2026-07-11T03:00:00.000Z");
    assert.equal(plan!.stall_events.length, 1, "stall_events pré-existente deve sobreviver ao retry, intacto");
  });

  it("arquivo genuinamente ausente → null IMEDIATO, sem retry (nenhuma rodada ativa é o caminho normal, não uma falha)", () => {
    let readFileSyncCalls = 0;
    const readers: PlanFileReaders = {
      existsSync: (() => false) as PlanFileReaders["existsSync"],
      readFileSync: ((..._args: unknown[]) => {
        readFileSyncCalls += 1;
        throw new Error("não deveria ser chamado — arquivo não existe");
      }) as PlanFileReaders["readFileSync"],
    };

    const plan = readPlanForStallHandling("/fake/plan.json", readers);

    assert.equal(plan, null);
    assert.equal(readFileSyncCalls, 0);
  });

  it("ambas as leituras batem em JSON truncado → null (retry não é infinito, cai no fallback de erro do main())", () => {
    const readers = makeReadersWithSequence(true, [
      '{"started_at": "2026-07-11T03:00:00.000Z", "stall',
      '{"started_at": "2026-07-11T03:00:00.000Z", "stall_ev', // ainda truncado na 2ª tentativa
    ]);

    const plan = readPlanForStallHandling("/fake/plan.json", readers);

    assert.equal(plan, null, "2 leituras truncadas seguidas deve desistir e retornar null, não travar");
  });

  it("sem readers explícito, usa o default (fs real) — smoke test de que a assinatura funciona sem DI", () => {
    // Arquivo genuinamente ausente no caminho fs real — cobre o caminho de
    // produção (main() chama sem passar `readers`).
    const plan = readPlanForStallHandling(
      resolve(dirname(fileURLToPath(import.meta.url)), "__nao-existe-3353__", "plan.json"),
    );
    assert.equal(plan, null);
  });
});

describe("overnight-watchdog.ts delega leitura/escrita de plan.json pra funções seguras contra truncamento (#3353)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(resolve(ROOT, "scripts/overnight-watchdog.ts"), "utf8");

  it("main() usa readPlanForStallHandling, não JSON.parse(readFileSync(...)) cru", () => {
    assert.match(
      source,
      /const plan = readPlanForStallHandling\(planPath\)/,
      "a leitura de plan.json no branch de stall deve delegar pra readPlanForStallHandling (que por sua vez usa readPlanFromDir com retry) — sem isso, reintroduz o bug do #3353",
    );
    assert.ok(
      !/JSON\.parse\(readFileSync\(planPath/.test(source),
      "não deve sobrar um JSON.parse(readFileSync(planPath...)) cru — essa era exatamente a implementação vulnerável ao truncamento",
    );
  });

  it("readPlanForStallHandling delega pra readPlanFromDir (importado de overnight-statusline.ts)", () => {
    assert.match(
      source,
      /import\s*\{\s*readPlanFromDir,\s*type PlanFileReaders\s*\}\s*from\s*"\.\/overnight-statusline\.ts"/,
      "deve importar readPlanFromDir da statusline em vez de reimplementar o retry",
    );
  });

  it("a escrita de plan.json (bloco STALL) usa writeFileAtomic, não writeFileSync cru", () => {
    const stallWriteBlock = source.slice(
      source.indexOf("// (a) Append stall_events no plan.json"),
      source.indexOf("// (b) Emite evento no run-log"),
    );
    assert.match(
      stallWriteBlock,
      /writeFileAtomic\(planPath,/,
      "gravar stall_event em plan.json deve usar writeFileAtomic (scripts/lib/atomic-write.ts) — writeFileSync cru é uma fonte de truncamento pros leitores concorrentes (#3353)",
    );
    assert.ok(
      !/writeFileSync\(planPath/.test(stallWriteBlock),
      "não deve sobrar um writeFileSync(planPath...) cru no bloco de gravação de stall_event",
    );
  });

  it("writeFileAtomic é importado de scripts/lib/atomic-write.ts", () => {
    assert.match(
      source,
      /import\s*\{\s*writeFileAtomic\s*\}\s*from\s*"\.\/lib\/atomic-write\.ts"/,
    );
  });
});

// ---------------------------------------------------------------------------
// #5520: watchdog só vigiava rodadas sem sufixo e se auto-alimentava
// ---------------------------------------------------------------------------

describe("findActiveRun: rodada com sufixo de letra (#5520)", () => {
  let tmpRoot: string;

  const mkRun = (name: string, opts: { report?: boolean } = {}) => {
    const dir = join(tmpRoot, "data", "overnight", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ started_at: "2026-08-16T00:00:00Z", stall_events: [] }),
      "utf-8",
    );
    if (opts.report) writeFileSync(join(dir, "report.md"), "# fim", "utf-8");
    return dir;
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-suffix-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: rodada 260816f (com sufixo) é detectada como ativa", () => {
    mkRun("260816f");

    const result = findActiveRun(tmpRoot);
    assert.notEqual(result, null, "rodada com sufixo tem que ser vigiada");
    assert.equal(result!.aammdd, "260816f");
  });

  it("REGRESSÃO: com rodadas sufixadas ativas, uma carcaça antiga sem sufixo NÃO é eleita", () => {
    // Reproduz o cenário real do #5520: 260707 morreu em julho sem report.md e
    // era eleita "ativa" porque o filtro /^\d{6}$/ escondia as rodadas atuais.
    mkRun("260707");
    mkRun("260816f");

    const result = findActiveRun(tmpRoot);
    assert.equal(result!.aammdd, "260816f");
  });

  it("ordena sufixo corretamente: 260816f vence 260816b e 260816", () => {
    mkRun("260816");
    mkRun("260816b");
    mkRun("260816f");

    assert.equal(findActiveRun(tmpRoot)!.aammdd, "260816f");
  });

  it("volta pra rodada sufixada anterior quando a mais recente concluiu", () => {
    mkRun("260816b");
    mkRun("260816f", { report: true });

    assert.equal(findActiveRun(tmpRoot)!.aammdd, "260816b");
  });

  it("nome inválido continua ignorado (sufixo é 1 letra minúscula, não texto livre)", () => {
    mkRun("260816bc");
    mkRun("260816B");
    mkRun("rascunho");

    assert.equal(findActiveRun(tmpRoot), null);
  });
});

describe("findActiveRun: expiração de rodada abandonada (#5520)", () => {
  let tmpRoot: string;
  const NOW = new Date("2026-08-17T02:00:00Z").getTime();
  const HOUR = 3_600_000;

  const mkRun = (name: string) => {
    const dir = join(tmpRoot, "data", "overnight", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "x", stall_events: [] }), "utf-8");
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-abandon-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: rodada sem atividade real há 5 semanas não é vigiada", () => {
    mkRun("260707");

    const result = findActiveRun(tmpRoot, "overnight", {
      nowMs: NOW,
      lastActivityOf: () => ({ ts: NOW - 35 * 24 * HOUR, source: "run-log" }),
    });
    assert.equal(result, null, "carcaça de julho não pode ser eleita rodada ativa");
  });

  it("rodada com atividade recente continua vigiada", () => {
    mkRun("260816f");

    const result = findActiveRun(tmpRoot, "overnight", {
      nowMs: NOW,
      lastActivityOf: () => ({ ts: NOW - 2 * HOUR, source: "run-log" }),
    });
    assert.equal(result!.aammdd, "260816f");
  });

  it("pula a carcaça e elege a rodada anterior que ainda tem atividade", () => {
    mkRun("260815");
    mkRun("260816f");

    const result = findActiveRun(tmpRoot, "overnight", {
      nowMs: NOW,
      lastActivityOf: (aammdd) =>
        aammdd === "260816f"
          ? { ts: NOW - 40 * HOUR, source: "run-log" } // abandonada
          : { ts: NOW - 10 * 60_000, source: "run-log" }, // viva
    });
    assert.equal(result!.aammdd, "260815");
  });

  it("atividade desconhecida (ts=0) NÃO expira — tem tratamento próprio a jusante", () => {
    mkRun("260816f");

    const result = findActiveRun(tmpRoot, "overnight", {
      nowMs: NOW,
      lastActivityOf: () => ({ ts: 0, source: "nenhuma" }),
    });
    assert.equal(result!.aammdd, "260816f");
  });
});

describe("isSelfInflictedPlanMtime (#5520)", () => {
  const AT = "2026-08-17T02:20:25.000Z";
  const atMs = new Date(AT).getTime();
  const ev = (at: string): StallEvent => ({ at, reason: "unknown", resumed_at: null });

  it("REGRESSÃO: mtime coincidente com stall_event próprio é escrita do watchdog", () => {
    assert.equal(isSelfInflictedPlanMtime(atMs + 500, [ev(AT)]), true);
  });

  it("mtime bem depois do último stall_event é atividade genuína", () => {
    assert.equal(isSelfInflictedPlanMtime(atMs + 30 * 60_000, [ev(AT)]), false);
  });

  it("sem stall_events, nada é auto-infligido", () => {
    assert.equal(isSelfInflictedPlanMtime(atMs, []), false);
    assert.equal(isSelfInflictedPlanMtime(atMs, undefined), false);
  });

  it("mtime null → false", () => {
    assert.equal(isSelfInflictedPlanMtime(null, [ev(AT)]), false);
  });

  it("stall_event com data malformada é ignorado sem lançar", () => {
    assert.equal(isSelfInflictedPlanMtime(atMs, [ev("não-é-data")]), false);
  });
});

describe("getLastRunLogActivity ignora eventos do próprio watchdog (#5520)", () => {
  let tmpRoot: string;

  const writeLog = (lines: object[]) => {
    const dir = join(tmpRoot, "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-selflog-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: alarme anterior do watchdog não conta como atividade da rodada", () => {
    writeLog([
      {
        timestamp: "2026-07-07T10:00:00Z",
        edition: "260707",
        agent: "overnight",
        message: "pr_opened",
        details: {},
      },
      {
        timestamp: "2026-08-17T02:20:26Z",
        edition: "260707",
        agent: "overnight",
        message: "stall_detected",
        details: { source: "overnight-watchdog", elapsed_min: 60 },
      },
    ]);

    const ts = getLastRunLogActivity(tmpRoot, "260707", "overnight");
    assert.equal(
      ts,
      new Date("2026-07-07T10:00:00Z").getTime(),
      "só o evento real de julho conta — senão o watchdog realimenta o próprio alarme",
    );
  });

  it("stall_detected do COORDENADOR (sem source de watchdog) continua contando", () => {
    writeLog([
      {
        timestamp: "2026-08-14T16:35:08Z",
        edition: "260814c",
        agent: "overnight",
        message: "stall_detected",
        details: { unidade: "#5227", reason: "fixer rodou npm test completo" },
      },
    ]);

    const ts = getLastRunLogActivity(tmpRoot, "260814c", "overnight");
    assert.equal(ts, new Date("2026-08-14T16:35:08Z").getTime());
  });

  it("rodada cuja ÚNICA atividade são alarmes do watchdog → sem atividade conhecida", () => {
    writeLog([
      {
        timestamp: "2026-08-17T01:20:02Z",
        edition: "260707",
        agent: "overnight",
        message: "stall_detected",
        details: { source: "overnight-watchdog" },
      },
      {
        timestamp: "2026-08-17T02:20:26Z",
        edition: "260707",
        agent: "overnight",
        message: "stall_detected",
        details: { source: "overnight-watchdog" },
      },
    ]);

    assert.equal(getLastRunLogActivity(tmpRoot, "260707", "overnight"), null);
  });
});

describe("resolveRunActivity: piso started_at (#5520, achado do review)", () => {
  let tmpRoot: string;
  let planPath: string;

  const writePlan = (startedAt: string, stallEvents: StallEvent[]) => {
    const dir = join(tmpRoot, "data", "overnight", "260817");
    mkdirSync(dir, { recursive: true });
    planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify({ started_at: startedAt, stall_events: stallEvents }), "utf-8");
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "watchdog-floor-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: rodada morta não vira ts=0 depois do 1º alarme — cai em started_at", () => {
    // Estado após o watchdog ter alarmado: o mtime do plan.json é da ESCRITA
    // DELE, e o único evento no run-log também é dele. Sem piso, as duas fontes
    // são descontadas, `computeLastActivity` devolve ts=0, o diagnóstico vira
    // `skip_unknown_activity` (só loga) e a expiração isenta ts=0 — a rodada
    // nunca mais alarma E nunca expira.
    writePlan("2026-08-15T00:00:00Z", [
      { at: new Date().toISOString(), reason: "unknown", resumed_at: null },
    ]);

    const activity = resolveRunActivity(tmpRoot, "overnight", "260817", planPath);
    assert.notEqual(activity.ts, 0, "ts=0 silenciaria o watchdog para sempre");
    assert.equal(activity.ts, new Date("2026-08-15T00:00:00Z").getTime());
    assert.match(activity.source, /started_at/);
  });

  it("com o piso, a rodada morta é aposentada como carcaça em 24h", () => {
    writePlan("2026-08-15T00:00:00Z", [
      { at: new Date().toISOString(), reason: "unknown", resumed_at: null },
    ]);

    const active = findActiveRun(tmpRoot, "overnight", {
      nowMs: new Date("2026-08-20T00:00:00Z").getTime(),
    });
    assert.equal(active, null, "5 dias depois do started_at tem que expirar");
  });

  it("atividade genuína recente vence o piso", () => {
    writePlan("2026-08-15T00:00:00Z", []); // sem stall_events → mtime não é descontado

    const activity = resolveRunActivity(tmpRoot, "overnight", "260817", planPath);
    assert.equal(activity.source, "plan.json mtime");
    assert.ok(activity.ts > new Date("2026-08-16T00:00:00Z").getTime());
  });

  it("sem started_at utilizável, mantém o ts=0 histórico (skip_unknown_activity)", () => {
    writePlan("não-é-data", [
      { at: new Date().toISOString(), reason: "unknown", resumed_at: null },
    ]);

    assert.equal(resolveRunActivity(tmpRoot, "overnight", "260817", planPath).ts, 0);
  });
});
