/**
 * test/check-seed-html-sync.test.ts (#3105)
 *
 * Cobre a lógica pura do guard CI #3105 (findDriftedPairs). Não testa main()
 * (depende de `git diff` externo — testado via integração no GH Action real,
 * mesmo padrão de test/check-pr-bugfix.test.ts).
 *
 * Regressão: commit 00dcb5a1 (#2451) atualizou seed/courses/cursos-ia.json
 * com 2 cursos novos e o HTML committed correspondente, mas o Worker nunca
 * foi re-deployado (#3105) — a página ao vivo ficou defasada por semanas.
 * Este check ataca o sintoma de PR (seed muda sem o HTML acompanhar no
 * mesmo PR), que é o sinal mais barato e cedo de "builder não rodou".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDriftedPairs, SEED_HTML_PAIRS, type SeedHtmlPair } from "../scripts/check-seed-html-sync.ts";

const CURSOS_PAIR = SEED_HTML_PAIRS.find((p) => p.name === "cursos") as SeedHtmlPair;
const LIVROS_PAIR = SEED_HTML_PAIRS.find((p) => p.name === "livros") as SeedHtmlPair;

describe("findDriftedPairs (#3105)", () => {
  it("seed de cursos mudou junto com o HTML — sem drift", () => {
    const changed = ["seed/courses/cursos-ia.json", "workers/cursos/public/index.html"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("seed de cursos mudou SEM o HTML — drift detectado (repro #3105)", () => {
    const changed = ["seed/courses/cursos-ia.json"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "cursos");
  });

  it("seed de livros mudou SEM o HTML — drift detectado", () => {
    const changed = ["seed/books/livros-ia.json", "README.md"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "livros");
  });

  it("nenhum seed mudou — sem drift mesmo se o HTML mudar sozinho", () => {
    const changed = ["workers/cursos/public/index.html", "scripts/build-cursos-page.ts"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("PR não toca nem seed nem HTML — sem drift", () => {
    const changed = ["README.md", "scripts/other-thing.ts"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("ambos os seeds mudam sem seus HTMLs — 2 pares driftados", () => {
    const changed = ["seed/courses/cursos-ia.json", "seed/books/livros-ia.json"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 2);
    assert.deepEqual(
      drifted.map((p) => p.name).sort(),
      ["cursos", "livros"],
    );
  });

  it("arquivo dentro do prefixo do seed mas não .json ainda conta (ex: novo doc na pasta)", () => {
    // Qualquer arquivo sob o prefixo do seed já é sinal suficiente de mudança
    // relevante — não restringimos por extensão pra manter a heurística simples.
    const changed = ["seed/courses/NOTES.md"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "cursos");
  });

  it("usa pares customizados quando passados explicitamente", () => {
    const customPair: SeedHtmlPair = {
      name: "custom",
      seedPrefix: "seed/custom/",
      htmlPath: "workers/custom/public/index.html",
      buildCommand: "npx tsx scripts/build-custom-page.ts",
    };
    const changed = ["seed/custom/data.json"];
    const drifted = findDriftedPairs(changed, [customPair]);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "custom");
  });

  it("sanity: os pares default apontam pros paths reais do repo", () => {
    assert.equal(CURSOS_PAIR.seedPrefix, "seed/courses/");
    assert.equal(CURSOS_PAIR.htmlPath, "workers/cursos/public/index.html");
    assert.equal(LIVROS_PAIR.seedPrefix, "seed/books/");
    assert.equal(LIVROS_PAIR.htmlPath, "workers/livros/public/index.html");
  });
});
