/**
 * test/run-geo-citation-monitor-ps1.test.ts (#4558 Parte C)
 *
 * `scripts/run-geo-citation-monitor.ps1` (wrapper de `geo-citation-monitor.ts`)
 * segue o MESMO molde de log resiliente + exit code honesto de
 * `run-cursos-kv-sync.ps1` (#4320) e `run-clarice-sync-daily.ps1`
 * (#4047/#4343). Mesmos 3 cenários travados:
 *   1. Caso feliz (script noop OK) → exit 0, log final criado.
 *   2. Log não gravável (parent do LogPath é um arquivo) → exit != 0.
 *   3. PATH restrito sem node/npx → `$LASTEXITCODE` fica indefinido/null →
 *      guard força exit != 0 (não um falso-sucesso silencioso, #4343).
 *
 * Por que travar isso num wrapper novo: o monitor de citação ficou desde o
 * #4616 sem NUNCA ter rodado, porque nada o agendava. Um wrapper que falhasse
 * em silêncio recriaria o mesmo problema numa camada acima — a task rodaria,
 * o Task Scheduler marcaria sucesso, e ninguém teria série nenhuma.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-geo-citation-monitor.ps1");
const NOOP_FIXTURE = join(ROOT, "test-fixtures", "clarice-sync-daily", "noop-exit0.ts");

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
  "run-geo-citation-monitor.ps1: log resiliente + exit code honesto (#4558 Parte C)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "geo-citation-monitor-test-"));
    });

    after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("caso feliz: monitor OK -> exit 0, log final criado", () => {
      const tempLog = join(workDir, "happy-temp.log");
      const finalLog = join(workDir, "happy-final.log");

      const result = runScript([
        "-MonitorScript", NOOP_FIXTURE,
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
      const badLogPath = join(blockerFile, "sub", ".monitor.log");

      const result = runScript([
        "-MonitorScript", NOOP_FIXTURE,
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

    /**
     * O molde copiado (`run-cursos-kv-sync-ps1.test.ts`) NÃO tem este caso —
     * dois irmãos o ganharam como achado nomeado do review #4552
     * (`run-evaluate-brevo-diaria-ps1`, `run-check-brevo-diaria-guardrail-ps1`)
     * e o backport nunca chegou ao molde que eu copiei, então a lacuna se
     * propagou até aqui. Achado do fleet review da PR #4754.
     *
     * Sem ele, nenhum dos casos exercita o branch central do wrapper —
     * `$monitorCode` vindo de uma falha REAL do script embrulhado. Os outros
     * cobrem sucesso e os dois guards (pré e pós-execução).
     */
    it("monitor falha (exit 1) -> wrapper propaga exit 1, não engole", () => {
      const tempLog = join(workDir, "fail-temp.log");
      const finalLog = join(workDir, "fail-final.log");
      const failFixture = join(ROOT, "test-fixtures", "clarice-sync-daily", "noop-exit1.ts");

      const result = runScript([
        "-MonitorScript", failFixture,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
      ]);

      assert.equal(
        result.status,
        1,
        `esperava o exit 1 do monitor propagado, obteve ${result.status}. ` +
          `Engolir isso faria a task marcar verde com zero medição — o modo de falha que a #4558 Parte C existe pra corrigir.`,
      );
      assert.ok(existsSync(finalLog), "o log final deve existir mesmo quando o monitor falha");
    });

    it("PATH sem node/npx -> npx não resolve -> $LASTEXITCODE null -> guard força exit != 0 (#4343)", () => {
      const tempLog = join(workDir, "nonpx-temp.log");
      const finalLog = join(workDir, "nonpx-final.log");

      const result = runScriptWithNpxUnresolvable([
        "-MonitorScript", NOOP_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
      ]);

      assert.notEqual(
        result.status,
        0,
        `esperava exit != 0 quando npx não resolve, obteve ${result.status}. ` +
          `Um exit 0 aqui seria falso-sucesso: a task marcaria verde sem nenhuma medição ter acontecido.`,
      );
    });
  },
);
