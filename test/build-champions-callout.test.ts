/**
 * build-champions-callout.test.ts (#2725)
 *
 * Regressão: box de início de mês (campeões do É IA? + sorteio do erro
 * intencional), criado manualmente na edição 260701, agora auto-gerado a
 * partir do `podium` do leaderboard + config `raffle`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChampionsCallout,
  monthLabelFromSlug,
  formatHourPt,
  raffleDateLabel,
  type PodiumEntry,
  type RaffleConfig,
} from "../scripts/lib/build-champions-callout.ts";

const PODIUM: PodiumEntry[] = [
  { nickname: "jorgemartinsfilho", rank: 1 },
  { nickname: "Bruna Quevedo", rank: 2 },
  { nickname: "Joshu", rank: 3 },
];

const RAFFLE: RaffleConfig = {
  meet_url: "https://meet.google.com/nbs-jcut-ojj",
  day_of_month: 2,
  hora_inicio: "13:30",
  hora_fim: "14:00",
};

describe("monthLabelFromSlug (#2725)", () => {
  it("resolve nome do mês em PT-BR minúsculo", () => {
    assert.equal(monthLabelFromSlug("2026-06"), "junho");
    assert.equal(monthLabelFromSlug("2026-01"), "janeiro");
    assert.equal(monthLabelFromSlug("2026-12"), "dezembro");
  });

  it("slug malformado → null (fail-safe)", () => {
    assert.equal(monthLabelFromSlug("nope"), null);
    assert.equal(monthLabelFromSlug("2026-13"), null);
    assert.equal(monthLabelFromSlug("2026-00"), null);
  });
});

describe("formatHourPt (#2725)", () => {
  it("omite minutos quando :00", () => {
    assert.equal(formatHourPt("14:00"), "14h");
    assert.equal(formatHourPt("09:00"), "09h");
  });

  it("preserva minutos quando != :00", () => {
    assert.equal(formatHourPt("13:30"), "13h30");
  });

  it("input malformado retorna verbatim (fail-open)", () => {
    assert.equal(formatHourPt("meio-dia"), "meio-dia");
  });
});

describe("raffleDateLabel (#2725)", () => {
  it("monta '{dia} de {mês}' a partir do mês da EDIÇÃO corrente (não o celebrado)", () => {
    // Edição 260701 (julho) — sorteio dia 2 de julho, mesmo que o pódio celebre junho.
    assert.equal(raffleDateLabel("2026-07", 2), "2 de julho");
  });

  it("slug malformado → null", () => {
    assert.equal(raffleDateLabel("nope", 2), null);
  });
});

describe("buildChampionsCallout (#2725)", () => {
  it("preenche o template com pódio + raffle + mês/data resolvidos", () => {
    const text = buildChampionsCallout(PODIUM, RAFFLE, "junho", "2 de julho");
    assert.ok(text);
    assert.match(text!, /^🎉 Os campeões do É IA\? em junho:/);
    assert.match(text!, /🥇 jorgemartinsfilho/);
    assert.match(text!, /🥈 Bruna Quevedo/);
    assert.match(text!, /🥉 Joshu/);
    assert.match(text!, /\*\*Sorteio\*\*/);
    assert.match(
      text!,
      /dia 2 de julho, das 13h30 às 14h, no \[Google Meet\]\(https:\/\/meet\.google\.com\/nbs-jcut-ojj\)/,
    );
    // não vaza `**` de wrap externo — quem envelopa é o injetor.
    assert.ok(!text!.startsWith("**"));
    assert.ok(!text!.endsWith("**"));
  });

  it("ordem do array de entrada não importa — mapeia por rank", () => {
    const shuffled: PodiumEntry[] = [
      { nickname: "Joshu", rank: 3 },
      { nickname: "jorgemartinsfilho", rank: 1 },
      { nickname: "Bruna Quevedo", rank: 2 },
    ];
    const text = buildChampionsCallout(shuffled, RAFFLE, "junho", "2 de julho");
    assert.ok(text);
    // 1º ainda aparece na medalha de ouro, independente da ordem do array.
    const idx1 = text!.indexOf("🥇");
    const idx2 = text!.indexOf("🥈");
    const idx3 = text!.indexOf("🥉");
    assert.ok(idx1 < idx2 && idx2 < idx3, "medalhas na ordem 🥇🥈🥉");
    assert.match(text!, /🥇 jorgemartinsfilho/);
  });

  it("pódio incompleto (falta rank 3) → null — sem box sem top-3 completo", () => {
    const partial: PodiumEntry[] = [
      { nickname: "jorgemartinsfilho", rank: 1 },
      { nickname: "Bruna Quevedo", rank: 2 },
    ];
    assert.equal(buildChampionsCallout(partial, RAFFLE, "junho", "2 de julho"), null);
  });

  it("pódio vazio → null", () => {
    assert.equal(buildChampionsCallout([], RAFFLE, "junho", "2 de julho"), null);
  });
});
