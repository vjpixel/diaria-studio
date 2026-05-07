/**
 * test/insert-titulo-subtitulo.test.ts (#916)
 *
 * Cobre helpers puros + integração CLI da inserção da seção
 * TÍTULO/SUBTÍTULO no topo do `02-reviewed.md`. Idempotência crítica:
 * re-executar o script (resume, multi-stage) não deve duplicar a seção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  hasTituloSubtituloBlock,
  renderTituloSubtituloBlock,
  insertOrUpdateTituloSubtitulo,
  extractTitlesFromMd,
} from "../scripts/insert-titulo-subtitulo.ts";

function newsletterFixture(d1 = "Título D1", d2 = "Título D2", d3 = "Título D3"): string {
  return [
    "Para esta edição, eu (o editor) enviei 11 submissões.",
    "",
    "---",
    "DESTAQUE 1 | MERCADO",
    d1,
    "https://example.com/d1",
    "",
    "Corpo d1.",
    "",
    "Por que isso importa:",
    "Impacto.",
    "",
    "---",
    "DESTAQUE 2 | PESQUISA",
    d2,
    "https://example.com/d2",
    "",
    "Corpo d2.",
    "",
    "Por que isso importa:",
    "Impacto d2.",
    "",
    "---",
    "DESTAQUE 3 | PRODUTO",
    d3,
    "https://example.com/d3",
    "",
    "Corpo d3.",
    "",
    "Por que isso importa:",
    "Impacto d3.",
    "",
  ].join("\n");
}

describe("renderTituloSubtituloBlock (#916)", () => {
  it("renderiza bloco completo com 3 títulos", () => {
    const out = renderTituloSubtituloBlock("D1 title", "D2 title", "D3 title");
    assert.match(out, /^TÍTULO\n\nD1 title\n\nSUBTÍTULO\n\nD2 title \| D3 title\n\n---\n/);
  });

  it("sem D3: subtítulo é só D2 (sem ' | ')", () => {
    const out = renderTituloSubtituloBlock("D1 title", "D2 title", "");
    assert.match(out, /SUBTÍTULO\n\nD2 title\n\n---/);
    assert.doesNotMatch(out, / \| /);
  });

  it("sem D2 e sem D3: subtítulo vazio", () => {
    const out = renderTituloSubtituloBlock("D1 title", "", "");
    // Subtitle linha vazia entre headers; ainda assim estrutura preservada.
    assert.match(out, /SUBTÍTULO\n\n\n*---/);
    assert.match(out, /^TÍTULO\n\nD1 title\n\nSUBTÍTULO/);
  });
});

describe("hasTituloSubtituloBlock (#916)", () => {
  it("detecta bloco no topo", () => {
    const md = "TÍTULO\n\nfoo\n\nSUBTÍTULO\n\nbar | baz\n\n---\n\nbody";
    assert.equal(hasTituloSubtituloBlock(md), true);
  });

  it("retorna false quando MD começa direto no body", () => {
    assert.equal(hasTituloSubtituloBlock(newsletterFixture()), false);
  });

  it("ignora 'TÍTULO' que aparece fora das primeiras 30 linhas", () => {
    const lines = Array(40).fill("conteúdo");
    lines.push("TÍTULO");
    const md = lines.join("\n");
    assert.equal(hasTituloSubtituloBlock(md), false);
  });
});

describe("extractTitlesFromMd (#916)", () => {
  it("extrai títulos de D1/D2/D3 de newsletter típica", () => {
    const md = newsletterFixture("Anthropic eleva limites", "Chineses treinam clones", "Biólogo conclui");
    const t = extractTitlesFromMd(md);
    assert.equal(t.d1, "Anthropic eleva limites");
    assert.equal(t.d2, "Chineses treinam clones");
    assert.equal(t.d3, "Biólogo conclui");
  });

  it("MD sem destaques: tudo null", () => {
    const t = extractTitlesFromMd("Texto qualquer sem DESTAQUEs.");
    assert.equal(t.d1, null);
    assert.equal(t.d2, null);
    assert.equal(t.d3, null);
  });

  it("apenas D1 e D2 (sem D3): d3 = null", () => {
    const md = [
      "DESTAQUE 1 | A",
      "Título 1",
      "https://x.com/1",
      "",
      "Corpo.",
      "",
      "---",
      "DESTAQUE 2 | B",
      "Título 2",
      "https://x.com/2",
      "",
      "Corpo.",
    ].join("\n");
    const t = extractTitlesFromMd(md);
    assert.equal(t.d1, "Título 1");
    assert.equal(t.d2, "Título 2");
    assert.equal(t.d3, null);
  });
});

describe("insertOrUpdateTituloSubtitulo (#916)", () => {
  it("insere seção quando não existe", () => {
    const md = newsletterFixture("D1 title", "D2 title", "D3 title");
    const r = insertOrUpdateTituloSubtitulo(md, "D1 title", "D2 title", "D3 title");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /^TÍTULO\n\nD1 title\n\nSUBTÍTULO\n\nD2 title \| D3 title\n\n---\n/);
    // Body preservado intacto
    assert.match(r.md, /Para esta edição/);
    assert.match(r.md, /DESTAQUE 1 \| MERCADO/);
  });

  it("idempotente: 2x consecutivos com mesmo input → mesmo output", () => {
    const md = newsletterFixture();
    const r1 = insertOrUpdateTituloSubtitulo(md, "D1", "D2", "D3");
    assert.equal(r1.action, "inserted");
    const r2 = insertOrUpdateTituloSubtitulo(r1.md, "D1", "D2", "D3");
    assert.equal(r2.action, "no_change");
    assert.equal(r2.md, r1.md);
  });

  it("atualiza in-place quando títulos mudaram (re-run pós-edição)", () => {
    const md = newsletterFixture();
    const r1 = insertOrUpdateTituloSubtitulo(md, "Antigo D1", "Antigo D2", "Antigo D3");
    assert.equal(r1.action, "inserted");
    const r2 = insertOrUpdateTituloSubtitulo(r1.md, "Novo D1", "Novo D2", "Novo D3");
    assert.equal(r2.action, "updated");
    assert.match(r2.md, /TÍTULO\n\nNovo D1/);
    assert.doesNotMatch(r2.md, /Antigo D1/);
    // Não duplica seções: só 1 ocorrência de TÍTULO/SUBTÍTULO
    const tituloCount = (r2.md.match(/^TÍTULO$/gm) ?? []).length;
    const subCount = (r2.md.match(/^SUBTÍTULO$/gm) ?? []).length;
    assert.equal(tituloCount, 1);
    assert.equal(subCount, 1);
    // Body preservado
    assert.match(r2.md, /DESTAQUE 1 \| MERCADO/);
  });

  it("preserva frontmatter YAML quando presente (insere após o front-matter)", () => {
    const md = "---\nintentional_error: true\n---\n\n" + newsletterFixture();
    const r = insertOrUpdateTituloSubtitulo(md, "D1", "D2", "D3");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /^---\nintentional_error: true\n---\n+TÍTULO/);
  });

  it("apenas D1+D2 (sem D3): SUBTÍTULO sem pipe", () => {
    const md = newsletterFixture();
    const r = insertOrUpdateTituloSubtitulo(md, "D1", "D2", "");
    assert.match(r.md, /SUBTÍTULO\n\nD2\n\n---/);
    assert.doesNotMatch(r.md.split("\n").slice(0, 10).join("\n"), / \| /);
  });
});

describe("CLI insert-titulo-subtitulo.ts (#916)", () => {
  it("inserção end-to-end: cria bloco no topo do arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "insert-tit-"));
    try {
      const path = join(dir, "02-reviewed.md");
      writeFileSync(path, newsletterFixture("Anthropic eleva", "Chineses clones", "Biólogo"));
      const result = spawnSync(
        "npx",
        ["tsx", "scripts/insert-titulo-subtitulo.ts", "--in", path],
        { cwd: process.cwd(), encoding: "utf8", shell: true },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
      const updated = readFileSync(path, "utf8");
      assert.match(updated, /^TÍTULO\n\nAnthropic eleva\n\nSUBTÍTULO\n\nChineses clones \| Biólogo/);
      const json = JSON.parse(result.stdout);
      assert.equal(json.action, "inserted");
      assert.equal(json.d1_title, "Anthropic eleva");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-run produz no_change (idempotência)", () => {
    const dir = mkdtempSync(join(tmpdir(), "insert-tit-"));
    try {
      const path = join(dir, "02-reviewed.md");
      writeFileSync(path, newsletterFixture("D1", "D2", "D3"));
      const args = ["tsx", "scripts/insert-titulo-subtitulo.ts", "--in", path];
      const r1 = spawnSync("npx", args, { cwd: process.cwd(), encoding: "utf8", shell: true });
      assert.equal(r1.status, 0, r1.stderr);
      const after1 = readFileSync(path, "utf8");
      const r2 = spawnSync("npx", args, { cwd: process.cwd(), encoding: "utf8", shell: true });
      assert.equal(r2.status, 0, r2.stderr);
      const after2 = readFileSync(path, "utf8");
      assert.equal(after2, after1);
      const json2 = JSON.parse(r2.stdout);
      assert.equal(json2.action, "no_change");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("erro quando MD não tem DESTAQUE 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "insert-tit-"));
    try {
      const path = join(dir, "02-reviewed.md");
      writeFileSync(path, "Texto sem destaques.");
      const result = spawnSync(
        "npx",
        ["tsx", "scripts/insert-titulo-subtitulo.ts", "--in", path],
        { cwd: process.cwd(), encoding: "utf8", shell: true },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /DESTAQUE 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
