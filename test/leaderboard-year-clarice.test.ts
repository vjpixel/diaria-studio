/**
 * leaderboard-year-clarice.test.ts (#2006)
 *
 * Visão ANUAL do leaderboard pra Clarice News (mensal): cada leitor vota
 * 1×/mês → ranking mensal é degenerado (0/1 ou 1/1). Cobre:
 *   - mergeYearEntries: agregação dos snapshots mensais por email;
 *   - leaderboardHref: pra clarice, slug mensal YYYY-MM vira o ano YYYY
 *     (choke-point que auto-corrige a página de voto e os e-mails enviados);
 *     diária inalterada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeYearEntries, type SnapshotEntry } from "../workers/poll/src/index";
import { leaderboardHref } from "../workers/poll/src/lib";

const e = (email: string, correct: number, total: number, nickname: string | null = null): SnapshotEntry =>
  ({ email, nickname, correct, total });

describe("mergeYearEntries (#2006)", () => {
  it("soma correct/total por email através dos meses", () => {
    const out = mergeYearEntries([
      [e("a@x.com", 1, 1), e("b@x.com", 0, 1)],
      [e("a@x.com", 0, 1)],
      [e("a@x.com", 1, 1), e("c@x.com", 1, 1)],
    ]);
    const byEmail = Object.fromEntries(out.map((r) => [r.email, r]));
    assert.deepEqual({ correct: byEmail["a@x.com"].correct, total: byEmail["a@x.com"].total }, { correct: 2, total: 3 });
    assert.deepEqual({ correct: byEmail["b@x.com"].correct, total: byEmail["b@x.com"].total }, { correct: 0, total: 1 });
    assert.deepEqual({ correct: byEmail["c@x.com"].correct, total: byEmail["c@x.com"].total }, { correct: 1, total: 1 });
  });

  it("email é case-insensitive no merge", () => {
    const out = mergeYearEntries([[e("A@X.com", 1, 1)], [e("a@x.com", 0, 1)]]);
    assert.equal(out.length, 1);
    assert.equal(out[0].total, 2);
  });

  // #2018: email armazenado SEMPRE em lowercase — antes byEmail.set(key, { ...e })
  // mantinha o email original (mixed-case) na entrada; lookups subsequentes e
  // exibição no leaderboard ficavam com casing inconsistente.
  it("#2018: email na saída é sempre lowercase (não mixed-case da entrada)", () => {
    const out = mergeYearEntries([[e("USER@Example.COM", 1, 1)]]);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "user@example.com", "email deve ser lowercase mesmo na 1ª entrada");
  });

  it("#2018: email lowercase quando entrada mista de meses com casing diferente", () => {
    const out = mergeYearEntries([[e("A@X.com", 1, 1)], [e("a@x.com", 0, 1)]]);
    assert.equal(out[0].email, "a@x.com", "email merged deve ser lowercase");
  });

  it("nickname: o do mês mais recente (não-nulo) vence; nulo não apaga", () => {
    const out = mergeYearEntries([
      [e("a@x.com", 1, 1, "Ana Jan")],
      [e("a@x.com", 0, 1, null)],
      [e("a@x.com", 1, 1, "Ana Mar")],
    ]);
    assert.equal(out[0].nickname, "Ana Mar");
    const out2 = mergeYearEntries([[e("a@x.com", 1, 1, "Ana")], [e("a@x.com", 0, 1, null)]]);
    assert.equal(out2[0].nickname, "Ana");
  });

  it("meses vazios / nenhum mês → []", () => {
    assert.deepEqual(mergeYearEntries([]), []);
    assert.deepEqual(mergeYearEntries([[], []]), []);
  });

  it("não muta os snapshots de entrada (cache compartilhado do #1348)", () => {
    const jan = [e("a@x.com", 1, 1)];
    const fev = [e("a@x.com", 1, 1)];
    mergeYearEntries([jan, fev]);
    assert.equal(jan[0].correct, 1);
    assert.equal(fev[0].correct, 1);
  });
});

describe("leaderboardHref (#2006 — clarice slug mensal → ano)", () => {
  it("clarice: YYYY-MM vira YYYY (auto-heal dos e-mails enviados)", () => {
    assert.equal(leaderboardHref("clarice", "2026-05"), "/leaderboard/2026?brand=clarice");
  });
  it("clarice: slug já-anual e sem slug preservados", () => {
    assert.equal(leaderboardHref("clarice", "2026"), "/leaderboard/2026?brand=clarice");
    assert.equal(leaderboardHref("clarice"), "/leaderboard?brand=clarice");
    assert.equal(leaderboardHref("clarice", null), "/leaderboard?brand=clarice");
  });
  it("diária INALTERADA: slug mensal continua mensal, sem query", () => {
    assert.equal(leaderboardHref("diaria", "2026-05"), "/leaderboard/2026-05");
    assert.equal(leaderboardHref("diaria"), "/leaderboard");
  });
});
