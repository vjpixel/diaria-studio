/**
 * build-champions-callout.test.ts (#2725)
 *
 * Regressão: box de início de mês (sorteio do erro intencional), criado
 * manualmente na edição 260701, auto-gerado a partir da config `raffle`.
 * #9236: os campeões do É IA? saíram deste callout (vivem no box do É IA?).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRaffleCallout,
  monthLabelFromSlug,
  formatHourPt,
  raffleDateLabel,
  type RaffleConfig,
} from "../scripts/lib/build-champions-callout.ts";

const RAFFLE: RaffleConfig = {
  meet_url: "https://meet.google.com/nbs-jcut-ojj",
  sorteio_do_mes: { mes: "2026-07", dia: 2 },
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

describe("buildRaffleCallout (#2725 → #9236: callout de intro só com o Sorteio)", () => {
  it("preenche o template do sorteio com raffle + data resolvida", () => {
    const text = buildRaffleCallout(RAFFLE, "2 de julho");
    // 1º parágrafo é o título do callout (marcador 🎉 → titleStyle body).
    assert.match(text, /^🎉 Sorteio\n\n/);
    assert.match(
      text,
      /dia 2 de julho, das 13h30 às 14h, no \[Google Meet\]\(https:\/\/meet\.google\.com\/nbs-jcut-ojj\)/,
    );
    assert.match(text, /Apareça para ver quem vai ganhar caneca/);
    // não vaza `**` de wrap externo — quem envelopa é o injetor; e nenhum `**`
    // interno (#6869: negrito aninhado disparava stacked-intro-callouts).
    assert.ok(!text.includes("**"));
  });

  it("#9236: NÃO carrega mais o bloco de campeões (migrou pro box do É IA?)", () => {
    const text = buildRaffleCallout(RAFFLE, "2 de julho");
    assert.doesNotMatch(text, /campeões/);
    assert.doesNotMatch(text, /[🥇🥈🥉]/u);
    assert.doesNotMatch(text, /ranking completo/);
  });

  it("#9242: sem apelidos no callout, nenhum '@***' de e-mail mascarado entra na região de intro", () => {
    const text = buildRaffleCallout(RAFFLE, "2 de julho");
    assert.doesNotMatch(text, /@\*\*\*/);
  });
});
