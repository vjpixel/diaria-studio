import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKitReviewRecord, checkIntentionalErrorInEmail } from "../scripts/lib/kit-review-record.ts";

describe("#10243 checagem determinística do erro intencional", () => {
  it("present quando wrong_value está no e-mail", () => {
    assert.equal(checkIntentionalErrorInEmail("O Unibanko abriu", "Unibanko"), "present");
  });
  it("missing quando só o texto correto está no e-mail (261015)", () => {
    assert.equal(checkIntentionalErrorInEmail("O Unibanco abriu", "Unibanko"), "missing");
  });
  it("normaliza HTML: tags e entidades", () => {
    assert.equal(checkIntentionalErrorInEmail("<p>Uni<b>banko</b> &amp; caf&eacute;</p>", "Unibanko &"), "present");
    assert.equal(checkIntentionalErrorInEmail("<p>Itaú&nbsp;Unibanko</p>", "Itaú Unibanko"), "present");
  });
  it("no_wrong_value / no_email", () => {
    assert.equal(checkIntentionalErrorInEmail("x", undefined), "no_wrong_value");
    assert.equal(checkIntentionalErrorInEmail(undefined, "Unibanko"), "no_email");
  });
  it("recusa status ok com check missing", () => {
    assert.throws(() => buildKitReviewRecord({ status: "ok", intentionalErrorCheck: "missing" }), /#10243/);
  });
  it("grava o check quando present", () => {
    const r = buildKitReviewRecord({ status: "ok", intentionalErrorCheck: "present" });
    assert.equal(r.intentional_error_check, "present");
  });
});
