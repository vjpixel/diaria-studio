/**
 * test/run-geo-citation-staleness-alarm-ps1.test.ts (#4756)
 *
 * `scripts/run-geo-citation-staleness-alarm.ps1` (#4755) não tinha teste de
 * regressão dedicado até a migração pro módulo compartilhado
 * `scripts/lib/Invoke-DiariaScheduledWrapper.psm1` (#4756) — segue o MESMO
 * molde de log resiliente + exit code honesto dos demais wrappers migrados
 * (`run-worker-drift-check.ps1`/`run-hub-drift-check.ps1`, #4064/#4320/#4343).
 * Cenários travados aqui:
 *   1. Caso feliz (script noop OK) → exit 0, log final criado.
 *   2. Log não gravável (parent do LogPath é um arquivo) → exit != 0.
 *   3. PATH restrito sem node/npx → `$LASTEXITCODE` fica indefinido/null →
 *      guard força exit != 0 (não um falso-sucesso silencioso, #4343).
 *   4. Script noop que falha (exit 1) → exit code do wrapper também é 1
 *      (mesmo caso do achado HIGH #2 do review #4552, escrito aqui desde a
 *      criação do teste — não há molde antigo pra faltar o backport).
 *   5. `Invoke-DiariaScheduledWrapper.psm1` não resolve (achado CRITICAL do
 *      fleet review pré-merge da #4756) → sem este guard, o `Import-Module`
 *      falhando é um erro NÃO-terminante sob `$ErrorActionPreference =
 *      "Continue"`, e o script cai direto no `exit $code` com `$code` nunca
 *      atribuído — que sai 0 sob `Set-StrictMode`. Sucesso fantasma
 *      justamente no wrapper de um ALARME de staleness. Note que o
 *      `try/catch` cobre só o `Import-Module`, nunca a chamada de
 *      `Invoke-DiariaScheduledWrapper` em si — envolvê-la também quebraria o
 *      guard #4343 (cenário 3 acima), que depende de rodar SEM um
 *      try/catch envolvente pra degradar corretamente pra
 *      `$LASTEXITCODE=$null` em vez de propagar a exceção terminante do
 *      comando não encontrado.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-geo-citation-staleness-alarm.ps1");
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
  "run-geo-citation-staleness-alarm.ps1: log resiliente + exit code honesto (#4756)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "geo-staleness-alarm-ps1-test-"));
    });

    after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("caso feliz: alarm script OK -> exit 0, log final criado", () => {
      const tempLog = join(workDir, "happy-temp.log");
      const finalLog = join(workDir, "happy-final.log");

      const result = runScript([
        "-AlarmScript", NOOP_FIXTURE,
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
      const badLogPath = join(blockerFile, "sub", ".staleness-alarm.log");

      const result = runScript([
        "-AlarmScript", NOOP_FIXTURE,
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
        "-AlarmScript", NOOP_FIXTURE,
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

    it("alarm script falha (exit 1) -> exit code do wrapper também é 1 (#4756, backport do achado #4552)", () => {
      const tempLog = join(workDir, "exit1-temp.log");
      const finalLog = join(workDir, "exit1-final.log");

      const result = runScript([
        "-AlarmScript", NOOP_EXIT1_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
      ]);

      assert.equal(
        result.status,
        1,
        `esperava exit 1 quando o alarm script falha com exit 1, obteve ${result.status}. ` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.ok(existsSync(finalLog), "esperava o log final criado");
      const content = readFileSync(finalLog, "utf8");
      assert.match(content, /fim \(alarm=1\)/);
    });

    it("Invoke-DiariaScheduledWrapper.psm1 não resolve -> exit != 0, nunca sucesso fantasma (achado CRITICAL, fleet review #4756)", () => {
      // Copia só o .ps1 pra um dir isolado SEM a subpasta lib/ -- o
      // Join-Path relativo a $ScriptDir nao encontra o modulo, forcando o
      // mesmo Import-Module que falharia num .psm1 corrompido/renomeado em
      // producao.
      const isolatedDir = mkdtempSync(join(tmpdir(), "geo-staleness-alarm-noModule-"));
      const isolatedScript = join(isolatedDir, "run-geo-citation-staleness-alarm.ps1");
      copyFileSync(SCRIPT, isolatedScript);

      const tempLog = join(workDir, "nomodule-temp.log");
      const finalLog = join(workDir, "nomodule-final.log");

      try {
        const result = spawnSync(
          POWERSHELL_ABS,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            isolatedScript,
            "-AlarmScript",
            NOOP_FIXTURE,
            "-LogPath",
            finalLog,
            "-TempLogPath",
            tempLog,
          ],
          { encoding: "utf8", timeout: 120_000 },
        );

        assert.notEqual(
          result.status,
          0,
          `esperava exit != 0 quando o modulo compartilhado nao resolve, obteve ${result.status} (sucesso fantasma). ` +
            `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
        assert.ok(existsSync(finalLog), "esperava o log final criado mesmo com o modulo ausente");
        const content = readFileSync(finalLog, "utf8");
        assert.match(content, /ERRO FATAL.*carregar Invoke-DiariaScheduledWrapper\.psm1/);
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true });
      }
    });
  },
);
