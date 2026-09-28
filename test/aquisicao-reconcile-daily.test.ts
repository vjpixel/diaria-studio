/**
 * test/aquisicao-reconcile-daily.test.ts (#8591)
 *
 * Cobre a única função PURA de scripts/aquisicao-reconcile-daily.ts —
 * `defaultProcessingDay` (dia BRT anterior ao instante de execução). O
 * resto do script é I/O (fetch de assinantes + leitura/escrita de arquivo)
 * já coberto indiretamente pelas funções que ele reusa de
 * `aquisicao-reconcile.ts` (test/aquisicao-reconcile.test.ts) — este
 * arquivo não duplica essa cobertura, só a composição nova.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultProcessingDay } from "../scripts/aquisicao-reconcile-daily.ts";

describe("defaultProcessingDay", () => {
  it("dia BRT anterior a um instante bem depois da meia-noite BRT", () => {
    // 2026-09-28T13:00:00Z = 2026-09-28T10:00:00 BRT → dia anterior 09-27
    assert.equal(defaultProcessingDay(new Date("2026-09-28T13:00:00Z")), "2026-09-27");
  });

  it("não escorrega pela borda UTC — pouco depois da virada BRT ainda conta o dia novo como 'ontem' correto", () => {
    // 2026-09-28T03:01:00Z = 2026-09-28T00:01:00 BRT → dia anterior 09-27
    assert.equal(defaultProcessingDay(new Date("2026-09-28T03:01:00Z")), "2026-09-27");
  });

  it("pouco antes da virada BRT ainda pertence ao dia anterior em BRT — 'ontem' cai 2 dias atrás em UTC", () => {
    // 2026-09-28T02:59:00Z = 2026-09-27T23:59:00 BRT → dia anterior 09-26
    assert.equal(defaultProcessingDay(new Date("2026-09-28T02:59:00Z")), "2026-09-26");
  });
});
