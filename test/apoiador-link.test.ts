/**
 * test/apoiador-link.test.ts (#7916, fatia 5/N)
 *
 * Cobre `scripts/lib/metrics/apoiador-link.ts`: vínculo assinante↔apoiador
 * por e-mail, tempo até 1º apoio (com o caso de antecedência negativa
 * tratado separado, nunca descartado), e receita mensal confirmada por
 * coorte (nunca fabrica `0` pra apoiador sem valor observável este mês).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApoiadorCohortTable,
  buildApoiadorEmailIndex,
  daysBetweenIso,
  linkSubscriberToApoiador,
  type CohortApoiadorInput,
  type LinkableApoiador,
} from "../scripts/lib/metrics/apoiador-link.ts";

describe("daysBetweenIso", () => {
  it("positivo quando 'to' é depois de 'from'", () => {
    assert.equal(daysBetweenIso("2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z"), 3);
  });

  it("negativo quando 'to' é antes de 'from'", () => {
    assert.equal(daysBetweenIso("2026-01-04T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), -3);
  });

  it("NaN quando qualquer data é inválida — nunca lança", () => {
    assert.ok(Number.isNaN(daysBetweenIso("not-a-date", "2026-01-01T00:00:00.000Z")));
    assert.ok(Number.isNaN(daysBetweenIso("2026-01-01T00:00:00.000Z", "")));
  });
});

describe("buildApoiadorEmailIndex / linkSubscriberToApoiador", () => {
  const apoiadorA: LinkableApoiador = {
    emails: ["Maria@Example.com", "maria.alt@example.com"],
    firstConfirmedAt: "2026-01-10T00:00:00.000Z",
    currentMonthlyValue: 25,
  };
  const apoiadorB: LinkableApoiador = {
    emails: ["joao@example.com"],
    firstConfirmedAt: "2026-02-01T00:00:00.000Z",
    currentMonthlyValue: null,
  };

  it("casa por e-mail normalizado (trim + lowercase), qualquer um dos e-mails do apoiador", () => {
    const index = buildApoiadorEmailIndex([apoiadorA, apoiadorB]);
    assert.equal(linkSubscriberToApoiador(["  MARIA@EXAMPLE.COM  "], index), apoiadorA);
    assert.equal(linkSubscriberToApoiador(["maria.alt@example.com"], index), apoiadorA);
    assert.equal(linkSubscriberToApoiador(["joao@example.com"], index), apoiadorB);
  });

  it("nenhum e-mail do subscriber bate -> null (nunca inventa vínculo)", () => {
    const index = buildApoiadorEmailIndex([apoiadorA]);
    assert.equal(linkSubscriberToApoiador(["outra-pessoa@example.com"], index), null);
  });

  it("subscriber com vários aliases: qualquer um casando já vincula", () => {
    const index = buildApoiadorEmailIndex([apoiadorA]);
    assert.equal(
      linkSubscriberToApoiador(["nao-bate@example.com", "maria@example.com"], index),
      apoiadorA,
    );
  });

  it("colisão de e-mail entre 2 apoiadores: o primeiro da lista vence, sem lançar", () => {
    const dup: LinkableApoiador = {
      emails: ["maria@example.com"],
      firstConfirmedAt: "2026-03-01T00:00:00.000Z",
      currentMonthlyValue: 50,
    };
    const index = buildApoiadorEmailIndex([apoiadorA, dup]);
    assert.equal(linkSubscriberToApoiador(["maria@example.com"], index), apoiadorA);
  });
});

describe("buildApoiadorCohortTable", () => {
  const base: Omit<CohortApoiadorInput, "apoiador"> = {
    enteredAt: "2026-09-01T15:00:00.000Z",
    utmSource: "newsletter-organica",
    utmMedium: null,
    utmChannel: null,
    referringSite: null,
  };

  it("subscriber sem vínculo: apoiadores=0, revenue=0, avg=null, nunca lança", () => {
    const rows = buildApoiadorCohortTable([{ ...base, apoiador: null }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalSubscribers, 1);
    assert.equal(rows[0].apoiadores, 0);
    assert.equal(rows[0].confirmedMonthlyRevenue, 0);
    assert.equal(rows[0].avgDaysToFirstSupport, null);
    assert.equal(rows[0].apoiadoresSemValorMensalConhecido, 0);
    assert.equal(rows[0].apoiadoresComApoioAnteriorAoCadastro, 0);
  });

  it("apoiador que confirmou apoio DEPOIS de assinar: entra na média, dias positivos", () => {
    const subs: CohortApoiadorInput[] = [
      {
        ...base,
        apoiador: {
          emails: ["a@example.com"],
          firstConfirmedAt: "2026-09-11T15:00:00.000Z", // +10 dias
          currentMonthlyValue: 20,
        },
      },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows[0].apoiadores, 1);
    assert.equal(rows[0].avgDaysToFirstSupport, 10);
    assert.equal(rows[0].confirmedMonthlyRevenue, 20);
    assert.equal(rows[0].apoiadoresComApoioAnteriorAoCadastro, 0);
  });

  it("apoiador que já apoiava ANTES de assinar: conta em apoiadoresComApoioAnteriorAoCadastro, exclui da média (nunca descarta)", () => {
    const subs: CohortApoiadorInput[] = [
      {
        ...base,
        apoiador: {
          emails: ["b@example.com"],
          firstConfirmedAt: "2026-08-20T15:00:00.000Z", // antes do enteredAt
          currentMonthlyValue: 10,
        },
      },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows[0].apoiadores, 1);
    assert.equal(rows[0].apoiadoresComApoioAnteriorAoCadastro, 1);
    assert.equal(rows[0].avgDaysToFirstSupport, null);
    // revenue continua contando — é receita real, independente da ordem cadastro/apoio.
    assert.equal(rows[0].confirmedMonthlyRevenue, 10);
  });

  it("apoiador sem currentMonthlyValue observável: NUNCA soma como 0, conta em apoiadoresSemValorMensalConhecido", () => {
    const subs: CohortApoiadorInput[] = [
      {
        ...base,
        apoiador: {
          emails: ["c@example.com"],
          firstConfirmedAt: "2026-09-05T15:00:00.000Z",
          currentMonthlyValue: null,
        },
      },
      {
        ...base,
        apoiador: {
          emails: ["d@example.com"],
          firstConfirmedAt: "2026-09-05T15:00:00.000Z",
          currentMonthlyValue: 30,
        },
      },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows[0].apoiadores, 2);
    assert.equal(rows[0].apoiadoresSemValorMensalConhecido, 1);
    // soma só o valor conhecido (30), o null nunca vira 0 somado.
    assert.equal(rows[0].confirmedMonthlyRevenue, 30);
  });

  it("média é só sobre os casos válidos — mistura de apoiador com data válida e outro sem apoiador", () => {
    const subs: CohortApoiadorInput[] = [
      { ...base, apoiador: null },
      {
        ...base,
        apoiador: {
          emails: ["e@example.com"],
          firstConfirmedAt: "2026-09-06T15:00:00.000Z", // +5 dias
          currentMonthlyValue: 15,
        },
      },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows[0].totalSubscribers, 2);
    assert.equal(rows[0].apoiadores, 1);
    assert.equal(rows[0].avgDaysToFirstSupport, 5);
  });

  it("agrupa por (dia, classe, utm_source) igual a buildAcquisitionCohortTable", () => {
    const subs: CohortApoiadorInput[] = [
      { ...base, apoiador: null },
      { ...base, enteredAt: "2026-09-02T15:00:00.000Z", apoiador: null },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].day, "2026-09-01");
    assert.equal(rows[1].day, "2026-09-02");
  });

  it("enteredAt inválido é excluído e contado em subscribersWithInvalidEnteredAt, nunca lança", () => {
    const subs: CohortApoiadorInput[] = [
      { ...base, enteredAt: "not-a-date", apoiador: null },
      { ...base, apoiador: null },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows.subscribersWithInvalidEnteredAt, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalSubscribers, 1);
  });

  it("apoiador com firstConfirmedAt inválido: não lança, não conta na média nem em antecedência negativa, mas conta em apoiadores/revenue", () => {
    const subs: CohortApoiadorInput[] = [
      {
        ...base,
        apoiador: {
          emails: ["f@example.com"],
          firstConfirmedAt: "not-a-date",
          currentMonthlyValue: 12,
        },
      },
    ];
    const rows = buildApoiadorCohortTable(subs);
    assert.equal(rows[0].apoiadores, 1);
    assert.equal(rows[0].apoiadoresComApoioAnteriorAoCadastro, 0);
    assert.equal(rows[0].avgDaysToFirstSupport, null);
    assert.equal(rows[0].confirmedMonthlyRevenue, 12);
  });
});
