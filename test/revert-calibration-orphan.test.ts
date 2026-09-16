/**
 * test/revert-calibration-orphan.test.ts (#8176)
 *
 * Cobre `scripts/lib/revert-calibration-orphan.ts` (lógica pura — o critério
 * de "PR órfã") e `scripts/check-revert-calibration-prs.ts::main` fim-a-fim
 * com `fetchOpenRevertCalibrationPrs` injetável (sem tocar `gh` real).
 *
 * Teste de regressão do #8176: antes deste watchdog existir, uma PR aberta
 * por `revert-calibration.ts` sem review/merge nunca era detectada — a
 * docstring do script prometia "auto-merge do #5251" mas nada garantia que
 * alguém estava olhando. Este arquivo trava que o watchdog (a) reconhece só
 * branches `revert/calibration-*`, (b) só alarma passado o limiar de idade,
 * e (c) escreve um evento de warning em `data/run-log.jsonl` por PR órfã.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ORPHAN_THRESHOLD_MS,
  isRevertCalibrationBranch,
  selectOrphanRevertPrs,
  type RevertPrCandidate,
} from "../scripts/lib/revert-calibration-orphan.ts";

const NOW = Date.parse("2026-09-16T20:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function pr(over: Partial<RevertPrCandidate> & Pick<RevertPrCandidate, "number" | "headRefName" | "createdAt">): RevertPrCandidate {
  return { url: `https://github.com/vjpixel/diaria-studio/pull/${over.number}`, comments: 0, ...over };
}

describe("isRevertCalibrationBranch (#8176)", () => {
  it("reconhece o prefixo exato produzido por buildRevertPlan", () => {
    assert.equal(isRevertCalibrationBranch("revert/calibration-abc1234567"), true);
  });
  it("rejeita branches de outra natureza, inclusive prefixo parecido", () => {
    assert.equal(isRevertCalibrationBranch("overnight/batch-revert-calibration"), false);
    assert.equal(isRevertCalibrationBranch("revert-calibration-abc123"), false); // sem a barra
    assert.equal(isRevertCalibrationBranch("develop/fix-1234"), false);
  });
  it("nunca lança em input não-string", () => {
    assert.equal(isRevertCalibrationBranch(undefined as unknown as string), false);
    assert.equal(isRevertCalibrationBranch(null as unknown as string), false);
  });
});

describe("selectOrphanRevertPrs (#8176)", () => {
  it("PR na branch certa, mais velha que o limiar → órfã", () => {
    const prs = [pr({ number: 1, headRefName: "revert/calibration-abc1234567", createdAt: isoAgo(3 * 60 * 60 * 1000) })];
    const orphans = selectOrphanRevertPrs(prs, NOW);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].number, 1);
    assert.ok(orphans[0].ageHours >= 3 && orphans[0].ageHours < 3.01);
  });

  it("PR na branch certa, MAIS NOVA que o limiar → NÃO é órfã ainda", () => {
    const prs = [pr({ number: 2, headRefName: "revert/calibration-def", createdAt: isoAgo(30 * 60 * 1000) })];
    assert.deepEqual(selectOrphanRevertPrs(prs, NOW), []);
  });

  it("PR fora da branch de revert de calibração → nunca conta, mesmo muito antiga", () => {
    const prs = [pr({ number: 3, headRefName: "overnight/batch-outra-coisa", createdAt: isoAgo(10 * 60 * 60 * 1000) })];
    assert.deepEqual(selectOrphanRevertPrs(prs, NOW), []);
  });

  it("createdAt ilegível → descartada, nunca tratada como 'há muito tempo' por default", () => {
    const prs = [pr({ number: 4, headRefName: "revert/calibration-xyz", createdAt: "not-a-date" })];
    assert.deepEqual(selectOrphanRevertPrs(prs, NOW), []);
  });

  it("limiar customizado (thresholdMs) é respeitado", () => {
    const prs = [pr({ number: 5, headRefName: "revert/calibration-abc", createdAt: isoAgo(90 * 60 * 1000) })]; // 1.5h
    assert.deepEqual(selectOrphanRevertPrs(prs, NOW, DEFAULT_ORPHAN_THRESHOLD_MS), [], "1.5h < limiar default de 2h");
    const orphans = selectOrphanRevertPrs(prs, NOW, 60 * 60 * 1000); // limiar de 1h
    assert.equal(orphans.length, 1, "1.5h >= limiar customizado de 1h");
  });

  it("múltiplas PRs: só as órfãs (branch certa + idade) voltam, na ordem de entrada", () => {
    const prs = [
      pr({ number: 10, headRefName: "revert/calibration-a", createdAt: isoAgo(5 * 60 * 60 * 1000) }), // órfã
      pr({ number: 11, headRefName: "develop/fix-99", createdAt: isoAgo(5 * 60 * 60 * 1000) }), // branch errada
      pr({ number: 12, headRefName: "revert/calibration-b", createdAt: isoAgo(10 * 60 * 1000) }), // nova demais
      pr({ number: 13, headRefName: "revert/calibration-c", createdAt: isoAgo(24 * 60 * 60 * 1000) }), // órfã
    ];
    const orphans = selectOrphanRevertPrs(prs, NOW);
    assert.deepEqual(orphans.map((o) => o.number), [10, 13]);
  });
});

// ─── main() fim-a-fim, com fetchOpenRevertCalibrationPrs injetada ─────────

describe("check-revert-calibration-prs.ts main() (#8176, gh mockado)", () => {
  function makeTempRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "revert-orphan-watchdog-"));
    return root;
  }

  it("PR órfã encontrada → grava evento de warning em data/run-log.jsonl", async () => {
    const root = makeTempRepo();
    try {
      const { main } = await import("../scripts/check-revert-calibration-prs.ts");
      main(root, [], () => [
        pr({ number: 42, headRefName: "revert/calibration-abcdef1234", createdAt: isoAgo(5 * 60 * 60 * 1000) }),
      ]);

      const logPath = join(root, "data", "run-log.jsonl");
      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const event = lines.find((l) => l.message === "revert_calibration_pr_orphaned");
      assert.ok(event, "deveria ter gravado o evento de PR órfã");
      assert.equal(event.level, "warn");
      assert.equal(event.details.pr, 42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhuma PR órfã → nada é gravado em run-log", async () => {
    const root = makeTempRepo();
    try {
      const { main } = await import("../scripts/check-revert-calibration-prs.ts");
      main(root, [], () => [
        pr({ number: 7, headRefName: "revert/calibration-fresh", createdAt: isoAgo(5 * 60 * 1000) }),
      ]);

      const logPath = join(root, "data", "run-log.jsonl");
      let contents = "";
      try {
        contents = readFileSync(logPath, "utf8");
      } catch {
        // arquivo nem chegou a ser criado — também conta como "nada gravado"
      }
      assert.equal(contents.includes("revert_calibration_pr_orphaned"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
