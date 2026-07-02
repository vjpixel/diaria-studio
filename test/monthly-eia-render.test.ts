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
  eiaEditionFromYymm,
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
    assert.ok(html.includes("&#9679;&nbsp;É IA?"), "deve renderizar o card");
    assert.ok(html.includes("brand=clarice"), "voto vai pro leaderboard da Clarice");
  });
  it("descarta corpo que é só placeholder [...] mesmo sem override (#1915 review)", () => {
    const chunk = "É IA? — DESTAQUE DO MÊS\n[Selecionar manualmente a edição...]";
    const html = renderEia(chunk, "2605", "https://x/A.jpg", "https://x/B.jpg");
    assert.ok(!html.includes("Selecionar manualmente"), "placeholder não pode vazar como crédito");
    assert.ok(html.includes("&#9679;&nbsp;É IA?"), "card ainda renderiza");
  });
});

describe("renderEia layout = diária (#1918)", () => {
  const html = renderEia(
    "É IA? — DESTAQUE DO MÊS\n[placeholder]",
    "2605",
    "https://x/A.jpg",
    "https://x/B.jpg",
    "Crédito.",
  );
  it("usa a frase da diária", () => {
    assert.ok(html.includes("Clique na imagem que foi gerada por IA."));
    assert.ok(!html.includes("Qual das imagens foi gerada por IA?"), "frase antiga removida");
  });
  it("NÃO tem botão de votar — a imagem é o link", () => {
    assert.ok(!html.includes("Votar: esta é IA"), "sem botão");
    // imagem A dentro de <a href=...choice=A...&brand=clarice>
    assert.match(html, /<a href="[^"]*choice=A[^"]*brand=clarice[^"]*"[^>]*>\s*<img[^>]*A\.jpg/);
    assert.match(html, /<a href="[^"]*choice=B[^"]*brand=clarice[^"]*"[^>]*>\s*<img[^>]*B\.jpg/);
  });
  it("imagens empilhadas A acima de B, em desktop e mobile (#2541 diária)", () => {
    assert.ok(!html.includes("mob-stack"), "sem mob-stack — não é mais lado a lado");
    assert.ok(!html.includes('width="50%"'), "sem células de 50% (não é 2 colunas)");
    const ai = html.indexOf("A.jpg");
    const bi = html.indexOf("B.jpg");
    assert.ok(ai > 0 && bi > ai, "imagem A renderiza acima da B");
  });
  it("mantém o merge tag Brevo e a legenda", () => {
    assert.ok(html.includes("{{ contact.EMAIL }}"), "merge tag Brevo preservado");
    assert.ok(html.includes("Crédito."), "legenda renderizada");
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
    assert.ok(html.includes("&#9679;&nbsp;É IA?"), "card do É IA? deve aparecer");
    assert.ok(html.includes("Legenda do É IA?."), "legenda do 01-eia.md deve aparecer");
    assert.ok(
      !html.includes("Selecionar manualmente"),
      "o placeholder do draft não pode vazar pro email",
    );
  });
});

// #2115: eiaEditionFromYymm agora emite o ciclo {YYMM}-{MM} em vez de AAMMDD
describe("eiaEditionFromYymm (#2115)", () => {
  it("emite formato de ciclo YYMM-MM", () => {
    assert.equal(eiaEditionFromYymm("2605"), "2605-06");
    assert.equal(eiaEditionFromYymm("2604"), "2604-05");
    assert.equal(eiaEditionFromYymm("2601"), "2601-02");
  });

  it("dezembro → janeiro do mês seguinte (overflow correto)", () => {
    assert.equal(eiaEditionFromYymm("2612"), "2612-01");
  });

  it("renderEia usa o ciclo no URL de voto (edition=2605-06)", () => {
    const html = renderEia(
      "É IA? — DESTAQUE DO MÊS\n[placeholder]",
      "2605",
      "https://x/A.jpg",
      "https://x/B.jpg",
      "Crédito.",
    );
    assert.ok(html.includes("edition=2605-06"), "URL de voto deve ter o ciclo 2605-06");
    assert.ok(!html.includes("edition=260531"), "não deve usar mais o formato legado AAMMDD");
  });
});
