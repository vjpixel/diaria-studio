/**
 * test/weekly-linkedin-cycle.test.ts (#4456)
 *
 * Resolução de ciclo/janela da newsletter semanal do LinkedIn:
 *   - ISO week label ({YY}w{WW}), incluindo virada de ano (semana 1 de um
 *     ano pode conter dias de dezembro do ano anterior).
 *   - Janela de conteúdo (segunda a sexta) derivada da segunda de
 *     PUBLICAÇÃO — sempre a semana ANTERIOR.
 *   - Ciclo é derivado da semana de CONTEÚDO, não da semana de publicação.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isoWeekInfo,
  isoWeekLabel,
  formatWeeklyCycle,
  isValidWeeklyCycle,
  parseAAMMDD,
  contentWindowFromPublishMonday,
  cycleFromContentMonday,
  resolveWeeklyLinkedinCycle,
  weeklyLinkedinRelDir,
  parsePublishMondayArg,
  nextMondayAAMMDD,
} from "../scripts/lib/weekly-linkedin-cycle.ts";

describe("isoWeekInfo / isoWeekLabel", () => {
  it("segunda-feira 2026-07-27 é semana ISO 31 de 2026", () => {
    assert.deepEqual(isoWeekInfo(new Date(2026, 6, 27)), { isoYear: 2026, week: 31 });
    assert.equal(isoWeekLabel(new Date(2026, 6, 27)), "26w31");
  });

  it("sexta-feira 2026-07-31 fica na mesma semana ISO que a segunda 27/07", () => {
    assert.deepEqual(isoWeekInfo(new Date(2026, 6, 31)), { isoYear: 2026, week: 31 });
  });

  it("segunda-feira 2026-08-03 é semana ISO 32 (a seguinte)", () => {
    assert.deepEqual(isoWeekInfo(new Date(2026, 7, 3)), { isoYear: 2026, week: 32 });
  });

  it("virada de ano: 2025-12-29 (segunda) já é semana ISO 1 de 2026", () => {
    assert.deepEqual(isoWeekInfo(new Date(2025, 11, 29)), { isoYear: 2026, week: 1 });
    assert.equal(isoWeekLabel(new Date(2025, 11, 29)), "26w01");
  });

  it("2020-12-31 é semana ISO 53 de 2020 (ano com 53 semanas ISO)", () => {
    assert.deepEqual(isoWeekInfo(new Date(2020, 11, 31)), { isoYear: 2020, week: 53 });
  });

  it("formatWeeklyCycle preenche zero à esquerda na semana", () => {
    assert.equal(formatWeeklyCycle({ isoYear: 2026, week: 1 }), "26w01");
    assert.equal(formatWeeklyCycle({ isoYear: 2026, week: 31 }), "26w31");
  });
});

describe("isValidWeeklyCycle", () => {
  it("aceita {YY}w{WW} bem formado", () => {
    assert.ok(isValidWeeklyCycle("26w31"));
    assert.ok(isValidWeeklyCycle("26w01"));
    assert.ok(isValidWeeklyCycle("26W31")); // case-insensitive
  });

  it("rejeita formato ausente, vazio ou fora do padrão", () => {
    assert.ok(!isValidWeeklyCycle(undefined));
    assert.ok(!isValidWeeklyCycle(""));
    assert.ok(!isValidWeeklyCycle("2631"));
    assert.ok(!isValidWeeklyCycle("26-31"));
    assert.ok(!isValidWeeklyCycle("26w00"));
    assert.ok(!isValidWeeklyCycle("26w54"));
  });
});

describe("parseAAMMDD", () => {
  it("parseia AAMMDD válido", () => {
    const d = parseAAMMDD("260727");
    assert.ok(d);
    assert.equal(d!.getFullYear(), 2026);
    assert.equal(d!.getMonth(), 6);
    assert.equal(d!.getDate(), 27);
  });

  it("rejeita data inexistente (31 de fevereiro) em vez de rolar silenciosamente", () => {
    assert.equal(parseAAMMDD("260231"), null);
  });

  it("rejeita formato malformado", () => {
    assert.equal(parseAAMMDD("2607"), null);
    assert.equal(parseAAMMDD("abcdef"), null);
  });
});

describe("contentWindowFromPublishMonday", () => {
  it("segunda de publicação 260803 (agosto) cobre a semana 27-31/jul", () => {
    const dates = contentWindowFromPublishMonday(new Date(2026, 7, 3));
    assert.deepEqual(dates, ["260727", "260728", "260729", "260730", "260731"]);
  });

  it("cruza virada de mês/ano corretamente (segunda 2026-01-05 cobre 29/dez-02/jan)", () => {
    const dates = contentWindowFromPublishMonday(new Date(2026, 0, 5));
    assert.deepEqual(dates, ["251229", "251230", "251231", "260101", "260102"]);
  });
});

describe("resolveWeeklyLinkedinCycle", () => {
  it("edição #1 (comentário 260802 5º do #4456): publish-monday 260803 → ciclo da semana de CONTEÚDO (26w31, não 26w32)", () => {
    const r = resolveWeeklyLinkedinCycle("260803");
    assert.ok(r);
    assert.equal(r!.cycle, "26w31");
    assert.equal(r!.publishMonday, "260803");
    assert.deepEqual(r!.contentWindow, ["260727", "260728", "260729", "260730", "260731"]);
  });

  it("retorna null para publish-monday inválido", () => {
    assert.equal(resolveWeeklyLinkedinCycle("nao-e-data"), null);
    assert.equal(resolveWeeklyLinkedinCycle(""), null);
  });

  it("cycleFromContentMonday é consistente com resolveWeeklyLinkedinCycle", () => {
    const contentMonday = parseAAMMDD("260727")!;
    assert.equal(cycleFromContentMonday(contentMonday), resolveWeeklyLinkedinCycle("260803")!.cycle);
  });
});

describe("weeklyLinkedinRelDir", () => {
  it("monta o path relativo data/weekly/{cycle}", () => {
    assert.equal(weeklyLinkedinRelDir("26w31"), "data/weekly/26w31");
  });
});

describe("parsePublishMondayArg", () => {
  it("extrai --publish-monday AAMMDD", () => {
    assert.equal(parsePublishMondayArg(["--publish-monday", "260803"]), "260803");
  });

  it("extrai --publish-monday=AAMMDD", () => {
    assert.equal(parsePublishMondayArg(["--publish-monday=260803"]), "260803");
  });

  it("retorna string vazia quando ausente (nunca lança)", () => {
    assert.equal(parsePublishMondayArg([]), "");
  });
});

describe("nextMondayAAMMDD (#5321 — default de --publish-monday quando omitido)", () => {
  it("de uma quinta-feira, resolve pra segunda seguinte", () => {
    // 2026-08-13 é quinta-feira.
    assert.equal(nextMondayAAMMDD(new Date(2026, 7, 13)), "260817");
  });

  it("de um domingo, resolve pra segunda do dia seguinte", () => {
    // 2026-08-16 é domingo.
    assert.equal(nextMondayAAMMDD(new Date(2026, 7, 16)), "260817");
  });

  it("se já for segunda, resolve pra ela mesma (inclusivo)", () => {
    // 2026-08-17 é segunda-feira.
    assert.equal(nextMondayAAMMDD(new Date(2026, 7, 17)), "260817");
  });

  it("atravessa virada de mês/ano corretamente", () => {
    // 2025-12-31 é quarta-feira → próxima segunda é 2026-01-05.
    assert.equal(nextMondayAAMMDD(new Date(2025, 11, 31)), "260105");
  });
});
