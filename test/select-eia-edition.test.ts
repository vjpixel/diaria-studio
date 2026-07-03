/**
 * test/select-eia-edition.test.ts (#1912)
 *
 * Cobre o seletor do É IA? mensal: escolher a edição do mês com poll mais
 * próximo de 50% de acerto, com threshold de votos, desempates e fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  monthDays,
  lastDayOfMonth,
  selectEiaEdition,
  resolveEiaSelection,
  signalEiaFallback,
  type EditionPollStat,
} from "../scripts/select-eia-edition.ts";

const stat = (
  edition: string,
  total: number,
  correct_pct: number | null,
  correct_answer: string | null = "A",
): EditionPollStat => ({ edition, total, correct_pct, correct_answer });

describe("monthDays / lastDayOfMonth (#1912)", () => {
  it("enumera todos os dias do mês", () => {
    const may = monthDays("2605");
    assert.equal(may.length, 31);
    assert.equal(may[0], "260501");
    assert.equal(may[30], "260531");
  });
  it("respeita meses de 30 dias e fevereiro", () => {
    assert.equal(monthDays("2604").length, 30); // abril
    assert.equal(lastDayOfMonth("2604"), "260430");
    assert.equal(monthDays("2602").length, 28); // fev 2026 (não-bissexto)
    assert.equal(monthDays("2802").length, 29); // fev 2028 (bissexto)
  });
  it("rejeita YYMM inválido", () => {
    assert.throws(() => monthDays("26"));
    assert.throws(() => monthDays("2613"));
    assert.throws(() => monthDays("2600"));
  });
});

describe("selectEiaEdition (#1912)", () => {
  it("escolhe a edição mais próxima de 50%", () => {
    const chosen = selectEiaEdition([
      stat("260501", 50, 90),
      stat("260510", 50, 48), // |48-50|=2 → vencedor
      stat("260520", 50, 20),
    ]);
    assert.equal(chosen?.edition, "260510");
  });

  it("ignora edições abaixo do threshold de votos", () => {
    const chosen = selectEiaEdition(
      [
        stat("260501", 4, 50), // exatamente 50% mas só 4 votos → ruído
        stat("260510", 30, 65), // |65-50|=15, mas elegível
      ],
      10,
    );
    assert.equal(chosen?.edition, "260510");
  });

  it("ignora edições sem gabarito definido (correct_answer null)", () => {
    const chosen = selectEiaEdition([
      stat("260501", 100, 50, null), // 50% perfeito mas sem gabarito
      stat("260510", 30, 70, "B"),
    ]);
    assert.equal(chosen?.edition, "260510");
  });

  it("ignora correct_pct null mesmo com votos", () => {
    const chosen = selectEiaEdition([
      stat("260501", 100, null, "A"),
      stat("260510", 20, 60, "A"),
    ]);
    assert.equal(chosen?.edition, "260510");
  });

  it("desempate por |pct−50| igual → mais votos", () => {
    const chosen = selectEiaEdition([
      stat("260501", 20, 45), // |45-50|=5
      stat("260510", 80, 55), // |55-50|=5, mais votos → vence
    ]);
    assert.equal(chosen?.edition, "260510");
  });

  it("desempate por votos igual → edição mais recente", () => {
    const chosen = selectEiaEdition([
      stat("260501", 40, 45), // |45-50|=5
      stat("260520", 40, 55), // |55-50|=5, mesmos votos → mais recente vence
    ]);
    assert.equal(chosen?.edition, "260520");
  });

  it("retorna null quando nada é elegível (caller faz fallback)", () => {
    assert.equal(selectEiaEdition([]), null);
    assert.equal(
      selectEiaEdition([stat("260501", 3, 50), stat("260502", 0, null, null)], 10),
      null,
    );
  });

  it("threshold default = 5", () => {
    // 4 votos < 5 default → inelegível → null
    assert.equal(selectEiaEdition([stat("260501", 4, 50)]), null);
    // 5 votos === threshold → elegível
    assert.equal(selectEiaEdition([stat("260501", 5, 50)])?.edition, "260501");
  });
});

describe("resolveEiaSelection (#2869 — traceability + no-silent-fallback)", () => {
  it("caso real 2606-07: escolhe a mais próxima de 50% respeitando o piso de votos, não a última do mês", () => {
    // Reconstrói o caso descrito na issue: 260630 tinha 43% (3ª mais dividida),
    // 260625 e 260616 empatavam em 50%. Piso de votos de 5 (default).
    const stats = [
      stat("260610", 8, 20),
      stat("260616", 12, 50), // |50-50|=0, 12 votos
      stat("260625", 9, 50), // |50-50|=0, 9 votos → menos votos que 260616 → 260616 vence o desempate
      stat("260630", 15, 43), // |43-50|=7 → perde pro critério, mas seria a "última do mês"
    ];
    const result = resolveEiaSelection(stats, "2606");
    assert.equal(result.selection, "criterion");
    assert.equal(result.edition, "260616"); // mais votos entre os empatados em 50%
    assert.equal(result.pct_correct, 50);
    assert.equal(result.total_votes, 12);
    assert.notEqual(result.edition, "260630", "não deve cair na última edição do mês quando há critério aplicável");
    assert.match(result.reason, /50%/);
  });

  it("sem dados de poll: fallback ao último dia do mês, sinalizado (não silencioso)", () => {
    const result = resolveEiaSelection([], "2606");
    assert.equal(result.selection, "fallback_last");
    assert.equal(result.edition, lastDayOfMonth("2606"));
    assert.equal(result.pct_correct, null);
    assert.equal(result.total_votes, null);
    // O sinal de "não foi pelo critério" precisa estar no dado retornado, não
    // só em algum log que o caller pode perder — reason é sempre não-vazio e
    // explica o motivo, pronto pra virar warning/log/item de gate (#2869).
    assert.ok(result.reason.length > 0);
    assert.match(result.reason, /elegível/);
  });

  it("edições abaixo do piso de votos: mesmo com 50% exato, cai em fallback sinalizado", () => {
    // "50% que é 3/6" citado na issue — 3 votos não deve contar mesmo perfeito.
    const result = resolveEiaSelection(
      [stat("260610", 3, 50)],
      "2606",
      5,
    );
    assert.equal(result.selection, "fallback_last");
    assert.equal(result.edition, lastDayOfMonth("2606"));
    assert.match(result.reason, /≥5 votos/);
  });

  it("propaga fetch_errors pro resultado estruturado (sinal parcial mesmo com critério aplicado)", () => {
    const result = resolveEiaSelection(
      [stat("260616", 12, 50)],
      "2606",
      5,
      ["260601", "260602"],
    );
    assert.equal(result.selection, "criterion");
    assert.deepEqual(result.fetch_errors, ["260601", "260602"]);
  });

  it("threshold customizado é refletido no resultado", () => {
    const result = resolveEiaSelection([stat("260610", 20, 45)], "2606", 10);
    assert.equal(result.threshold, 10);
    assert.equal(result.selection, "criterion");
  });
});

describe("signalEiaFallback (#2869 — o warning REALMENTE é emitido, não só comentado)", () => {
  it("fallback_last: persiste warn em data/run-log.jsonl (não silencioso)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eia-fallback-signal-"));
    try {
      const result = resolveEiaSelection([], "2606");
      signalEiaFallback(result, "2606", "2606-07", dir);

      const logPath = join(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "data/run-log.jsonl deveria existir após fallback");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.level, "warn");
      assert.equal(entry.edition, "2606-07");
      assert.equal(entry.stage, 3);
      assert.equal(entry.agent, "select-eia-edition");
      assert.match(entry.message, /fallback/);
      assert.equal(entry.details.selection, "fallback_last");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("criterion: NÃO grava run-log.jsonl (nada a sinalizar quando a seleção foi correta)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eia-criterion-signal-"));
    try {
      const result = resolveEiaSelection([stat("260616", 12, 50)], "2606");
      signalEiaFallback(result, "2606", "2606-07", dir);

      const logPath = join(dir, "data", "run-log.jsonl");
      assert.ok(!existsSync(logPath), "run-log.jsonl não deveria ser criado quando a seleção foi pelo critério");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
