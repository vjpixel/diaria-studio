/**
 * #8769 — o auto-reporter sinalizava query `discovery:*` com streak congelado
 * (402 de cota da API de busca, 3+ semanas atrás) e sugeria desativá-la em
 * seed/sources.csv, onde queries de discovery não existem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signalsFromSourceHealth, DISCOVERY_STALE_DAYS } from "../scripts/collect-edition-signals.ts";

const NOW = new Date("2026-09-22T12:00:00Z");
const outcomes = (isoDays: string[]) => isoDays.map((d) => ({ outcome: "fail", timestamp: `${d}T10:00:00Z` }));

describe("signalsFromSourceHealth — discovery:* (#8769)", () => {
  it("streak de discovery cujo último 402 foi 3+ semanas atrás não é sinalizado", () => {
    const signals = signalsFromSourceHealth(
      { sources: { "discovery:tutorial IA para iniciantes": { recent_outcomes: outcomes(["2026-08-27", "2026-08-28", "2026-08-30", "2026-08-31"]) } } },
      3, 6, new Set(["OpenAI"]), NOW,
    );
    assert.deepEqual(signals, []);
  });

  it("streak de discovery RECENTE ainda sinaliza, com ação própria (nunca seed/sources.csv como alvo)", () => {
    const signals = signalsFromSourceHealth(
      { sources: { "discovery:agentes": { recent_outcomes: outcomes(["2026-09-19", "2026-09-20", "2026-09-21"]) } } },
      3, 6, undefined, NOW,
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_streak");
    assert.match(signals[0].suggested_action, /cota/);
    assert.doesNotMatch(signals[0].suggested_action, /desativar .* em seed\/sources\.csv/);
  });

  it("fonte do CSV com streak antigo continua sinalizando (a janela só vale pra discovery)", () => {
    const signals = signalsFromSourceHealth(
      { sources: { OpenAI: { recent_outcomes: outcomes(["2026-08-27", "2026-08-28", "2026-08-31"]) } } },
      3, 6, new Set(["OpenAI"]), NOW,
    );
    assert.equal(signals.length, 1);
    assert.match(signals[0].suggested_action, /seed\/sources\.csv/);
  });

  it("outcome sem timestamp não é tratado como congelado", () => {
    const signals = signalsFromSourceHealth(
      { sources: { "discovery:x": { recent_outcomes: [{ outcome: "fail" }, { outcome: "fail" }, { outcome: "fail" }] } } },
      3, 6, undefined, NOW,
    );
    assert.equal(signals.length, 1);
  });

  it("a janela é de 14 dias", () => {
    assert.equal(DISCOVERY_STALE_DAYS, 14);
  });
});
