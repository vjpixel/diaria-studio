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
import { leaderboardHref, hashEmailForMatch, maskEmail } from "../workers/poll/src/lib";

// #4123: SnapshotEntry não carrega mais `email` cru (só `uid`/`masked`,
// derivados na escrita — ver leaderboard-routes.ts). O helper deriva os dois
// a partir do e-mail "de teste" pra manter os fixtures legíveis; `mergeYearEntries`
// mescla por `uid` (não mais `email.toLowerCase()`).
const e = (email: string, correct: number, total: number, nickname: string | null = null): SnapshotEntry =>
  ({ uid: hashEmailForMatch(email), masked: maskEmail(email), nickname, correct, total });

describe("mergeYearEntries (#2006)", () => {
  it("soma correct/total por leitor (uid) através dos meses", () => {
    const out = mergeYearEntries([
      [e("a@x.com", 1, 1), e("b@x.com", 0, 1)],
      [e("a@x.com", 0, 1)],
      [e("a@x.com", 1, 1), e("c@x.com", 1, 1)],
    ]);
    const byUid = Object.fromEntries(out.map((r) => [r.uid, r]));
    const uidA = hashEmailForMatch("a@x.com");
    const uidB = hashEmailForMatch("b@x.com");
    const uidC = hashEmailForMatch("c@x.com");
    assert.deepEqual({ correct: byUid[uidA].correct, total: byUid[uidA].total }, { correct: 2, total: 3 });
    assert.deepEqual({ correct: byUid[uidB].correct, total: byUid[uidB].total }, { correct: 0, total: 1 });
    assert.deepEqual({ correct: byUid[uidC].correct, total: byUid[uidC].total }, { correct: 1, total: 1 });
  });

  it("uid é case-insensitive no merge (hashEmailForMatch normaliza trim+lowercase antes de hashear)", () => {
    const out = mergeYearEntries([[e("A@X.com", 1, 1)], [e("a@x.com", 0, 1)]]);
    assert.equal(out.length, 1);
    assert.equal(out[0].total, 2);
  });

  // #2018 (pré-#4123): o bug original era `email` armazenado em mixed-case,
  // causando lookups inconsistentes / entradas duplicadas cross-mês. Pós-#4123,
  // SnapshotEntry não tem mais `email` — a identidade de merge é `uid`, que já
  // normaliza trim+lowercase ANTES de hashear (hashEmailForMatch, lib.ts). O
  // equivalente estrutural do #2018 é: casing diferente do e-mail cru entre
  // meses ainda colapsa pro MESMO uid (nunca duplica a linha).
  it("#2018 (equivalente pós-#4123): uid colapsa pro mesmo valor independente do casing do e-mail cru entre meses", () => {
    const out = mergeYearEntries([[e("USER@Example.COM", 1, 1)], [e("user@example.com", 0, 1)]]);
    assert.equal(out.length, 1, "mesmo uid — não deve duplicar por casing diferente entre meses");
    assert.equal(out[0].uid, hashEmailForMatch("user@example.com"));
    assert.equal(out[0].total, 2, "soma normalmente apesar do casing diferente");
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
