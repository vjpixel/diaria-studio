/**
 * test/run-worker-drift-check-ps1.test.ts (#4723)
 *
 * `scripts/run-worker-drift-check.ps1` segue o MESMO molde de
 * `scripts/run-apoios-diff-alarm.ps1`/`scripts/run-cursos-error-alarm.ps1`
 * (#4064/#4343), extraído para `scripts/lib/Invoke-DiariaScheduledWrapper.psm1`
 * em #4756: log resiliente (temp file fora de data/, anexo com retry) +
 * exit code honesto mesmo quando `npx` genuinamente não resolve no PATH
 * (contexto de serviço do Task Scheduler). Cenários travados aqui — ver
 * `test/run-cursos-error-alarm-ps1.test.ts` pro precedente direto. O caso
 * exit-1 (#4756, backport do achado #4552) fecha a mesma lacuna encontrada
 * em `run-geo-citation-monitor-ps1.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-worker-drift-check.ps1");
const NOOP_FIXTURE = join(ROOT, "test-fixtures", "clarice-sync-daily", "noop-exit0.ts");
const NOOP_EXIT1_FIXTURE = join(ROOT, "test-fixtures", "clarice-sync-daily", "noop-exit1.ts");

const isWindows = process.platform === "win32";

const POWERSHELL_ABS = join(
  String(process.env.SystemRoot ?? "C:\\Windows"),
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function runScript(args: string[], timeoutMs = 120_000) {
  return spawnSync(POWERSHELL_ABS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function runScriptWithNpxUnresolvable(args: string[], timeoutMs = 120_000) {
  const systemRoot = String(process.env.SystemRoot ?? "C:\\Windows");
  const restrictedPath = [
    join(systemRoot, "System32"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  return spawnSync(POWERSHELL_ABS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      SystemRoot: systemRoot,
      windir: systemRoot,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      PATH: restrictedPath,
    },
  });
}

describe(
  "run-worker-drift-check.ps1: log resiliente + exit code honesto (#4723)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "worker-drift-check-ps1-test-"));
    });

    after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("caso feliz: check script OK -> exit 0, log final criado", () => {
      const tempLog = join(workDir, "happy-temp.log");
      const finalLog = join(workDir, "happy-final.log");

      const result = runScript([
        "-CheckScript", NOOP_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
      ]);

      assert.equal(result.status, 0, `esperava exit 0, obteve ${result.status}. stderr:\n${result.stderr}`);
      assert.ok(existsSync(finalLog), "esperava o log final criado");
    });

    it("log não gravável (parent do LogPath é um arquivo) -> exit != 0", () => {
      const tempLog = join(workDir, "logfail-temp.log");
      const blockerFile = join(workDir, "blocker.txt");
      writeFileSync(blockerFile, "sou um arquivo, nao um diretorio");
      const badLogPath = join(blockerFile, "sub", ".drift-check.log");

      const result = runScript([
        "-CheckScript", NOOP_FIXTURE,
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
      assert.ok(existsSync(tempLog), "esperava o log temporário preservado quando o anexo final falha");
    });

    it("PATH sem node/npx -> npx não resolve -> $LASTEXITCODE null -> guard força exit != 0 (#4343)", () => {
      const tempLog = join(workDir, "npxfail-temp.log");
      const finalLog = join(workDir, "npxfail-final.log");

      const result = runScriptWithNpxUnresolvable([
        "-CheckScript", NOOP_FIXTURE,
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
    });

    it("check script falha (exit 1) -> exit code do wrapper também é 1 (#4756, backport do achado #4552)", () => {
      const tempLog = join(workDir, "exit1-temp.log");
      const finalLog = join(workDir, "exit1-final.log");

      const result = runScript([
        "-CheckScript", NOOP_EXIT1_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
      ]);

      assert.equal(
        result.status,
        1,
        `esperava exit 1 quando o check script falha com exit 1, obteve ${result.status}. ` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.ok(existsSync(finalLog), "esperava o log final criado");
      const content = readFileSync(finalLog, "utf8");
      assert.match(content, /fim \(check=1\)/);
    });
  },
);
