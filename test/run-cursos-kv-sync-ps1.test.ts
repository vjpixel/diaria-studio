/**
 * test/run-cursos-kv-sync-ps1.test.ts (#4320)
 *
 * `scripts/run-cursos-kv-sync.ps1` (wrapper de `sync-cursos-subscribers-kv.ts`,
 * #4052) segue o MESMO molde de log resiliente + exit code honesto de
 * `run-clarice-sync-daily.ps1` (#4047/#4343). Mesmos 3 cenários travados:
 *   1. Caso feliz (script noop OK) → exit 0, log final criado.
 *   2. Log não gravável (parent do LogPath é um arquivo) → exit != 0.
 *   3. PATH restrito sem node/npx → `$LASTEXITCODE` fica indefinido/null →
 *      guard força exit != 0 (não um falso-sucesso silencioso, #4343).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-cursos-kv-sync.ps1");
const NOOP_FIXTURE = join(ROOT, "test", "fixtures", "clarice-sync-daily", "noop-exit0.ts");

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
  "run-cursos-kv-sync.ps1: log resiliente + exit code honesto (#4320)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "cursos-kv-sync-test-"));
    });

    after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("caso feliz: sync script OK -> exit 0, log final criado", () => {
      const tempLog = join(workDir, "happy-temp.log");
      const finalLog = join(workDir, "happy-final.log");

      const result = runScript([
        "-SyncScript", NOOP_FIXTURE,
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
      const badLogPath = join(blockerFile, "sub", ".kv-sync.log");

      const result = runScript([
        "-SyncScript", NOOP_FIXTURE,
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
        "-SyncScript", NOOP_FIXTURE,
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
  },
);
