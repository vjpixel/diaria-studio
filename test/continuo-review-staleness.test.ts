import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateReviewStaleness } from "../scripts/lib/continuo-review-staleness.ts";
import { extractIndependentReviewHeadSha } from "../scripts/lib/pr-review-authenticity.ts";

const A = "8d9a8bd5448435544feceb1d7767765eb39e52b4";
const B = "8c460b7e775563c9d66a996a48595a3f4069dd87";

describe("#8445 — review de SHA antigo não é review da PR", () => {
  it("reproduz #8381: review no SHA A, fixer empurrou SHA B → stale (precisa re-revisar)", () => {
    const r = evaluateReviewStaleness({ currentHeadSha: B, reviewedHeadSha: A });
    assert.equal(r.verdict, "stale");
    assert.match(r.reason, /nunca foi revisado/);
  });

  it("mesmo SHA → fresh (não re-revisa à toa)", () => {
    assert.equal(evaluateReviewStaleness({ currentHeadSha: A, reviewedHeadSha: A }).verdict, "fresh");
  });

  it("marcador legado sem head= → unknown, NUNCA stale (senão re-revisaria a cada tick, laço de custo)", () => {
    assert.equal(evaluateReviewStaleness({ currentHeadSha: A, reviewedHeadSha: null }).verdict, "unknown");
  });

  it("HEAD atual desconhecido → unknown", () => {
    assert.equal(evaluateReviewStaleness({ currentHeadSha: null, reviewedHeadSha: A }).verdict, "unknown");
  });

  it("integração com o extrator real: usa o review MAIS RECENTE, então um review novo no SHA B zera o stale", () => {
    const marker = (verdict: string, head: string, run: string) => ({
      id: run,
      body: `<!-- continuo-review: run=${run} at=2026-09-19T10:00:00Z verdict=${verdict} head=${head} -->\nreview`,
    });
    const before = [marker("reject", A, "r1")];
    assert.equal(
      evaluateReviewStaleness({ currentHeadSha: B, reviewedHeadSha: extractIndependentReviewHeadSha(before) }).verdict,
      "stale",
    );
    const after = [...before, marker("approve", B, "r2")];
    assert.equal(
      evaluateReviewStaleness({ currentHeadSha: B, reviewedHeadSha: extractIndependentReviewHeadSha(after) }).verdict,
      "fresh",
    );
  });
});
