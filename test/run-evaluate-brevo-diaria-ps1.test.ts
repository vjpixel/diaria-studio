/**
 * test/run-evaluate-brevo-diaria-ps1.test.ts (#4534, guard de junction +
 * teste de propagação de exit code adicionados no review do #4552)
 *
 * `scripts/run-evaluate-brevo-diaria.ps1` segue o MESMO molde de
 * `scripts/run-apoios-diff-alarm.ps1`/`scripts/run-cursos-error-alarm.ps1`/
 * `scripts/run-clarice-guardrail-alarm.ps1` (#4064/#4320/#4343/#4485): log
 * resiliente (temp file fora de data/, anexo com retry) + exit code honesto
 * mesmo quando `npx` genuinamente não resolve no PATH (contexto de serviço
 * do Task Scheduler). Cenários travados aqui:
 *   1. Caso feliz (script noop OK) → exit 0, log final criado.
 *   2. Log não gravável (parent do LogPath é um arquivo) → exit != 0.
 *   3. PATH restrito sem node/npx → `$LASTEXITCODE` fica indefinido/null →
 *      guard força exit != 0 (não um falso-sucesso silencioso, #4343).
 *   4. Script noop que falha (exit 1) → `$LASTEXITCODE` do wrapper também é
 *      1 (propagação verificada automaticamente, não só manual — achado HIGH
 *      #2 do review do #4552).
 *   5. `contacts.json` ausente (junction data/ do OneDrive não montada ainda)
 *      → wrapper aborta SEM invocar o evaluate script, exit != 0 (achado
 *      HIGH #1 do review do #4552 — sem esse guard, `--push` sobrescreveria
 *      o store real com `{"contacts":[]}`).
 *
 * Os testes 1-4 passam `-ContactsJsonPath` apontando pra um fixture que
 * EXISTE (criado no `before()`), pra não colidir com o novo guard #5 — sem
 * isso, rodar a suíte num clone/worktree sem o junction `data/` montado
 * (o caso comum de CI, #2643) faria o guard disparar em todo teste, não só
 * no que testa o próprio guard.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-evaluate-brevo-diaria.ps1");
const NOOP_FIXTURE = join(ROOT, "test", "fixtures", "clarice-sync-daily", "noop-exit0.ts");
const NOOP_EXIT1_FIXTURE = join(ROOT, "test", "fixtures", "clarice-sync-daily", "noop-exit1.ts");

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
  "run-evaluate-brevo-diaria.ps1: log resiliente + exit code honesto (#4534)",
  { skip: !isWindows && "requer powershell.exe (Windows)" },
  () => {
    let workDir: string;
    let contactsJsonPath: string;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "evaluate-brevo-diaria-test-"));
      // Fixture de contacts.json VÁLIDO (junction "montada") -- usado pelos
      // testes que não exercitam o guard do achado #1, pra preservar o
      // comportamento anterior deles independente de `data/` existir no
      // ambiente onde a suíte roda.
      contactsJsonPath = join(workDir, "contacts.json");
      writeFileSync(contactsJsonPath, JSON.stringify({ contacts: [] }));
    });

    after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("caso feliz: evaluate script OK -> exit 0, log final criado", () => {
      const tempLog = join(workDir, "happy-temp.log");
      const finalLog = join(workDir, "happy-final.log");

      const result = runScript([
        "-EvaluateScript", NOOP_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
        "-ContactsJsonPath", contactsJsonPath,
      ]);

      assert.equal(result.status, 0, `esperava exit 0, obteve ${result.status}. stderr:\n${result.stderr}`);
      assert.ok(existsSync(finalLog), "esperava o log final criado");
    });

    it("log não gravável (parent do LogPath é um arquivo) -> exit != 0", () => {
      const tempLog = join(workDir, "logfail-temp.log");
      const blockerFile = join(workDir, "blocker.txt");
      writeFileSync(blockerFile, "sou um arquivo, nao um diretorio");
      const badLogPath = join(blockerFile, "sub", ".evaluate.log");

      const result = runScript([
        "-EvaluateScript", NOOP_FIXTURE,
        "-LogPath", badLogPath,
        "-TempLogPath", tempLog,
        "-ContactsJsonPath", contactsJsonPath,
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
        "-EvaluateScript", NOOP_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
        "-ContactsJsonPath", contactsJsonPath,
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

    it("evaluate script falha (exit 1) -> exit code do wrapper também é 1, com o log de fim correto (achado HIGH #2 do review #4552)", () => {
      const tempLog = join(workDir, "exit1-temp.log");
      const finalLog = join(workDir, "exit1-final.log");

      const result = runScript([
        "-EvaluateScript", NOOP_EXIT1_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
        "-ContactsJsonPath", contactsJsonPath,
      ]);

      assert.equal(
        result.status,
        1,
        `esperava exit 1 quando o evaluate script falha com exit 1, obteve ${result.status}. ` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.ok(existsSync(finalLog), "esperava o log final criado");
      const content = readFileSync(finalLog, "utf8");
      assert.match(content, /fim \(evaluate=1\)/);
    });

    it("contacts.json ausente (junction data/ não montada) -> guard aborta SEM invocar o evaluate script, exit != 0 (achado HIGH #1 do review #4552)", () => {
      const tempLog = join(workDir, "missingcontacts-temp.log");
      const finalLog = join(workDir, "missingcontacts-final.log");
      const missingContactsPath = join(workDir, "does-not-exist", "contacts.json");

      const result = runScript([
        "-EvaluateScript", NOOP_FIXTURE,
        "-LogPath", finalLog,
        "-TempLogPath", tempLog,
        "-ContactsJsonPath", missingContactsPath,
      ]);

      assert.notEqual(
        result.status,
        0,
        `esperava exit != 0 quando contacts.json está ausente, obteve ${result.status}. ` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.ok(existsSync(finalLog), "esperava o log final criado mesmo com o guard abortando");
      const content = readFileSync(finalLog, "utf8");
      assert.match(content, /AVISO.*contacts\.json nao encontrado/);
      // Prova de que o evaluate script (NOOP_FIXTURE) nunca rodou: seu
      // próprio stdout ("noop ok", ver test/fixtures/clarice-sync-daily/
      // noop-exit0.ts) nunca teria chegado ao log se o guard interceptou
      // antes da chamada `npx tsx`.
      assert.doesNotMatch(content, /noop ok/);
    });
  },
);
