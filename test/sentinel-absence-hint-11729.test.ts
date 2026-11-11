/**
 * test/sentinel-absence-hint-11729.test.ts (#11729)
 *
 * Edição 261030: o Stage 4 foi aprovado no Neo e o `/diaria-publica-video` no
 * `300` recusou como "etapa não aprovada" porque o OneDrive ainda não tinha
 * trazido `_internal/.step-4-done.json`. A mensagem de sentinel ausente agora
 * diz "possível defasagem de sync do OneDrive" e mostra a idade do arquivo
 * mais recente da edição nesta máquina, em vez de concluir "não aprovada".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSentinelAbsenceHint,
  describeSentinelAbsence,
  findNewestFile,
  formatAgeMs,
  SYNC_LAG_PHRASE,
} from "../scripts/lib/sentinel-absence-hint.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

const NOW = Date.parse("2026-10-30T15:00:00Z");

describe("formatAgeMs (#11729)", () => {
  it("formata minutos, horas e dias", () => {
    assert.equal(formatAgeMs(30_000), "agora");
    assert.equal(formatAgeMs(12 * 60_000), "12 min");
    assert.equal(formatAgeMs((3 * 60 + 5) * 60_000), "3 h 05 min");
    assert.equal(formatAgeMs((2 * 24 + 4) * 3_600_000), "2 d 4 h");
  });

  it("mtime no futuro (relógio de outra máquina adiantado) vira 'agora'", () => {
    assert.equal(formatAgeMs(-5 * 60_000), "agora");
  });

  it("NaN não quebra", () => {
    assert.equal(formatAgeMs(Number.NaN), "idade desconhecida");
  });
});

describe("buildSentinelAbsenceHint (#11729)", () => {
  it("cita a defasagem de sync e a idade do arquivo mais recente, sem concluir 'não aprovada'", () => {
    const msg = buildSentinelAbsenceHint({
      editionId: "261030",
      editionDirLabel: "data/editions/2610/261030",
      missing: ["_internal/.step-4-done.json"],
      newest: { relPath: "03-social.md", mtimeMs: NOW - 3 * 3_600_000 },
      nowMs: NOW,
    });
    assert.ok(msg.includes(SYNC_LAG_PHRASE), msg);
    assert.ok(msg.includes("_internal/.step-4-done.json"), msg);
    assert.ok(msg.includes("03-social.md"), msg);
    assert.ok(msg.includes("há 3 h 00 min"), msg);
    assert.ok(msg.includes("2026-10-30T12:00:00.000Z"), msg);
    assert.doesNotMatch(msg, /etapa não aprovada|não aprovada \(/);
  });

  it("pasta ausente/vazia: diz isso em vez de inventar uma idade", () => {
    const msg = buildSentinelAbsenceHint({
      editionId: "261030",
      editionDirLabel: "data/editions/2610/261030",
      missing: ["_internal/.step-4-done.json"],
      newest: null,
      nowMs: NOW,
    });
    assert.ok(msg.includes(SYNC_LAG_PHRASE), msg);
    assert.match(msg, /ausente ou vazia/);
  });
});

describe("findNewestFile (#11729)", () => {
  it("acha o arquivo de mtime mais recente, inclusive em _internal/", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-hint-newest-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{}");
      const old = new Date(NOW - 10 * 3_600_000);
      const recent = new Date(NOW - 2 * 3_600_000);
      utimesSync(join(dir, "02-reviewed.md"), old, old);
      utimesSync(join(dir, "_internal", "01-approved.json"), recent, recent);
      const newest = findNewestFile(dir);
      assert.ok(newest);
      assert.equal(newest.relPath, "_internal/01-approved.json");
      assert.equal(Math.round(newest.mtimeMs / 1000), Math.round(recent.getTime() / 1000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pasta inexistente devolve null sem lançar", () => {
    assert.equal(findNewestFile(join(tmpdir(), "nao-existe-11729-xyz")), null);
  });

  it("describeSentinelAbsence lê o disco e monta a mensagem", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-hint-describe-"));
    try {
      writeFileSync(join(dir, "03-social.md"), "x");
      const t = new Date(NOW - 45 * 60_000);
      utimesSync(join(dir, "03-social.md"), t, t);
      const msg = describeSentinelAbsence(dir, "261030", ["_internal/.step-4-done.json"], NOW);
      assert.ok(msg.includes("03-social.md, modificado há 45 min"), msg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pipeline-sentinel.ts — sentinel ausente cita o sync (#11729)", () => {
  function run(args: string[]): { status: number | null; stderr: string } {
    const r = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: r.status, stderr: r.stderr };
  }

  it("exists sem sentinel: exit 1 e stderr com a dica de sync + arquivo mais recente", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-hint-exists-"));
    try {
      const editionDir = join(root, "261030");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "03-social.md"), "x");
      const { status, stderr } = run(["exists", "--edition", "261030", "--step", "4", "--dir", editionDir]);
      assert.equal(status, 1);
      assert.ok(stderr.includes(SYNC_LAG_PHRASE), stderr);
      assert.ok(stderr.includes("03-social.md"), stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exists com sentinel: exit 0 e stderr sem a dica", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-hint-exists-ok-"));
    try {
      const editionDir = join(root, "261030");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", ".step-4-done.json"),
        JSON.stringify({ step: 4, completed_at: "2026-10-30T12:22:00Z", outputs: [] }),
      );
      const { status, stderr } = run(["exists", "--edition", "261030", "--step", "4", "--dir", editionDir]);
      assert.equal(status, 0);
      assert.ok(!stderr.includes(SYNC_LAG_PHRASE), stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assert sem --sync-hint (resume check) não imprime a dica; com --sync-hint imprime", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-hint-assert-"));
    try {
      const editionDir = join(root, "261030");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "02-reviewed.md"), "x");
      const base = ["assert", "--edition", "261030", "--step", "4", "--dir", editionDir, "--outputs", "02-reviewed.md,03-social.md"];
      const plain = run(base);
      assert.equal(plain.status, 1);
      assert.ok(!plain.stderr.includes(SYNC_LAG_PHRASE), plain.stderr);
      const hinted = run([...base, "--sync-hint"]);
      assert.equal(hinted.status, 1);
      assert.ok(hinted.stderr.includes(SYNC_LAG_PHRASE), hinted.stderr);
      assert.ok(hinted.stderr.includes("02-reviewed.md, modificado há"), hinted.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("playbooks repassam a dica em vez de concluir 'não aprovada' (#11729)", () => {
  it("/diaria-publica-video não afirma mais 'não aprovada' no exit 1 do sentinel", () => {
    const skill = readFileSync(join(repoRoot, ".claude/skills/diaria-publica/SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /da edição \{AAMMDD\} não aprovada/);
    assert.match(skill, /possível defasagem de sync do OneDrive/);
  });

  it("Stage 5 e Stage 6 chamam o assert do sentinel anterior com --sync-hint", () => {
    for (const f of ["orchestrator-stage-5.md", "orchestrator-stage-6.md"]) {
      const body = readFileSync(join(repoRoot, ".claude/agents", f), "utf8");
      assert.match(body, /--sync-hint/, f);
    }
  });
});
