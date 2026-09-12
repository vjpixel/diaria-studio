/**
 * test/acquisition-cohort.test.ts (#7916, fatia 2/N)
 *
 * Cobre `scripts/lib/metrics/acquisition-cohort.ts`: agrupamento por dia
 * BRT × classe de aquisição × utm_source, e a regra central da issue —
 * confirmado/pendente (Kit) nunca vira `0` fabricado quando a distinção não
 * é observável (Beehiiv/Brevo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAcquisitionCohortTable,
  isoToBrtDay,
  type CohortSubscriberInput,
  type KitSubscriptionStatus,
} from "../scripts/lib/metrics/acquisition-cohort.ts";

describe("isoToBrtDay", () => {
  it("madrugada BRT não vaza pro dia UTC seguinte", () => {
    // 2026-09-01T02:00:00Z = 2026-08-31T23:00:00 BRT (UTC-3) — ainda dia 31.
    assert.equal(isoToBrtDay("2026-09-01T02:00:00.000Z"), "2026-08-31");
  });

  it("meio-dia UTC cai no mesmo dia BRT", () => {
    assert.equal(isoToBrtDay("2026-09-01T15:00:00.000Z"), "2026-09-01");
  });
});

describe("buildAcquisitionCohortTable — agrupamento básico", () => {
  it("agrupa por (dia, classe, utm_source) e soma total", () => {
    const subs: CohortSubscriberInput[] = [
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: "newsletter-organica",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
      {
        enteredAt: "2026-09-01T16:00:00.000Z",
        utmSource: "newsletter-organica",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
      {
        enteredAt: "2026-09-02T15:00:00.000Z",
        utmSource: "newsletter-organica",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows.length, 2);
    const day1 = rows.find((r) => r.day === "2026-09-01");
    assert.ok(day1);
    assert.equal(day1?.total, 2);
    const day2 = rows.find((r) => r.day === "2026-09-02");
    assert.equal(day2?.total, 1);
  });

  it("ordena por dia ascendente, depois total descendente dentro do dia", () => {
    const mk = (day: string, utmSource: string): CohortSubscriberInput => ({
      enteredAt: `${day}T15:00:00.000Z`,
      utmSource,
      utmMedium: null,
      utmChannel: null,
      referringSite: null,
      kitStatus: null,
    });
    const subs: CohortSubscriberInput[] = [
      mk("2026-09-02", "a"),
      mk("2026-09-01", "b"),
      mk("2026-09-01", "b"),
      mk("2026-09-01", "c"),
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.deepEqual(
      rows.map((r) => [r.day, r.utmSource, r.total]),
      [
        ["2026-09-01", "b", 2],
        ["2026-09-01", "c", 1],
        ["2026-09-02", "a", 1],
      ],
    );
  });

  it("utm_source nulo forma seu próprio grupo, nunca se funde com um grupo nomeado", () => {
    const subs: CohortSubscriberInput[] = [
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: null,
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: "x",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.utmSource === null && r.total === 1));
    assert.ok(rows.some((r) => r.utmSource === "x" && r.total === 1));
  });
});

describe("buildAcquisitionCohortTable — confirmado/pendente Kit nunca fabricado", () => {
  it("grupo sem NENHUM membro com kitStatus: confirmedKit/unconfirmedKit são null, nunca 0", () => {
    const subs: CohortSubscriberInput[] = [
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: "beehiiv-organico",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].confirmedKit, null);
    assert.equal(rows[0].unconfirmedKit, null);
  });

  it("grupo com sinal Kit: conta active como confirmado, inactive como pendente", () => {
    const mk = (kitStatus: KitSubscriptionStatus | null): CohortSubscriberInput => ({
      enteredAt: "2026-09-01T15:00:00.000Z",
      utmSource: "kit-organico",
      utmMedium: null,
      utmChannel: null,
      referringSite: null,
      kitStatus,
    });
    const subs: CohortSubscriberInput[] = [mk("active"), mk("active"), mk("inactive")];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 3);
    assert.equal(rows[0].confirmedKit, 2);
    assert.equal(rows[0].unconfirmedKit, 1);
  });

  it("kitStatus fora de active/inactive (cancelled, bounced) conta no total mas não em confirmado/pendente", () => {
    const subs: CohortSubscriberInput[] = [
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: "kit-organico",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: "cancelled",
      },
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows[0].total, 1);
    // hasKitSignal é true (kitStatus não-nulo) — os contadores deixam de
    // ser null, mas nem active nem inactive bateram, então ficam 0 (0 real,
    // não fabricado: sabemos que a distinção É observável aqui, e o valor
    // observado não é nenhum dos dois estados contados).
    assert.equal(rows[0].confirmedKit, 0);
    assert.equal(rows[0].unconfirmedKit, 0);
  });

  it("bucket misto (1 membro com sinal Kit + 1 sem) — total conta os 2, confirmado/pendente refletem só quem tem sinal (achado do pr-test-analyzer)", () => {
    // Mesmo dia/classe/utm_source: 1 pessoa só na Beehiiv (kitStatus null) +
    // 1 pessoa também no Kit, ativa. O denominador de total NUNCA é "quantos
    // têm sinal Kit" — é "quantos cadastros neste grupo", plataforma à
    // parte. confirmedKit/unconfirmedKit contam só quem TEM o sinal
    // observável, então total > confirmedKit + unconfirmedKit é esperado e
    // correto aqui, não um bug de soma.
    const subs: CohortSubscriberInput[] = [
      {
        enteredAt: "2026-09-01T15:00:00.000Z",
        utmSource: "kit-organico",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: null,
      },
      {
        enteredAt: "2026-09-01T16:00:00.000Z",
        utmSource: "kit-organico",
        utmMedium: null,
        utmChannel: null,
        referringSite: null,
        kitStatus: "active",
      },
    ];
    const rows = buildAcquisitionCohortTable(subs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 2);
    assert.equal(rows[0].confirmedKit, 1);
    assert.equal(rows[0].unconfirmedKit, 0);
  });
});
