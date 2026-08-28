/**
 * test/clarice-hour-test-5140.test.ts (#5140)
 *
 * Cobre a máquina do teste de HORÁRIO da onda `ramp-warm`: estado durável,
 * rótulo/parse da célula, conversão BRT→UTC, split estratificado e o naming
 * de lista que separa horário de assunto.
 *
 * O fio condutor de quase todo caso aqui: os valores viram `scheduledAt` e
 * nome de lista de campanha Brevo REAL. Erro nesta camada não aparece em
 * runtime — aparece depois do disparo, quando já não tem volta.
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brtHourToUtcHourSameDay,
  hourCellLabel,
  parseHourCell,
  scheduledAtForDate,
  waveKey,
} from "../scripts/lib/clarice-wave-plan.ts";
import { buildHourCells, checkSingleStrategyAgainstHourTest, checkKeyAgainstHourTest } from "../scripts/lib/clarice-group-cells.ts";
import { groupCellListNameFor, isGroupCellWave } from "../scripts/clarice-import-waves.ts";
import {
  closeClariceHourTest,
  clariceHourTestStatePath,
  invalidHourTestDaysPath,
  markInvalidHourTestDay,
  normalizeHours,
  readClariceHourTestState,
  readInvalidHourTestDays,
  startClariceHourTest,
  toHourTestKvState, // #5189
} from "../scripts/lib/clarice-hour-test.ts";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "hour-test-"));
  mkdirSync(join(root, "data"), { recursive: true });
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("rótulo e parse da célula de horário", () => {
  it("hourCellLabel zero-padda a hora BRT", () => {
    assert.equal(hourCellLabel(6), "H06");
    assert.equal(hourCellLabel(10), "H10");
    assert.equal(hourCellLabel(0), "H00");
  });

  it("hourCellLabel rejeita hora fora de 0–23", () => {
    assert.throws(() => hourCellLabel(24), /hora BRT inválida/);
    assert.throws(() => hourCellLabel(-1), /hora BRT inválida/);
    assert.throws(() => hourCellLabel(6.5), /hora BRT inválida/);
  });

  it("parseHourCell é o inverso, e devolve null pra célula de ASSUNTO", () => {
    assert.equal(parseHourCell("H06"), 6);
    assert.equal(parseHourCell("H00"), 0);
    // A separação entre as duas dimensões depende disto: 'A' nunca pode
    // atravessar como célula de horário, nem 'H06' como célula de assunto.
    assert.equal(parseHourCell("A"), null);
    assert.equal(parseHourCell("H6"), null);
    assert.equal(parseHourCell("H99"), null);
  });
});

describe("brtHourToUtcHourSameDay", () => {
  it("converte com offset fixo de +3", () => {
    assert.equal(brtHourToUtcHourSameDay(6), 9);
    assert.equal(brtHourToUtcHourSameDay(10), 13);
    assert.equal(brtHourToUtcHourSameDay(0), 3);
    assert.equal(brtHourToUtcHourSameDay(20), 23);
  });

  it("REGRESSÃO: 21:00+ BRT LANÇA — `(h+3)%24` agendaria 24h antes do pretendido", () => {
    // O bug que este guard existe pra impedir: 22:00 BRT com módulo vira
    // 01:00 UTC do MESMO sendDate, que é 22:00 BRT do dia ANTERIOR. Campanha
    // real disparada um dia antes, descoberto só depois do envio.
    assert.throws(() => brtHourToUtcHourSameDay(21), /dia seguinte em UTC/);
    assert.throws(() => brtHourToUtcHourSameDay(23), /dia seguinte em UTC/);
  });

  it("o par com scheduledAtForDate produz o horário BRT pedido, no dia certo", () => {
    assert.equal(
      scheduledAtForDate("2026-08-13", brtHourToUtcHourSameDay(6)),
      "2026-08-13T09:00:00.000Z",
    );
    assert.equal(
      scheduledAtForDate("2026-08-13", brtHourToUtcHourSameDay(10)),
      "2026-08-13T13:00:00.000Z",
    );
  });
});

describe("waveKey com célula de horário", () => {
  it("sufixa a célula de horário", () => {
    assert.equal(waveKey(13, "2026-08-13", "H06"), "d13-qui13-H06");
    assert.equal(waveKey(13, "2026-08-13", "H10"), "d13-qui13-H10");
  });

  it("continua aceitando célula de assunto e sem célula", () => {
    assert.equal(waveKey(13, "2026-08-13", "A"), "d13-qui13-A");
    assert.equal(waveKey(13, "2026-08-13"), "d13-qui13");
  });

  it("REGRESSÃO: sufixo desconhecido LANÇA — senão colapsaria duas células numa lista", () => {
    // Sem validação, um sufixo tipo "-X" passaria por `isGroupCellWave` como
    // "sem célula", `resolveListName` daria o mesmo nome aos dois braços e o
    // teste sairia com as duas metades na mesma lista.
    assert.throws(() => waveKey(13, "2026-08-13", "X" as never), /célula inválida/);
    assert.throws(() => waveKey(13, "2026-08-13", "H6" as never), /célula inválida/);
    assert.throws(() => waveKey(13, "2026-08-13", "H24" as never), /célula inválida/);
  });
});

describe("naming e detecção de célula no import", () => {
  it("isGroupCellWave reconhece célula de horário além de A/B/C", () => {
    assert.equal(isGroupCellWave("d13-qui13", "d13-qui13-H06"), true);
    assert.equal(isGroupCellWave("d13-qui13", "d13-qui13-A"), true);
    assert.equal(isGroupCellWave("d13-qui13", "d13-qui13"), false);
  });

  it("isGroupCellWave continua gateado em `group` (defesa do #4762)", () => {
    assert.equal(isGroupCellWave(null, "d13-qui13-H06"), false);
  });

  it("groupCellListNameFor rotula horário de forma legível a humano", () => {
    assert.equal(
      groupCellListNameFor("2607-08", "d13-qui13-H06"),
      "Clarice 2607-08 d13-qui13-H06 — hora 06:00 BRT",
    );
  });

  it("o nome do braço de horário NÃO casa o parser de célula A/B/C", () => {
    // É a garantia central da escolha de sufixo próprio (#5140): o painel não
    // pode ler um teste de horário como teste de assunto.
    const nome = groupCellListNameFor("2607-08", "d13-qui13-H10");
    assert.ok(!/—\s*célula\s*[ABC]\b/i.test(nome), `não deveria parecer célula A/B/C: ${nome}`);
  });

  it("sufixo desconhecido continua lançando", () => {
    assert.throws(() => groupCellListNameFor("2607-08", "d13-qui13-interno"), /não é uma célula de teste/);
  });
});

describe("buildHourCells", () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ EMAIL: `a${i}@x.com`, tier: i % 5 }));

  it("divide em N células com chaves derivadas da hora e sem perder linha", () => {
    const art = buildHourCells(rows, 13, "2026-08-13", [6, 10]);
    assert.equal(art.cells.length, 2);
    assert.deepEqual(
      art.cells.map((c) => c.entry.key),
      ["d13-qui13-H06", "d13-qui13-H10"],
    );
    const total = art.cells.reduce((s, c) => s + c.rows.length, 0);
    assert.equal(total, rows.length, "nenhuma linha pode sumir na divisão");
  });

  it("reparte o resto (101 em 2 → 51/50), nunca descarta", () => {
    const art = buildHourCells(rows, 13, "2026-08-13", [6, 10]);
    assert.deepEqual(art.cells.map((c) => c.rows.length), [51, 50]);
  });

  it("a descrição diz a hora — é o que o operador lê no manifest", () => {
    const art = buildHourCells(rows, 13, "2026-08-13", [6, 10]);
    assert.equal(art.cells[0].entry.desc, "hora 06:00 BRT");
  });

  it("exige >= 2 horas", () => {
    assert.throws(() => buildHourCells(rows, 13, "2026-08-13", [6]), />= 2 horas/);
  });
});

describe("estado durável do teste de horário", () => {
  it("arquivo ausente = inativo, sem aviso (default seguro)", () => {
    withRoot((root) => {
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, undefined);
    });
  });

  it("start grava ativo com horas normalizadas", () => {
    withRoot((root) => {
      startClariceHourTest(root, { hoursBrt: [10, 6], now: () => new Date("2026-08-13T12:00:00Z") });
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "ativo");
      assert.deepEqual(st.status === "ativo" ? st.hoursBrt : null, [6, 10]);
    });
  });

  it("close registra vencedor, e aceita encerramento SEM veredito", () => {
    withRoot((root) => {
      startClariceHourTest(root, { hoursBrt: [6, 10] });
      closeClariceHourTest(root, { winnerBrt: 10, rationale: "clique +2pp, p<0,05" });
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "encerrado");
      assert.equal(st.status === "encerrado" ? st.winnerBrt : undefined, 10);
    });

    withRoot((root) => {
      startClariceHourTest(root, { hoursBrt: [6, 10] });
      closeClariceHourTest(root, { winnerBrt: null });
      const st = readClariceHourTestState(root);
      assert.equal(st.status === "encerrado" ? st.winnerBrt : undefined, null);
    });
  });

  it("close com vencedor que não é braço do teste LANÇA", () => {
    withRoot((root) => {
      startClariceHourTest(root, { hoursBrt: [6, 10] });
      assert.throws(
        () => closeClariceHourTest(root, { winnerBrt: 14 }),
        /não é um dos braços/,
      );
    });
  });

  it("JSON corrompido cai em inativo COM aviso — nunca divide a onda às cegas", () => {
    withRoot((root) => {
      writeFileSync(clariceHourTestStatePath(root), "{ nao é json", "utf-8");
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, true);
      assert.match(st.degradedReason ?? "", /ilegível/);
    });
  });

  it("estado ativo com horas inválidas em disco vira inativo COM aviso", () => {
    withRoot((root) => {
      writeFileSync(
        clariceHourTestStatePath(root),
        JSON.stringify({ status: "ativo", hoursBrt: [6, 99], startedAt: "2026-08-13T00:00:00Z" }),
        "utf-8",
      );
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, true);
    });
  });

  // #5189: close propaga `startedAt` — sem isso o dashboard (`aggregateHourTest`)
  // não teria como delimitar o INÍCIO da janela de um teste encerrado.
  it("close PROPAGA startedAt do ativo que fecha (#5189)", () => {
    withRoot((root) => {
      startClariceHourTest(root, { hoursBrt: [6, 10], now: () => new Date("2026-08-01T00:00:00Z") });
      closeClariceHourTest(root, { winnerBrt: 10, now: () => new Date("2026-08-15T00:00:00Z") });
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "encerrado");
      assert.equal(st.status === "encerrado" ? st.startedAt : undefined, "2026-08-01T00:00:00.000Z");
      assert.equal(st.status === "encerrado" ? st.decidedAt : undefined, "2026-08-15T00:00:00.000Z");
    });
  });

  // #5189: um estado "encerrado" em disco SEM startedAt (ex: escrito à mão,
  // ou por uma versão pré-#5189 do arquivo) é INVÁLIDO — cai em inativo COM
  // aviso, nunca é tratado como um "encerrado" sem janela conhecida (que
  // enganaria `aggregateHourTest` a excluir tudo silenciosamente sem avisar
  // que o arquivo está incompleto).
  it("estado encerrado SEM startedAt em disco vira inativo COM aviso (#5189)", () => {
    withRoot((root) => {
      writeFileSync(
        clariceHourTestStatePath(root),
        JSON.stringify({ status: "encerrado", hoursBrt: [6, 10], winnerBrt: 10, decidedAt: "2026-08-15T00:00:00Z" }),
        "utf-8",
      );
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, true);
    });
  });
});

// #5189: projeção pro shape SLIM que viaja pro KV do dashboard.
describe("toHourTestKvState (#5189)", () => {
  it("inativo → { status: 'inativo' }, sem campos extras", () => {
    assert.deepEqual(toHourTestKvState({ status: "inativo" }), { status: "inativo" });
  });

  it("ativo → mantém hoursBrt/startedAt, descarta startedBy/rationale", () => {
    const kv = toHourTestKvState({
      status: "ativo",
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      startedBy: "editor",
      rationale: "teste #5140",
    });
    assert.deepEqual(kv, { status: "ativo", hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00.000Z" });
  });

  it("encerrado → mantém hoursBrt/startedAt/decidedAt, descarta winnerBrt/decidedBy/rationale", () => {
    const kv = toHourTestKvState({
      status: "encerrado",
      winnerBrt: 10,
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      decidedAt: "2026-08-15T00:00:00.000Z",
      decidedBy: "editor",
      rationale: "clique +2pp, p<0,05",
    });
    assert.deepEqual(kv, {
      status: "encerrado",
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      decidedAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("ativo com invalidDays propaga no KV (#5947)", () => {
    const kv = toHourTestKvState({
      status: "ativo",
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      startedBy: "test",
    }, ["2026-08-21", "2026-08-22"]);
    assert.deepEqual(kv, {
      status: "ativo",
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      invalidDays: ["2026-08-21", "2026-08-22"],
    });
  });

  it("encerrado com invalidDays vazio (undefined) omite o campo (#5947)", () => {
    const kv = toHourTestKvState({
      status: "encerrado",
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00.000Z",
      decidedAt: "2026-08-15T00:00:00.000Z",
      winnerBrt: 10,
      decidedBy: "test",
    });
    assert.equal((kv as any).invalidDays, undefined);
  });
});

test("#5140: normalizeHours recusa 1 braço e mais que o teto", () => {
  assert.throws(() => normalizeHours([6]), />= 2 horas distintas/);
  assert.throws(() => normalizeHours([6, 6]), />= 2 horas distintas/);
  assert.throws(() => normalizeHours([6, 9, 12, 15]), /no máximo/);
  assert.deepEqual(normalizeHours([10, 6]), [6, 10]);
});

describe("#5171: normalizeHours alinhada com brtHourToUtcHourSameDay", () => {
  it("REGRESSÃO: 21h/22h/23h BRT são rejeitadas na validação de entrada", () => {
    // Antes do fix, [6, 21] passava por normalizeHours (só checava 0-23) e
    // só lançava depois — dentro de clarice-envio-run.ts, ao montar
    // scheduledAt via brtHourToUtcHourSameDay — quando clarice-split-group-cells
    // e clarice-import-waves --execute já tinham escrito na Brevo (listas
    // órfãs). O guard precisa disparar AQUI, antes de qualquer escrita.
    assert.throws(() => normalizeHours([6, 21]), /dia seguinte em UTC/);
    assert.throws(() => normalizeHours([6, 22]), /dia seguinte em UTC/);
    assert.throws(() => normalizeHours([6, 23]), /dia seguinte em UTC/);
  });

  it("20h BRT continua aceita — é o limite superior válido", () => {
    assert.deepEqual(normalizeHours([6, 20]), [6, 20]);
  });

  it("startClariceHourTest propaga a rejeição sem gravar estado em disco", () => {
    withRoot((root) => {
      assert.throws(
        () => startClariceHourTest(root, { hoursBrt: [6, 21] }),
        /dia seguinte em UTC/,
      );
      // Nenhum arquivo de estado foi criado — o teste nunca "iniciou".
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, undefined);
    });
  });

  it("estado em disco com hora 21h+ degrada pra inativo COM aviso (mesmo path do JSON corrompido)", () => {
    withRoot((root) => {
      writeFileSync(
        clariceHourTestStatePath(root),
        JSON.stringify({ status: "ativo", hoursBrt: [6, 22], startedAt: "2026-08-13T00:00:00Z" }),
        "utf-8",
      );
      const st = readClariceHourTestState(root);
      assert.equal(st.status, "inativo");
      assert.equal(st.degraded, true);
      assert.match(st.degradedReason ?? "", /hora.*inválida.*22|dia seguinte em UTC/i);
    });
  });
});

describe("#5827: --no-cells não pode fragmentar um teste de horário ativo em silêncio", () => {
  it("REGRESSÃO: --no-cells + teste ativo ABORTA (onda d24-sex21, 260820 — 7500 contatos saíram inteiros às 06h)", () => {
    const msg = checkSingleStrategyAgainstHourTest(
      { kind: "single" },
      { status: "ativo", hoursBrt: [6, 10], startedAt: "2026-08-16T13:18:32.343Z", startedBy: "editor" },
      false,
    );
    assert.match(msg ?? "", /teste de HORÁRIO.*ATIVO/);
    assert.match(msg ?? "", /--hour-cells 6,10/);
  });

  it("--no-cells + teste inativo segue normalmente (null = sem choque)", () => {
    const msg = checkSingleStrategyAgainstHourTest(
      { kind: "single" },
      { status: "inativo" },
      false,
    );
    assert.equal(msg, null);
  });

  it("--no-cells + teste encerrado segue normalmente (só 'ativo' bloqueia)", () => {
    const msg = checkSingleStrategyAgainstHourTest(
      { kind: "single" },
      { status: "encerrado", hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00Z", decidedAt: "2026-08-15T00:00:00Z", decidedBy: "editor", winnerBrt: 10, rationale: "x" },
      false,
    );
    assert.equal(msg, null);
  });

  it("--ignore-hour-test é o escape hatch explícito — bypassa mesmo com teste ativo", () => {
    const msg = checkSingleStrategyAgainstHourTest(
      { kind: "single" },
      { status: "ativo", hoursBrt: [6, 10], startedAt: "2026-08-16T13:18:32.343Z", startedBy: "editor" },
      true,
    );
    assert.equal(msg, null);
  });

  it("estratégia 'hours' ou 'cells' nunca choca com o teste de horário (só 'single' fragmenta)", () => {
    const ativo = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-16T13:18:32.343Z", startedBy: "editor" };
    assert.equal(checkSingleStrategyAgainstHourTest({ kind: "hours", hoursBrt: [6, 10] }, ativo, false), null);
    assert.equal(checkSingleStrategyAgainstHourTest({ kind: "cells" }, ativo, false), null);
  });
});

describe("#6307: checkKeyAgainstHourTest — guard preventivo do caminho --group/--key manual", () => {
  const ativo = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-16T13:18:32.343Z", startedBy: "editor" };

  it("REGRESSÃO: keys reais do incidente ('d25-sab22', 'd26-dom23') sem sufixo -H{HH} ABORTAM com teste ativo", () => {
    const msgA = checkKeyAgainstHourTest("d25-sab22", ativo, false);
    assert.match(msgA ?? "", /--key 'd25-sab22' não termina em -H\{HH\}/);
    assert.match(msgA ?? "", /teste de HORÁRIO.*ATIVO/);
    assert.match(msgA ?? "", /--ignore-hour-test/);

    const msgB = checkKeyAgainstHourTest("d26-dom23", ativo, false);
    assert.match(msgB ?? "", /--key 'd26-dom23' não termina em -H\{HH\}/);
  });

  it("key JÁ com sufixo -H{HH} (o caminho correto, ex: 'd25-sab22-H10') segue normalmente mesmo com teste ativo", () => {
    assert.equal(checkKeyAgainstHourTest("d25-sab22-H10", ativo, false), null);
    assert.equal(checkKeyAgainstHourTest("d25-sab22-H06", ativo, false), null);
  });

  it("key sem sufixo + teste INATIVO segue normalmente (nada a proteger)", () => {
    assert.equal(checkKeyAgainstHourTest("d25-sab22", { status: "inativo" }, false), null);
  });

  it("key sem sufixo + teste ENCERRADO segue normalmente (só 'ativo' bloqueia)", () => {
    const encerrado = {
      status: "encerrado" as const,
      hoursBrt: [6, 10],
      startedAt: "2026-08-01T00:00:00Z",
      decidedAt: "2026-08-15T00:00:00Z",
      decidedBy: "editor",
      winnerBrt: 10,
      rationale: "x",
    };
    assert.equal(checkKeyAgainstHourTest("d25-sab22", encerrado, false), null);
  });

  it("--ignore-hour-test é o escape hatch explícito — bypassa mesmo com teste ativo e key sem sufixo", () => {
    assert.equal(checkKeyAgainstHourTest("reativacao", ativo, true), null);
  });
});

describe("#5887: onda montada com o teste ATIVO nunca termina como célula única", () => {
  it("REGRESSÃO: reproduz o cenário exato do d24-sex21 — --no-cells + teste ativo ABORTA, não degrada em silêncio", () => {
    // Este é o teste de regressão exigido pela #5887: uma onda montada com
    // clarice-hour-test.json em status "ativo" NÃO PODE terminar como
    // célula única. `checkSingleStrategyAgainstHourTest` é o ÚNICO ponto de
    // validação compartilhado pelos dois caminhos (manual — Passo 8 da
    // skill — e automático — clarice-envio-run.ts, que nunca passa
    // --ignore-hour-test) porque os dois chamam clarice-split-group-cells.ts
    // pra materializar a onda; testar aqui cobre os dois sem duplicar setup.
    const hourTestState = {
      status: "ativo" as const,
      hoursBrt: [6, 10],
      startedAt: "2026-08-16T13:18:32.343Z",
      startedBy: "editor",
    };
    const msg = checkSingleStrategyAgainstHourTest({ kind: "single" }, hourTestState, false);
    assert.notEqual(msg, null, "onda única com teste ativo tem que abortar, nunca seguir em silêncio");
  });
});

describe("#5887: dias inválidos (apuração exclui dias sem split)", () => {
  it("arquivo ausente = lista vazia, sem lançar", () => {
    withRoot((root) => {
      assert.deepEqual(readInvalidHourTestDays(root), []);
    });
  });

  it("markInvalidHourTestDay grava e é lido de volta", () => {
    withRoot((root) => {
      const days = markInvalidHourTestDay(root, {
        date: "2026-08-21",
        reason: "onda d24-sex21 saiu como campanha única (#5887)",
        now: () => new Date("2026-08-22T10:00:00Z"),
      });
      assert.equal(days.length, 1);
      assert.equal(days[0].date, "2026-08-21");
      assert.equal(days[0].recordedAt, "2026-08-22T10:00:00.000Z");

      const reread = readInvalidHourTestDays(root);
      assert.deepEqual(reread, days);
    });
  });

  it("idempotente por data — 2ª marcação da MESMA data não duplica", () => {
    withRoot((root) => {
      markInvalidHourTestDay(root, { date: "2026-08-21", reason: "primeiro motivo" });
      const after = markInvalidHourTestDay(root, { date: "2026-08-21", reason: "motivo diferente, ignorado" });
      assert.equal(after.length, 1);
      assert.equal(after[0].reason, "primeiro motivo", "1ª marcação vence — não sobrescreve em silêncio");
    });
  });

  it("datas diferentes acumulam, ordenadas", () => {
    withRoot((root) => {
      markInvalidHourTestDay(root, { date: "2026-08-22", reason: "b" });
      markInvalidHourTestDay(root, { date: "2026-08-21", reason: "a" });
      const days = readInvalidHourTestDays(root);
      assert.deepEqual(days.map((d) => d.date), ["2026-08-21", "2026-08-22"]);
    });
  });

  it("rejeita data em formato inválido, nada é escrito", () => {
    withRoot((root) => {
      assert.throws(() => markInvalidHourTestDay(root, { date: "21/08/2026", reason: "x" }), /data inválida/);
      assert.deepEqual(readInvalidHourTestDays(root), []);
    });
  });

  it("JSON corrompido no arquivo de dias inválidos degrada pra lista vazia (fail-soft)", () => {
    withRoot((root) => {
      writeFileSync(invalidHourTestDaysPath(root), "{ nao é json", "utf-8");
      assert.deepEqual(readInvalidHourTestDays(root), []);
    });
  });

  it("entrada inválida no array é filtrada, entradas válidas sobrevivem", () => {
    withRoot((root) => {
      writeFileSync(
        invalidHourTestDaysPath(root),
        JSON.stringify([
          { date: "2026-08-21", reason: "ok", recordedAt: "2026-08-22T00:00:00Z" },
          { date: "nao-e-data", reason: "ok mas data invalida" },
          "string solta",
        ]),
        "utf-8",
      );
      const days = readInvalidHourTestDays(root);
      assert.equal(days.length, 1);
      assert.equal(days[0].date, "2026-08-21");
    });
  });
});
