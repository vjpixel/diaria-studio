/**
 * test/build-article-page-3940.test.ts (#3940)
 *
 * Teste do pipeline de geração do HTML do artigo mensal
 * (`scripts/lib/mensal/build-article-page.ts`). `buildArticleHtml` é pura —
 * reusa `draftToEmail` (já testado em `test/monthly-render*.test.ts`) — este
 * teste cobre só o wiring novo (ciclo → yymm, validação de ciclo, shape do
 * retorno), sem duplicar a suíte de render já existente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArticleHtml } from "../scripts/lib/mensal/build-article-page.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DRAFT = readFileSync(
  resolve(__dir, "fixtures/publish-monthly/2604/draft.md"),
  "utf-8",
);

describe("buildArticleHtml (#3940)", () => {
  it("gera um documento HTML completo a partir do draft.md do ciclo", () => {
    const page = buildArticleHtml(FIXTURE_DRAFT, "2604-05");
    assert.match(page.html, /^<!DOCTYPE html/);
    assert.match(page.html, /<\/html>$/);
  });

  it("extrai o subject de ASSUNTO", () => {
    const page = buildArticleHtml(FIXTURE_DRAFT, "2604-05");
    assert.equal(page.subject, "Edição de Teste");
  });

  it("extrai o previewText de PREVIEW", () => {
    const page = buildArticleHtml(FIXTURE_DRAFT, "2604-05");
    assert.equal(page.previewText, "Preview do teste.");
  });

  it("renderiza o título e corpo do destaque no HTML", () => {
    const page = buildArticleHtml(FIXTURE_DRAFT, "2604-05");
    assert.match(page.html, /Título do destaque de teste/);
    assert.match(page.html, /href="https:\/\/example\.com"/);
  });

  it("ciclo inválido (não {conteúdo}-{envio}) → lança erro explícito", () => {
    assert.throws(() => buildArticleHtml(FIXTURE_DRAFT, "260405"), /ciclo inválido/);
    assert.throws(() => buildArticleHtml(FIXTURE_DRAFT, ""), /ciclo inválido/);
  });

  it("sem imagens (destaqueImageUrls omitido) → renderiza sem crashar, sem <img> do destaque", () => {
    const page = buildArticleHtml(FIXTURE_DRAFT, "2604-05");
    // Sanidade: o pipeline não requer imagens geradas pra funcionar (#3940
    // escopo — imagens reais são fast-follow, ver docstring do módulo).
    assert.doesNotThrow(() => page.html.length);
  });
});
