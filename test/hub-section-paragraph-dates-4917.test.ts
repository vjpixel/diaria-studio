/**
 * test/hub-section-paragraph-dates-4917.test.ts (#4917 item 4)
 *
 * Guard anti-regressão: TODO parágrafo de `sections[].paragraphs`, em TODO
 * hub de `HUB_LOADERS`, carrega pelo menos uma data absoluta — "D de mês[ de
 * AAAA]" ou "DD/MM/AAAA". `test/build-hub-page.test.ts` já cobria essa
 * garantia especificamente pras 3 seções do hub Anthropic que motivaram a
 * auditoria original (S3/S4/S5, #4917 item 4, corrigido por `8f157390`) —
 * este teste generaliza a mesma garantia pra TODO hub via `HUB_LOADERS`
 * (mesmo padrão de `test/hub-content-no-diaria-nickname-4795.test.ts`), pra
 * um hub futuro nascer coberto sem precisar de entrada manual.
 *
 * Auditoria 260811 (mesma issue, retomada): `openai-chatgpt.ts` tinha 5 de
 * 12 parágrafos sem data absoluta, `google-gemini.ts` tinha 8 de 16.
 * `meta-ai.ts` já nasceu com `DD/MM/AAAA` em toda seção (auditoria: 0 de
 * 12). Corrigido reusando a mesma técnica de `anthropic-claude.ts`: cada
 * afirmação já linka a edição que a sustenta — a data usada é a `date` real
 * de `{slug}-sources.generated.json`, nunca inventada.
 *
 * Não cobre `introParagraph`/`faq[].answer` — esses campos citam a JANELA
 * de cobertura via `hubCoverageWindow`/`formatDateShort`, não uma sequência
 * de eventos individuais; o requisito de "cada afirmação tem uma data" é
 * específico da narrativa de `sections`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";

const ABSOLUTE_DATE_RE =
  /\d{1,2}º? de (?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|\b\d{2}\/\d{2}\/\d{4}\b/i;

const HUBS = Object.entries(HUB_LOADERS).map(([slug, load]) => ({ slug, content: load() }));

describe("#4917 item 4 — todo parágrafo de sections[].paragraphs tem ≥1 data absoluta", () => {
  it("cobre TODO hub de HUB_LOADERS, não uma lista escrita à mão", () => {
    assert.ok(HUBS.length >= 4, `esperado >= 4 hubs, veio ${HUBS.length} — o registry regrediu?`);
  });

  for (const { slug, content } of HUBS) {
    it(`${slug}: cada parágrafo de cada seção tem pelo menos 1 data absoluta`, () => {
      const violations: string[] = [];
      for (const section of content.sections) {
        section.paragraphs.forEach((paragraph, i) => {
          if (!ABSOLUTE_DATE_RE.test(paragraph)) {
            violations.push(`"${section.heading}" parágrafo ${i + 1}: ${paragraph.slice(0, 100)}...`);
          }
        });
      }
      assert.deepEqual(violations, [], `Parágrafo(s) sem data absoluta em ${slug}:\n  ${violations.join("\n  ")}`);
    });
  }
});
