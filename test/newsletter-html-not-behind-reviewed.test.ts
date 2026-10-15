import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkNewsletterHtmlNotBehindReviewed } from "../scripts/lib/invariant-checks/stage-4.ts";

const mt = (m: Record<string, number>) => (p: string) => (p in m ? m[p] : null);
const HTML = "_internal/newsletter-final.html";

describe("checkNewsletterHtmlNotBehindReviewed (#10245)", () => {
  it("acusa HTML mais antigo que 02-reviewed.md (replant sem re-render)", () => {
    const v = checkNewsletterHtmlNotBehindReviewed("/x", mt({ [HTML]: 1_000_000, "02-reviewed.md": 2_000_000 }));
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
  });
  it("passa quando o HTML é mais novo", () => {
    assert.deepEqual(checkNewsletterHtmlNotBehindReviewed("/x", mt({ [HTML]: 3_000_000, "02-reviewed.md": 2_000_000 })), []);
  });
  it("não acusa HTML ausente", () => {
    assert.deepEqual(checkNewsletterHtmlNotBehindReviewed("/x", mt({ "02-reviewed.md": 2_000_000 })), []);
  });
});
