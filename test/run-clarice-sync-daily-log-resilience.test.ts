/**
 * test/run-clarice-sync-daily-log-resilience.test.ts (#4047)
 *
 * `scripts/run-clarice-sync-daily.ps1` escreve o log em `data/clarice-subscribers/
 * .brevo-sync-daily.log`, dentro da directory junction pro OneDrive. `Add-Content`
 * direto nesse path falhava intermitentemente ("O fluxo não era legível" — lock
 * do OneDrive, observado ao reconectar a task 260726) e o script seguia como se
 * nada tivesse acontecido: nem log gravado, nem exit code refletindo a falha
 * (`$ErrorActionPreference = "Continue"` engolia o erro, e `$code` só olhava
 * `$syncCode`/`$sumCode` — uma run sem NENHUM log ainda reportava exit 0 pro
 * Task Scheduler).
 *
 * O fix reescreve o script para: (1) logar tudo primeiro num arquivo temporário
 * FORA de data/ (sem risco de lock OneDrive), (2) só no final anexar esse log
 * ao destino final com retry curto, (3) se o anexo falhar mesmo após retry,
 * sair com exit != 0 mesmo que os passos sync/summary tenham ido bem.
 *
 * Este teste roda o .ps1 de verdade (powershell.exe, disponível no Windows —
 * ambiente desta suíte) com os passos sync/summary substituídos por um fixture
 * noop (evita credenciais reais / junction data/) e o LogPath apontado pra um
 * destino que sempre falha (parent path é um ARQUIVO, não diretório — New-Item
 * -ItemType Directory sobre ele sempre lança). Trava a regressão: exit code
 * deve ser != 0 quando o log não pôde ser persistido, e = 0 no caso feliz.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-clarice-sync-daily.ps1");
const NOOP_FIXTURE = join(ROOT, "test", "fixtures", "clarice-sync-daily", "noop-exit0.ts");

const isWindows = process.platform === "win32";

function runScript(args: string[], timeoutMs = 120_000) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
    { encoding: "utf8", timeout: timeoutMs },
  );
}

// #4343: reproduz o cenário REAL do bug — `npx` genuinamente não resolvível
// no PATH do processo (o que acontece sob o contexto de serviço do Task
// Scheduler quando o PATH não é herdado corretamente). Usa o caminho
// absoluto do powershell.exe (não depende do PATH do processo de teste pra
// resolver o próprio powershell) e restringe o PATH do FILHO a só
// System32 (sem o diretório do Node/npx) — `& npx ...` levanta
// CommandNotFoundException, $LASTEXITCODE fica $null, e sem o guard
// `exit $null` resolveria pra exit 0 (falso sucesso).
const POWERSHELL_ABS = join(
  String(process.env.SystemRoot ?? "C:\\Windows"),
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function runScriptWithNpxUnresolvable(script: string, args: string[], timeoutMs = 120_000) {
  const systemRoot = String(process.env.SystemRoot ?? "C:\\Windows");
  const restrictedPath = [
    join(systemRoot, "System32"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  return spawnSync(
    POWERSHELL_ABS,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        SystemRoot: systemRoot,
        windir: systemRoot,
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
        PATH: restrictedPath,
      },
    },
  );
}

describe("run-clarice-sync-daily.ps1: exit code honesto quando o log falha (#4047)", { skip: !isWindows && "requer powershell.exe (Windows)" }, () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "clarice-sync-daily-test-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("caso feliz: sync+summary OK e log gravável -> exit 0, log final criado", () => {
    const tempLog = join(workDir, "happy-temp.log");
    const finalLog = join(workDir, "happy-final.log");

    const result = runScript([
      "-SyncScript", NOOP_FIXTURE,
      "-SummaryScript", NOOP_FIXTURE,
      "-LogPath", finalLog,
      "-TempLogPath", tempLog,
    ]);

    assert.equal(result.status, 0, `esperava exit 0, obteve ${result.status}. stderr:\n${result.stderr}`);
    assert.ok(existsSync(finalLog), "esperava o log final criado");
    const content = readFileSync(finalLog, "utf8");
    assert.match(content, /clarice-sync-brevo --incremental/);
    assert.match(content, /clarice-db-summary/);
  });

  it("sync/summary OK mas log não gravável (parent path é um arquivo) -> exit != 0", () => {
    const tempLog = join(workDir, "fail-temp.log");
    // Parent do LogPath ("blocker.txt") é um ARQUIVO, não diretório — qualquer
    // tentativa de New-Item -ItemType Directory ou Add-Content sob ele falha
    // de forma determinística e repetível (não depende de lock real do OneDrive).
    const blockerFile = join(workDir, "blocker.txt");
    writeFileSync(blockerFile, "sou um arquivo, nao um diretorio");
    const badLogPath = join(blockerFile, "sub", ".brevo-sync-daily.log");

    const result = runScript([
      "-SyncScript", NOOP_FIXTURE,
      "-SummaryScript", NOOP_FIXTURE,
      "-LogPath", badLogPath,
      "-TempLogPath", tempLog,
    ]);

    assert.notEqual(
      result.status,
      0,
      `esperava exit != 0 quando o log não pôde ser persistido, obteve ${result.status}. ` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout ?? "", /AVISO.*falha ao gravar o log final/);
    // O log temporário é preservado (não removido) quando o anexo final falha —
    // evidência de que a run não perdeu o registro do que aconteceu.
    assert.ok(existsSync(tempLog), "esperava o log temporário preservado quando o anexo final falha");
  });
});

// #4343: $LASTEXITCODE fica $null se npx não spawnar (falso sucesso). O
// guard mirror do fix aplicado em run-postmaster-spam-sync.ps1 (#4342) —
// aplicado aqui e em run-clarice-guardrail-alarm.ps1.
describe("run-clarice-sync-daily.ps1: exit code honesto quando npx não spawna (#4343)", { skip: !isWindows && "requer powershell.exe (Windows)" }, () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "clarice-sync-daily-npx-test-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("PATH sem node/npx -> npx não resolve -> $LASTEXITCODE null -> guard força exit != 0", () => {
    const tempLog = join(workDir, "npxfail-temp.log");
    const finalLog = join(workDir, "npxfail-final.log");

    const result = runScriptWithNpxUnresolvable(SCRIPT, [
      "-SyncScript", NOOP_FIXTURE,
      "-SummaryScript", NOOP_FIXTURE,
      "-LogPath", finalLog,
      "-TempLogPath", tempLog,
    ]);

    assert.notEqual(
      result.status,
      0,
      `esperava exit != 0 quando npx não spawna, obteve ${result.status}. ` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(existsSync(finalLog), "esperava o log final criado mesmo com npx não resolvido");
    const content = readFileSync(finalLog, "utf8");
    assert.match(content, /npx nao executou/);
  });
});
