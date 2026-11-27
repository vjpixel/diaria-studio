/**
 * test/verify-clarice-coupons.test.ts (#1982)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCouponSurvival, SPONSORED_LITERALS } from "../scripts/verify-clarice-coupons.ts";

const SPONSOR_BLOCK = [
  "**📣 Escreva melhor com a Clarice.ai",
  "",
  "Leitores têm desconto.",
  "",
  "[Acesse com os cupons NEWS25 ou NEWS50](https://clarice.ai/precos-planos?via=diaria)**",
].join("\n");

describe("checkCouponSurvival (#1982)", () => {
  it("cupons + link preservados pós-Clarice → ok", () => {
    const r = checkCouponSurvival(SPONSOR_BLOCK, SPONSOR_BLOCK);
    assert.equal(r.status, "ok");
    assert.equal(r.dropped.length, 0);
  });

  it("Clarice reescreveu NEWS25 → drop (error)", () => {
    const post = SPONSOR_BLOCK.replace("NEWS25", "NEW25"); // typo introduzido
    const r = checkCouponSurvival(SPONSOR_BLOCK, post);
    assert.equal(r.status, "error");
    assert.ok(r.dropped.some((d) => d.literal === "NEWS25"));
  });

  it("Clarice removeu o ?via=diaria (tracking) → drop", () => {
    const post = SPONSOR_BLOCK.replace("?via=diaria", "");
    const r = checkCouponSurvival(SPONSOR_BLOCK, post);
    assert.equal(r.status, "error");
    assert.ok(r.dropped.some((d) => d.literal === "clarice.ai/precos-planos?via=diaria"));
  });

  it("edição SEM patrocínio (literais ausentes no pré) → ok (nada a proteger)", () => {
    const plain = "**DESTAQUE 1**\n\nCorpo sem patrocínio.";
    const r = checkCouponSurvival(plain, plain);
    assert.equal(r.status, "ok");
  });

  it("conta múltiplas ocorrências — boxDivulgacao1 + PARA ENCERRAR (2 blocos)", () => {
    const pre = SPONSOR_BLOCK + "\n\n---\n\n" + SPONSOR_BLOCK; // cupons aparecem 2x
    // Clarice dropou 1 das 2 ocorrências de NEWS50 → post < pre
    const post = pre.replace(/NEWS50/, "NEWS-50");
    const r = checkCouponSurvival(pre, post);
    assert.equal(r.status, "error");
    const d = r.dropped.find((x) => x.literal === "NEWS50")!;
    assert.equal(d.pre_count, 2);
    assert.equal(d.post_count, 1);
  });

  it("SPONSORED_LITERALS cobre cupons + link de afiliado", () => {
    assert.ok(SPONSORED_LITERALS.includes("NEWS25"));
    assert.ok(SPONSORED_LITERALS.includes("NEWS50"));
    assert.ok(SPONSORED_LITERALS.includes("clarice.ai/precos-planos?via=diaria"));
  });
});

describe("NEWS65 — box Black Friday da 261130 (#14358)", () => {
  // Texto no formato do box Black Friday (#14334): cupom NEWS65 + link de afiliado.
  const BF_BOX = [
    "**📣 Black Friday da Clarice**",
    "",
    "Até 30/11, 65% de desconto no plano anual.",
    "",
    "[Use o cupom NEWS65](https://clarice.ai/precos-planos?via=diaria)",
  ].join("\n");

  it("SPONSORED_LITERALS inclui NEWS65", () => {
    assert.ok((SPONSORED_LITERALS as readonly string[]).includes("NEWS65"));
  });

  it("NEWS65 preservado pós-Clarice → ok (não é acusado)", () => {
    const r = checkCouponSurvival(BF_BOX, BF_BOX);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.dropped, []);
  });

  for (const rewritten of ["NEWS 65", "News65", "NEWS-65", "NEW65"]) {
    it(`NEWS65 reescrito como "${rewritten}" → drop (error)`, () => {
      const post = BF_BOX.replace("NEWS65", rewritten);
      const r = checkCouponSurvival(BF_BOX, post);
      assert.equal(r.status, "error");
      assert.deepEqual(r.dropped, [{ literal: "NEWS65", pre_count: 1, post_count: 0 }]);
    });
  }

  it("box com NEWS65 + crédito com NEWS50: reescrever só o NEWS50 segue acusando o NEWS50", () => {
    const pre = BF_BOX + "\n\n---\n\n" + SPONSOR_BLOCK;
    const post = pre.replace("NEWS50", "NEWS 50");
    const r = checkCouponSurvival(pre, post);
    assert.equal(r.status, "error");
    assert.deepEqual(
      r.dropped.map((d) => d.literal),
      ["NEWS50"],
    );
  });

  it("edição sem NEWS65 no pré (depois da oferta) → NEWS65 não é checado", () => {
    const r = checkCouponSurvival(SPONSOR_BLOCK, SPONSOR_BLOCK);
    assert.equal(r.status, "ok");
    assert.ok(!r.dropped.some((d) => d.literal === "NEWS65"));
  });
});
