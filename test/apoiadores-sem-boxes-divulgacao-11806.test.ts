/**
 * test/apoiadores-sem-boxes-divulgacao-11806.test.ts (#11806)
 *
 * Decisão do editor (01/11/2026, ciclo 2610-11): a página
 * `retrospectiva.diar.ia.br/{AAMM}` e o e-mail Kit dos apoiadores saem sem o
 * box `DIVULGAÇÃO` e sem o box `LIVROS` (curadoria). O envio Clarice continua
 * com os dois. Antes do fix, `filterDraftForApoiadores` só cortava as seções
 * Clarice, e o editor tirava os boxes à mão a cada ciclo.
 *
 * Ponta a ponta pelos dois canais reais (`buildArticleHtml` e
 * `draftToEmailApoiadoresKit`), mais o render Clarice como controle.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArticleHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { draftToEmail, splitByLabels, normalizeLabel } from "../scripts/lib/mensal/monthly-render.ts";
import { filterDraftForApoiadores, isApoiadoresExcludedBox } from "../scripts/lib/mensal/monthly-draft-filter.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = readFileSync(resolve(__dir, "fixtures/publish-monthly/2604/draft.md"), "utf-8");

const BOXES = [
  "**DIVULGAÇÃO**",
  "",
  "Acesso antecipado ao produto parceiro XYZDIVULGA",
  "",
  "Texto do anúncio do parceiro.",
  "",
  "→ [Conheça o parceiro](https://parceiro.example.com/oferta)",
  "",
  "---",
  "",
  "**LIVROS**",
  "",
  "Curadoria de livros sobre IA",
  "",
  "A diar.ia.br mantém uma curadoria de livros CURADORIAXYZ.",
  "",
  "→ [Confira a página de livros](https://livros.diar.ia.br)",
  "",
  "---",
  "",
  "**LIVRO DO MÊS**",
  "",
  "Recomendação de leitura",
  "",
  "**[Livro Indicado LIVROMESXYZ](https://www.amazon.com.br/dp/123)**",
  "",
  "Parágrafo sobre o autor.",
  "",
  "Parágrafo sobre o livro.",
  "",
  "---",
  "",
].join("\n");

const DRAFT = BASE.replace("**PARA ENCERRAR**", `${BOXES}**PARA ENCERRAR**`);

describe("#11806 — canal dos apoiadores sem DIVULGAÇÃO e LIVROS", () => {
  it("fixture tem os dois boxes (sanidade: o teste não passa por vácuo)", () => {
    const labels = splitByLabels(DRAFT).map((c) => normalizeLabel(c.split("\n")[0]));
    assert.ok(labels.includes("DIVULGAÇÃO"), labels.join(","));
    assert.ok(labels.includes("LIVROS"), labels.join(","));
  });

  it("isApoiadoresExcludedBox: só DIVULGAÇÃO e LIVROS (LIVRO do mês e Clarice ficam de fora)", () => {
    assert.equal(isApoiadoresExcludedBox("DIVULGAÇÃO"), true);
    assert.equal(isApoiadoresExcludedBox("LIVROS"), true);
    assert.equal(isApoiadoresExcludedBox("LIVRO"), false);
    assert.equal(isApoiadoresExcludedBox("LIVRO DO MÊS"), false);
    assert.equal(isApoiadoresExcludedBox("CLARICE — DIVULGAÇÃO"), false);
    assert.equal(isApoiadoresExcludedBox("RADAR"), false);
  });

  it("filterDraftForApoiadores remove os dois e mantém LIVRO DO MÊS e PARA ENCERRAR", () => {
    const filtered = filterDraftForApoiadores(DRAFT);
    const labels = splitByLabels(filtered).map((c) => normalizeLabel(c.split("\n")[0]));
    assert.ok(!labels.includes("DIVULGAÇÃO"), labels.join(","));
    assert.ok(!labels.includes("LIVROS"), labels.join(","));
    assert.ok(labels.includes("LIVRO DO MÊS"), labels.join(","));
    assert.ok(labels.includes("PARA ENCERRAR"), labels.join(","));
  });

  it("página da retrospectiva sai sem os dois boxes", () => {
    const { html } = buildArticleHtml(DRAFT, "2604-05");
    assert.doesNotMatch(html, /XYZDIVULGA|parceiro\.example\.com/);
    assert.doesNotMatch(html, /CURADORIAXYZ/);
    assert.match(html, /LIVROMESXYZ/);
  });

  it("e-mail Kit dos apoiadores sai sem os dois boxes", () => {
    const { html } = draftToEmailApoiadoresKit(DRAFT, null, "2604");
    assert.doesNotMatch(html, /XYZDIVULGA|parceiro\.example\.com/);
    assert.doesNotMatch(html, /CURADORIAXYZ/);
    assert.match(html, /LIVROMESXYZ/);
  });

  it("envio Clarice continua com os dois boxes (controle)", () => {
    const { html } = draftToEmail(DRAFT, null, "2604");
    assert.match(html, /XYZDIVULGA/);
    assert.match(html, /CURADORIAXYZ/);
  });
});
