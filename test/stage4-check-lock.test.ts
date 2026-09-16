/**
 * test/stage4-check-lock.test.ts (#8123 Fatia 3)
 *
 * Coalescing das checagens em background do Stage 4: uma rajada de ajustes
 * deve gerar UMA rodada de checagem sobre o estado final, não uma por
 * ajuste. Cobre o mecanismo de generation em `scripts/lib/stage4-check-lock.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLock, claimGeneration, releaseGeneration, isCheckRunning } from "../scripts/lib/stage4-check-lock.ts";

function withLockPath(fn: (lockPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stage4-lock-"));
  const lockPath = join(dir, "_internal", ".stage4-post-edit-checks-lock.json");
  try {
    fn(lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readLock", () => {
  it("estado inicial quando o lock não existe: generation 0, running false", () => {
    withLockPath((lockPath) => {
      const state = readLock(lockPath);
      assert.equal(state.generation, 0);
      assert.equal(state.running, false);
    });
  });

  it("fail-soft: lock corrompido (JSON inválido) volta pro estado inicial em vez de lançar", () => {
    withLockPath((lockPath) => {
      mkdirSync(join(lockPath, ".."), { recursive: true });
      writeFileSync(lockPath, "{ isso não é json válido", "utf8");
      const state = readLock(lockPath);
      assert.equal(state.generation, 0);
      assert.equal(state.running, false);
    });
  });
});

describe("claimGeneration / releaseGeneration", () => {
  it("cada claim incrementa a generation e marca running:true", () => {
    withLockPath((lockPath) => {
      const gen1 = claimGeneration(lockPath);
      assert.equal(gen1, 1);
      assert.equal(isCheckRunning(lockPath), true);

      const gen2 = claimGeneration(lockPath);
      assert.equal(gen2, 2);
      assert.equal(isCheckRunning(lockPath), true);
    });
  });

  it("release marca running:false quando a generation ainda é a corrente", () => {
    withLockPath((lockPath) => {
      const gen = claimGeneration(lockPath);
      releaseGeneration(lockPath, gen);
      assert.equal(isCheckRunning(lockPath), false);
    });
  });

  it("isCheckRunning: PID vivo (o processo de teste, sempre existe) mantém running:true (#8123 review)", () => {
    withLockPath((lockPath) => {
      claimGeneration(lockPath); // claimGeneration grava process.pid (o pid deste próprio teste)
      assert.equal(isCheckRunning(lockPath), true);
    });
  });

  it("isCheckRunning: PID morto (processo não existe mais) auto-cura o lock, evita ficar travado pra sempre (#8123 review)", () => {
    withLockPath((lockPath) => {
      claimGeneration(lockPath);
      // Simula o processo em background morrendo anormalmente (SIGKILL/OOM)
      // ANTES do `finally { releaseGeneration }` rodar: reescreve o lock
      // com um PID que quase certamente não existe.
      const DEAD_PID = 999999;
      writeFileSync(
        lockPath,
        JSON.stringify({ running: true, generation: 1, pid: DEAD_PID, started_at: new Date().toISOString() }, null, 2) + "\n",
        "utf8",
      );
      assert.equal(isCheckRunning(lockPath), false, "lock com PID morto não deveria travar isCheckRunning pra sempre");
    });
  });

  it("isCheckRunning: lock sem pid gravado (sentinel legado) trata como ainda rodando — conservador", () => {
    withLockPath((lockPath) => {
      mkdirSync(join(lockPath, ".."), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({ running: true, generation: 1 }, null, 2) + "\n",
        "utf8",
      );
      assert.equal(isCheckRunning(lockPath), true);
    });
  });

  it("coalescing: release de uma generation VELHA nunca apaga o running:true de uma generation mais NOVA (#8123 §3)", () => {
    withLockPath((lockPath) => {
      // Rodada A começa (ajuste 1).
      const genA = claimGeneration(lockPath);

      // Enquanto A ainda roda, o editor faz outro ajuste (ajuste 2) —
      // orchestrator lança a rodada B ANTES de A terminar (não deveria
      // acontecer se o orchestrator checar isCheckRunning antes de
      // relançar, mas o lock precisa ser correto mesmo se isso falhar).
      const genB = claimGeneration(lockPath);
      assert.equal(genB, genA + 1);

      // Rodada A termina e libera — mas B é mais nova, o release de A é
      // um no-op.
      releaseGeneration(lockPath, genA);
      assert.equal(isCheckRunning(lockPath), true, "release de generation velha não pode apagar running de generation nova");
      assert.equal(readLock(lockPath).generation, genB);

      // Rodada B termina de verdade — agora sim libera.
      releaseGeneration(lockPath, genB);
      assert.equal(isCheckRunning(lockPath), false);
    });
  });
});
