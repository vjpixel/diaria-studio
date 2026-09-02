/**
 * test/no-busy-wait-lock-acquisition-7031.test.ts (#7031)
 *
 * Guard de regressão contra a classe de erro do #7031: o commit `353f73f1`
 * (#6952/#6969) trocou o spin busy-wait de `scripts/lib/file-lock.ts` por
 * `Atomics.wait` — o spin queimava CPU competindo com o dono do lock
 * justamente quando ele precisava de CPU pra soltá-lo (medição da PR: batch
 * de 400s+/morto → 43s/exit 0). No MESMO commit, dois hooks escritos/
 * expandidos (`session-beacon.mjs`, `consume-merge-grant-on-merge.mjs`)
 * mantiveram o padrão antigo — reincidência #7031 (5ª/6ª ocorrência da
 * classe "instrução em prosa não é guard", #6864/#6941).
 *
 * Por que um teste e não só o fix: contenção de CPU é difícil de exercitar
 * direto em CI (não dá pra medir "queimou CPU competindo com o dono do
 * lock" de forma determinística e rápida). O guard prático é ESTÁTICO —
 * varre o código-fonte à procura da FORMA do bug (spin busy-wait numa
 * retentativa de aquisição de lock por arquivo `.lock`/EEXIST), não o
 * sintoma em runtime. Mesmo gênero do guard de cadência em prosa (#6928).
 *
 * Discriminador: um loop `while (Date.now() < X) {}` sozinho não é
 * necessariamente um bug — `scripts/lib/source-runs.ts` tem um backoff
 * síncrono legítimo (retry de `appendFileSync` em codes transientes do
 * Windows/OneDrive) que não é aquisição de lock por arquivo. O que torna o
 * padrão uma reincidência do #7031 é aparecer dentro do MESMO bloco de
 * retentativa que checa `EEXIST` (a assinatura de "outro processo já
 * segura o `.lock`, tenta de novo") — por isso o scan exige as DUAS
 * evidências próximas: `EEXIST` E `while (Date.now() < ... ) {` num raio de
 * poucas linhas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

const BUSY_WAIT_RE = /while\s*\(\s*Date\.now\(\)\s*<\s*[^)]+\)\s*\{/;
const EEXIST_RE = /EEXIST/;

/** Raio de linhas (pra trás E pra frente) em que `EEXIST` conta como
 *  contexto de aquisição de lock para a linha de busy-wait. */
const CONTEXT_WINDOW = 6;

/**
 * Decide se a linha `idx` (0-based) de `lines` é um busy-wait de aquisição
 * de lock por arquivo — mesmo critério usado pelo scan de arquivos abaixo,
 * exposto separadamente para os testes unitários de classe.
 */
export function isLockAcquisitionBusyWaitLine(lines: string[], idx: number): boolean {
  if (!BUSY_WAIT_RE.test(lines[idx])) return false;
  const start = Math.max(0, idx - CONTEXT_WINDOW);
  const end = Math.min(lines.length, idx + CONTEXT_WINDOW + 1);
  return lines.slice(start, end).some((l) => EEXIST_RE.test(l));
}

function listFiles(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry === "node_modules" || entry === ".git") continue;
      out.push(...listFiles(full, pred));
    } else if (pred(entry)) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const violations: string[] = [];
  lines.forEach((_line, i) => {
    if (isLockAcquisitionBusyWaitLine(lines, i)) {
      violations.push(`${file}:${i + 1} — ${lines[i].trim()}`);
    }
  });
  return violations;
}

describe("no-busy-wait-lock-acquisition-7031 (#7031)", () => {
  const hookFiles = listFiles(join(REPO_ROOT, ".claude", "hooks"), (n) => n.endsWith(".mjs"));
  const libFiles = listFiles(join(REPO_ROOT, "scripts", "lib"), (n) => n.endsWith(".ts"));

  it("varre os diretórios certos (sanidade da própria varredura)", () => {
    assert.ok(
      hookFiles.some((f) => f.endsWith("session-beacon.mjs")),
      "session-beacon.mjs tem que estar no escopo",
    );
    assert.ok(
      hookFiles.some((f) => f.endsWith("consume-merge-grant-on-merge.mjs")),
      "consume-merge-grant-on-merge.mjs tem que estar no escopo",
    );
    assert.ok(
      libFiles.some((f) => f.endsWith("file-lock.ts")),
      "file-lock.ts tem que estar no escopo",
    );
  });

  it("nenhum hook/lib usa busy-wait de CPU numa retentativa de lock EEXIST", () => {
    const violations = [...hookFiles, ...libFiles].flatMap(scanFile);
    assert.deepEqual(
      violations,
      [],
      `Busy-wait de CPU numa aquisição de lock por arquivo — trocar por ` +
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) ` +
        `(síncrono, dorme de verdade — não precisa de função async). ` +
        `Ver scripts/lib/file-lock.ts e issue #7031:\n${violations.join("\n")}`,
    );
  });
});

describe("no-busy-wait-lock-acquisition-7031 — matching por CLASSE", () => {
  it("acusa o padrão do incidente (EEXIST + while Date.now busy-wait próximos)", () => {
    const lines = [
      "    } catch (e) {",
      '      if (e?.code !== "EEXIST") throw e;',
      "      if (Date.now() >= deadline) throw new Error('timeout');",
      "      const end = Date.now() + 50;",
      "      while (Date.now() < end) { /* busy wait */ }",
      "    }",
    ];
    assert.equal(isLockAcquisitionBusyWaitLine(lines, 4), true);
  });

  it("NÃO acusa Atomics.wait (o fix correto)", () => {
    const lines = [
      '      if (e?.code !== "EEXIST") throw e;',
      "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
    ];
    assert.equal(BUSY_WAIT_RE.test(lines[1]), false);
  });

  it("NÃO acusa busy-wait sem contexto de EEXIST (ex: backoff de I/O do source-runs.ts)", () => {
    const lines = [
      "  for (let i = 0; i < attempts.length; i++) {",
      "    if (attempts[i] > 0) {",
      "      const deadline = Date.now() + attempts[i];",
      "      while (Date.now() < deadline) {",
      "        /* spin */",
      "      }",
      "    }",
      "    try {",
      "      appendFn(filePath, data, 'utf8');",
      "      return;",
      "    } catch (err) {",
      "      const code = (err as NodeJS.ErrnoException)?.code;",
      "    }",
      "  }",
    ];
    assert.equal(isLockAcquisitionBusyWaitLine(lines, 3), false);
  });

  it("acusa mesmo quando EEXIST aparece DEPOIS do busy-wait (ordem qualquer no raio)", () => {
    const lines = [
      "for (;;) {",
      "  try { closeSync(openSync(lockPath, 'wx')); break; } catch (e) {",
      "    while (Date.now() < end) { /* busy wait */ }",
      '    if (e?.code !== "EEXIST") throw e;',
      "  }",
      "}",
    ];
    assert.equal(isLockAcquisitionBusyWaitLine(lines, 2), true);
  });
});
