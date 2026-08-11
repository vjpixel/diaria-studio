/**
 * test/image-generate-integrity.test.ts (#4989)
 *
 * Regressão do bug real de 260811: promoção manual de D3 → D1 (mv de
 * `04-d3-*.jpg` para `04-d1-*.jpg` fora do pipeline) seguida de uma
 * re-invocação de `image-generate.ts --destaque d1` apagava silenciosamente
 * o `04-d1-2x1.jpg` recém-promovido quando só um dos dois arquivos do par
 * wide (2x1/1x1) estava presente — o check antigo (`existsSync(2x1) &&
 * existsSync(1x1)`) tratava "só um presente" igual a "nenhum presente" e
 * caía pro fluxo de geração nova, cujo `renameSync` final sobrescreve o
 * destino em silêncio.
 *
 * `resolveWideImageIntegrity` foi extraído de `main()` (mesmo padrão de
 * `resolveRatio`, #4093) justamente pra poder testar a decisão sem gerar
 * imagem real nem tocar disco — o guard desta rodada proíbe qualquer
 * chamada real ao gerador de imagem (Gemini/ComfyUI) em teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveWideImageIntegrity } from "../scripts/image-generate.ts";

describe("resolveWideImageIntegrity — decisão de idempotência do par wide 2x1/1x1 (#4989)", () => {
  it("ambos presentes, sem --force → skip (idempotência preservada, comportamento pré-#4989)", () => {
    const action = resolveWideImageIntegrity(true, true, false);
    assert.deepEqual(action, { kind: "skip" });
  });

  it("CASO REAL #4989 — só o 2x1 presente (promoção manual moveu só um dos dois arquivos) → derive-1x1-from-2x1, NUNCA regenerate", () => {
    const action = resolveWideImageIntegrity(true, false, false);
    assert.deepEqual(
      action,
      { kind: "derive-1x1-from-2x1" },
      "com o 2x1 já presente, o script deve derivar o 1x1 via crop — nunca cair pra geração nova, que sobrescreveria o 2x1 promovido",
    );
  });

  it("só o 1x1 presente (2x1 ausente) → regenerate (não dá pra derivar 2x1 a partir de um crop 1x1)", () => {
    const action = resolveWideImageIntegrity(false, true, false);
    assert.deepEqual(action, { kind: "regenerate" });
  });

  it("nenhum presente → regenerate (fluxo normal, primeira geração)", () => {
    const action = resolveWideImageIntegrity(false, false, false);
    assert.deepEqual(action, { kind: "regenerate" });
  });

  it("--force sempre força regenerate, mesmo com ambos presentes", () => {
    const action = resolveWideImageIntegrity(true, true, true);
    assert.deepEqual(action, { kind: "regenerate" });
  });

  it("--force força regenerate no caso 'só 2x1 presente' também (comportamento explícito do editor tem precedência)", () => {
    const action = resolveWideImageIntegrity(true, false, true);
    assert.deepEqual(action, { kind: "regenerate" });
  });
});
