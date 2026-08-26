/**
 * test/pipeline-sentinel-legacy-cutoff.test.ts (#5678)
 *
 * `pipeline-sentinel.ts assert` tem um fallback "legacy/migração" (exit 3,
 * warn-only): quando o sentinel formal está ausente mas todos os
 * `--outputs` já existem em disco, ele passa em vez de bloquear. Esse
 * fallback foi pensado pra edições anteriores ao mecanismo de sentinel
 * (#1216, 2026-05-13) — mas não distinguia isso de um stage rodado fora do
 * playbook numa edição RECENTE (achado ao vivo na 260819: Stage 2/3
 * produziram outputs reais sem nunca passar pelo sentinel/bookkeeping do
 * orchestrator, e o fallback legado mascarou isso como "legado").
 *
 * `isLegacySentinelEdition` restringe o fallback por data de criação da
 * edição: só edições ANTERIORES à data de corte (#1216) usam o warn; uma
 * edição de 2026-08 cai no ramo de erro de verdade (exit 1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLegacySentinelEdition,
  SENTINEL_MECHANISM_CUTOFF_AAMMDD,
} from "../scripts/pipeline-sentinel.ts";

// `fileURLToPath` e não `new URL(...).pathname` (#6206): no Windows o pathname
// de uma file URL vem com barra ANTES da letra do drive (`/C:/Users/...`), e
// `resolve` sobre isso produz um caminho inexistente. `sentinelCli` apontava
// pro vazio, `spawnSync` falhava, e as 3 asserções deste arquivo comparavam o
// `status: null` do spawn frustrado contra o exit code esperado — falha que
// parecia do CLI sob teste, sem nunca tê-lo executado.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

describe("isLegacySentinelEdition (#5678)", () => {
  it("edição anterior à data de corte (#1216) é legada", () => {
    assert.equal(isLegacySentinelEdition("260101"), true);
  });

  it("edição na própria data de corte NÃO é legada (mecanismo já existia)", () => {
    assert.equal(isLegacySentinelEdition(SENTINEL_MECHANISM_CUTOFF_AAMMDD), false);
  });

  it("edição posterior à data de corte NÃO é legada", () => {
    assert.equal(isLegacySentinelEdition("260819"), false);
  });

  it("edition id malformado (não-AAMMDD) NÃO é legado — fail-safe", () => {
    assert.equal(isLegacySentinelEdition("2604-06"), false);
    assert.equal(isLegacySentinelEdition(""), false);
    assert.equal(isLegacySentinelEdition("abcdef"), false);
  });
});

/** Roda `pipeline-sentinel.ts assert` como subprocesso real (exercita o CLI, não só a lib). */
function runAssert(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, "assert", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("pipeline-sentinel assert — fallback legado restrito por data (#5678)", () => {
  it("edição RECENTE sem sentinel formal mas com outputs em disco → falha (exit 1), não warn", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "sentinel-cutoff-recent-"));
    try {
      const editionDir = join(editionsRoot, "260819");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      // Stage 3 "rodou por fora" — outputs em disco, sentinel nunca escrito.
      writeFileSync(join(editionDir, "04-d1-2x1.jpg"), "fake-jpg");

      const { status, stderr } = runAssert([
        "--edition",
        "260819",
        "--step",
        "3",
        "--outputs",
        "04-d1-2x1.jpg",
        "--dir",
        editionDir,
      ]);

      assert.equal(status, 1);
      assert.match(stderr, /posterior à data de corte/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("edição ANTIGA (pré-#1216) sem sentinel mas com outputs em disco → warn (exit 3), comportamento preservado", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "sentinel-cutoff-legacy-"));
    try {
      const editionDir = join(editionsRoot, "260101");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "04-d1-2x1.jpg"), "fake-jpg");

      const { status, stderr } = runAssert([
        "--edition",
        "260101",
        "--step",
        "3",
        "--outputs",
        "04-d1-2x1.jpg",
        "--dir",
        editionDir,
      ]);

      assert.equal(status, 3);
      assert.match(stderr, /legado/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("pipeline com --dir (ex: mensal, id fora do formato AAMMDD) preserva o warn legado — fora do escopo do #5678", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-cutoff-monthly-"));
    try {
      const monthlyDir = join(root, "data", "monthly", "2608-09");
      mkdirSync(join(monthlyDir, "_internal"), { recursive: true });
      writeFileSync(join(monthlyDir, "draft.md"), "# draft");

      const { status, stderr } = runAssert([
        "--edition",
        "2608-09",
        "--step",
        "2",
        "--outputs",
        "draft.md",
        "--dir",
        monthlyDir,
      ]);

      assert.equal(status, 3);
      assert.match(stderr, /legado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
