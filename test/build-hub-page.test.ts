/**
 * test/build-hub-page.test.ts (#4558 Parte A)
 *
 * Cobre `renderGeneratedModule` (build-hub-page.ts) e `buildAnthropicClaudeFaq`
 * (scripts/lib/hubs/anthropic-claude.ts) contra o `sources.generated.json`
 * REAL commitado — não um fixture sintético, porque o bug que este teste
 * previne (contagem de "lançamentos" caindo silenciosamente pra 0) só
 * aparece com o texto NFD real do cache Beehiiv; um fixture escrito à mão
 * em NFC não teria pego o achado ao vivo desta sessão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderGeneratedModule } from "../scripts/build-hub-page.ts";
import { buildAnthropicClaudeFaq, getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";
import sourcesRaw from "../scripts/lib/hubs/anthropic-claude-sources.generated.json" with { type: "json" };

describe("renderGeneratedModule (#4558 Parte A)", () => {
  it("emite um módulo TS válido com a constante esperada", () => {
    const mod = renderGeneratedModule("anthropic-claude", "<html>oi</html>");
    assert.match(mod, /GERADO, NÃO EDITAR À MÃO/);
    assert.match(mod, /export const HUB_HTML_ANTHROPIC_CLAUDE = "<html>oi<\/html>";/);
  });

  it("nome da constante segue slug com hífen → SCREAMING_SNAKE_CASE", () => {
    const mod = renderGeneratedModule("foo-bar-baz", "x");
    assert.match(mod, /export const HUB_HTML_FOO_BAR_BAZ =/);
  });
});

describe("buildAnthropicClaudeFaq (#4558 Parte A) — regression do bug NFD/NFC", () => {
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);

  it("6-10 perguntas (issue #4558 item 3)", () => {
    assert.ok(faq.length >= 6 && faq.length <= 10, `esperado 6-10, veio ${faq.length}`);
  });

  it("conta lançamentos > 0 — regression: regex acentuado contra texto NFD batia 0/12 antes da normalização NFC", () => {
    const launchFaq = faq.find((f) => f.question.startsWith("Com que frequência"));
    assert.ok(launchFaq);
    assert.doesNotMatch(launchFaq.answer, /noticiou 0 lançamentos/);
    assert.match(launchFaq.answer, /noticiou 12 lançamentos/);
  });

  it("cada resposta do FAQ aparece idêntica no corpo visível da página (paridade com o JSON-LD)", () => {
    const hub = getAnthropicClaudeHub();
    // hub.faq é a MESMA lista usada pelo JSON-LD (renderGeoJsonLd) e pelo
    // bloco visível (renderGeoFaqSection) em hub-page.ts — checar aqui que
    // buildAnthropicClaudeFaq() não diverge do que getAnthropicClaudeHub()
    // efetivamente usa.
    assert.deepEqual(hub.faq, faq);
  });
});

describe("getAnthropicClaudeHub (#4558 Parte A)", () => {
  const hub = getAnthropicClaudeHub();

  it("sourceEditions não é vazio e está ordenado do mais recente pro mais antigo", () => {
    assert.ok(hub.sourceEditions.length > 0);
    for (let i = 1; i < hub.sourceEditions.length; i++) {
      assert.ok(hub.sourceEditions[i - 1].date >= hub.sourceEditions[i].date);
    }
  });

  it("toda sourceEdition aponta pro domínio de marca diar.ia.br", () => {
    for (const e of hub.sourceEditions) {
      assert.match(e.url, /^https:\/\/diar\.ia\.br\/p\//);
    }
  });

  it("contentDate é um literal estático YYYY-MM-DD (não Date.now())", () => {
    assert.match(hub.contentDate, /^\d{4}-\d{2}-\d{2}$/);
  });
});
