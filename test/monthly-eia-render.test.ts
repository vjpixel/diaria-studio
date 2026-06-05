/**
 * test/monthly-eia-render.test.ts (#1914)
 *
 * O É IA? mensal precisa:
 *  - ser reconhecido como seção mesmo com o rótulo longo do template
 *    ("É IA? — DESTAQUE DO MÊS"), não só "É IA?";
 *  - usar a legenda do 01-eia.md (creditOverride) no lugar do placeholder do
 *    draft, e renderizar o card (imagens + botão de voto brand=clarice).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSectionLabel,
  parseEiaLegend,
  renderEia,
  draftToEmail,
} from "../scripts/lib/monthly-render.ts";

describe("parseEiaLegend (#1914)", () => {
  it("extrai a legenda do 01-eia.md (sem frontmatter nem header)", () => {
    const md = [
      "---",
      "eia_answer:",
      "  A: real",
      "  B: ia",
      "---",
      "",
      "**É IA?**",
      "",
      "Ilha de Sveti Đorđe, Montenegro. — Marcin Konsek / CC BY-SA 4.0.",
    ].join("\n");
    assert.equal(
      parseEiaLegend(md),
      "Ilha de Sveti Đorđe, Montenegro. — Marcin Konsek / CC BY-SA 4.0.",
    );
  });
  it("tolera header sem bold (É IA?) e CRLF", () => {
    const md = "---\r\neia_answer:\r\n  A: real\r\n---\r\n\r\nÉ IA?\r\n\r\nLegenda X.";
    assert.equal(parseEiaLegend(md), "Legenda X.");
  });
});

describe("renderEia creditOverride (#1914)", () => {
  it("usa a legenda passada no lugar do corpo do chunk", () => {
    const chunk = "É IA? — DESTAQUE DO MÊS\n[placeholder a ser ignorado]";
    const html = renderEia(chunk, "2605", "https://x/A.jpg", "https://x/B.jpg", "Legenda real.");
    assert.ok(html.includes("Legenda real."), "deve usar a legenda override");
    assert.ok(!html.includes("placeholder a ser ignorado"), "não deve usar o placeholder");
    assert.ok(html.includes("🤔 É IA?"), "deve renderizar o card");
    assert.ok(html.includes("brand=clarice"), "voto vai pro leaderboard da Clarice");
  });
  it("descarta corpo que é só placeholder [...] mesmo sem override (#1915 review)", () => {
    const chunk = "É IA? — DESTAQUE DO MÊS\n[Selecionar manualmente a edição...]";
    const html = renderEia(chunk, "2605", "https://x/A.jpg", "https://x/B.jpg");
    assert.ok(!html.includes("Selecionar manualmente"), "placeholder não pode vazar como crédito");
    assert.ok(html.includes("🤔 É IA?"), "card ainda renderiza");
  });
});

describe("draftToEmail dispatch do É IA? com rótulo longo (#1914)", () => {
  const draft = [
    "**\\[ASSUNTO\\]**",
    "1. Assunto de teste",
    "",
    "**\\[É IA? — DESTAQUE DO MÊS\\]**",
    "[Selecionar manualmente a edição... placeholder]",
  ].join("\n");

  it("isSectionLabel reconhece o rótulo longo do É IA?", () => {
    assert.equal(isSectionLabel("**\\[É IA? — DESTAQUE DO MÊS\\]**"), true);
  });

  it("renderiza o card do É IA? (não o placeholder) com a legenda do 01-eia.md", () => {
    const { html } = draftToEmail(
      draft,
      "Assunto de teste",
      "2605",
      "https://x/A.jpg",
      "https://x/B.jpg",
      "Legenda do É IA?.",
    );
    assert.ok(html.includes("🤔 É IA?"), "card do É IA? deve aparecer");
    assert.ok(html.includes("Legenda do É IA?."), "legenda do 01-eia.md deve aparecer");
    assert.ok(
      !html.includes("Selecionar manualmente"),
      "o placeholder do draft não pode vazar pro email",
    );
  });
});
