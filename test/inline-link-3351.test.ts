/**
 * test/inline-link-3351.test.ts
 *
 * Regressão #3351: o fix do #3300 (`hasOpenBold` gate em
 * `parseLinkAtLineStart`, scripts/lib/inline-link.ts) corrigiu o caso de
 * bold independente colado (`[T](url)**Atualização:** resto`), mas junto
 * derrubou silenciosamente um caso diferente e legítimo: uma linha que
 * perdeu só o marcador de ABERTURA do bold — ficando `[Título](url)**`
 * sozinho na linha, sem mais nada depois (edição manual no Drive, ou um
 * passe do humanizador que corta um lado).
 *
 * Antes do #3300, a linha correspondente tratava `**` de fechamento como
 * opcional e independente do de abertura (#590) — strip incondicional.
 * Depois do #3300, com `hasOpenBold=false`, o `**` solo deixou de ser
 * stripado e `rest` ficou `"**"` (não-vazio) → `parseInlineLink` retorna
 * `null` → consumidores reais (`parseDestaques`/`extract-destaques.ts`,
 * `parseListItems`/`newsletter-parse.ts`) corrompem título/URL: o título
 * vira o markdown literal `"[Título](url)**"` e a URL fica vazia — viola a
 * regra do CLAUDE.md "Output final sem markdown".
 *
 * Fix: tolerar o `**` de fechamento solo (sem abertura) SOMENTE quando é o
 * ÚNICO conteúdo restante da linha (nada, ou só whitespace, depois dele) —
 * sem reabrir o #3300, cujo cenário sempre tem conteúdo real após o `**`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInlineLink,
  parseInlineLinkWithTrailing,
} from "../scripts/lib/inline-link.ts";

describe("#3351 — parseLinkAtLineStart: ** de fechamento SOLO (sem abertura) tolerado quando é o único conteúdo restante", () => {
  it("'[Título](https://x.com)**' sozinho na linha → extrai title/url, NÃO retorna null", () => {
    const r = parseInlineLink("[Título](https://x.com)**");
    assert.deepEqual(r, { title: "Título", url: "https://x.com" });
  });

  it("tolera whitespace à direita do ** solo: '[Título](https://x.com)**  '", () => {
    const r = parseInlineLink("[Título](https://x.com)**  ");
    assert.deepEqual(r, { title: "Título", url: "https://x.com" });
  });

  it("título com bold interno balanceado + ** de fechamento solo: '[**Título**](url)**'", () => {
    const r = parseInlineLink("[**Título**](https://x.com)**");
    assert.deepEqual(r, { title: "Título", url: "https://x.com" });
  });

  it("caso real da issue: destaque D1 com ** solo perdendo a abertura", () => {
    const r = parseInlineLink(
      "[OpenAI lanca novo modelo](https://openai.com/blog/x)**",
    );
    assert.deepEqual(r, {
      title: "OpenAI lanca novo modelo",
      url: "https://openai.com/blog/x",
    });
  });

  it("NÃO reabre #3300: '[Título](url)**Atualização:** resto' continua retornando null (bold independente colado, não fechamento solo)", () => {
    const line = "[Título](https://ex.com)**Atualização:** o resto";
    assert.equal(parseInlineLink(line), null);
    assert.equal(parseInlineLinkWithTrailing(line), null);
  });

  it("NÃO reabre #3300: '[Título](https://ex.com)** o resto' continua retornando null (sobra texto após o **, não é fechamento solo)", () => {
    const line = "[Título](https://ex.com)** o resto";
    assert.equal(parseInlineLink(line), null);
    assert.equal(parseInlineLinkWithTrailing(line), null);
  });

  it("com abertura correspondente, comportamento do #3300 pra ** desemparelhado continua intacto: '**[Título](url)**' segue stripando", () => {
    const r = parseInlineLink("**[Título](https://x.com)**");
    assert.deepEqual(r, { title: "Título", url: "https://x.com" });
  });
});
