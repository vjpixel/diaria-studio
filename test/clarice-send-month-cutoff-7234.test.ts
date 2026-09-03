/**
 * clarice-send-month-cutoff-7234.test.ts (#7234)
 *
 * Regressão do defeito: o **1º envio do mês** — o único que deveria RESETAR a
 * fila e voltar ao topo do score — era montado com o cutoff do mês ANTERIOR.
 *
 * Causa: `computeExpectedEnvioCycle` resolve o ciclo pela data de EXECUÇÃO,
 * `sendDateBrt` agenda pro dia SEGUINTE, e o cutoff de recência derivava do
 * CICLO (`cycleSendMonthStartIso`). Na virada do mês os dois discordam por
 * exatamente um dia, e é o dia que importa.
 *
 * O teste-âncora é `1º envio do mês reseta a fila`: sem o fix ele falha,
 * porque a rodada de 31/ago produz cutoff 2026-08-01 em vez de 2026-09-01.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeExpectedEnvioCycle } from "../scripts/lib/clarice-envio-cycle.ts";
import { cycleSendMonthStartIso, sendMonthStartIso } from "../scripts/lib/clarice-paths.ts";
import { sendDateBrt } from "../scripts/clarice-envio-run.ts";

/** 22:15Z ≈ 19:15 BRT do MESMO dia (BRT = UTC−3) — horário real das tasks diárias. */
function runAt(dayIso: string): Date {
  return new Date(`${dayIso}T22:15:00Z`);
}

describe("#7234 — cutoff do filtro de recência deriva da DATA DE ENVIO", () => {
  describe("sendMonthStartIso (helper novo)", () => {
    it("devolve o 1º instante do mês-calendário da data de envio", () => {
      assert.equal(sendMonthStartIso("2026-09-01"), "2026-09-01T00:00:00.000Z");
      assert.equal(sendMonthStartIso("2026-09-30"), "2026-09-01T00:00:00.000Z");
      assert.equal(sendMonthStartIso("2026-01-15"), "2026-01-01T00:00:00.000Z");
    });

    it("atravessa a virada de ANO sem escorregar de mês", () => {
      assert.equal(sendMonthStartIso("2027-01-01"), "2027-01-01T00:00:00.000Z");
      assert.equal(sendMonthStartIso("2026-12-31"), "2026-12-01T00:00:00.000Z");
    });

    it("rejeita entrada malformada em vez de adivinhar", () => {
      assert.throws(() => sendMonthStartIso("2026-9-1"), /data de envio inválida/);
      assert.throws(() => sendMonthStartIso("01/09/2026"), /data de envio inválida/);
      assert.throws(() => sendMonthStartIso(""), /data de envio inválida/);
      assert.throws(() => sendMonthStartIso("2026-13-01"), /fora de faixa/);
    });
  });

  describe("o 1º envio do mês reseta a fila (âncora da regressão)", () => {
    it("rodada de 31/ago agenda pra 1º/set e usa o cutoff de SETEMBRO", () => {
      const now = runAt("2026-08-31");
      const sendDate = sendDateBrt(now);

      assert.equal(sendDate, "2026-09-01", "a rodada de 31/ago agenda pro dia 1º");

      // O comportamento CORRETO (pós-#7234): cutoff do mês do ENVIO.
      assert.equal(
        sendMonthStartIso(sendDate),
        "2026-09-01T00:00:00.000Z",
        "o envio que cai no dia 1º precisa resetar a fila do mês",
      );

      // E o comportamento ANTIGO, aqui congelado como documentação do bug:
      // derivar do ciclo devolvia AGOSTO pro mesmo envio.
      const cycle = computeExpectedEnvioCycle(now);
      assert.equal(cycle, "2607-08");
      assert.equal(cycleSendMonthStartIso(cycle), "2026-08-01T00:00:00.000Z");
      assert.notEqual(
        cycleSendMonthStartIso(cycle),
        sendMonthStartIso(sendDate),
        "é exatamente nesta divergência que o 1º envio do mês deixava de resetar",
      );
    });

    it("nos demais dias do mês os dois cutoffs concordam (o fix não muda nada fora da virada)", () => {
      for (const day of ["2026-09-01", "2026-09-02", "2026-09-15", "2026-09-29"]) {
        const now = runAt(day);
        const cycle = computeExpectedEnvioCycle(now);
        assert.equal(
          sendMonthStartIso(sendDateBrt(now)),
          cycleSendMonthStartIso(cycle),
          `${day}: fora da virada, cutoff por envio e por ciclo têm que bater`,
        );
      }
    });

    it("vale também na virada de DEZEMBRO→JANEIRO (rollover de ano)", () => {
      const now = runAt("2026-12-31");
      const sendDate = sendDateBrt(now);
      assert.equal(sendDate, "2027-01-01");
      assert.equal(sendMonthStartIso(sendDate), "2027-01-01T00:00:00.000Z");

      const cycle = computeExpectedEnvioCycle(now);
      assert.equal(cycle, "2611-12");
      assert.equal(cycleSendMonthStartIso(cycle), "2026-12-01T00:00:00.000Z");
    });
  });
});
