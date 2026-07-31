/**
 * test/run-postmaster-spam-sync-npx-guard.test.ts (#4375)
 *
 * `scripts/run-postmaster-spam-sync.ps1` roda `npx tsx postmaster-spam-sync.ts`
 * como a PRIMEIRA (e única) invocação nativa da sessão do PowerShell. Sob
 * `Set-StrictMode -Version Latest` (já presente no script), se `npx` não puder
 * ser resolvido via PATH (cenário real: contexto de serviço do Task Scheduler
 * não herda o PATH corretamente), `& npx ...` lança `CommandNotFoundException`
 * e `$LASTEXITCODE` fica genuinamente INDEFINIDO (não `$null`) nessa sessão
 * nova — ler uma variável indefinida sob StrictMode lança outro erro
 * (não-terminante, engolido por `$ErrorActionPreference = "Continue"`), e um
 * guard que só checasse `if ($null -eq $syncCode)` DEPOIS da chamada nunca
 * dispararia (a própria leitura de `$syncCode`/`$LASTEXITCODE` já lançaria) —
 * a run cairia no `exit $code` final com `$code` também indefinido,
 * resolvendo pra exit 0 (falso sucesso), o pior cenário possível pra uma
 * invocação não-supervisionada.
 *
 * Este é o script ORIGINAL que introduziu o guard (#4342) — o gap foi
 * corrigido nos 2 wrappers irmãos em #4343 (ver
 * test/run-clarice-guardrail-alarm-npx-guard.test.ts e
 * test/run-clarice-sync-daily-log-resilience.test.ts) mas ficou fora de
 * escopo daquele PR. Este teste fecha o mesmo gap aqui, com o mesmo padrão:
 * roda o `.ps1` de verdade com o PATH do processo FILHO restringido a só
 * System32 (sem o diretório do Node/npx) — reproduz o cenário real (npx
 * genuinamente não resolvível), não um mock sintético. Sem o fix (guard
 * sozinho, sem a pré-inicialização de `$LASTEXITCODE = $null`), este teste
 * falharia com exit 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-postmaster-spam-sync.ps1");
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
  "run-postmaster-spam-sync.ps1: exit code honesto quando npx não spawna (#4375)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "postmaster-spam-sync-npx-test-"));
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

    it("PATH sem node/npx -> npx não resolve -> $LASTEXITCODE null -> guard força exit != 0", () => {
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
