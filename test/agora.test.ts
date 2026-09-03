/**
 * test/agora.test.ts (#7346)
 *
 * Regressão pura pra `scripts/agora.ts` — helper canônico de "hora atual em
 * BRT" que substitui `TZ=America/Sao_Paulo date` (que devolve UTC em
 * silêncio no Git Bash/MSYS2 — o bug que motivou a issue). Cobre o caso
 * concreto do achado: um instante que é 03/set 16:57 UTC precisa aparecer
 * como 13:57 em BRT (offset -03 sempre aplicado), nunca como 16:57.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatBrtNow, formatUtcNow, agoraReport } from "../scripts/agora.ts";

describe("formatBrtNow (#7346)", () => {
  it("aplica o offset -03 sobre um instante UTC — nunca devolve a hora UTC crua", () => {
    // 2026-09-03T16:57:00Z == 2026-09-03 13:57:00 BRT (UTC-3 fixo).
    const instant = new Date("2026-09-03T16:57:00Z");
    assert.equal(formatBrtNow(instant), "2026-09-03 13:57:00 -03");
  });

  it("cruza a meia-noite corretamente (BRT no dia anterior ao UTC)", () => {
    // 2026-09-04T01:30:00Z == 2026-09-03 22:30:00 BRT.
    const instant = new Date("2026-09-04T01:30:00Z");
    assert.equal(formatBrtNow(instant), "2026-09-03 22:30:00 -03");
  });

  it("o sufixo é sempre '-03', nunca 'GMT' (o defeito do date do Git Bash)", () => {
    const label = formatBrtNow(new Date("2026-09-03T12:00:00Z"));
    assert.ok(label.endsWith("-03"), `esperava sufixo -03, recebeu: ${label}`);
    assert.ok(!label.includes("GMT"), `saída não deve conter GMT: ${label}`);
  });
});

describe("formatUtcNow (#7346)", () => {
  it("formata o mesmo instante em UTC, lado a lado do BRT", () => {
    const instant = new Date("2026-09-03T16:57:00Z");
    assert.equal(formatUtcNow(instant), "2026-09-03 16:57:00 UTC");
  });
});

describe("agoraReport (#7346)", () => {
  it("devolve brt e utc do mesmo instante, sempre com offset de 3h", () => {
    const instant = new Date("2026-09-03T16:57:00Z");
    const report = agoraReport(instant);
    assert.equal(report.brt, "2026-09-03 13:57:00 -03");
    assert.equal(report.utc, "2026-09-03 16:57:00 UTC");
    assert.equal(report.epochMs, instant.getTime());
  });
});
