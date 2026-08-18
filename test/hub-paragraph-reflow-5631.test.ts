/**
 * test/hub-paragraph-reflow-5631.test.ts (#5631)
 *
 * Guard anti-regressão: `openai-chatgpt`, `meta-ai` e `mercado-trabalho`
 * ficaram fora do reflow de parágrafo/data-absoluta-primeiro do commit
 * `cdcdd013` (#5258/#5259, que tocou `anthropic-claude`, `brasil-regulacao`
 * e `google-gemini`). Medição da issue antes do fix: `openai-chatgpt` tinha
 * 12 cadeias de intervalo relativo ("N dias depois") no total e 2/12
 * parágrafos de seção acima de 120 palavras (o maior com 149);
 * `mercado-trabalho` tinha 5 parágrafos acima de 120 (o maior com 148,
 * segundo a issue); `meta-ai` tinha 1 parágrafo de 119 palavras, no limite
 * da meta de ~120 sem estourá-la.
 *
 * `HUB_MAX_PARAGRAPH_WORDS` (`scripts/lib/shared/hub-page.ts`) continua em
 * 160 — este teste NÃO reduz o teto mecânico (a issue deixa essa decisão em
 * aberto, e baixá-lo quebraria o build dos 6 hubs de uma vez, fora de
 * escopo aqui). O que este teste trava é a META editorial de ~120 palavras
 * por parágrafo de seção nos 3 hubs que o #5631 tratou — abaixo do teto
 * mecânico, mas o padrão que `anthropic-claude`/`google-gemini`/
 * `brasil-regulacao` já seguiam desde o #5259.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOpenaiChatgptHub } from "../scripts/lib/hubs/openai-chatgpt.ts";
import { getMetaAiHub } from "../scripts/lib/hubs/meta-ai.ts";
import { getMercadoTrabalhoHub } from "../scripts/lib/hubs/mercado-trabalho.ts";
import type { HubContent } from "../scripts/lib/shared/hub-page.ts";

/** Meta editorial do #5259 — mais apertada que `HUB_MAX_PARAGRAPH_WORDS`
 * (160), que é só o teto mecânico que `validateHubContent` faz cumprir. */
const REFLOW_TARGET_WORDS = 120;

function wordCount(p: string): number {
  return p.trim().split(/\s+/).filter(Boolean).length;
}

const HUBS: { slug: string; hub: HubContent }[] = [
  { slug: "openai-chatgpt", hub: getOpenaiChatgptHub() },
  { slug: "meta-ai", hub: getMetaAiHub() },
  { slug: "mercado-trabalho", hub: getMercadoTrabalhoHub() },
];

describe("#5631 — reflow de parágrafo aplicado a openai-chatgpt/meta-ai/mercado-trabalho", () => {
  for (const { slug, hub } of HUBS) {
    it(`${slug}: nenhum parágrafo de seção passa de ${REFLOW_TARGET_WORDS} palavras`, () => {
      const violations: string[] = [];
      hub.sections.forEach((section, sIdx) => {
        section.paragraphs.forEach((p, pIdx) => {
          const words = wordCount(p);
          if (words > REFLOW_TARGET_WORDS) {
            violations.push(`sections[${sIdx}].paragraphs[${pIdx}]: ${words} palavras`);
          }
        });
      });
      assert.deepEqual(violations, [], `parágrafo(s) acima da meta de ${REFLOW_TARGET_WORDS} palavras:\n  ${violations.join("\n  ")}`);
    });
  }

  it("openai-chatgpt: total de cadeias de intervalo relativo caiu (era 17 antes do reflow, medido ao vivo)", () => {
    const RE = /\b(dias?|semanas?|meses)\s+(depois|mais tarde|depois disso)\b/gi;
    const hub = getOpenaiChatgptHub();
    let total = 0;
    for (const section of hub.sections) {
      for (const p of section.paragraphs) total += (p.match(RE) ?? []).length;
    }
    assert.ok(total < 17, `esperado < 17 cadeias relativas no total (baseline pré-#5631), veio ${total}`);
  });
});
