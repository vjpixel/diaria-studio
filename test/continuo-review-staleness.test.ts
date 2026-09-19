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

import { consumeReReviewAttempt, MAX_RE_REVIEW_ATTEMPTS, STALE_EXIT_CODE } from "../scripts/lib/continuo-review-staleness.ts";

describe("#8451 review — exit code e teto de re-review (custo)", () => {
  it("stale NUNCA usa exit 1 — Node/tsx saem 1 em toda exceção, e um crash viraria review pago por tick", () => {
    assert.notEqual(STALE_EXIT_CODE, 1);
    assert.ok(![0, 2, 3].includes(STALE_EXIT_CODE), "não pode colidir com os outros códigos do CLI");
  });

  it("permite até o teto por PR+SHA e depois nega, sem alterar o estado", () => {
    let state = {};
    for (let i = 0; i < MAX_RE_REVIEW_ATTEMPTS; i++) {
      const r = consumeReReviewAttempt(state, 8381, "abc");
      assert.equal(r.allowed, true, `tentativa ${i + 1} deveria ser permitida`);
      state = r.next;
    }
    const denied = consumeReReviewAttempt(state, 8381, "abc");
    assert.equal(denied.allowed, false, "sessão que sai 0 sem postar marcador não pode gerar review infinito");
    assert.deepEqual(denied.next, state);
  });

  it("o teto é por SHA: um push novo reabre a cota, e outra PR não consome a cota desta", () => {
    let state = consumeReReviewAttempt({}, 8381, "abc").next;
    state = consumeReReviewAttempt(state, 8381, "abc").next;
    assert.equal(consumeReReviewAttempt(state, 8381, "abc").allowed, false);
    assert.equal(consumeReReviewAttempt(state, 8381, "def").allowed, true, "SHA novo = review legítimo");
    assert.equal(consumeReReviewAttempt(state, 8367, "abc").allowed, true, "outra PR");
  });

  it("estado corrompido (valor não inteiro) é tratado como zero, nunca lança", () => {
    assert.equal(consumeReReviewAttempt({ "1@x": "lixo" as unknown as number }, 1, "x").allowed, true);
  });
});
