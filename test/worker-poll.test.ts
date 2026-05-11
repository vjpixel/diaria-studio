/**
 * test/worker-poll.test.ts (#1083 / #1086)
 *
 * Cobre helpers puros do Worker `diar-ia-poll`:
 *   - formatEditionDate (AAMMDD → "10 de maio de 2026")
 *   - htmlEscape (XSS prevention no votePageHtml)
 *   - parseValidEditions (KV value → string[] | null)
 *   - isValidEdition (gate de aceitação de votos)
 *
 * Não testa handleVote/handleSetName end-to-end — pra isso precisaria do
 * `unstable_dev` do Wrangler (scope creep). Smoke manual via curl cobre
 * os fluxos integrados (#1083 PR body).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatEditionDate,
  htmlEscape,
  parseValidEditions,
  isValidEdition,
} from "../workers/poll/src/lib.ts";

describe("formatEditionDate (#1080)", () => {
  it("converte AAMMDD pro formato pt-BR humano", () => {
    assert.equal(formatEditionDate("260511"), "11 de maio de 2026");
    assert.equal(formatEditionDate("260101"), "1 de janeiro de 2026");
    assert.equal(formatEditionDate("251231"), "31 de dezembro de 2025");
  });

  it("retorna input cru quando formato inválido (no-op safe)", () => {
    // Não deve crashar — comunicação com leitor pode receber valor estranho
    assert.equal(formatEditionDate("invalid"), "invalid");
    assert.equal(formatEditionDate(""), "");
    assert.equal(formatEditionDate("12345"), "12345"); // 5 dígitos
    assert.equal(formatEditionDate("1234567"), "1234567"); // 7 dígitos
  });

  it("retorna input cru quando MM ou DD fora de range (defesa contra typos)", () => {
    assert.equal(formatEditionDate("261301"), "261301"); // mês 13
    assert.equal(formatEditionDate("260132"), "260132"); // dia 32
    assert.equal(formatEditionDate("260000"), "260000"); // mês 0
  });

  it("ano 2000-2099 com prefixo 20YY", () => {
    assert.equal(formatEditionDate("000101"), "1 de janeiro de 2000");
    assert.equal(formatEditionDate("991231"), "31 de dezembro de 2099");
  });
});

describe("htmlEscape (#1083)", () => {
  it("escapa caracteres especiais HTML", () => {
    assert.equal(htmlEscape("<script>"), "&lt;script&gt;");
    assert.equal(htmlEscape('"'), "&quot;");
    assert.equal(htmlEscape("'"), "&#39;");
    assert.equal(htmlEscape("&"), "&amp;");
  });

  it("ordem correta — & primeiro pra não escapar dobrado", () => {
    // Se & fosse processado depois de < ou >, "&lt;" viraria "&amp;lt;"
    assert.equal(htmlEscape("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  });

  it("XSS payload típico via attribute break", () => {
    // Email malicioso (improvável mas defensivo) que tentaria escapar
    // do <input value="..."> pra injetar tag
    const payload = `evil"><script>alert(1)</script>`;
    const escaped = htmlEscape(payload);
    assert.match(escaped, /&quot;/);
    assert.match(escaped, /&lt;script&gt;/);
    assert.doesNotMatch(escaped, /<script>/);
  });

  it("strings normais passam intactas", () => {
    assert.equal(htmlEscape("usuario@example.com"), "usuario@example.com");
    assert.equal(htmlEscape("11 de maio de 2026"), "11 de maio de 2026");
    assert.equal(htmlEscape(""), "");
  });

  it("emojis e UTF-8 não-ASCII passam intactos", () => {
    assert.equal(htmlEscape("✅ Acertou!"), "✅ Acertou!");
    assert.equal(htmlEscape("ç ã é í"), "ç ã é í");
  });
});

describe("parseValidEditions (#1086)", () => {
  it("retorna null pra raw=null (KV key ausente → fail-open)", () => {
    assert.equal(parseValidEditions(null), null);
  });

  it("retorna null pra string vazia", () => {
    assert.equal(parseValidEditions(""), null);
  });

  it("parseia array JSON válido", () => {
    assert.deepEqual(parseValidEditions(`["260511"]`), ["260511"]);
    assert.deepEqual(
      parseValidEditions(`["260511","260512","260513"]`),
      ["260511", "260512", "260513"],
    );
  });

  it("retorna null pra JSON corrupted (fail-open)", () => {
    assert.equal(parseValidEditions(`{invalid json`), null);
    assert.equal(parseValidEditions(`["unterminated`), null);
  });

  it("retorna null quando JSON válido mas não-array (fail-open)", () => {
    assert.equal(parseValidEditions(`"260511"`), null);
    assert.equal(parseValidEditions(`{"editions":["260511"]}`), null);
    assert.equal(parseValidEditions(`42`), null);
  });

  it("filtra entries não-string do array", () => {
    assert.deepEqual(
      parseValidEditions(`["260511", 260512, null, "260513"]`),
      ["260511", "260513"],
    );
  });

  it("retorna array vazio quando JSON é []", () => {
    assert.deepEqual(parseValidEditions(`[]`), []);
  });
});

describe("isValidEdition (#1086)", () => {
  it("aceita qualquer edição quando set é null (fail-open)", () => {
    assert.equal(isValidEdition(null, "260511"), true);
    assert.equal(isValidEdition(null, "999999"), true);
  });

  it("aceita qualquer edição quando set é vazio (compat antes do gate)", () => {
    assert.equal(isValidEdition([], "260511"), true);
  });

  it("aceita edição presente no set", () => {
    assert.equal(isValidEdition(["260511", "260512"], "260511"), true);
    assert.equal(isValidEdition(["260511", "260512"], "260512"), true);
  });

  it("rejeita edição ausente do set", () => {
    assert.equal(isValidEdition(["260511"], "260510"), false);
    assert.equal(isValidEdition(["260511"], "260512"), false);
    assert.equal(isValidEdition(["260511"], "999999"), false);
  });

  it("case-sensitive (AAMMDD é numérico, não tem case mas defensive)", () => {
    // edition vem sempre de URL param trim+upper-no-op pra AAMMDD numérico
    assert.equal(isValidEdition(["260511"], "260511"), true);
  });
});
