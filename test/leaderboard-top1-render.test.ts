import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLeaderboardTop1Row, type EIA } from "../scripts/render-newsletter-html.ts";
import { editionToMonthSlug } from "../scripts/fetch-leaderboard-top1.ts";

const PSTYLE = "font:0;"; // dummy, só pra passar pro renderer

/** Texto visível do bloco (tags removidas, espaços colapsados). */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function makeEia(overrides: Partial<EIA>): EIA {
  return {
    credit: "credit",
    imageA: "a.jpg",
    imageB: "b.jpg",
    edition: "260518",
    ...overrides,
  };
}

describe("renderLeaderboardTop1Row (#1160 followup → #9236 bloco de campeões com medalhas)", () => {
  it("retorna '' quando leaderboard ausente", () => {
    const r = renderLeaderboardTop1Row(makeEia({}), PSTYLE);
    assert.equal(r, "");
  });

  it("retorna '' quando podium array vazio", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({ leaderboardPodium: [], leaderboardPeriod: "Maio" }),
      PSTYLE,
    );
    assert.equal(r, "");
  });

  it("single leader (rank 1 só): posição ordinal + nome", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /<strong>🎉 Os campeões do É IA\? em maio:<\/strong>/);
    assert.match(r, />🥇 Alice<\/p>/);
    assert.doesNotMatch(r, /100%/);
    // #9236: a linha compacta antiga ("Vencedores de Maio: 1º …") não volta.
    assert.doesNotMatch(r, /Vencedores/);
  });

  it("2 leitores no podium: '1º X, 2º Y'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 2 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(text(r), /🥇 Alice 🥈 Bob$/);
  });

  it("3 leitores no podium (1,2,3): '1º X, 2º Y, 3º Z' na ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 2 },
          { nickname: "Carol", rank: 3 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(text(r), /em maio: 🥇 Alice 🥈 Bob 🥉 Carol$/);
  });

  it("3 empatados em rank 1: cada um marcado 1º na mesma ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Davyd", rank: 1 },
          { nickname: "Luisao P", rank: 1 },
          { nickname: "Vanessa", rank: 1 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(text(r), /🥇 Davyd 🥇 Luisao P 🥇 Vanessa$/);
  });

  it("5 leitores no podium (2 ouros + 1 prata + 2 bronzes): ordinais em ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 1 },
          { nickname: "Carol", rank: 2 },
          { nickname: "Dave", rank: 3 },
          { nickname: "Eve", rank: 3 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(text(r), /🥇 Alice 🥇 Bob 🥈 Carol 🥉 Dave 🥉 Eve$/);
  });

  it("período ausente: título genérico sem ' em {mês}'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
      }),
      PSTYLE,
    );
    assert.match(r, /Os campeões do É IA\? do mês:/);
    assert.doesNotMatch(r, / em [a-z]+:/);
  });

  it("HTML escape em nickname com caracteres especiais", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "<script>", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /&lt;script&gt;/);
    assert.doesNotMatch(r, /<script>/i);
  });

  it("back-compat: cai em leaderboardTop1 quando podium ausente", () => {
    // Arquivo legacy sem campo podium
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [{ nickname: "Legacy", pct: 100, correct: 1, total: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /🥇 Legacy/);
  });

  it("#9236: rank fora de 1-3 cai em ordinal (sem medalha inventada)", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Zé", rank: 4 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, />4º Zé<\/p>/);
  });

  it("#9242: e-mail mascarado com '@***' sai literal, sem virar negrito/itálico", () => {
    // O apelido nunca passa por parse de markdown no box do É IA? — vem do
    // JSON do leaderboard e só é escapado como HTML. Os '***' do mascaramento
    // (maskEmail, workers/poll) não podem abrir/fechar <strong>/<em>.
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Bruna Quevedo", rank: 1 },
          { nickname: "Robin", rank: 2 },
          { nickname: "perli…@***", rank: 3 },
        ],
        leaderboardPeriod: "Setembro",
        leaderboardPeriodSlug: "2026-09",
      }),
      PSTYLE,
    );
    assert.match(r, />🥉 perli…@\*\*\*<\/p>/);
    assert.equal((r.match(/<strong>/g) ?? []).length, 1, "só o título é <strong>");
    assert.equal((r.match(/<\/strong>/g) ?? []).length, 1);
    assert.doesNotMatch(r, /<em>/);
  });
});

describe("editionToMonthSlug — script duplicate (#1160 mirror)", () => {
  it("AAMMDD → YYYY-MM", () => {
    assert.equal(editionToMonthSlug("260518"), "2026-05");
    assert.equal(editionToMonthSlug("251201"), "2025-12");
  });

  it("inválido → null", () => {
    assert.equal(editionToMonthSlug("invalid"), null);
    assert.equal(editionToMonthSlug("261301"), null);
    assert.equal(editionToMonthSlug(""), null);
  });
});
