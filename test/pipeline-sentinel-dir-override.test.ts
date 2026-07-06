/**
 * test/pipeline-sentinel-dir-override.test.ts (#2795)
 *
 * `pipeline-sentinel.ts` era hardcoded para `data/editions/{edition}` — o
 * layout da pipeline DIÁRIA. O digest MENSAL (`/diaria-mensal`) guarda seus
 * outputs em `data/monthly/{ciclo}/`, um layout diferente. #2795 pede que os
 * checkpoints `.step-N-done.json` do mensal sigam a MESMA convenção da
 * diária (mesmo formato de sentinel) sem duplicar a lógica de
 * pipeline-state.ts — daí o `--dir` override.
 *
 * Este teste cobre `resolveEditionDir` (a função pura que decide o
 * diretório) e um roundtrip write→assert→exists usando o dir resolvido,
 * provando que o sentinel funciona fora do layout `data/editions/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveEditionDir } from "../scripts/pipeline-sentinel.ts";
import { writeSentinel, assertSentinel, sentinelExists } from "../scripts/lib/pipeline-state.ts";

describe("resolveEditionDir (#2795, atualizado #2463/#3024)", () => {
  it("sem --dir e edição não existe no disco: default NESTED (#2463/#3024 — mesmo layout de editionDir())", () => {
    // #3024: quando a edição não está em nenhum layout no disco (ex: cwd
    // fictício de teste, ou edição nova ainda não criada), o fallback
    // segue o layout NESTED — o mesmo que editionDir() produz a partir de
    // #3023, não mais o flat legado hardcoded.
    const cwd = "C:/repo";
    const dir = resolveEditionDir({ edition: "260418" }, cwd);
    assert.equal(dir, resolve(cwd, "data", "editions", "2604", "260418"));
  });

  it("sem --dir mas edição já existe FLAT no disco: resolve pro flat existente (não recria nested)", () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-sentinel-flat-"));
    try {
      mkdirSync(join(root, "data", "editions", "260418"), { recursive: true });
      const dir = resolveEditionDir({ edition: "260418" }, root);
      assert.equal(dir, resolve(root, "data", "editions", "260418"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem --dir e edição já existe NESTED no disco: resolve pro nested existente", () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-sentinel-nested-"));
    try {
      mkdirSync(join(root, "data", "editions", "2604", "260418"), { recursive: true });
      const dir = resolveEditionDir({ edition: "260418" }, root);
      assert.equal(dir, resolve(root, "data", "editions", "2604", "260418"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("com --dir: usa o path explícito em vez de data/editions/", () => {
    const cwd = "C:/repo";
    const dir = resolveEditionDir({ edition: "2605-06", dir: "data/monthly/2605-06" }, cwd);
    assert.equal(dir, resolve(cwd, "data/monthly/2605-06"));
  });

  it("--dir relativo é resolvido contra cwd, não contra process.cwd() global", () => {
    const dir = resolveEditionDir({ edition: "2605-06", dir: "data/monthly/2605-06" }, "/tmp/worktree-x");
    assert.equal(dir, resolve("/tmp/worktree-x", "data/monthly/2605-06"));
  });

  it("edition ausente + sem --dir: não lança (edition vira string vazia no join)", () => {
    const dir = resolveEditionDir({}, "C:/repo");
    assert.equal(dir, resolve("C:/repo", "data", "editions", ""));
  });
});

describe("sentinel roundtrip fora do layout data/editions/ (#2795 — usado pelo /diaria-mensal)", () => {
  it("write → assert(ok) → exists(true) num diretório resolvido via --dir", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-monthly-sentinel-"));
    try {
      // Simula: --dir data/monthly/2605-06 (relativo a um cwd fake) — aqui já
      // resolvido, pois resolveEditionDir é testado isoladamente acima.
      const monthlyDir = resolveEditionDir({ edition: "2605-06", dir: "data/monthly/2605-06" }, root);
      mkdirSync(monthlyDir, { recursive: true });
      writeFileSync(join(monthlyDir, "prioritized.md"), "# conteúdo");

      writeSentinel(monthlyDir, 1, ["prioritized.md"]);

      assert.equal(sentinelExists(monthlyDir, 1), true);
      const result = assertSentinel(monthlyDir, 1);
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("legado sem sentinel mas com output em disco → assertSentinel reporta sentinel_missing (CLI trata como exit 3/legacy)", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-monthly-sentinel-legacy-"));
    try {
      const monthlyDir = resolveEditionDir({ edition: "2604", dir: "data/monthly/2604" }, root);
      mkdirSync(monthlyDir, { recursive: true });
      // Ciclo legado: draft.md existe em disco, mas NUNCA foi gravado sentinel
      // (pipeline rodou antes do #2795). O caller (SKILL) trata isso via
      // `pipeline-sentinel.ts assert --outputs` (exit 3 = legacy, não bloqueia).
      writeFileSync(join(monthlyDir, "draft.md"), "# draft legado");

      const result = assertSentinel(monthlyDir, 2);
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "sentinel_missing");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
