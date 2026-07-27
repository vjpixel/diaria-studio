/**
 * test/eia-log-used-lock-4125.test.ts (#4125 item 7)
 *
 * `scripts/eia-log-used.ts` (chamado por `eia-compose.ts` a cada edição) e
 * `scripts/sync-eia-used.ts` faziam read-JSON → mutate → writeFileSync em
 * `data/eia-used.json` SEM lock. Duas execuções concorrentes (padrão
 * documentado neste projeto — overnight/develop rodando lotes em paralelo,
 * cada worktree compondo o "É IA?" de uma edição diferente ao mesmo tempo)
 * podiam interlear as duas leituras ANTES de qualquer escrita — a 2ª escrita
 * sobrescrevia o arquivo inteiro com uma cópia de `existing` que não incluía
 * a entrada que a 1ª acabara de gravar. Resultado: uma edição futura podia
 * selecionar uma foto do Wikimedia já usada, sem nenhum erro visível.
 *
 * FIX: `.lock` (criação exclusiva `wx`, mesmo mecanismo de
 * `scripts/lib/social-published-store.ts`, #758/#918 — extraído em
 * `scripts/lib/file-lock.ts`) serializa as duas execuções, e a escrita usa
 * tmp+rename atômico.
 *
 * Este teste roda `eia-log-used.ts` DUAS VEZES em paralelo de verdade
 * (2 processos via spawn, não chamadas sequenciais) contra o MESMO
 * `data/eia-used.json`, com edições/títulos DIFERENTES, e confirma que
 * AMBAS as entradas sobrevivem — a regressão exata seria "só 1 das 2
 * entradas aparece no arquivo final".
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  cpSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows, NPX } from "./_helpers/spawn-npx.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function spawnAsync(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NPX, args, { cwd, shell: isWindows });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

describe("eia-log-used.ts — lock previne perda de entrada em execuções concorrentes (#4125 item 7)", () => {
  let sandboxRoot: string;

  before(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "eia-log-used-lock-"));
    cpSync(resolve(ROOT, "scripts"), join(sandboxRoot, "scripts"), { recursive: true });
    cpSync(resolve(ROOT, "package.json"), join(sandboxRoot, "package.json"));
    cpSync(resolve(ROOT, "tsconfig.json"), join(sandboxRoot, "tsconfig.json"));
    if (existsSync(resolve(ROOT, "node_modules"))) {
      try {
        symlinkSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), isWindows ? "junction" : "dir");
      } catch {
        cpSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), { recursive: true });
      }
    }
    mkdirSync(join(sandboxRoot, "data"), { recursive: true });
  });

  after(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("2 execuções concorrentes (edições diferentes) — AMBAS as entradas sobrevivem, nenhuma some", async () => {
    const [r1, r2] = await Promise.all([
      spawnAsync(
        ["tsx", "scripts/eia-log-used.ts", "--edition", "260710", "--image-date", "2026-07-01",
          "--title", "File:ConcurrentA.jpg", "--url", "https://example.com/a.jpg"],
        sandboxRoot,
      ),
      spawnAsync(
        ["tsx", "scripts/eia-log-used.ts", "--edition", "260711", "--image-date", "2026-07-02",
          "--title", "File:ConcurrentB.jpg", "--url", "https://example.com/b.jpg"],
        sandboxRoot,
      ),
    ]);

    assert.equal(r1.status, 0, `1ª execução deveria sair 0 — stderr: ${r1.stderr}`);
    assert.equal(r2.status, 0, `2ª execução deveria sair 0 — stderr: ${r2.stderr}`);

    const finalLog = JSON.parse(readFileSync(join(sandboxRoot, "data", "eia-used.json"), "utf8")) as Array<{ edition_date: string; title: string }>;
    const editions = finalLog.map((e) => e.edition_date).sort();
    assert.deepEqual(
      editions,
      ["260710", "260711"],
      `REGRESSÃO #4125 item 7: as duas entradas devem sobreviver — recebeu ${JSON.stringify(editions)} (uma sumiu = race condition voltou)`,
    );
    assert.ok(finalLog.some((e) => e.title === "File:ConcurrentA.jpg"));
    assert.ok(finalLog.some((e) => e.title === "File:ConcurrentB.jpg"));
  });

  it("nenhum .lock/.tmp fica pra trás depois que as execuções terminam (cleanup correto)", () => {
    assert.equal(existsSync(join(sandboxRoot, "data", "eia-used.json.lock")), false, ".lock deve ser removido no finally");
    assert.equal(existsSync(join(sandboxRoot, "data", "eia-used.json.tmp")), false, ".tmp deve ser renomeado, nunca sobrar");
  });

  it("execução única (sem concorrência) continua funcionando normalmente — comportamento pré-existente preservado", async () => {
    const r = await spawnAsync(
      ["tsx", "scripts/eia-log-used.ts", "--edition", "260712", "--image-date", "2026-07-03",
        "--title", "File:Solo.jpg", "--credit", "Fulano, CC BY-SA", "--url", "https://example.com/solo.jpg"],
      sandboxRoot,
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const lastLine = r.stdout.trim().split("\n").pop() ?? "{}";
    const out = JSON.parse(lastLine) as { logged: { title: string }; total_entries: number };
    assert.equal(out.logged.title, "File:Solo.jpg");
    assert.ok(out.total_entries >= 1);
  });
});
