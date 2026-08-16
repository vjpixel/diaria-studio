/**
 * test/eia-dispatch-state.test.ts (#5414)
 *
 * Cobre `scripts/lib/eia-dispatch-state.ts` — o Stage 3 (`/diaria-3-imagens`,
 * sessão nova possível) precisa saber QUANDO o eia-compose foi dispatchado
 * pelo Stage 1 sem depender de memória de conversa, pra que o timeout de
 * 10min do §3a funcione mesmo sem o `bashId` da sessão original.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEiaDispatchState,
  writeEiaDispatchState,
  type EiaDispatchState,
} from "../scripts/lib/eia-dispatch-state.ts";

const DEFAULT: EiaDispatchState = { bashId: null, dispatchedAt: null };

describe("readEiaDispatchState / writeEiaDispatchState (#5414)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "eia-dispatch-state-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("sem arquivo -> default (bashId/dispatchedAt null)", () => {
    assert.deepEqual(readEiaDispatchState(editionDir), DEFAULT);
  });

  it("write grava e read reflete", () => {
    const written = writeEiaDispatchState(editionDir, {
      bashId: "bash_abc123",
      dispatchedAt: "2026-08-16T08:00:00.000Z",
    });
    assert.equal(written.bashId, "bash_abc123");
    assert.equal(written.dispatchedAt, "2026-08-16T08:00:00.000Z");
    assert.deepEqual(readEiaDispatchState(editionDir), written);
  });

  it("um novo dispatch (retry --force) substitui por completo, não faz merge parcial", () => {
    writeEiaDispatchState(editionDir, { bashId: "bash_retry", dispatchedAt: "2026-08-16T08:15:00.000Z" });
    const read = readEiaDispatchState(editionDir);
    assert.equal(read.bashId, "bash_retry");
    assert.equal(read.dispatchedAt, "2026-08-16T08:15:00.000Z");
  });

  it("cria _internal/ se ainda não existir", () => {
    const fresh = mkdtempSync(join(tmpdir(), "eia-dispatch-state-nodir-"));
    assert.equal(existsSync(join(fresh, "_internal")), false);
    writeEiaDispatchState(fresh, { bashId: "b1", dispatchedAt: "2026-08-16T08:00:00.000Z" });
    assert.equal(existsSync(join(fresh, "_internal", "eia-dispatch-state.json")), true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "eia-dispatch-state-corrupt-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "eia-dispatch-state.json"), "não é json", "utf8");
    assert.deepEqual(readEiaDispatchState(dir), DEFAULT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com campo de tipo errado -> normaliza pra null", () => {
    const dir = mkdtempSync(join(tmpdir(), "eia-dispatch-state-badtype-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "eia-dispatch-state.json"),
      JSON.stringify({ bashId: 12345, dispatchedAt: "2026-08-16T08:00:00.000Z" }),
      "utf8",
    );
    assert.deepEqual(readEiaDispatchState(dir), { bashId: null, dispatchedAt: "2026-08-16T08:00:00.000Z" });
    rmSync(dir, { recursive: true, force: true });
  });

  // Fleet review pré-merge #5414 (silent-failure-hunter, CRITICAL #1) — o
  // catch genérico original engolia EACCES/EPERM/EISDIR/lock do OneDrive sem
  // log nenhum, indistinguível de "nunca dispatchado". Simula um erro de FS
  // real (não ausência de arquivo, não JSON corrompido) fazendo o path do
  // state file ser um DIRETÓRIO em vez de um arquivo — `existsSync` retorna
  // true, mas `readFileSync` lança EISDIR, tanto em Windows quanto POSIX.
  // (CRITICAL #2, upsert perdendo dado em escrita, não se aplica aqui — o
  // silent-failure-hunter confirmou que `writeEiaDispatchState` sempre
  // sobrescreve por completo, nunca faz merge sobre uma leitura anterior.)
  it("erro de FS real na leitura (EISDIR) -> loga e retorna default, nunca lança (CRITICAL #1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eia-dispatch-state-eisdir-"));
    mkdirSync(join(dir, "_internal", "eia-dispatch-state.json"), { recursive: true });

    let logged = "";
    const originalError = console.error;
    console.error = (msg: unknown) => {
      logged = String(msg);
    };
    try {
      assert.deepEqual(readEiaDispatchState(dir), DEFAULT);
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.length > 0, "esperava console.error chamado com o erro de FS");
    assert.match(logged, /EISDIR/);
    rmSync(dir, { recursive: true, force: true });
  });
});
