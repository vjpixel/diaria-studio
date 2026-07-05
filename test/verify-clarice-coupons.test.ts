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
