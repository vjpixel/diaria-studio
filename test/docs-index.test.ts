/**
 * test/docs-index.test.ts (#14061)
 *
 * Cobre o gerador do índice `docs/README.md` (título + primeira linha de cada
 * doc), o `--check` que reprova doc novo fora do índice, e o arquivo commitado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  collectDocs,
  extractDocSummary,
  generateDocsIndex,
  indexMatches,
  TITLE_ONLY_DOCS,
} from "../scripts/docs-index.ts";

const ROOT = resolve(import.meta.dirname, "..");

function runCli(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "docs-index.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
}

function fixtureDocs(): string {
  const dir = mkdtempSync(join(tmpdir(), "docs-index-"));
  writeFileSync(join(dir, "alpha.md"), "# Alpha\n\nPrimeira linha do alpha.\n");
  mkdirSync(join(dir, "archive"));
  writeFileSync(join(dir, "archive", "velho.md"), "# Velho\n\n> **Status: arquivado.**\n");
  mkdirSync(join(dir, "audience-history"));
  writeFileSync(join(dir, "audience-history", "snap.md"), "# Snapshot\n");
  writeFileSync(join(dir, "dados.json"), "{}\n");
  return dir;
}

describe("extractDocSummary (#14061)", () => {
  it("título ATX e o 1º parágrafo inteiro, juntando linhas quebradas", () => {
    const r = extractDocSummary("# Título X\n\nUma frase quebrada\nem duas linhas.\n\nOutro parágrafo.\n");
    assert.equal(r.title, "Título X");
    assert.equal(r.summary, "Uma frase quebrada em duas linhas.");
  });

  it("pula linha de Issue:, tabela, bloco de código e cabeçalho", () => {
    const md = [
      "# T",
      "",
      "Issue: [#1](https://x/1).",
      "",
      "## Seção",
      "```",
      "codigo",
      "```",
      "| a | b |",
      "",
      "Texto real.",
    ].join("\n");
    assert.equal(extractDocSummary(md).summary, "Texto real.");
  });

  it("negrito que atravessa a quebra de linha sai sem `**` sobrando", () => {
    const r = extractDocSummary("# T\n\nResultado: **não foi\nlocalizado** nada.\n");
    assert.equal(r.summary, "Resultado: não foi localizado nada.");
  });

  it("citação de Status vira o resumo, sem o `>`", () => {
    const r = extractDocSummary("# T\n\n> **Status: superado por X.**\n> Detalhe.\n");
    assert.equal(r.summary, "Status: superado por X. Detalhe.");
  });

  it("front matter YAML: name/description", () => {
    const r = extractDocSummary("---\nname: eia-composer\ndescription: Faz a coisa.\nmodel: haiku\n---\n\nCorpo.\n");
    assert.equal(r.title, "eia-composer");
    assert.equal(r.summary, "Faz a coisa.");
  });

  it("título setext (`===`) e CRLF", () => {
    const r = extractDocSummary("Troca de box\r\n=====\r\n\r\nUso supervisionado.\r\n");
    assert.equal(r.title, "Troca de box");
    assert.equal(r.summary, "Uso supervisionado.");
  });

  it("sem título devolve null; resumo longo é cortado com reticências", () => {
    const r = extractDocSummary(`${"palavra ".repeat(60)}\n`);
    assert.equal(r.title, null);
    assert.ok(r.summary!.endsWith("…"));
    assert.ok(r.summary!.length <= 161);
  });
});

describe("collectDocs / generateDocsIndex (#14061)", () => {
  it("lista todo arquivo, inclusive subpasta e não-markdown, e exclui audience-history e o próprio README", () => {
    const dir = fixtureDocs();
    try {
      writeFileSync(join(dir, "README.md"), "velho\n");
      const paths = collectDocs(dir).map((e) => e.path);
      assert.deepEqual(paths, ["alpha.md", "archive/velho.md", "dados.json"]);
      const md = generateDocsIndex(dir);
      assert.match(md, /\[`alpha\.md`\]\(\.\/alpha\.md\) \| Alpha \| Primeira linha do alpha\. \|/);
      assert.match(md, /### `docs\/archive\/` \(1\)/);
      assert.match(md, /\[`dados\.json`\]/);
      assert.doesNotMatch(md, /snap\.md/);
      assert.match(md, /## Índice \(3 arquivos\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapa `|` do título para não quebrar a tabela", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-index-pipe-"));
    try {
      writeFileSync(join(dir, "a.md"), "# A | B\n\nx\n");
      assert.match(generateDocsIndex(dir), /\| A \\\| B \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indexMatches ignora CRLF do checkout no Windows", () => {
    assert.ok(indexMatches("a\r\nb\n", "a\nb\n"));
    assert.ok(!indexMatches("a\nb\n", "a\nc\n"));
  });
});

describe("fonte da lista: git ls-files, disco só como fallback (#14061)", () => {
  function git(cwd: string, ...args: string[]): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }

  it("arquivo não rastreado fica fora do índice; o disco (fallback) o enxergaria", () => {
    const repo = mkdtempSync(join(tmpdir(), "docs-index-git-"));
    try {
      git(repo, "init", "-q");
      const docs = join(repo, "docs");
      mkdirSync(join(docs, "sub"), { recursive: true });
      mkdirSync(join(docs, "audience-history"));
      writeFileSync(join(docs, "rastreado.md"), "# R\n\nx\n");
      writeFileSync(join(docs, "sub", "fundo.md"), "# F\n\ny\n");
      writeFileSync(join(docs, "audience-history", "snap.md"), "# S\n");
      writeFileSync(join(docs, "README.md"), "velho\n");
      git(repo, "add", "docs");
      writeFileSync(join(docs, "solto.md"), "# Solto\n\nnão commitado\n");

      const viaGit = collectDocs(docs).map((e) => e.path);
      assert.deepEqual(viaGit, ["rastreado.md", "sub/fundo.md"]);
      const viaFs = collectDocs(docs, { source: "fs" }).map((e) => e.path);
      assert.deepEqual(viaFs, ["rastreado.md", "solto.md", "sub/fundo.md"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fora de repositório git cai no disco", () => {
    const dir = fixtureDocs();
    try {
      // mkdtemp em tmpdir não é repo: git ls-files falha e o fallback lista o disco.
      assert.deepEqual(
        collectDocs(dir).map((e) => e.path),
        ["alpha.md", "archive/velho.md", "dados.json"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI --check (#14061)", () => {
  it("exit 0 depois do --write; exit 1 com doc novo fora do índice; exit 1 sem README", () => {
    const dir = fixtureDocs();
    try {
      assert.equal(runCli(["--docs-dir", dir, "--check"]).status, 1, "sem README deve reprovar");
      assert.equal(runCli(["--docs-dir", dir, "--write"]).status, 0);
      assert.equal(runCli(["--docs-dir", dir, "--check"]).status, 0);
      writeFileSync(join(dir, "novo.md"), "# Novo\n\nDoc criado sem regenerar.\n");
      const r = runCli(["--docs-dir", dir, "--check"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /conteúdo de docs\/ mudou \(título\/1ª linha, doc novo, renomeado ou apagado\)/);
      assert.match(r.stderr, /docs-index\.ts --write/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs/README.md commitado (#14061)", () => {
  it("bate com o que o gerador produz a partir de docs/", () => {
    const committed = readFileSync(join(ROOT, "docs", "README.md"), "utf8");
    assert.ok(
      indexMatches(committed, generateDocsIndex(join(ROOT, "docs"))),
      "docs/README.md divergiu. Rodar: npx tsx scripts/docs-index.ts --write",
    );
  });

  it("doc regravado por script entra só pelo título: regen do bug-heatmap não deixa o --check vermelho", () => {
    const committed = readFileSync(join(ROOT, "docs", "README.md"), "utf8");
    const docs = join(ROOT, "docs");
    for (const path of Object.keys(TITLE_ONLY_DOCS)) {
      assert.ok(existsSync(join(docs, path)), `TITLE_ONLY_DOCS cita ${path}, que não existe`);
      const row = committed.split("\n").find((l) => l.startsWith(`| [\`${path}\`]`));
      assert.ok(row, `${path} fora do índice`);
      assert.match(row!, /\| {2}\|$/,`${path} não deveria ter 1ª linha no índice`);
    }
    // Simula o regen semanal: muda só o timestamp da 1ª linha do heatmap.
    const tmp = mkdtempSync(join(tmpdir(), "docs-index-heatmap-"));
    try {
      writeFileSync(join(tmp, "bug-heatmap.md"), "# Bug Heatmap — diar.ia.br\n\n**Gerado em**: 2026-11-20T18:15:49.971Z\n");
      const before = generateDocsIndex(tmp);
      writeFileSync(join(tmp, "bug-heatmap.md"), "# Bug Heatmap — diar.ia.br\n\n**Gerado em**: 2026-11-27T18:15:49.971Z\n");
      assert.equal(generateDocsIndex(tmp), before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("nenhum resumo do índice traz data/hora de geração (doc gerado novo precisa entrar em TITLE_ONLY_DOCS)", () => {
    const offenders = collectDocs(join(ROOT, "docs")).filter((e) =>
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.summary ?? ""),
    );
    assert.deepEqual(
      offenders.map((e) => e.path),
      [],
      "esses docs mostram timestamp no índice; incluir em TITLE_ONLY_DOCS (scripts/docs-index.ts)",
    );
  });

  it("weekly-bug-heatmap.yml regenera o índice e o inclui na PR do bot", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "weekly-bug-heatmap.yml"), "utf8");
    assert.match(wf, /npx tsx scripts\/docs-index\.ts --write/);
    const add = wf.match(/add-paths:\s*\|\n((?:\s+\S.*\n)+)/);
    assert.ok(add, "add-paths em bloco");
    assert.match(add![1], /docs\/README\.md/);
    assert.match(add![1], /docs\/bug-heatmap\.md/);
  });

  it("o --check está armado no pr-checks.yml (roda também em PR só de docs)", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "pr-checks.yml"), "utf8");
    assert.match(wf, /npx tsx scripts\/docs-index\.ts --check/);
  });
});
