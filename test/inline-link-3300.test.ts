/**
 * test/inline-link-3300.test.ts
 *
 * Regressão #3300: `parseLinkAtLineStart` (scripts/lib/inline-link.ts),
 * consumida por `parseInlineLink`/`parseInlineLinkWithTrailing` (por sua vez
 * usadas por `newsletter-parse.ts`, `normalize-newsletter.ts`,
 * `extract-destaques.ts` e lint-checks de título), tratava QUALQUER `**`
 * colado logo após o link como par de fechamento — mesmo quando não havia
 * abertura `**` correspondente ANTES do `[`. `rest.startsWith("**")`
 * disparava o strip incondicionalmente (linha ~72 pré-fix).
 *
 * Cenário concreto da issue: `[Título](https://ex.com)**Atualização:** o resto`
 * (link seguido de bold INDEPENDENTE colado, sem abertura de bold antes do
 * link) — `rest.slice(2)` fatiava incorretamente o `**` que na verdade ABRE
 * a frase bold independente "Atualização:", corrompendo o texto adjacente.
 *
 * Fix: só consome o `**` de fechamento quando (a) houve abertura `**` antes
 * do `[` E (b) o candidato está genuinamente desemparelhado no restante da
 * linha (paridade par/ímpar, mesma heurística de `isUnpairedBoldMarker` em
 * newsletter-render-html.ts, #3280).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInlineLink,
  parseInlineLinkWithTrailing,
} from "../scripts/lib/inline-link.ts";

describe("#3300 — parseLinkAtLineStart: ** colado ao link SEM abertura correspondente não é stripado incondicionalmente", () => {
  it("regressão determinística: '[Título](https://ex.com)** o resto' NÃO deve virar trailing='o resto' (o ** stray seria comido silenciosamente pelo bug)", () => {
    // Sem abertura `**` antes do `[`, o `**` colado ao link (sem par nenhum —
    // não fecha nem abre nada de verdade) NÃO deve ser tratado como fechamento
    // do bold-wrap. Pré-fix: `rest.startsWith("**")` disparava incondicionalmente,
    // `rest = rest.slice(2)` transformava "** o resto" em " o resto" (ganhando
    // um espaço à esquerda que NUNCA existiu no texto original) — o que fazia
    // `parseInlineLinkWithTrailing` (que exige `rest` começando com whitespace)
    // silenciosamente aceitar e devolver trailing="o resto", comendo o "**" que
    // era só ruído sem abertura correspondente. Pós-fix: sem `hasOpenBold`, o
    // strip nunca roda — `rest` permanece "** o resto" (não começa com
    // whitespace) — e AMBOS os parsers corretamente retornam null.
    const line = "[Título](https://ex.com)** o resto";
    assert.equal(
      parseInlineLinkWithTrailing(line),
      null,
      "'**' sem abertura correspondente não deveria ser silenciosamente descartado, virando trailing",
    );
    assert.equal(parseInlineLink(line), null, "não é link puro (sobra texto '** o resto')");
  });

  it("cenário da issue: '[Título](https://ex.com)**Atualização:** o resto' (bold independente colado) — nem link puro nem trailing (falta separador whitespace)", () => {
    const line = "[Título](https://ex.com)**Atualização:** o resto";
    assert.equal(parseInlineLink(line), null, "não é link puro (tem texto colado depois)");
    assert.equal(
      parseInlineLinkWithTrailing(line),
      null,
      "sem whitespace separando o link do que vem depois, não deveria virar trailing",
    );
  });

  it("comportamento pré-existente preservado: '**[Título](URL)**' (abertura+fechamento genuínos) continua stripando o ** de fechamento", () => {
    const r = parseInlineLink("**[Título em negrito](https://example.com)**");
    assert.deepEqual(r, { title: "Título em negrito", url: "https://example.com" });
  });

  it("comportamento pré-existente preservado: '**[Título](URL)** resto' (abertura+fechamento + trailing) continua funcionando", () => {
    const r = parseInlineLinkWithTrailing(
      "**[NVIDIA anuncia novidade](https://blogs.nvidia.com/x)** Resumo da notícia aqui.",
    );
    assert.deepEqual(r, {
      title: "NVIDIA anuncia novidade",
      url: "https://blogs.nvidia.com/x",
      trailing: "Resumo da notícia aqui.",
    });
  });

  it("sem abertura E sem trailing bold colado: '[Título](url) texto normal' funciona normalmente (não afetado pelo fix)", () => {
    const r = parseInlineLinkWithTrailing("[Título](https://x.com) texto normal aqui.");
    assert.deepEqual(r, { title: "Título", url: "https://x.com", trailing: "texto normal aqui." });
  });

  it("abertura genuína + bold independente auto-pareado no trailing: '**[T](url)** e **outro** trecho' ainda fecha o wrap do link e preserva o bold independente no trailing", () => {
    const r = parseInlineLinkWithTrailing(
      "**[Título](https://x.com)** e **outro** trecho",
    );
    assert.ok(r, "deveria parsear com trailing");
    assert.equal(r?.title, "Título");
    assert.equal(r?.url, "https://x.com");
    assert.equal(r?.trailing, "e **outro** trecho");
  });
});
