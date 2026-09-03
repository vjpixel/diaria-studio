/**
 * test/acquisition-store-deps.test.ts (#7295)
 *
 * Regressão do defeito central da #7295: `getStoreCounts()` roda em
 * produção e calcula `subscriptions_coverage_low`, mas nada alimentava
 * `AcquisitionMetricDeps.subscriptionCoverageLow` com esse sinal — o único
 * destino era um `console.warn`. Este teste prova a LIGAÇÃO fim-a-fim contra
 * um store SQLite real (`:memory:`, mesmo padrão de
 * `test/diaria-subscribers-db.test.ts`): baixa cobertura de `subscription`
 * → `aggregateAcquisition()` (via `cadastros-dia.computar`) devolve
 * `indeterminado`, NUNCA `0` fabricado — não só a lógica pura já coberta em
 * `test/metrics-registry.test.ts`, mas o CAMINHO real que o #7295 encontrou
 * ausente: `getStoreCounts` → `resolveSubscriptionCoverage` →
 * `AcquisitionMetricDeps` → `MetricDef.computar`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  upsertSubscription,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  resolveSubscriptionCoverage,
  registrosFromStore,
  buildAcquisitionDepsFromStore,
  brtDayKey,
} from "../scripts/lib/metrics/acquisition-store-deps.ts";
import { getMetric, type Janela } from "../scripts/lib/metrics/registry.ts";
import type { CapturaLogEntry } from "../scripts/lib/metrics/captura-log.ts";

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function capturaEm(dia: string): CapturaLogEntry {
  return {
    captura_id: `kit-${dia}T09:00:00.000Z`,
    captured_at: `${dia}T09:00:00.000Z`,
    total_retornado_api: 1,
    novos_gravados: 1,
    eventos_estado: 0,
    exit: 0,
  };
}

describe("resolveSubscriptionCoverage (#7295)", () => {
  it("store vazio (sem subscriber nenhum): subscriptionCoverageLow false — nada pra avaliar", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = resolveSubscriptionCoverage(db);
    assert.equal(result.subscriptionCoverageLow, false);
  });

  it("subscribers sem NENHUMA subscription: coverage 0%, subscriptionCoverageLow true com motivo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // 3 subscribers, 0 com subscription — abaixo de SUBSCRIPTION_COVERAGE_WARN_FRACTION (0.5).
    ensureSubscriber(db, "beehiiv", "ext-1", "a@example.com");
    ensureSubscriber(db, "beehiiv", "ext-2", "b@example.com");
    ensureSubscriber(db, "beehiiv", "ext-3", "c@example.com");

    const result = resolveSubscriptionCoverage(db);
    assert.equal(result.subscriptionCoverageLow, true);
    assert.ok(result.subscriptionCoverageMotivo && result.subscriptionCoverageMotivo.length > 0);
  });

  it("cobertura acima do piso: subscriptionCoverageLow false", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id1 = ensureSubscriber(db, "beehiiv", "ext-1", "a@example.com");
    const id2 = ensureSubscriber(db, "beehiiv", "ext-2", "b@example.com");
    upsertSubscription(db, id1, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });
    upsertSubscription(db, id2, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });
    const result = resolveSubscriptionCoverage(db);
    assert.equal(result.subscriptionCoverageLow, false);
  });
});

describe("aggregateAcquisition via store real (#7295) — a ligação fim-a-fim", () => {
  it("cobertura baixa: cadastros-dia.computar() devolve indeterminado, NUNCA 0 — mesmo com cadastros reais gravados", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id1 = ensureSubscriber(db, "beehiiv", "ext-1", "a@example.com");
    // 1 subscription para 3 subscribers => coverage 33%, abaixo do piso de 50%.
    ensureSubscriber(db, "beehiiv", "ext-2", "b@example.com");
    ensureSubscriber(db, "beehiiv", "ext-3", "c@example.com");
    upsertSubscription(db, id1, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });

    const deps = buildAcquisitionDepsFromStore(db, [capturaEm("2026-08-26")]);
    assert.equal(deps.subscriptionCoverageLow, true);

    const def = getMetric("cadastros-dia")!;
    const resultado = await def.computar({ janela: janelaDia("2026-08-26"), deps });

    assert.equal(resultado.valor, null);
    assert.equal(resultado.qualidade, "indeterminado");
    assert.ok(resultado.motivo && resultado.motivo.length > 0);
  });

  it("cobertura alta: cadastros-dia.computar() calcula de verdade a partir do store (exato)", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id1 = ensureSubscriber(db, "beehiiv", "ext-1", "a@example.com");
    const id2 = ensureSubscriber(db, "beehiiv", "ext-2", "b@example.com");
    upsertSubscription(db, id1, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });
    upsertSubscription(db, id2, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-27T12:00:00Z", // fora da janela pedida
      exitedAt: null,
      source: "seo",
    });

    const deps = buildAcquisitionDepsFromStore(db, [capturaEm("2026-08-26")]);
    assert.equal(deps.subscriptionCoverageLow, false);

    const def = getMetric("cadastros-dia")!;
    const resultado = await def.computar({ janela: janelaDia("2026-08-26"), deps });

    assert.equal(resultado.qualidade, "exato");
    assert.equal(resultado.valor, 1);
  });
});

describe("registrosFromStore — filtro de janela BRT (#7295)", () => {
  it("ignora subscription sem entered_at, sem email, e fora da janela", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const idOk = ensureSubscriber(db, "beehiiv", "ext-1", "a@example.com");
    const idNoEnteredAt = ensureSubscriber(db, "beehiiv", "ext-2", "b@example.com");
    const idNoEmail = ensureSubscriber(db, "beehiiv", "ext-3", null);
    const idOutOfWindow = ensureSubscriber(db, "kit", "ext-4", "d@example.com");

    upsertSubscription(db, idOk, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });
    upsertSubscription(db, idNoEnteredAt, "beehiiv", {
      status: "active",
      enteredAt: null,
      exitedAt: null,
      source: "seo",
    });
    upsertSubscription(db, idNoEmail, "beehiiv", {
      status: "active",
      enteredAt: "2026-08-26T12:00:00Z",
      exitedAt: null,
      source: "seo",
    });
    upsertSubscription(db, idOutOfWindow, "kit", {
      status: "active",
      enteredAt: "2026-08-25T12:00:00Z", // fora da janela
      exitedAt: null,
      source: "seo",
    });

    const registros = registrosFromStore(db, janelaDia("2026-08-26"));
    assert.equal(registros.length, 1);
    assert.equal(registros[0].email, "a@example.com");
    assert.equal(registros[0].dia, "2026-08-26");
  });
});

describe("brtDayKey (#7295) — sanity da conversão local", () => {
  it("21h UTC de 26/08 ainda é 26/08 em BRT (UTC-3)", () => {
    assert.equal(brtDayKey("2026-08-26T21:00:00Z"), "2026-08-26");
  });

  it("meia-noite UTC de 27/08 ainda é 26/08 em BRT", () => {
    assert.equal(brtDayKey("2026-08-27T02:00:00Z"), "2026-08-26");
  });

  it("null/undefined/inválido devolvem null", () => {
    assert.equal(brtDayKey(null), null);
    assert.equal(brtDayKey(undefined), null);
    assert.equal(brtDayKey("not-a-date"), null);
  });
});
