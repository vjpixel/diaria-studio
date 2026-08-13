/**
 * test/utm-registry-hour-cell-5154.test.ts (#5154 item 1)
 *
 * Regressão (#633) para `tagHourCellUtm` (scripts/lib/shared/utm-registry.ts)
 * — pós-processamento que acrescenta o sufixo de CÉLULA do teste de horário
 * (`H06`/`H10`, #5140) a todo `utm_campaign=clarice-...` já embutido num HTML
 * renderizado, pra que clique/cadastro/cupom fiquem atribuíveis por braço
 * (achado item 1 da issue #5154 — sem isso os dois horários enviam o MESMO
 * HTML com o MESMO UTM).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tagHourCellUtm } from "../scripts/lib/shared/utm-registry.ts";

describe("tagHourCellUtm", () => {
  test("acrescenta o sufixo a um utm_campaign=clarice-... dentro de href com &amp;", () => {
    const html =
      '<a href="https://diar.ia.br/?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2607-08-inline-apresentacao">aqui</a>';
    const out = tagHourCellUtm(html, "H06");
    assert.ok(out.includes("utm_campaign=clarice-2607-08-inline-apresentacao-H06"));
    // Nada mais no HTML foi tocado.
    assert.ok(out.includes("utm_source=clarice"));
  });

  test("acrescenta o sufixo a TODAS as ocorrências (wordmark + inline + cta + titulo + pill)", () => {
    const html = [
      'utm_campaign=clarice-2607-08-wordmark-apresentacao"',
      'utm_campaign=clarice-2607-08-inline-encerramento"',
      'utm_campaign=clarice-2607-08-cta-destaque1"',
    ].join(" ");
    const out = tagHourCellUtm(html, "H10");
    const matches = out.match(/utm_campaign=clarice-[\w-]+/g) ?? [];
    assert.equal(matches.length, 3);
    for (const m of matches) assert.ok(m.endsWith("-H10"));
  });

  test("nunca toca utm_campaign de OUTRA audiência (mensal-beehiiv/mensal-apoiadores-brevo)", () => {
    const html =
      'utm_campaign=mensal-beehiiv-2607-08-inline" utm_campaign=mensal-apoiadores-brevo-2607-08-cta"';
    const out = tagHourCellUtm(html, "H06");
    assert.equal(out, html); // inalterado — prefixo não é "clarice-"
  });

  test("nunca toca o UTM fixo do voto (eia-vote-clarice-signup — prefixo eia-, não clarice-)", () => {
    const html = 'utm_source=clarice-email&utm_campaign=eia-vote-clarice-signup"';
    const out = tagHourCellUtm(html, "H06");
    assert.equal(out, html);
  });

  test("html sem nenhum utm_campaign=clarice-... → inalterado", () => {
    const html = "<p>sem UTM nenhum aqui</p>";
    assert.equal(tagHourCellUtm(html, "H06"), html);
  });

  test("valor com hífens múltiplos (ciclo + posição multi-palavra) captura o valor INTEIRO antes de sufixar", () => {
    const html = 'utm_campaign=clarice-2607-08-hub-anthropic-claude-footer-nav"';
    const out = tagHourCellUtm(html, "H06");
    assert.ok(out.includes("utm_campaign=clarice-2607-08-hub-anthropic-claude-footer-nav-H06"));
  });
});
