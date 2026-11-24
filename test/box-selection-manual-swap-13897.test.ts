/**
 * #13897 — o editor trocou o box do slot 2 editando o `02-reviewed.md`
 * (Artigo Especial → livros, edição 261124), mas `_internal/box-selection.json`
 * seguiu com o slot 2 em `artigo-especial-apoiadores.md`. O render leu rótulo
 * e alt desse arquivo: o box de livros saiu com o rótulo "Artigo Especial".
 *
 * Agora, quando o box presente não casa com nenhuma entry da seleção mas casa
 * com um único snippet de `data/snippets/`, os metadados vêm desse snippet.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readBoxSelectionFileForSlot,
  matchSnippetLibraryByContent,
  resolveBoxDivulgacaoCategoriaForSlot,
  resolveBoxDivulgacaoAltForSlot,
} from "../scripts/lib/newsletter-parse.ts";

const ARTIGO = "artigo-especial-apoiadores.md";
const LIVROS = "livros-divulgacao.md";

const ARTIGO_SNIPPET =
  "<!--\nnome: Artigo Especial\ncategoria: Artigo Especial\nalt: Artigo Especial de agosto — Engenharia de ilusão\n-->\n\n" +
  "**Artigo Especial de Setembro**\n\nO Artigo Especial desse mês é: **\"O Jev na diar.ia.br\"**.\n\n[Ler o Artigo Especial](https://especial.diar.ia.br/2026/o-jev/)";
const LIVROS_SNIPPET =
  "<!--\nnome: Livros\ncategoria: Recomendação de Leitura\nalt: Capas dos livros recomendados pela diar.ia.br\n-->\n\n" +
  "**Livros que recomendo sobre inteligência artificial**\n\nUma seleção dos livros que mais me ajudaram.\n\n[Ver os livros](https://livros.diar.ia.br)";

const LIVROS_BOX_IN_MD =
  "**Livros que recomendo sobre inteligência artificial**\n\nUma seleção dos livros que mais me ajudaram.\n\n[Ver os livros](https://livros.diar.ia.br)";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(snippets: Record<string, string>): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "box-13897-root-"));
  mkdirSync(join(root, "data", "snippets", "_arquivo"), { recursive: true });
  for (const [f, body] of Object.entries(snippets)) writeFileSync(join(root, "data", "snippets", f), body);
  writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot2: ARTIGO } }));
  const dir = mkdtempSync(join(tmpdir(), "box-13897-ed-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  // Seleção congelada no stitch: slot 2 = Artigo Especial.
  writeFileSync(
    resolve(dir, "_internal", "box-selection.json"),
    JSON.stringify([
      { slot: 1, mode: "auto", file: "amazon-loja-divulgacao.md" },
      { slot: 2, mode: "auto", file: ARTIGO },
    ]),
  );
  dirs.push(root, dir);
  return { dir, root };
}

describe("#13897 — box trocado à mão no .md com box-selection.json antigo", () => {
  it("resolve o snippet do box presente, não o congelado na seleção", () => {
    const { dir, root } = setup({ [ARTIGO]: ARTIGO_SNIPPET, [LIVROS]: LIVROS_SNIPPET });
    assert.equal(readBoxSelectionFileForSlot(dir, 2, LIVROS_BOX_IN_MD, root), LIVROS);
  });

  it("rótulo e alt saem do box de livros, nunca do Artigo Especial", () => {
    const { dir, root } = setup({ [ARTIGO]: ARTIGO_SNIPPET, [LIVROS]: LIVROS_SNIPPET });
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(2, dir, root, LIVROS_BOX_IN_MD), "Recomendação de Leitura");
    assert.equal(
      resolveBoxDivulgacaoAltForSlot(2, dir, root, LIVROS_BOX_IN_MD),
      "Capas dos livros recomendados pela diar.ia.br",
    );
  });

  it("box que segue igual ao da seleção continua resolvendo pela seleção", () => {
    const { dir, root } = setup({ [ARTIGO]: ARTIGO_SNIPPET, [LIVROS]: LIVROS_SNIPPET });
    const artigoBox = "**Artigo Especial de Setembro**\n\nO Artigo Especial desse mês é: **\"O Jev na diar.ia.br\"**.";
    assert.equal(readBoxSelectionFileForSlot(dir, 2, artigoBox, root), ARTIGO);
  });

  it("box sem snippet correspondente mantém o comportamento anterior (entry do slot)", () => {
    const { dir, root } = setup({ [ARTIGO]: ARTIGO_SNIPPET, [LIVROS]: LIVROS_SNIPPET });
    assert.equal(readBoxSelectionFileForSlot(dir, 2, "Texto escrito à mão, sem snippet algum.", root), ARTIGO);
  });

  it("dois snippets com o mesmo conteúdo é ambíguo: não escolhe nenhum", () => {
    const { root } = setup({ [LIVROS]: LIVROS_SNIPPET, "livros-copia.md": LIVROS_SNIPPET });
    assert.equal(matchSnippetLibraryByContent(LIVROS_BOX_IN_MD, root), null);
  });

  it("snippet só em _arquivo/ não entra no casamento", () => {
    const { root } = setup({ [ARTIGO]: ARTIGO_SNIPPET });
    writeFileSync(join(root, "data", "snippets", "_arquivo", LIVROS), LIVROS_SNIPPET);
    assert.equal(matchSnippetLibraryByContent(LIVROS_BOX_IN_MD, root), null);
  });

  it("data/snippets ausente não lança", () => {
    assert.equal(matchSnippetLibraryByContent(LIVROS_BOX_IN_MD, join(tmpdir(), "nao-existe-13897")), null);
  });
});
