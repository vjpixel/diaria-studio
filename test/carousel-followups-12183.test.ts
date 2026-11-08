/**
 * test/carousel-followups-12183.test.ts — resíduos da #12094 (#12183, itens 4-6).
 *
 * 4. Anual: `slide_prefix` só se aplica quando os cards vêm da legenda
 *    `## d{N}`; a seção `## d{N}-cards` já é o texto do card e não leva o
 *    prefixo. A anual não escreve `-cards` hoje.
 * 5. Re-humanização scoped no Stage 4 com o alvo `main_d{N}-cards`: antes o
 *    alvo era ignorado em silêncio e o check saía OK sem o humanizador tocar
 *    os cards.
 * 6. Eval #8144: ressalva quando baseline e candidato medem textos diferentes
 *    (legenda num lado, cards no outro).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cardsSectionText, slideSourceText } from "../scripts/gen-carousel-cards.ts";
import { buildDaySocialMd, type AnnualSocialKey } from "../scripts/lib/anual/annual-social-plan.ts";
import { checkScopedHumanizerCoverage } from "../scripts/lib/social-lint-rules.ts";
import { agentBodyWritesCarouselCards, carouselCardsSourceCaveat } from "../scripts/lib/prompt-regression-eval.ts";
import { renderAgentEvalPrReport } from "../scripts/run-agent-eval-for-pr.ts";

const PREFIX = "Retrospectiva de 1 ano da diar.ia.br, tema 1 de 6: o trabalho.";

function dirWithCover(cover: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "c12183-"));
  mkdirSync(join(d, "_internal"));
  writeFileSync(join(d, "_internal", "social-cover.json"), JSON.stringify(cover));
  return d;
}

describe("#12183 item 4 — slide_prefix da anual e a seção -cards", () => {
  it("a anual não escreve `## d{N}-cards`: os cards dela caem na legenda e levam o slide_prefix", () => {
    const md = buildDaySocialMd(
      { date: "260913", keys: ["t1"] as AnnualSocialKey[], slots: { d1: "2026-09-13T09:00" } },
      { social: { t1: `${PREFIX} Corpo.` }, curto: { t1: "C" } } as never,
    );
    assert.ok(!/-cards/.test(md), "buildDaySocialMd passou a escrever -cards: rever o slide_prefix em cardsSectionText");
  });

  it("texto vindo de `-cards` ignora o slide_prefix; slide_text explícito continua vencendo", () => {
    const d = dirWithCover({ d1: { kicker: "Série", slide_prefix: PREFIX } });
    // Sem prefixo no texto dos cards: nada a tirar e nada lança (slideSourceText lançaria).
    assert.equal(cardsSectionText(d, "d1", "Card um.\n\nCard dois.\n\nCard três."), "Card um.\n\nCard dois.\n\nCard três.");
    assert.throws(() => slideSourceText(d, "d1", "Card um."), /slide_prefix/);
    const d2 = dirWithCover({ d1: { kicker: "Série", slide_text: "Explícito." } });
    assert.equal(cardsSectionText(d2, "d1", "Card um."), "Explícito.");
  });
});

const social = (d1: string, d1Cards: string, d2: string) =>
  `# Social\n\n## d1\n${d1}\n\n## d1-cards\n${d1Cards}\n\n## d2\n${d2}\n`;

describe("#12183 item 5 — verify-scoped-humanization com alvo main_d{N}-cards", () => {
  const pre = social("Legenda velha.", "Cards velhos.", "Outro destaque.");

  it("alvo main_d1-cards não tocado pelo humanizador falha (antes passava em silêncio)", () => {
    const post = social("Legenda nova.", "Cards velhos.", "Outro destaque.");
    const r = checkScopedHumanizerCoverage(pre, post, ["main_d1", "main_d1-cards"]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.untouchedTargets, ["main_d1-cards"]);
    assert.deepEqual(r.touchedTargets, ["main_d1"]);
  });

  it("alvo main_d1-cards tocado conta como coberto", () => {
    const post = social("Legenda nova.", "Cards novos.", "Outro destaque.");
    const r = checkScopedHumanizerCoverage(pre, post, ["main_d1", "main_d1-cards"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.touchedTargets.sort(), ["main_d1", "main_d1-cards"]);
  });

  it("mudança fora do alvo em seção conhecida continua acusada", () => {
    const post = social("Legenda nova.", "Cards novos.", "Outro destaque mexido.");
    const r = checkScopedHumanizerCoverage(pre, post, ["main_d1", "main_d1-cards"]);
    assert.deepEqual(r.unexpectedChanges, ["main_d2"]);
  });
});

describe("#12183 item 6 — ressalva do eval quando só um lado escreve -cards", () => {
  const OLD = "Escreva `## d1`, `## d2`, `## d3`.";
  const NEW = "Logo depois de cada `## d{N}`, escreva `## d{N}-cards`.";

  it("detecta a seção -cards no corpo do agent", () => {
    assert.equal(agentBodyWritesCarouselCards(NEW), true);
    assert.equal(agentBodyWritesCarouselCards(OLD), false);
  });

  it("baseline sem -cards e candidato com -cards gera a ressalva; mesmo texto nos dois não gera", () => {
    const c = carouselCardsSourceCaveat("social-writer", OLD, NEW);
    assert.ok(c && /candidato escreve/.test(c) && /carousel-text-overflow/.test(c));
    assert.equal(carouselCardsSourceCaveat("social-writer", NEW, NEW), null);
    assert.equal(carouselCardsSourceCaveat("social-writer", OLD, OLD), null);
    assert.equal(carouselCardsSourceCaveat("writer-destaque", OLD, NEW), null);
  });

  it("o relatório de PR mostra a ressalva", () => {
    const caveat = carouselCardsSourceCaveat("social-writer", OLD, NEW)!;
    const md = renderAgentEvalPrReport({
      prNumber: 1,
      prUrl: "https://example.test/pr/1",
      prTitle: "t",
      live: false,
      triggering: [{ agent: "social-writer", verdict: { reason: "corpo mudou" } }],
      reports: { "social-writer": { agent: "social-writer", baseline_ref: "origin/master", repetitions: 1, dry_run: true, editions: [], caveats: [caveat] } },
      costDeltas: [],
    } as never);
    assert.ok(md.includes(caveat));
  });
});
