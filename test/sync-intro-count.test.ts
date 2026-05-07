/**
 * test/sync-intro-count.test.ts (#876)
 *
 * Cobre o ajuste narrativo de "X lançamentos" no intro quando
 * `_internal/02-lancamentos-removed.json` está presente. O ajuste do
 * número total da intro (#743) é coberto via integração no script CLI
 * em outros testes — aqui o foco é o helper puro `syncLancamentosNarrative`
 * e o end-to-end do CLI quando o resumo de removed existe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncLancamentosNarrative } from "../scripts/sync-intro-count.ts";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("syncLancamentosNarrative (helper puro, #876)", () => {
  it("ajusta '5 lançamentos' para '3 lançamentos' quando 2 foram removidos", () => {
    const md = `Linha de cobertura: 5 lançamentos da semana foram destaque.\n\n# Corpo`;
    const summary = {
      removed: [
        { url: "https://x.com/1", reason: "non_official_domain" },
        { url: "https://y.com/2", reason: "non_official_domain" },
      ],
      original_count: 5,
      final_count: 3,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, true);
    assert.match(r.md, /3 lançamentos da semana/);
    assert.doesNotMatch(r.md, /5 lançamentos/);
  });

  it("não muda quando não há menção numérica de lançamentos", () => {
    const md = `Esta semana destacamos 12 artigos.\n\n# Corpo`;
    const summary = {
      removed: [{ url: "https://x.com/1", reason: "non_official_domain" }],
      original_count: 4,
      final_count: 3,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, false);
    assert.equal(r.md, md);
  });

  it("no-op quando original_count == final_count (nada removido)", () => {
    const md = `Linha: 3 lançamentos da semana.`;
    const summary = {
      removed: [],
      original_count: 3,
      final_count: 3,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, false);
    assert.equal(r.md, md);
  });

  it("aceita variação singular 'lançamento'", () => {
    const md = `Apenas 1 lançamento foi mantido.`;
    const summary = {
      removed: [{ url: "https://x.com/1", reason: "non_official_domain" }],
      original_count: 1,
      final_count: 0,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, true);
    assert.match(r.md, /0 lançamento\b/);
  });

  it("cobre múltiplas menções na mesma intro (case-insensitive)", () => {
    const md = `Tivemos 4 LANÇAMENTOS, mas dos 4 lançamentos só destacamos os melhores.`;
    const summary = {
      removed: [
        { url: "https://x.com/1", reason: "non_official_domain" },
        { url: "https://y.com/2", reason: "non_official_domain" },
      ],
      original_count: 4,
      final_count: 2,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, true);
    assert.match(r.md, /2 LANÇAMENTOS/);
    assert.match(r.md, /2 lançamentos/);
  });

  it("não toca em números diferentes do original_count", () => {
    const md = `Tivemos 5 lançamentos e 12 artigos no total.`;
    const summary = {
      removed: [{ url: "https://x.com/1", reason: "non_official_domain" }],
      original_count: 5,
      final_count: 4,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, true);
    assert.match(r.md, /4 lançamentos/);
    assert.match(r.md, /12 artigos/); // intacto
  });

  it("aceita 'lancamento' sem cedilha como variação", () => {
    const md = `Tivemos 5 lancamentos da semana.`;
    const summary = {
      removed: [
        { url: "https://x.com/1", reason: "non_official_domain" },
        { url: "https://y.com/2", reason: "non_official_domain" },
      ],
      original_count: 5,
      final_count: 3,
    };
    const r = syncLancamentosNarrative(md, summary);
    assert.equal(r.changed, true);
    assert.match(r.md, /3 lancamentos/);
  });
});

// ---------------------------------------------------------------------------
// Integração CLI — cobre o caso "arquivo ausente => no-op" + caso completo.
// ---------------------------------------------------------------------------

describe("sync-intro-count CLI (#876 + #743 integration)", () => {
  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    // Resolve script path relative to test file location (test/ -> scripts/sync-intro-count.ts)
    // cwd fica no projeto para que `tsx` seja resolvido em node_modules.
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

  it("sem arquivo lancamentos-removed: comportamento legacy (#743) intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-no-removed-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        "Para esta edição, eu (o editor) enviei 1 submissão e a Diar.ia encontrou outros 50 artigos. Selecionamos os 8 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "DESTAQUE 1 | PRODUTO",
        "https://example.com/1",
        "Texto.",
        "",
        "---",
        "",
        "DESTAQUE 2 | PRODUTO",
        "https://example.com/2",
        "Texto.",
        "",
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");

      const r = runCli(["--md", mdPath]);
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.lancamentos_changed, false);
      // Note: o lintIntroCount counts highlights as 1 each → actual=2, claimed=8 → não bate
      // mas sem flag --lancamentos-removed nada de narrativa é mexido aqui
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com arquivo lancamentos-removed presente: ajusta narrativa", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-with-removed-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const removedPath = join(dir, "02-lancamentos-removed.json");
      const md = [
        "Para esta edição, eu (o editor) enviei 1 submissão e a Diar.ia encontrou outros 50 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "Esta semana tivemos 5 lançamentos importantes.",
        "",
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      writeFileSync(
        removedPath,
        JSON.stringify({
          removed: [
            { url: "https://x.com/1", reason: "non_official_domain" },
            { url: "https://y.com/2", reason: "non_official_domain" },
          ],
          original_count: 5,
          final_count: 3,
        }),
        "utf8",
      );

      const r = runCli([
        "--md",
        mdPath,
        "--lancamentos-removed",
        removedPath,
      ]);
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.lancamentos_changed, true);

      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /3 lançamentos importantes/);
      assert.doesNotMatch(updated, /5 lançamentos/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo lancamentos-removed inexistente: silenciosamente no-op em narrativa", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-missing-removed-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        "Selecionamos os 5 mais relevantes.\n\nTivemos 3 lançamentos.",
        "utf8",
      );
      const ghostPath = join(dir, "_internal", "02-lancamentos-removed.json");

      const r = runCli([
        "--md",
        mdPath,
        "--lancamentos-removed",
        ghostPath,
      ]);
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.lancamentos_changed, false);
      // arquivo MD não pode ter sido alterado pela narrativa
      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /3 lançamentos/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
