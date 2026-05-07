/**
 * test/sync-intro-count-906.test.ts (#906)
 *
 * Regressão pro caso 260507: writer publicou intro com "Selecionamos os
 * 30 mais relevantes" (vindo do approved.json bruto), mas a edição
 * efetivamente publicou 17 artigos pós-caps. sync-intro-count.ts deve
 * detectar e corrigir o número.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function runCli(
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "sync-intro-count.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("sync-intro-count CLI — caps regression (#906)", () => {
  it("corrige 'Selecionamos os 30' → 'Selecionamos os 12' quando body tem 12 URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-906-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      // 3 destaques + 2 lançamentos + 3 pesquisas + 4 outras = 12 URLs
      const md = [
        "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 100 artigos. Selecionamos os 30 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "---",
        "",
        "DESTAQUE 1 | PRODUTO",
        "[Título 1](https://h.com/1)",
        "https://h.com/1",
        "",
        "Texto.",
        "",
        "---",
        "",
        "DESTAQUE 2 | PESQUISA",
        "[Título 2](https://h.com/2)",
        "https://h.com/2",
        "",
        "Texto.",
        "",
        "---",
        "",
        "DESTAQUE 3 | MERCADO",
        "[Título 3](https://h.com/3)",
        "https://h.com/3",
        "",
        "Texto.",
        "",
        "---",
        "",
        "LANÇAMENTOS",
        "",
        "[L1](https://l.com/1)",
        "Desc 1.",
        "",
        "[L2](https://l.com/2)",
        "Desc 2.",
        "",
        "---",
        "",
        "PESQUISAS",
        "",
        "[P1](https://p.com/1)",
        "Desc.",
        "",
        "[P2](https://p.com/2)",
        "Desc.",
        "",
        "[P3](https://p.com/3)",
        "Desc.",
        "",
        "---",
        "",
        "OUTRAS NOTÍCIAS",
        "",
        "[N1](https://n.com/1)",
        "Desc.",
        "",
        "[N2](https://n.com/2)",
        "Desc.",
        "",
        "[N3](https://n.com/3)",
        "Desc.",
        "",
        "[N4](https://n.com/4)",
        "Desc.",
        "",
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");

      const r = runCli(["--md", mdPath]);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.changed, true);
      assert.equal(out.claimed_before, 30);
      assert.equal(out.actual, 12);

      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /Selecionamos os 12 mais relevantes/);
      assert.doesNotMatch(updated, /Selecionamos os 30/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-op quando intro já está sincronizada com body", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-906-noop-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        "Para esta edição, eu (o editor) enviei 1 submissão e a Diar.ia encontrou outros 50 artigos. Selecionamos os 1 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "DESTAQUE 1 | PRODUTO",
        "[Título](https://h.com/1)",
        "https://h.com/1",
        "",
        "Texto.",
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");

      const r = runCli(["--md", mdPath]);
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.changed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
