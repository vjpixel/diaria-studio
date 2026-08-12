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
import { buildHourCells } from "../scripts/lib/clarice-group-cells.ts";
import { groupCellListNameFor, isGroupCellWave } from "../scripts/clarice-import-waves.ts";
import {
  closeClariceHourTest,
  clariceHourTestStatePath,
  normalizeHours,
  readClariceHourTestState,
  startClariceHourTest,
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
