/**
 * test/monthly-eia-prev-result.test.ts (#2948)
 *
 * Follow-up de #2709: o suporte de render (opt-in) da linha "Resultado da
 * última edição: X% acertaram" no bloco É IA? mensal já existia
 * (`renderEia`/`draftToEmail`, ver test/monthly-eia-render.test.ts), mas
 * nenhum caller buscava o dado real. Este arquivo cobre o WIRING:
 *   - `prevYymm`: deriva o mês de conteúdo anterior (com virada de ano)
 *   - `fetchMonthlyEiaPrevResultLine`: busca o ciclo anterior com
 *     brand=clarice (via `fetchPollStatsImpl` injetado — sem tocar rede real)
 *     e monta a linha via `buildPrevResultLine`; omite (null) quando não há
 *     dado confiável.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prevYymm,
  fetchMonthlyEiaPrevResultLine,
} from "../scripts/lib/mensal/monthly-eia-prev-result.ts";
import type { PollStatsOutput } from "../scripts/fetch-poll-stats.ts";

describe("prevYymm (#2948)", () => {
  it("mês normal: 2606 (junho) → 2605 (maio)", () => {
    assert.equal(prevYymm("2606"), "2605");
  });

  it("janeiro → dezembro do ano anterior (virada de ano)", () => {
    assert.equal(prevYymm("2601"), "2512");
  });

  it("dezembro → novembro (mesmo ano)", () => {
    assert.equal(prevYymm("2612"), "2611");
  });

  it("YYMM mal formado lança erro claro", () => {
    assert.throws(() => prevYymm("260"), /YYMM inválido/);
    assert.throws(() => prevYymm("abcd"), /YYMM inválido/);
  });

  it("mês fora de 1-12 lança erro claro", () => {
    assert.throws(() => prevYymm("2600"), /mês inválido/);
    assert.throws(() => prevYymm("2613"), /mês inválido/);
  });
});

describe("fetchMonthlyEiaPrevResultLine (#2948)", () => {
  const makeStats = (overrides: Partial<PollStatsOutput> = {}): PollStatsOutput => ({
    edition: "2605-06",
    total_responses: 10,
    correct_responses: 7,
    pct_correct: 70,
    correct_choice: "A",
    below_threshold: false,
    source: "poll-worker",
    fetched_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });

  it("deriva o ciclo do mês de conteúdo anterior e busca com brand=clarice", async () => {
    let calledEdition = "";
    let calledOpts: { brand?: string; workerUrl?: string } | undefined;
    const line = await fetchMonthlyEiaPrevResultLine("2606", {
      fetchPollStatsImpl: async (edition, opts) => {
        calledEdition = edition;
        calledOpts = opts;
        return makeStats();
      },
    });
    assert.equal(calledEdition, "2605-06", "edição buscada deve ser o ciclo do mês anterior (maio → 2605-06)");
    assert.equal(calledOpts?.brand, "clarice");
    assert.equal(line, "Resultado da última edição: 70% das pessoas acertaram.");
  });

  it("virada de ano: yymm=2601 busca o ciclo 2512-01", async () => {
    let calledEdition = "";
    await fetchMonthlyEiaPrevResultLine("2601", {
      fetchPollStatsImpl: async (edition) => {
        calledEdition = edition;
        return makeStats({ edition: "2512-01" });
      },
    });
    assert.equal(calledEdition, "2512-01");
  });

  it("repassa workerUrl customizado pro fetchPollStatsImpl", async () => {
    let calledOpts: { brand?: string; workerUrl?: string } | undefined;
    await fetchMonthlyEiaPrevResultLine("2606", {
      workerUrl: "https://custom-poll.example",
      fetchPollStatsImpl: async (_edition, opts) => {
        calledOpts = opts;
        return makeStats();
      },
    });
    assert.equal(calledOpts?.workerUrl, "https://custom-poll.example");
  });

  it("abaixo do piso de confiança → omite a linha (null)", async () => {
    const line = await fetchMonthlyEiaPrevResultLine("2606", {
      fetchPollStatsImpl: async () =>
        makeStats({ below_threshold: true, pct_correct: null, skipped: "fewer_than_5_responses" }),
    });
    assert.equal(line, null);
  });

  it("sem votos (1ª edição do ano) → omite a linha (null)", async () => {
    const line = await fetchMonthlyEiaPrevResultLine("2606", {
      fetchPollStatsImpl: async () =>
        makeStats({ total_responses: 0, below_threshold: true, pct_correct: null, correct_choice: null }),
    });
    assert.equal(line, null);
  });

  it("pct_correct null mesmo com total_responses presente → omite (dado incompleto)", async () => {
    const line = await fetchMonthlyEiaPrevResultLine("2606", {
      fetchPollStatsImpl: async () => makeStats({ pct_correct: null }),
    });
    assert.equal(line, null);
  });
});
