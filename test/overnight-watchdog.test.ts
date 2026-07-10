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
  diagnoseWatchdogActivity,
  buildTelegramAlertRequest,
  WATCHDOG_IO_TIMEOUT_MS,
  type StallEvent,
} from "../scripts/overnight-watchdog.ts";

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
    });
    assert.equal(result.action, "stall");
    // #2781: main() usa diagnosis.elapsedMin no bloco STALL (emitRunLogEvent,
    // renderHaltBanner, alerta Telegram) em vez de recomputar — precisa bater
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
    });
    assert.equal(result.action, "skip_unknown_activity");
    assert.equal(typeof result.elapsedMin, "number");
  });
});

// ---------------------------------------------------------------------------
// buildTelegramAlertRequest + timeouts (#2958)
// ---------------------------------------------------------------------------
//
// #2958 (260704): a task Task Scheduler roda com ExecutionTimeLimit de 5 min;
// se o watchdog ficasse pendurado num I/O sem timeout, o Task Scheduler
// forçava o término (Last Result 267014). Dois pontos sem timeout: o fetch
// do alerta Telegram e os execFileSync de render-halt-banner/log-event.

describe("buildTelegramAlertRequest (#2958)", () => {
  it("inclui um AbortSignal de timeout na requisição (nunca fica pendurado sem limite)", () => {
    const { url, options } = buildTelegramAlertRequest("TOKEN123", "chat-1", "mensagem de teste");
    assert.equal(url, "https://api.telegram.org/botTOKEN123/sendMessage");
    assert.ok(options.signal instanceof AbortSignal, "options.signal deve ser um AbortSignal");
    assert.equal(options.method, "POST");
  });

  it("o corpo carrega chat_id e a mensagem informados", () => {
    const { options } = buildTelegramAlertRequest("TOKEN123", "chat-42", "stall detectado");
    const body = JSON.parse(options.body as string);
    assert.equal(body.chat_id, "chat-42");
    assert.equal(body.text, "stall detectado");
  });

  it("WATCHDOG_IO_TIMEOUT_MS é um valor finito e positivo (bounded, nunca 0/Infinity)", () => {
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
