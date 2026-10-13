/**
 * #10113 — promote-to-destaque renumera os destaques (inserção do slot novo),
 * mas só atualizava o `location` do erro intencional. A narrativa "Nessa
 * edição, … no destaque N." do bloco ERRO INTENCIONAL em `02-reviewed.md` e o
 * `description`/`reveal` do `_internal/intentional-error.json` continuavam na
 * ordem antiga — o reveal da edição seguinte apontaria o destaque errado.
 * Mesmo fix que o #10098 deu ao reorder-destaques.
 *
 * Cenário da issue: erro no D2, `--position 1` (newOrder [3,1,2]) → antigo D2
 * vira D3; as três referências precisam dizer "destaque 3".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPromoteToReviewedMd, promoteToDestaque } from "../scripts/promote-to-destaque.ts";

const URL_RADAR = "https://www.anthropic.com/research/claude-enzyme";

const ERRO_BLOCK = [
  "**ERRO INTENCIONAL**",
  "",
  "Na última edição, escrevi 1990 no destaque 2, o correto é 1998.",
  "",
  "Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 2.",
  "",
].join("\n");

function reviewedMd(): string {
  return [
    "**DESTAQUE 1 | IA**",
    "",
    "t1",
    "",
    "---",
    "",
    "**DESTAQUE 2 | IA**",
    "",
    "t2 Bradesko",
    "",
    "---",
    "",
    ERRO_BLOCK,
  ].join("\n");
}

function approved() {
  return {
    highlights: [
      { rank: 1, score: 90, bucket: "noticias", url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "D1" } },
      { rank: 2, score: 80, bucket: "noticias", url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "D2" } },
    ],
    radar: [{ url: URL_RADAR, title: "Claude discovers a novel enzyme system", score: 70, category: "pesquisa" }],
    use_melhor: [],
  };
}

describe("applyPromoteToReviewedMd (#10113): narrativa do erro intencional segue a renumeração", () => {
  it("--position 1: 'Nessa edição … destaque 2' vira 'destaque 3'; 'Na última edição' intacta", () => {
    const { md } = applyPromoteToReviewedMd(reviewedMd(), 1, "Novo destaque", URL_RADAR);
    assert.match(md, /Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 3\./);
    assert.match(md, /Na última edição, escrevi 1990 no destaque 2, o correto é 1998\./);
  });

  it("--position 3 (sem deslocamento): narrativa não muda", () => {
    const { md } = applyPromoteToReviewedMd(reviewedMd(), 3, "Novo destaque", URL_RADAR);
    assert.match(md, /Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 2\./);
  });
});

describe("promoteToDestaque ponta a ponta (#10113): erro no D2, --position 1", () => {
  it("location, description, reveal e narrativa do md apontam todos para o destaque 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-10113-"));
    try {
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "01-approved.json"), JSON.stringify(approved()));
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd());
      writeFileSync(
        join(internalDir, "intentional-error.json"),
        JSON.stringify(
          {
            description: "Nome do banco grafado errado (Bradesko) no destaque 2",
            reveal: "Na última edição, escrevi Bradesko no destaque 2, o correto é Bradesco.",
            location: "DESTAQUE 2, parágrafo 1",
            category: "ortografico",
            correct_value: "Bradesco",
            wrong_value: "Bradesko",
          },
          null,
          2,
        ),
      );

      promoteToDestaque(dir, URL_RADAR, 1);

      const ie = JSON.parse(readFileSync(join(internalDir, "intentional-error.json"), "utf8"));
      assert.equal(ie.location, "DESTAQUE 3, parágrafo 1");
      assert.equal(ie.description, "Nome do banco grafado errado (Bradesko) no destaque 3");
      assert.equal(ie.reveal, "Na última edição, escrevi Bradesko no destaque 3, o correto é Bradesco.");
      assert.equal(ie.correct_value, "Bradesco");

      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(md, /Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 3\./);
      assert.match(md, /Na última edição, escrevi 1990 no destaque 2, o correto é 1998\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
