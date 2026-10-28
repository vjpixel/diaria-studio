/**
 * test/task-runner-failure-report-10063.test.ts (#10063)
 *
 * Dois defeitos de observabilidade que esconderam o OOM diário da unit
 * `diaria-tmp-cleanup`:
 *   1. processo morto por SINAL (SIGABRT do OOM do V8) era rotulado
 *      "falha de spawn antes do processo iniciar: status null";
 *   2. nada da saída do passo ia pro stderr — o journal do systemd só
 *      mostrava "status=1/FAILURE".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  abnormalStepExitReason,
  execTsxStep,
  formatFailedStepReport,
  runScheduledTask,
  FAILED_STEP_STDERR_TAIL_LINES,
  STEP_MAX_BUFFER_BYTES,
  type StepExecResult,
} from "../scripts/lib/task-runner.ts";
import type { ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import type { GitSyncResult } from "../scripts/lib/git-sync.ts";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: sinais POSIX; no Windows o SIGTERM vira TerminateProcess e o filho não termina 'pelo sinal'";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOOP_SYNC = (): GitSyncResult => ({
  outcome: "already_up_to_date",
  message: "no-op (#7736)",
  branch_before: "master",
  warnings: [],
  proceed: true,
  up_to_date: true,
  commits_behind: 0,
  preserved_stash: null,
  stale_autostash_count: -1,
});

const DEF: ScheduledTaskDefinition = {
  name: "Diaria-Teste-10063",
  description: "fixture #10063",
  steps: [{ key: "cleanup", script: "nao-importa.ts" }],
  logPath: "task-runner-test/.10063.log",
  schedule: { kind: "daily", hour: 3, minute: 20 },
  issue: "#10063 (teste)",
};

let workDir: string;
before(() => {
  workDir = mkdtempSync(join(tmpdir(), "task-runner-10063-"));
});
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("#10063 — abnormalStepExitReason distingue sinal de falha de spawn", () => {
  it("SIGABRT → 'encerrado pelo sinal' + dica de OOM, nunca 'falha de spawn'", () => {
    const r = abnormalStepExitReason({ status: null, signal: "SIGABRT" });
    assert.match(r, /encerrado pelo sinal SIGABRT/);
    assert.match(r, /heap out of memory/);
    assert.doesNotMatch(r, /falha de spawn/);
  });

  it("error de spawn → mantém 'falha de spawn antes do processo iniciar'", () => {
    const r = abnormalStepExitReason({ error: new Error("ENOENT"), status: null, signal: null });
    assert.match(r, /falha de spawn antes do processo iniciar\): ENOENT/);
  });

  it("spawn real de um script que se mata com SIGTERM → output nomeia o sinal", { skip: SKIP_WIN32 }, () => {
    const script = join(workDir, "self-kill.ts");
    writeFileSync(script, 'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 5000);\n');
    const result = execTsxStep(script, [], ROOT);
    assert.equal(result.code, 1);
    assert.match(result.output, /encerrado pelo sinal SIGTERM/);
    assert.doesNotMatch(result.output, /falha de spawn/);
  });
});

describe("#10071 — ENOBUFS/ETIMEDOUT do spawnSync não são 'falha de spawn'", () => {
  const errWithCode = (code: string): Error =>
    Object.assign(new Error(`spawnSync node ${code}`), { code });

  it("ENOBUFS (pure) → 'limite de saida (maxBuffer)', nunca 'falha de spawn'", () => {
    const r = abnormalStepExitReason({ error: errWithCode("ENOBUFS"), status: null, signal: "SIGTERM" });
    assert.match(r, /encerrado \(sinal SIGTERM\) por exceder o limite de saida \(maxBuffer\)/);
    assert.doesNotMatch(r, /falha de spawn/);
  });

  it("ETIMEDOUT (pure) → 'por timeout', nunca 'falha de spawn'", () => {
    const r = abnormalStepExitReason({ error: errWithCode("ETIMEDOUT"), status: null, signal: "SIGTERM" });
    assert.match(r, /encerrado \(sinal SIGTERM\) por timeout/);
    assert.doesNotMatch(r, /falha de spawn/);
  });

  it("spawn real: passo que emite >1 MiB passa com o maxBuffer default (antes: ENOBUFS)", () => {
    assert.ok(STEP_MAX_BUFFER_BYTES > 1024 * 1024);
    const script = join(workDir, "verbose.ts");
    writeFileSync(script, 'process.stdout.write("x".repeat(2 * 1024 * 1024));\n');
    const result = execTsxStep(script, [], ROOT);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.output, /falha de spawn/);
  });

  it("spawn real: saída acima do maxBuffer → motivo nomeia maxBuffer, não 'falha de spawn'", () => {
    const script = join(workDir, "verbose-over.ts");
    writeFileSync(script, 'process.stdout.write("x".repeat(2 * 1024 * 1024));\n');
    const result = execTsxStep(script, [], ROOT, 1024 * 1024);
    assert.equal(result.code, 1);
    assert.match(result.output, /limite de saida \(maxBuffer\)/);
    assert.doesNotMatch(result.output, /falha de spawn/);
  });
});

describe("#10063 — passo falho vai pro stderr (journal), com o fim da saída", () => {
  it("formatFailedStepReport mantém só as últimas N linhas e aponta o log", () => {
    const output = Array.from({ length: 50 }, (_, i) => `linha ${i}`).join("\n");
    const msg = formatFailedStepReport("Diaria-X", "cleanup", 1, output, "/data/x.log");
    assert.match(msg, /Diaria-X: passo 'cleanup' falhou \(code 1\)/);
    assert.match(msg, /linha 49/);
    assert.doesNotMatch(msg, /linha 29\n/);
    assert.match(msg, new RegExp(`linha ${50 - FAILED_STEP_STDERR_TAIL_LINES}`));
    assert.match(msg, /log completo: \/data\/x\.log/);
  });

  it("runScheduledTask reporta o passo que falhou e não reporta o que passou", () => {
    const reports: string[] = [];
    const def: ScheduledTaskDefinition = {
      ...DEF,
      steps: [
        { key: "ok", script: "a.ts" },
        { key: "cleanup", script: "b.ts" },
      ],
    };
    const execStep = (script: string): StepExecResult =>
      script.endsWith("a.ts")
        ? { code: 0, output: "tudo certo\n" }
        : { code: 1, output: "FATAL ERROR: JavaScript heap out of memory\nERRO: sinal SIGABRT\n" };
    const result = runScheduledTask(def, {
      rootDir: ROOT,
      logPathOverride: join(workDir, "final.log"),
      tempLogPathOverride: join(workDir, "temp.log"),
      execStep,
      syncCode: NOOP_SYNC,
      reportFailure: (m) => reports.push(m),
    });
    assert.equal(result.code, 1);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /passo 'cleanup' falhou/);
    assert.match(reports[0], /heap out of memory/);
  });
});
