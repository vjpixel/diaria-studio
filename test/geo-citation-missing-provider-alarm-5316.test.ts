/**
 * test/geo-citation-missing-provider-alarm-5316.test.ts (#5316)
 *
 * Regressão do achado ao vivo: a Anthropic ficou muda em `predator` desde
 * 11/ago/2026 (`ANTHROPIC_API_KEY` sumiu do `.env` local) e o alarme de
 * staleness (#4755) nunca disparou — Google e OpenAI seguiam gravando
 * normalmente, então `history.jsonl` não parava de crescer (o único sinal
 * que aquele alarme sabe ler). Este teste cobre o alarme NOVO, que compara
 * o conjunto de providers da última rodada conhecida de cada painel contra
 * `GEO_PROVIDERS` (o conjunto canônico) e dispara quando algum provider
 * configurado some — mesmo com os outros providers saudáveis.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPanelProviderRecords } from "../scripts/geo-citation-staleness-alarm.ts";
import { latestRoundProviders } from "../scripts/lib/geo-citation-monitor.ts";
import {
  computeMissingProviders,
  computeMultiPanelMissingProviders,
  shouldAlarmMissingProviders,
  buildMissingProviderAlarmEmail,
  advanceState,
  emptyGeoCitationStalenessAlarmState,
  type GeoCitationStalenessAlarmState,
} from "../scripts/lib/geo-citation-staleness-alarm.ts";

const ALL_PROVIDERS = ["anthropic", "openai", "google"];

function historyWith(records: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "geo-missing-provider-"));
  const p = join(dir, "history.jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return p;
}

const rec = (date: string, provider: string, panel?: string) => ({
  ts: `${date}T07:00:00.000Z`,
  date,
  question: "q?",
  provider,
  cited: false,
  ...(panel ? { panel } : {}),
});

describe("computeMissingProviders (#5316) — pure", () => {
  it("nenhum provider ausente -> lista vazia", () => {
    assert.deepEqual(computeMissingProviders(["anthropic", "openai", "google"], ALL_PROVIDERS), []);
  });

  it("1 provider ausente -> devolve só ele", () => {
    assert.deepEqual(computeMissingProviders(["openai", "google"], ALL_PROVIDERS), ["anthropic"]);
  });

  it("providers em ordem/conjunto diferente ainda resolve certo", () => {
    assert.deepEqual(computeMissingProviders(["google"], ALL_PROVIDERS), ["anthropic", "openai"]);
  });
});

describe("cenário real da issue: Anthropic sumiu de N rodadas recentes, os outros seguem presentes", () => {
  it("ALARMA citando o provider ausente quando um provider configurado desaparece de rodadas recentes", () => {
    // Espelha o achado ao vivo: 07/08 e 10/08 só com openai+google;
    // 11/08 com os 3 (rodada manual do #4904); a ÚLTIMA rodada conhecida
    // (11/08) ainda tem os 3 — então avançamos o cenário pra depois de
    // 11/08 continuar SÓ com openai+google (a máquina nunca repôs a key),
    // que é o estado real em `predator` na data da issue.
    const p = historyWith([
      rec("2026-08-07", "openai"),
      rec("2026-08-07", "google"),
      rec("2026-08-10", "openai"),
      rec("2026-08-10", "google"),
      rec("2026-08-11", "anthropic"),
      rec("2026-08-11", "openai"),
      rec("2026-08-11", "google"),
      rec("2026-08-16", "openai"),
      rec("2026-08-16", "google"),
    ]);

    const records = readPanelProviderRecords(p, "geral");
    const latest = latestRoundProviders(records);
    assert.equal(latest?.date, "2026-08-16", "sanity: a rodada mais recente é 16/08");
    assert.deepEqual([...latest!.providers].sort(), ["google", "openai"], "sanity: anthropic não está na última rodada");

    const agg = computeMultiPanelMissingProviders(
      [{ panel: "geral", latestRoundProviders: latest!.providers }],
      ALL_PROVIDERS,
    );
    assert.equal(agg.hasMissing, true);
    assert.deepEqual(agg.panelsWithMissing, [{ panel: "geral", missingProviders: ["anthropic"] }]);

    const state = emptyGeoCitationStalenessAlarmState();
    assert.equal(shouldAlarmMissingProviders(state, agg, agg.fingerprint), true);

    const { subject, body } = buildMissingProviderAlarmEmail(agg.panelsWithMissing);
    assert.match(subject, /anthropic/);
    assert.match(body, /painel "geral": faltando anthropic/);
  });

  it("NÃO alarma quando todos os providers configurados aparecem normalmente na última rodada", () => {
    const p = historyWith([
      rec("2026-08-16", "anthropic"),
      rec("2026-08-16", "openai"),
      rec("2026-08-16", "google"),
    ]);
    const records = readPanelProviderRecords(p, "geral");
    const latest = latestRoundProviders(records);
    const agg = computeMultiPanelMissingProviders(
      [{ panel: "geral", latestRoundProviders: latest!.providers }],
      ALL_PROVIDERS,
    );
    assert.equal(agg.hasMissing, false);
    assert.deepEqual(agg.panelsWithMissing, []);

    const state = emptyGeoCitationStalenessAlarmState();
    assert.equal(shouldAlarmMissingProviders(state, agg, agg.fingerprint), false);
  });

  it("painel sem NENHUM registro conta como todos os providers ausentes", () => {
    const agg = computeMultiPanelMissingProviders([{ panel: "hubs", latestRoundProviders: [] }], ALL_PROVIDERS);
    assert.equal(agg.hasMissing, true);
    assert.deepEqual(agg.panelsWithMissing[0].missingProviders.sort(), ["anthropic", "google", "openai"]);
  });

  it("2 painéis: só o painel com ausência real entra no resultado (mesmo racional de #4900/#4961)", () => {
    const agg = computeMultiPanelMissingProviders(
      [
        { panel: "geral", latestRoundProviders: ["anthropic", "openai", "google"] },
        { panel: "hubs", latestRoundProviders: ["openai", "google"] },
      ],
      ALL_PROVIDERS,
    );
    assert.equal(agg.hasMissing, true);
    assert.deepEqual(agg.panelsWithMissing.map((p) => p.panel), ["hubs"]);
    assert.doesNotMatch(agg.fingerprint, /geral:/);
  });
});

describe("idempotência (#5316) — mesmo padrão de shouldAlarm/advanceState pra staleness", () => {
  it("não reenvia o mesmo alarme enquanto a mesma ausência persistir", () => {
    const agg = computeMultiPanelMissingProviders([{ panel: "geral", latestRoundProviders: ["openai", "google"] }], ALL_PROVIDERS);
    let state = advanceState(null, new Date("2026-08-16T10:30:00.000Z"), agg.fingerprint);
    assert.equal(shouldAlarmMissingProviders(state, agg, agg.fingerprint), false, "mesma ausência não reenvia");
  });

  it("re-arma quando o provider volta, e alarma de novo se sumir outra vez", () => {
    const missingFp = computeMultiPanelMissingProviders(
      [{ panel: "geral", latestRoundProviders: ["openai", "google"] }],
      ALL_PROVIDERS,
    ).fingerprint;
    let state: GeoCitationStalenessAlarmState = {
      lastAlarmedFingerprint: null,
      lastCheckedAt: "2026-08-16T10:30:00.000Z",
      lastAlarmedMissingProviderFingerprint: missingFp,
    };

    // Provider volta -> hasMissing false -> não alarma, e o caller (main())
    // avança o estado pra null (re-arma), mesmo padrão de advanceState pra
    // staleness.
    const healthy = computeMultiPanelMissingProviders(
      [{ panel: "geral", latestRoundProviders: ["anthropic", "openai", "google"] }],
      ALL_PROVIDERS,
    );
    assert.equal(shouldAlarmMissingProviders(state, healthy, healthy.fingerprint), false);
    state = advanceState(null, new Date("2026-08-23T10:30:00.000Z"), null);
    assert.equal(state.lastAlarmedMissingProviderFingerprint, null);

    // Some de novo -> deve alarmar de novo mesmo sendo a MESMA ausência de antes.
    const aggAgain = computeMultiPanelMissingProviders(
      [{ panel: "geral", latestRoundProviders: ["openai", "google"] }],
      ALL_PROVIDERS,
    );
    assert.equal(shouldAlarmMissingProviders(state, aggAgain, aggAgain.fingerprint), true);
  });
});
