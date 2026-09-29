/**
 * test/aquisicao-reconcile-daily.test.ts (#8591)
 *
 * Cobre a única função PURA de scripts/aquisicao-reconcile-daily.ts —
 * `defaultProcessingDay` (dia BRT anterior ao instante de execução). O
 * resto do script é I/O (fetch de assinantes + leitura/escrita de arquivo)
 * já coberto indiretamente pelas funções que ele reusa de
 * `aquisicao-reconcile.ts` (test/aquisicao-reconcile.test.ts) — este
 * arquivo não duplica essa cobertura, só a composição nova.
 *
 * #9016: cobre também `evaluateAndAlarmDrift` (com `gh` e paths injetados) —
 * o ciclo abre → volta à faixa → fecha do alarme de fator.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLOSE_ALARM_ISSUE_AFTER_RUNS,
  defaultProcessingDay,
  evaluateAndAlarmDrift,
} from "../scripts/aquisicao-reconcile-daily.ts";
import type { AlarmIssuesState, GhRunFn } from "../scripts/lib/alarm-issues.ts";
import type { FactorResult } from "../scripts/aquisicao-reconcile.ts";

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

// #9016 — regressão: `evaluateAndAlarmDrift` saía com `return` antes de
// `applyAlarmReconciliation` quando nenhum canal estava fora da faixa, então
// a issue de alarme aberta por um drift nunca fechava. Ciclo completo com
// `gh` mockado: drift abre → fator volta à faixa → comenta → avança →
// fecha após CLOSE_ALARM_ISSUE_AFTER_RUNS execuções.
describe("evaluateAndAlarmDrift — ciclo abre/fecha (#9016)", () => {
  let dir: string;
  let statePath: string;
  let calls: string[][];
  const run: GhRunFn = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/777\n", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  function writeFator(day: string, reported: number, real: number): void {
    const result: FactorResult = {
      rows: [
        {
          channel: "meta",
          cohort_key: "meta",
          reported_conversions: reported,
          coorte_real: real,
          fator_superestimacao: real > 0 ? reported / real : null,
          status: "ok",
        },
      ],
      canais_coorte_sem_painel: [],
    };
    writeFileSync(join(dir, `${day}.fator.json`), JSON.stringify(result));
  }
  const readState = (): AlarmIssuesState => JSON.parse(readFileSync(statePath, "utf8")) as AlarmIssuesState;
  const key = "aquisicao-reconcile-drift:aquisicao-reconcile-drift:meta";
  const verbs = () => calls.map((c) => `${c[0]} ${c[1]}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-daily-9016-"));
    statePath = join(dir, "alarm-issues.json");
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drift 2,4x abre a issue; fator de volta a 1,1x fecha após N execuções limpas", () => {
    // Dia 1: Meta reportando 2,4x (volume real acima do piso de 20).
    writeFator("2026-09-01", 72, 30);
    evaluateAndAlarmDrift("2026-09-01", { painelDir: dir, statePath, run, cwd: dir });
    assert.ok(verbs().includes("issue create"), "drift deve abrir issue");
    assert.equal(readState()[key]?.issueNumber, 777);
    assert.equal(readState()[key]?.closedAt, null);

    // Janela seguinte: dias antigos saem da janela de 7d; fator volta a 1,1x.
    const cleanDays = ["2026-09-10", "2026-09-11", "2026-09-12"];
    assert.equal(cleanDays.length, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    for (const [i, day] of cleanDays.entries()) {
      calls = [];
      writeFator(day, 33, 30);
      evaluateAndAlarmDrift(day, { painelDir: dir, statePath, run, cwd: dir, now: new Date(`${day}T12:00:00Z`) });
      const entry = readState()[key]!;
      assert.equal(entry.missingStreak, i + 1, `streak deve avançar na execução limpa ${i + 1}`);
      if (i === 0) assert.deepEqual(verbs(), ["issue comment"], "1ª execução limpa comenta 'não reproduz'");
      if (i === 1) assert.deepEqual(verbs(), [], "meio da faixa só avança o streak, sem gh");
      if (i === cleanDays.length - 1) {
        assert.deepEqual(verbs(), ["issue close"], "N-ésima execução limpa fecha");
        assert.equal(calls[0]![2], "777");
        assert.ok(entry.closedAt, "closedAt setado após fechar");
      }
    }
  });

  it("sem nenhum canal fora da faixa, o state ainda é gravado (reconciliação roda com findings vazio)", () => {
    writeFator("2026-09-10", 33, 30);
    const seeded: AlarmIssuesState = {
      [key]: { issueNumber: 555, url: "https://github.com/vjpixel/diaria-studio/issues/555", missingStreak: 0, closedAt: null, family: "estado" },
    };
    writeFileSync(statePath, JSON.stringify(seeded));
    evaluateAndAlarmDrift("2026-09-10", { painelDir: dir, statePath, run, cwd: dir });
    assert.ok(existsSync(statePath));
    assert.equal(readState()[key]?.missingStreak, 1);
    assert.deepEqual(verbs(), ["issue comment"]);
  });
});
