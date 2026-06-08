/**
 * test/monthly-ds-1955.test.ts (#1955)
 *
 * Trava a aplicação do DS atualizado no digest mensal:
 *  - type scale só {12,16,22,26} (snap de 13/17/18/19/20/21);
 *  - superfícies brancas (card + página #FFFFFF, sem #FBFAF6) — override
 *    email-only, espelhando o diário (#1943/#1945);
 *  - boxes/réguas de contraste seguem bege #EBE5D0 (BEGE preservado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { draftToEmail } from "../scripts/publish-monthly.ts";

const MONTHLY_DRAFT = `**ASSUNTO**

1. Diar.ia | Teste mensal

**PREVIEW**

Preview do teste.

**INTRO**

Resumo do mês de teste, em destaque.

**DESTAQUE 1 | ANTHROPIC**

Título do destaque do mês

Parágrafo um com um [link](https://example.com).

Parágrafo final do destaque.
`;

describe("digest mensal — DS atualizado (#1955)", () => {
  const { html } = draftToEmail(MONTHLY_DRAFT, null, "2605");
  const sizes = [...html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));

  it("type scale só usa {12,16,22,26}", () => {
    const allowed = new Set([12, 16, 22, 26]);
    const stray = [...new Set(sizes.filter((s) => !allowed.has(s)))];
    assert.deepEqual(stray, [], `font-size fora da escala: ${stray.join(", ")}`);
  });

  it("não usa mais os tamanhos antigos (13/17/18/19/20/21)", () => {
    const old = [...new Set(sizes.filter((s) => [13, 17, 18, 19, 20, 21].includes(s)))];
    assert.deepEqual(old, [], `tamanhos antigos ainda presentes: ${old.join(", ")}`);
  });

  it("superfícies brancas (card + página), sem paper #FBFAF6", () => {
    assert.match(html, /#FFFFFF/i);
    assert.doesNotMatch(html, /#FBFAF6/i);
  });

  it("boxes/réguas de contraste seguem bege #EBE5D0", () => {
    assert.match(html, /#EBE5D0/i);
  });
});
