import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipDuplicateRejectComment } from "../scripts/lib/continuo-reject-comment.ts";

describe("shouldSkipDuplicateRejectComment (#7446 item 1)", () => {
  it("último comentário == candidato → true (pula, não duplica)", () => {
    const body = "Gate de merge automático (#6926): rejeitado — veredito da revisão: reject";
    assert.equal(shouldSkipDuplicateRejectComment(body, body), true);
  });

  it("último comentário diferente (motivo mudou) → false (posta)", () => {
    const last = "Gate de merge automático (#6926): rejeitado — veredito da revisão: reject";
    const candidate = "Gate de merge automático (#6926): rejeitado — CI: fail";
    assert.equal(shouldSkipDuplicateRejectComment(last, candidate), false);
  });

  it("PR sem comentários (null) → false, nunca conta como duplicata", () => {
    assert.equal(shouldSkipDuplicateRejectComment(null, "qualquer coisa"), false);
  });

  it("PR sem comentários (undefined) → false", () => {
    assert.equal(shouldSkipDuplicateRejectComment(undefined, "qualquer coisa"), false);
  });

  it("último comentário vazio (string) não é null — comparado normalmente", () => {
    assert.equal(shouldSkipDuplicateRejectComment("", "algo"), false);
    assert.equal(shouldSkipDuplicateRejectComment("", ""), true);
  });

  it("9 rejeições idênticas em sequência (reprodução do #7404) — todas menos a 1ª são puladas", () => {
    const body = "Gate de merge automático (#6926): rejeitado — veredito da revisão: reject";
    let last: string | null = null;
    let posted = 0;
    for (let i = 0; i < 9; i++) {
      if (!shouldSkipDuplicateRejectComment(last, body)) {
        posted++;
        last = body;
      }
    }
    assert.equal(posted, 1);
  });
});
