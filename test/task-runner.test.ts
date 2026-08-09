/**
 * test/task-runner.test.ts (#4805 Fase 2)
 *
 * Cobertura de `scripts/lib/task-runner.ts` (runScheduledTask). Trava os 5
 * comportamentos herdados dos wrappers `.ps1` (ver docstring do módulo, cada
 * item citado explicitamente aqui) sem precisar de PowerShell nem do
 * junction `data/` — spawn real de `node --import tsx` contra fixtures em
 * `test-fixtures/clarice-sync-daily/` (mesmas usadas pelos testes `.ps1`
 * equivalentes, ex: `test/run-apoios-diff-alarm-ps1.test.ts`) + injeção de
 * `execStep` pra cenários que precisariam de spawn-failure sintético.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScheduledTask, execTsxStep, type StepExecResult, type AppendLogFn } from "../scripts/lib/task-runner.ts";
import type { ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOOP_FIXTURE = "test-fixtures/clarice-sync-daily/noop-exit0.ts";
const NOOP_EXIT1_FIXTURE = "test-fixtures/clarice-sync-daily/noop-exit1.ts";

function baseDef(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  return {
    name: "Diaria-Teste-Fixture",
    description: "task de teste (fixture, não faz parte do registro real)",
    steps: [{ key: "noop", script: NOOP_FIXTURE }],
    logPath: "task-runner-test/.fixture.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    legacySetupScript: "scripts/setup-apoios-diff-alarm-schedule.ps1", // qualquer .ps1 real serve, não é lido
    issue: "#4805 (teste)",
    ...overrides,
  };
}

describe("runScheduledTask — caso feliz (spawn real via node --import tsx)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-happy-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("passo único OK -> exit 0, log final criado com cabeçalho + rodapé", () => {
    const tempLogPath = join(workDir, "happy-temp.log");
    const logPathOverride = join(workDir, "happy-final.log");

    const result = runScheduledTask(baseDef(), { rootDir: ROOT, logPathOverride, tempLogPathOverride: tempLogPath });

    assert.equal(result.code, 0);
    assert.equal(result.guardAborted, false);
    assert.equal(result.logAppendOk, true);
    assert.deepEqual(result.steps, [{ key: "noop", code: 0, bestEffort: false }]);
    assert.ok(existsSync(logPathOverride), "esperava o log final criado");
    assert.ok(!existsSync(tempLogPath), "esperava o log temporário removido após sucesso");

    const content = readFileSync(logPathOverride, "utf8");
    assert.match(content, /- task de teste \(fixture, não faz parte do registro real\) =====/);
    assert.match(content, /----- noop -----/);
    assert.match(content, /fim \(noop=0\)/);
  });

  it("passo único falha (exit 1) -> exit code do runner também é 1, rodapé reflete o código (#4756)", () => {
    const tempLogPath = join(workDir, "fail-temp.log");
    const logPathOverride = join(workDir, "fail-final.log");

    const def = baseDef({ steps: [{ key: "noop", script: NOOP_EXIT1_FIXTURE }] });
    const result = runScheduledTask(def, { rootDir: ROOT, logPathOverride, tempLogPathOverride: tempLogPath });

    assert.equal(result.code, 1);
    assert.deepEqual(result.steps, [{ key: "noop", code: 1, bestEffort: false }]);
    const content = readFileSync(logPathOverride, "utf8");
    assert.match(content, /fim \(noop=1\)/);
  });
});

describe("runScheduledTask — log não gravável (parent do LogPath é um arquivo) -> exit != 0 (#4047)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-logfail-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("mesmo com o passo OK, falha de log final reprova a run (exit code honesto)", () => {
    const tempLogPath = join(workDir, "logfail-temp.log");
    const blockerFile = join(workDir, "blocker.txt");
    writeFileSync(blockerFile, "sou um arquivo, não um diretório");
    const badLogPath = join(blockerFile, "sub", ".fixture.log");

    const result = runScheduledTask(baseDef(), {
      rootDir: ROOT,
      logPathOverride: badLogPath,
      tempLogPathOverride: tempLogPath,
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.logAppendOk, false);
    assert.ok(existsSync(tempLogPath), "esperava o log temporário preservado quando o anexo final falha");
  });
});

describe("runScheduledTask — retry-then-recover do log-append (achado do fleet review #4821, item 3)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-logretry-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("falha nas 2 primeiras tentativas, sucede na 3ª -> logAppendOk true, exit 0, temp removido", () => {
    const tempLogPath = join(workDir, "retry-temp.log");
    const logPathOverride = join(workDir, "retry-final.log");

    let attempts = 0;
    const appendLog: AppendLogFn = (logPath, content) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`falha transitória simulada (tentativa ${attempts})`);
      }
      writeFileSync(logPath, content, "utf8");
    };

    const result = runScheduledTask(baseDef(), {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      appendLog,
    });

    assert.equal(attempts, 3, "esperava exatamente 3 tentativas (2 falhas + 1 sucesso)");
    assert.equal(result.logAppendOk, true);
    assert.equal(result.code, 0);
    assert.ok(existsSync(logPathOverride), "esperava o log final criado na 3ª tentativa");
    assert.ok(!existsSync(tempLogPath), "esperava o log temporário removido após a recuperação");
  });

  it("falha em 1 tentativa, sucede na 2ª -> logAppendOk true sem esgotar as 3 tentativas", () => {
    const tempLogPath = join(workDir, "retry-once-temp.log");
    const logPathOverride = join(workDir, "retry-once-final.log");

    let attempts = 0;
    const appendLog: AppendLogFn = (logPath, content) => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("falha transitória simulada (tentativa única)");
      }
      writeFileSync(logPath, content, "utf8");
    };

    const result = runScheduledTask(baseDef(), {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      appendLog,
    });

    assert.equal(attempts, 2, "esperava parar de tentar assim que a 2ª tentativa sucede");
    assert.equal(result.logAppendOk, true);
    assert.equal(result.code, 0);
  });
});

describe("runScheduledTask — falha de spawn nunca vira exit 0 silencioso (defesa em profundidade, análogo ao #4343)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-spawnfail-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("cwd inexistente -> spawnSync real falha a spawnar -> execTsxStep retorna code=1, nunca lança", () => {
    const result = execTsxStep(join(ROOT, NOOP_FIXTURE), [], "/caminho/definitivamente/inexistente-xyz-4805");
    assert.equal(result.code, 1);
    assert.match(result.output, /nao executou/);
  });

  it("execStep injetado simulando spawn-failure -> exit code do runner é 1, log registra o erro", () => {
    const tempLogPath = join(workDir, "spawnfail-temp.log");
    const logPathOverride = join(workDir, "spawnfail-final.log");

    const fakeExecStep = (): StepExecResult => ({
      code: 1,
      output: "ERRO: o passo nao executou (falha de spawn antes do processo iniciar): ENOENT simulado\n",
    });

    const result = runScheduledTask(baseDef(), {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: fakeExecStep,
    });

    assert.equal(result.code, 1);
    const content = readFileSync(logPathOverride, "utf8");
    assert.match(content, /ENOENT simulado/);
  });

  it("execStep que lança síncrono (exceção inesperada) é capturado -> exit 1, run termina normalmente", () => {
    const tempLogPath = join(workDir, "throw-temp.log");
    const logPathOverride = join(workDir, "throw-final.log");

    const throwingExecStep = (): StepExecResult => {
      throw new Error("boom inesperado");
    };

    const result = runScheduledTask(baseDef(), {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: throwingExecStep,
    });

    assert.equal(result.code, 1);
    assert.equal(result.logAppendOk, true);
    const content = readFileSync(logPathOverride, "utf8");
    assert.match(content, /boom inesperado/);
  });
});

describe("runScheduledTask — sequenciamento multi-passo (#4740, molde run-clarice-sync-daily.ps1)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-multistep-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("passo 1 falha (não best-effort) -> passos seguintes AINDA rodam (nenhum passo cancela os outros)", () => {
    const tempLogPath = join(workDir, "multi-temp.log");
    const logPathOverride = join(workDir, "multi-final.log");

    const calls: string[] = [];
    const fakeExecStep = (scriptAbs: string): StepExecResult => {
      calls.push(scriptAbs);
      return scriptAbs.endsWith("step1.ts") ? { code: 1, output: "step1 falhou" } : { code: 0, output: "ok" };
    };

    const def = baseDef({
      steps: [
        { key: "step1", script: "step1.ts" },
        { key: "step2", script: "step2.ts", bestEffort: true },
        { key: "step3", script: "step3.ts" },
      ],
    });

    const result = runScheduledTask(def, {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: fakeExecStep,
    });

    assert.equal(calls.length, 3, "esperava os 3 passos rodando, mesmo com step1 falhando");
    assert.equal(result.steps.length, 3);
    // exit code final = do PRIMEIRO passo não-best-effort que falhou (step1),
    // não sobrescrito por um sucesso posterior.
    assert.equal(result.code, 1);
    assert.deepEqual(
      result.steps.map((s) => `${s.key}=${s.code}`),
      ["step1=1", "step2=0", "step3=0"],
    );
  });

  it("passo best-effort falhando NÃO reprova a run (extract-opens-catchup-status.ts, #4740)", () => {
    const tempLogPath = join(workDir, "besteffort-temp.log");
    const logPathOverride = join(workDir, "besteffort-final.log");

    const fakeExecStep = (scriptAbs: string): StepExecResult =>
      scriptAbs.endsWith("extract.ts") ? { code: 1, output: "extract falhou (best-effort)" } : { code: 0, output: "ok" };

    const def = baseDef({
      steps: [
        { key: "sync", script: "sync.ts" },
        { key: "extract", script: "extract.ts", bestEffort: true },
        { key: "summary", script: "summary.ts" },
      ],
    });

    const result = runScheduledTask(def, {
      rootDir: ROOT,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: fakeExecStep,
    });

    assert.equal(result.code, 0, "step best-effort falhando não deveria reprovar a run");
  });

  it("token {tempLogPath} nos args é substituído pelo path absoluto do log temporário desta run", () => {
    const tempLogPath = join(workDir, "token-temp.log");
    const logPathOverride = join(workDir, "token-final.log");

    let capturedArgs: string[] = [];
    const fakeExecStep = (_script: string, args: string[]): StepExecResult => {
      capturedArgs = args;
      return { code: 0, output: "ok" };
    };

    const def = baseDef({
      steps: [{ key: "extract", script: "extract.ts", args: ["--log", "{tempLogPath}", "--out", "foo.json"] }],
    });

    runScheduledTask(def, { rootDir: ROOT, logPathOverride, tempLogPathOverride: tempLogPath, execStep: fakeExecStep });

    assert.deepEqual(capturedArgs, ["--log", tempLogPath, "--out", "foo.json"]);
  });
});

describe("runScheduledTask — guard de pré-condição (#4552, molde Diaria-Brevo-Diaria-Evaluate)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-guard-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("arquivo requerido AUSENTE -> aborta sem rodar nenhum passo, exit 1, log tem AVISO com a mensagem do guard", () => {
    const tempLogPath = join(workDir, "guard-fail-temp.log");
    const logPathOverride = join(workDir, "guard-fail-final.log");

    let stepCalled = false;
    const fakeExecStep = (): StepExecResult => {
      stepCalled = true;
      return { code: 0, output: "não deveria rodar" };
    };

    const def = baseDef({
      guard: {
        requiredFile: "arquivo-que-nao-existe-4805.json",
        abortMessage: "abortando por seguranca, arquivo nao encontrado.",
      },
    });

    const result = runScheduledTask(def, {
      rootDir: workDir, // rootDir sem o arquivo requerido
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: fakeExecStep,
    });

    assert.equal(stepCalled, false, "nenhum passo deveria ter rodado com o guard abortando");
    assert.equal(result.code, 1);
    assert.equal(result.guardAborted, true);
    assert.deepEqual(result.steps, []);
    const content = readFileSync(logPathOverride, "utf8");
    assert.match(content, /AVISO: abortando por seguranca, arquivo nao encontrado\./);
    assert.match(content, /fim \(guard=skip\)/);
  });

  it("arquivo requerido PRESENTE -> guard passa, passos rodam normalmente", () => {
    const tempLogPath = join(workDir, "guard-ok-temp.log");
    const logPathOverride = join(workDir, "guard-ok-final.log");
    mkdirSync(join(workDir, "data"), { recursive: true });
    writeFileSync(join(workDir, "data", "presente.json"), "{}");

    let stepCalled = false;
    const fakeExecStep = (): StepExecResult => {
      stepCalled = true;
      return { code: 0, output: "rodou" };
    };

    const def = baseDef({
      guard: { requiredFile: "presente.json", abortMessage: "não deveria aparecer" },
    });

    const result = runScheduledTask(def, {
      rootDir: workDir,
      logPathOverride,
      tempLogPathOverride: tempLogPath,
      execStep: fakeExecStep,
    });

    assert.equal(stepCalled, true);
    assert.equal(result.code, 0);
    assert.equal(result.guardAborted, false);
  });
});

describe("runScheduledTask — injeção de relógio (now)", () => {
  it("usa now() injetado no cabeçalho do log em vez do relógio real", () => {
    const workDir = mkdtempSync(join(tmpdir(), "task-runner-clock-"));
    try {
      const tempLogPath = join(workDir, "clock-temp.log");
      const logPathOverride = join(workDir, "clock-final.log");
      const fixedDate = new Date("2026-01-01T00:00:00.000Z");

      runScheduledTask(baseDef({ steps: [{ key: "noop", script: NOOP_FIXTURE }] }), {
        rootDir: ROOT,
        logPathOverride,
        tempLogPathOverride: tempLogPath,
        now: () => fixedDate,
        execStep: () => ({ code: 0, output: "ok" }),
      });

      const content = readFileSync(logPathOverride, "utf8");
      assert.match(content, /2026-01-01T00:00:00\.000Z/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
