/**
 * test/artigo-especial-gate-price-drift-8155.test.ts (#8155 follow-up)
 *
 * A #8155 extraiu os 4 limiares de nível de recompensa pra
 * `scripts/lib/reward-tier-thresholds.ts` e consertou o drift-risk em
 * `studio-apoios.ts`/`site-apoiar-page.ts` — mas o fleet review da própria
 * PR (`type-design-analyzer`) achou a MESMA classe de risco intocada em
 * duas outras superfícies: `scripts/lib/shared/artigo-especial-gate-cta.ts`
 * (CTA do teaser dos Artigos Especiais) e `workers/artigos/src/gate-page.ts`
 * (tela `GET /gate`) — as duas hardcodavam "R$10/mês" como string solta,
 * sem NENHUM import de `reward-tier-thresholds.ts`.
 *
 * Mesmo padrão de `test/retrospectiva-copy-limiar-7690.test.ts` e
 * `test/site-apoiar-page-7915.test.ts`: deriva o valor esperado direto do
 * módulo compartilhado, nunca transcreve o número — mexer no limiar sem
 * mexer na copy quebra aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderGateCta } from "../scripts/lib/shared/artigo-especial-gate-cta.ts";
import { renderGatePage } from "../workers/artigos/src/gate-page.ts";
import { REWARD_TIER_APOIADOR_MIN } from "../scripts/lib/reward-tier-thresholds.ts";

const VALOR_APOIADOR = `R$${REWARD_TIER_APOIADOR_MIN}/mês`;

describe("#8155 follow-up — CTA do gate dos Artigos Especiais cita o limiar REAL", () => {
  it("REWARD_TIER_APOIADOR_MIN é R$10 hoje (sanity — se mudar, os asserts abaixo têm que acompanhar)", () => {
    assert.equal(REWARD_TIER_APOIADOR_MIN, 10);
  });

  it("artigo-especial-gate-cta.ts (renderGateCta): cita o valor derivado, nunca um literal hardcoded", () => {
    const html = renderGateCta("some-slug");
    const ocorrencias = html.match(/R\$\d+\/mês/g) ?? [];
    assert.ok(ocorrencias.length > 0, "deveria citar um valor em R$/mês");
    for (const ocorrencia of ocorrencias) {
      assert.equal(ocorrencia, VALOR_APOIADOR, `citou "${ocorrencia}" em vez do limiar real (${VALOR_APOIADOR}) — desincronizou de REWARD_TIER_APOIADOR_MIN`);
    }
  });

  it("workers/artigos/src/gate-page.ts (renderGatePage): cita o valor derivado, nunca um literal hardcoded", () => {
    const html = renderGatePage("/some/redirect");
    const ocorrencias = html.match(/R\$\d+\/mês/g) ?? [];
    assert.ok(ocorrencias.length > 0, "deveria citar um valor em R$/mês");
    for (const ocorrencia of ocorrencias) {
      assert.equal(ocorrencia, VALOR_APOIADOR, `citou "${ocorrencia}" em vez do limiar real (${VALOR_APOIADOR}) — desincronizou de REWARD_TIER_APOIADOR_MIN`);
    }
  });
});
