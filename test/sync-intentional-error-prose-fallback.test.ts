/**
 * sync-intentional-error-prose-fallback.test.ts (#1860)
 *
 * Regressão: quando o frontmatter `intentional_error` está ausente mas o erro
 * foi declarado só na prosa ("Nessa edição, …"), o sync deve extrair da prosa
 * e gravar uma entry com source="prose_block" — em vez de falhar e deixar um
 * buraco no JSONL (o que fazia o reveal da próxima edição pular a edição certa,
 * #1854).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runSync(mdPath: string, edition: string, jsonlPath: string) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "sync-intentional-error.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--md", mdPath, "--edition", edition, "--jsonl", jsonlPath],
    { encoding: "utf8" },
  );
}

describe("sync-intentional-error fallback de prosa (#1860)", () => {
  it("frontmatter ausente + prosa 'Nessa edição' → grava entry source=prose_block", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-prose-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");
      // Sem frontmatter intentional_error — só a declaração em prosa.
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Nessa edição, atribuímos a citação ao Bill Gates, mas o correto era Satya Nadella.",
          "",
        ].join("\n"),
        "utf8",
      );
      const r = runSync(mdPath, "260605", jsonlPath);
      assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
      assert.ok(existsSync(jsonlPath), "jsonl deve ser criado");
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.edition, "260605");
      assert.equal(entry.source, "prose_block");
      assert.equal(entry.is_feature, true);
      assert.match(entry.detail, /Satya Nadella|citação/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("idempotente: edição já no JSONL → no-op (added:false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-prose-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Nessa edição, escrevi X onde deveria ser Y.",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        jsonlPath,
        JSON.stringify({ edition: "260605", error_type: "factual", is_feature: true, detail: "preexistente" }) + "\n",
        "utf8",
      );
      const r = runSync(mdPath, "260605", jsonlPath);
      assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "não deve duplicar a entry da edição");
      assert.match(r.stdout, /"added": false/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("sem frontmatter E sem prosa → exit 1 (nada pra extrair)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-prose-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(mdPath, "**DESTAQUE 1**\n\nTexto qualquer sem erro declarado.\n", "utf8");
      const r = runSync(mdPath, "260605", jsonlPath);
      assert.equal(r.status, 1, "deve falhar quando não há nada pra extrair");
      assert.ok(!existsSync(jsonlPath), "não deve criar jsonl quando falha");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
