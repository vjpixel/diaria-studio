import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aammddToIso,
  isWithinPendingWindow,
} from "../scripts/merge-local-pending.ts";

describe("aammddToIso (#863)", () => {
  it("converte AAMMDD pra ISO", () => {
    assert.equal(aammddToIso("260507"), "2026-05-07");
    assert.equal(aammddToIso("251231"), "2025-12-31");
    assert.equal(aammddToIso("260101"), "2026-01-01");
  });
});

describe("isWithinPendingWindow — anchor em today, não em edition (#863)", () => {
  // Cenário base: today=2026-05-07, current=260510 (edition agendada 3d à frente)
  const anchor = "2026-05-07";
  const current = "2026-05-10";

  it("inclui edição da última semana relativa a today (window=5)", () => {
    // 260504 = 2026-05-04 = 3 dias antes do anchor (today). Dentro de window=5.
    assert.equal(
      isWithinPendingWindow("2026-05-04", current, anchor, 5),
      true,
    );
  });

  it("exclui edição fora da window relativa a today", () => {
    // 260501 = 2026-05-01 = 6 dias antes do anchor. Fora de window=5.
    assert.equal(
      isWithinPendingWindow("2026-05-01", current, anchor, 5),
      false,
    );
  });

  it("exclui a própria edição corrente", () => {
    assert.equal(
      isWithinPendingWindow("2026-05-10", current, anchor, 5),
      false,
    );
  });

  it("exclui edições futuras (após current)", () => {
    assert.equal(
      isWithinPendingWindow("2026-05-15", current, anchor, 5),
      false,
    );
  });

  it("inclui edição no boundary exato do cutoff (cutoff <= edition)", () => {
    // anchor 2026-05-07 - 5d = 2026-05-02. Edição em 2026-05-02 é incluída.
    assert.equal(
      isWithinPendingWindow("2026-05-02", current, anchor, 5),
      true,
    );
  });

  it("regression #863: anchor=today vs anchor=edition produz resultados diferentes", () => {
    // current = 260520 (edição agendada 13d à frente).
    // anchor=today (2026-05-07): cutoff = 2026-05-02. Edição 260504 INCLUÍDA.
    // anchor=edition (2026-05-20): cutoff = 2026-05-15. Edição 260504 EXCLUÍDA.
    const futureCurrent = "2026-05-20";
    const editionIso = "2026-05-04";

    assert.equal(
      isWithinPendingWindow(editionIso, futureCurrent, "2026-05-07", 5),
      true,
      "anchor=today inclui pending de 3d atrás (correto per #863)",
    );

    assert.equal(
      isWithinPendingWindow(editionIso, futureCurrent, "2026-05-20", 5),
      false,
      "anchor=edition exclui pending de 16d 'atrás' relativo à edição (bug pré-#863)",
    );
  });

  it("daysAgo math também muda com anchor — pendings flagged stale relativo a today", () => {
    // Verificação implícita: cutoff math é determinista, mesma semântica que daysAgo
    // (que main() agora computa contra anchor — testado via smoke porque é dentro de main).
    // Documenta o comportamento aqui pra contrato:
    const oneDayMs = 24 * 60 * 60 * 1000;
    const anchorMs = new Date(anchor + "T00:00:00Z").getTime();
    const editionMs = new Date("2026-05-04T00:00:00Z").getTime();
    const daysAgo = Math.round((anchorMs - editionMs) / oneDayMs);
    assert.equal(daysAgo, 3, "edição de 3d atrás relativa ao anchor");
  });
});
