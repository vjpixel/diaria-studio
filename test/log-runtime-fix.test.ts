/**
 * test/log-runtime-fix.test.ts (#1210)
 *
 * Cobre log-runtime-fix.ts (CLI + helper) e a integração com
 * collect-edition-signals (signalsFromRuntimeFixes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { appendRuntimeFix } from "../scripts/log-runtime-fix.ts";
import { signalsFromRuntimeFixes } from "../scripts/collect-edition-signals.ts";

describe("appendRuntimeFix (#1210)", () => {
  it("cria diretório _internal e escreve JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-fix-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir);
      appendRuntimeFix(editionDir, {
        edition: "260517",
        stage: 2,
        fix_type: "structural",
        component: "title-picker",
        description: "remontei estrutura pós title-picker",
        severity: "P2",
      });
      const outPath = join(editionDir, "_internal", "runtime-fixes.jsonl");
      assert.ok(existsSync(outPath));
      const lines = readFileSync(outPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.component, "title-picker");
      assert.equal(entry.severity, "P2");
      assert.ok(entry.timestamp);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("multiple appends viram múltiplas linhas (append-only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-fix-multi-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir);
      appendRuntimeFix(editionDir, {
        edition: "260517", stage: 1, fix_type: "format",
        component: "writer", description: "bold link format", severity: "P2",
      });
      appendRuntimeFix(editionDir, {
        edition: "260517", stage: 2, fix_type: "structural",
        component: "title-picker", description: "moveu ERRO INTENCIONAL", severity: "P2",
      });
      const lines = readFileSync(
        join(editionDir, "_internal", "runtime-fixes.jsonl"),
        "utf8",
      ).trim().split("\n");
      assert.equal(lines.length, 2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("signalsFromRuntimeFixes (#1210)", () => {
  it("retorna [] em jsonl vazio", () => {
    const r = signalsFromRuntimeFixes("");
    assert.equal(r.length, 0);
  });

  it("filtra P3 (cleanup, não vira issue)", () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-05-13T00:00:00Z", edition: "260517", stage: 1,
        fix_type: "format", component: "writer",
        description: "trivial cleanup", severity: "P3",
      }),
    ].join("\n");
    const r = signalsFromRuntimeFixes(jsonl);
    assert.equal(r.length, 0);
  });

  it("agrupa fixes por (component, fix_type)", () => {
    // 3 fixes em writer/format + 1 em title-picker/structural = 2 grupos
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-05-13T00:00:00Z", edition: "260517", stage: 1,
        fix_type: "format", component: "writer",
        description: "bold link", severity: "P2",
      }),
      JSON.stringify({
        timestamp: "2026-05-13T00:05:00Z", edition: "260517", stage: 1,
        fix_type: "format", component: "writer",
        description: "coverage line", severity: "P2",
      }),
      JSON.stringify({
        timestamp: "2026-05-13T00:10:00Z", edition: "260517", stage: 1,
        fix_type: "format", component: "writer",
        description: "min chars", severity: "P2",
      }),
      JSON.stringify({
        timestamp: "2026-05-13T00:15:00Z", edition: "260517", stage: 2,
        fix_type: "structural", component: "title-picker",
        description: "moveu ERRO INTENCIONAL", severity: "P2",
      }),
    ].join("\n");
    const signals = signalsFromRuntimeFixes(jsonl);
    assert.equal(signals.length, 2);
    const writerSig = signals.find((s) =>
      (s.details.component as string) === "writer",
    );
    const tpSig = signals.find((s) =>
      (s.details.component as string) === "title-picker",
    );
    assert.ok(writerSig);
    assert.equal(writerSig.details.count, 3);
    assert.ok(tpSig);
    assert.equal(tpSig.details.count, 1);
  });

  it("P1 severity → severity 'high'", () => {
    const jsonl = JSON.stringify({
      timestamp: "2026-05-13T00:00:00Z", edition: "260517", stage: 4,
      fix_type: "config", component: "publish-newsletter",
      description: "ADMIN_SECRET workaround", severity: "P1",
    });
    const r = signalsFromRuntimeFixes(jsonl);
    assert.equal(r.length, 1);
    assert.equal(r[0].severity, "high");
  });

  it("P2 severity → severity 'medium'", () => {
    const jsonl = JSON.stringify({
      timestamp: "2026-05-13T00:00:00Z", edition: "260517", stage: 1,
      fix_type: "format", component: "writer",
      description: "bold link", severity: "P2",
    });
    const r = signalsFromRuntimeFixes(jsonl);
    assert.equal(r.length, 1);
    assert.equal(r[0].severity, "medium");
  });

  it("ignora linhas malformadas (JSONL parsing)", () => {
    const jsonl = [
      "{ not valid json",
      JSON.stringify({
        timestamp: "2026-05-13T00:00:00Z", edition: "260517", stage: 1,
        fix_type: "format", component: "writer",
        description: "ok", severity: "P2",
      }),
      "",
      "another bad line",
    ].join("\n");
    const r = signalsFromRuntimeFixes(jsonl);
    assert.equal(r.length, 1);
  });
});

describe("log-runtime-fix CLI (#1210)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "log-runtime-fix.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
    });
  }

  it("rejeita uso sem flags obrigatórias", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Uso:|Faltam/);
  });

  it("rejeita fix-type inválido", () => {
    const r = runCli([
      "--edition", "260517",
      "--stage", "1",
      "--fix-type", "invalid-type",
      "--component", "writer",
      "--description", "test",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /fix-type inválido/);
  });

  it("rejeita severity inválida", () => {
    const r = runCli([
      "--edition", "260517",
      "--stage", "1",
      "--fix-type", "format",
      "--component", "writer",
      "--description", "test",
      "--severity", "P5",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /severity inválida/);
  });

  it("rejeita edition dir ausente", () => {
    const r = runCli([
      "--edition", "999999",
      "--stage", "1",
      "--fix-type", "format",
      "--component", "writer",
      "--description", "test",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não existe/);
  });
});
