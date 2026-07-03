/**
 * test/sanitize-description-ellipsis.test.ts (#2881)
 *
 * Regressão (#633) pros 3 casos exigidos pela issue:
 *   (a) snippet terminando em "…" → descrição saneada sem reticência
 *   (b) descrição completa legítima → intacta
 *   (c) "…" no MEIO da frase (uso legítimo) → NÃO tocado, só no final
 *
 * Casos reais da edição 260703 (#2881):
 *   - "...com ênfase em ética, transparência, não-discriminação, segurança e
 *     soberania…"
 *   - "...um hotel processado por casos de intoxicação alimentar em massa foi
 *     descrito como…"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTrailingEllipsis } from "../scripts/lib/sanitize-description-ellipsis.ts";

describe("sanitizeTrailingEllipsis (#2881)", () => {
  describe("caso (a): snippet terminando em reticência", () => {
    it("CASO REAL: 'Gestão lança Matriz de Competências em IA...soberania…' — remove a reticência final", () => {
      const input =
        "Gestão lança Matriz de Competências em IA com ênfase em ética, transparência, " +
        "não-discriminação, segurança e soberania…";
      const out = sanitizeTrailingEllipsis(input);
      assert.ok(!/[…]$/.test(out), "não deve terminar em reticência unicode");
      assert.ok(!/\.{2,}$/.test(out), "não deve terminar em reticência ascii");
      assert.equal(
        out,
        "Gestão lança Matriz de Competências em IA com ênfase em ética, transparência, " +
          "não-discriminação, segurança e soberania",
      );
    });

    it("CASO REAL: 'AI summaries...intoxicação alimentar em massa foi descrito como…' — remove a reticência final", () => {
      const input =
        "um hotel processado por casos de intoxicação alimentar em massa foi descrito como…";
      const out = sanitizeTrailingEllipsis(input);
      assert.ok(!out.endsWith("…"));
      assert.equal(
        out,
        "um hotel processado por casos de intoxicação alimentar em massa foi descrito como",
      );
    });

    it("corta no último fim-de-frase completo quando existe um antes da reticência", () => {
      const input =
        "A empresa fechou uma parceria estratégica com o fornecedor. Além disso, o plano prevê " +
        "expansão para outros mercados da América Latina e Ásia…";
      const out = sanitizeTrailingEllipsis(input);
      assert.equal(
        out,
        "A empresa fechou uma parceria estratégica com o fornecedor.",
      );
    });

    it("remove só a reticência quando o que sobra já é frase completa (termina em pontuação)", () => {
      const input = "O anúncio confirma o que já se especulava há semanas.…";
      const out = sanitizeTrailingEllipsis(input);
      assert.equal(out, "O anúncio confirma o que já se especulava há semanas.");
    });

    it("também trata reticências ascii (3 pontos) no final", () => {
      const input = "A startup captou uma nova rodada de investimento...";
      const out = sanitizeTrailingEllipsis(input);
      assert.equal(out, "A startup captou uma nova rodada de investimento");
    });

    it("também trata ' ...' (espaço + 3 pontos) no final", () => {
      const input = "A startup captou uma nova rodada de investimento ...";
      const out = sanitizeTrailingEllipsis(input);
      assert.equal(out, "A startup captou uma nova rodada de investimento");
    });

    it("também trata reticências ascii de 2 pontos (convenção do repo: \\.{2,} = reticência)", () => {
      const input = "A startup captou uma nova rodada de investimento..";
      const out = sanitizeTrailingEllipsis(input);
      assert.equal(out, "A startup captou uma nova rodada de investimento");
    });
  });

  describe("caso (b): descrição completa legítima", () => {
    it("não toca descrição sem reticência nenhuma", () => {
      const input = "A Meta anunciou um novo modelo de IA generativa nesta semana.";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });

    it("não toca descrição terminando em '?' (pergunta legítima)", () => {
      const input = "Será que a regulamentação vai travar a inovação no Brasil?";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });

    it("não toca descrição terminando em '!' (exclamação legítima)", () => {
      const input = "A parceria promete revolucionar o setor!";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });

    it("string vazia é retornada intacta", () => {
      assert.equal(sanitizeTrailingEllipsis(""), "");
    });
  });

  describe("caso (c): reticência no MEIO da frase (uso legítimo) — não tocado", () => {
    it("não remove reticência no meio, só continua o texto normalmente", () => {
      const input = "E foi só o começo… ninguém esperava o que veio a seguir na conferência.";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });

    it("não remove reticência ascii no meio da frase", () => {
      const input = "Era pra ser simples... acabou virando um projeto de 6 meses inteiro.";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });
  });

  describe("edge cases", () => {
    it("texto formado só por reticências (sem conteúdo) é devolvido intacto", () => {
      const input = "…";
      assert.equal(sanitizeTrailingEllipsis(input), input);
    });

    it("é idempotente — aplicar 2x dá o mesmo resultado que aplicar 1x", () => {
      const input =
        "Gestão lança Matriz de Competências em IA com ênfase em soberania…";
      const once = sanitizeTrailingEllipsis(input);
      const twice = sanitizeTrailingEllipsis(once);
      assert.equal(once, twice);
    });
  });
});
