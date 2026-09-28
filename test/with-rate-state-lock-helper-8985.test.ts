/**
 * test/with-rate-state-lock-helper-8985.test.ts (#8985)
 *
 * Regressão para o `ENOENT` visto em CI 3x seguidas na PR #8985:
 * `acquireRateStateTestLock()` (test/_helpers/with-rate-state-lock.ts)
 * chamava `acquireLock` direto sobre um path dentro de `data/` — que é
 * inteiramente gitignored (#6952 fez `acquireLock` propagar `ENOENT` em vez
 * de engolir como contenção, o que é correto, mas expõe que ninguém
 * garantia o diretório pai antes). Em CI, `data/` só existe se outro
 * arquivo de teste já tiver criado a subpasta que precisa; a ordem de
 * batches de `node --test` (scripts/run-tests.ts, arquivos ordenados
 * alfabeticamente) é o único motivo de isso nunca ter estourado antes —
 * inserir um novo arquivo alfabeticamente cedo (aquisicao-reconcile-alarm)
 * reordenou os batches e expôs a corrida.
 *
 * Este teste não mexe no `data/` real do repo (compartilhado entre
 * processos concorrentes, ver docstring de with-rate-state-lock.ts) —
 * exercita o MESMO padrão (`mkdirSync(dirname(lockPath), {recursive:true})`
 * antes de `acquireLock`) contra um diretório tmp isolado, provando (a) que
 * sem o mkdir a falha é ENOENT e (b) que com o mkdir o lock é adquirido
 * mesmo quando o diretório pai não existe ainda.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, releaseLock } from "../scripts/lib/file-lock.ts";

describe("padrão mkdir-antes-do-lock (fix #8985)", () => {
  it("acquireLock sozinho falha com ENOENT quando o diretório pai não existe", () => {
    const base = mkdtempSync(join(tmpdir(), "rate-state-lock-8985-"));
    try {
      const missingDir = join(base, "nested", "does-not-exist-yet");
      const lockPath = join(missingDir, "state.json.test-lock");
      assert.throws(
        () => acquireLock(lockPath, 200),
        (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("mkdirSync recursive antes do acquireLock adquire o lock mesmo com diretório pai ausente", () => {
    const base = mkdtempSync(join(tmpdir(), "rate-state-lock-8985-"));
    try {
      const missingDir = join(base, "nested", "does-not-exist-yet");
      const lockPath = join(missingDir, "state.json.test-lock");
      assert.equal(existsSync(missingDir), false);

      // Mesmo padrão de acquireRateStateTestLock() pós-fix.
      mkdirSync(dirname(lockPath), { recursive: true });
      acquireLock(lockPath, 200);
      try {
        assert.equal(existsSync(lockPath), true);
      } finally {
        releaseLock(lockPath);
      }
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("mkdirSync recursive é idempotente quando o diretório já existe (caminho comum em CI)", () => {
    const base = mkdtempSync(join(tmpdir(), "rate-state-lock-8985-"));
    try {
      const dir = join(base, "already-there");
      mkdirSync(dir, { recursive: true });
      // Não deve lançar mesmo já existindo.
      assert.doesNotThrow(() => mkdirSync(dir, { recursive: true }));
      const lockPath = join(dir, "state.json.test-lock");
      acquireLock(lockPath, 200);
      releaseLock(lockPath);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
