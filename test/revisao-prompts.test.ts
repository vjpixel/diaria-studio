/**
 * test/revisao-prompts.test.ts (#3629) — cobertura da lógica PURA de
 * montagem dos prompts dos ganchos "Reescrever título"/"Regenerar imagem"
 * do painel de revisão (`scripts/studio-ui/public/revisao-prompts.js`).
 * Mesmo padrão de `test/chat-hydration.test.ts`: o módulo não toca
 * `document`/`fetch`, então é testável com fixtures puras, sem DOM real.
 *
 * Regressão: antes do #3629, os dois cards eram stubs ("Gancho — não
 * implementado nesta fatia", ver #3559) sem NENHUMA lógica — só texto
 * estático. Este arquivo cobre a função que efetivamente monta o prompt
 * pré-preenchido no chat (o `prefillMessage` em si, puramente DOM, é
 * exercido pelo contrato de `window.diariaStudioChat` em
 * `test/studio-chat-drawer-contract.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRewriteTitlePrompt,
  buildRegenerateImagePrompt,
} from "../scripts/studio-ui/public/revisao-prompts.js";

describe("buildRewriteTitlePrompt (#3629)", () => {
  it("reflete D1/D2/D3 corretamente no texto", () => {
    for (const destaque of ["d1", "d2", "d3"]) {
      const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque, instrucao: "" });
      assert.match(prompt, new RegExp(destaque.toUpperCase()));
    }
  });

  it("inclui o AAMMDD", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d2", instrucao: "" });
    assert.match(prompt, /260717/);
  });

  it("referencia 02-reviewed.md", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.match(prompt, /02-reviewed\.md/);
  });

  it("pede 2-3 opções antes de aplicar", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.match(prompt, /2-3 opções/);
  });

  it("instrução livre incluída quando presente", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1", instrucao: "mais curto, foco no dado" });
    assert.match(prompt, /mais curto, foco no dado/);
  });

  it("instrução livre omitida quando vazia (sem linha 'Instrução do editor')", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.doesNotMatch(prompt, /Instrução do editor/);
  });

  it("instrução livre omitida quando só espaços em branco", () => {
    const prompt = buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1", instrucao: "   " });
    assert.doesNotMatch(prompt, /Instrução do editor/);
  });

  it("instrucao ausente (undefined) não lança", () => {
    assert.doesNotThrow(() => buildRewriteTitlePrompt({ aammdd: "260717", destaque: "d1" }));
  });
});

describe("buildRegenerateImagePrompt (#3629)", () => {
  it("reflete D1/D2/D3 corretamente no texto e no slug do comando", () => {
    for (const destaque of ["d1", "d2", "d3"]) {
      const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque, instrucao: "" });
      assert.match(prompt, new RegExp(destaque.toUpperCase()));
      assert.match(prompt, new RegExp(`--destaque ${destaque}\\b`));
    }
  });

  it("inclui o AAMMDD (no texto e no --out-dir)", () => {
    const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.match(prompt, /260717/);
    assert.match(prompt, /out-dir data\/editions\/260717\//);
  });

  it("menciona o comando image-generate.ts com --ratio 2x1", () => {
    const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.match(prompt, /scripts\/image-generate\.ts/);
    assert.match(prompt, /--ratio 2x1/);
    assert.match(prompt, /--force/);
  });

  it("instrução livre incluída quando presente (e menciona ajuste do prompt editorial)", () => {
    const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque: "d1", instrucao: "cores mais quentes" });
    assert.match(prompt, /cores mais quentes/);
    assert.match(prompt, /ajuste o prompt de imagem/);
  });

  it("instrução livre omitida quando vazia", () => {
    const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque: "d1", instrucao: "" });
    assert.doesNotMatch(prompt, /Instrução do editor/);
  });

  it("destaque ausente/malformado tem fallback seguro (d1/D1), não lança", () => {
    assert.doesNotThrow(() => buildRegenerateImagePrompt({ aammdd: "260717" }));
    const prompt = buildRegenerateImagePrompt({ aammdd: "260717", destaque: "" });
    assert.match(prompt, /D1/);
    assert.match(prompt, /--destaque d1\b/);
  });
});
