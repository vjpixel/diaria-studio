import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastTrustedCommentBodyFromPrViewJson, shouldSkipDuplicateRejectComment } from "../scripts/lib/continuo-reject-comment.ts";

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

describe("lastTrustedCommentBodyFromPrViewJson — só autor confiável conta como último (#9776)", () => {
  const reject = "Gate de merge automático (#6926): rejeitado — veredito da revisão: reject";
  const view = (comments: unknown[]) => JSON.stringify({ comments });

  it("terceiro (NONE) posta texto idêntico ao reject como último comentário → o contínuo NÃO cala o dele", () => {
    const out = lastTrustedCommentBodyFromPrViewJson(
      view([
        { authorAssociation: "OWNER", body: "review: tudo certo" },
        { authorAssociation: "NONE", body: reject },
      ]),
    );
    assert.deepEqual(out, { ok: true, body: "review: tudo certo" });
    assert.equal(shouldSkipDuplicateRejectComment(out.body, reject), false);
  });

  it("CONTRIBUTOR e associação ausente também são ignorados", () => {
    const out = lastTrustedCommentBodyFromPrViewJson(
      view([{ authorAssociation: "CONTRIBUTOR", body: reject }, { body: reject }]),
    );
    assert.deepEqual(out, { ok: true, body: null });
    assert.equal(shouldSkipDuplicateRejectComment(out.body, reject), false);
  });

  it("reject anterior do dono continua deduplicando, mesmo com comentário de terceiro depois", () => {
    const out = lastTrustedCommentBodyFromPrViewJson(
      view([
        { authorAssociation: "OWNER", body: reject },
        { authorAssociation: "NONE", body: "spam qualquer" },
      ]),
    );
    assert.deepEqual(out, { ok: true, body: reject });
    assert.equal(shouldSkipDuplicateRejectComment(out.body, reject), true);
  });

  it("PR sem comentários → ok com body null", () => {
    assert.deepEqual(lastTrustedCommentBodyFromPrViewJson(view([])), { ok: true, body: null });
  });

  it("payload inesperado → ok:false (fail-open: chamador posta)", () => {
    assert.deepEqual(lastTrustedCommentBodyFromPrViewJson("não é json"), { ok: false, body: null });
    assert.deepEqual(lastTrustedCommentBodyFromPrViewJson("{}"), { ok: false, body: null });
    assert.deepEqual(lastTrustedCommentBodyFromPrViewJson("null"), { ok: false, body: null });
  });
});
