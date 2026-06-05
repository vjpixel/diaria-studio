/**
 * test/select-eia-edition.test.ts (#1912)
 *
 * Cobre o seletor do É IA? mensal: escolher a edição do mês com poll mais
 * próximo de 50% de acerto, com threshold de votos, desempates e fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  monthDays,
  lastDayOfMonth,
  selectEiaEdition,
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
