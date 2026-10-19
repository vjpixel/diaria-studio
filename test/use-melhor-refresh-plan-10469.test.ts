/**
 * test/use-melhor-refresh-plan-10469.test.ts (#10469)
 * Plano de refresh do 4º post: idempotente, N de slides nunca presumido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUseMelhorRefreshPlan } from "../scripts/lib/use-melhor-refresh-plan.ts";
import type { UseMelhorPostStatusInput } from "../scripts/lib/use-melhor-post.ts";

const DIR = "data/editions/261019/";
function status(over: Partial<UseMelhorPostStatusInput> = {}, url = "https://a.com/x"): UseMelhorPostStatusInput {
  return {
    config: { enabled: true, time: "10:00" } as UseMelhorPostStatusInput["config"],
    state: { enabled: true, item: { url, title: "T", source_text_path: "_internal/src.txt" } } as unknown as UseMelhorPostStatusInput["state"],
    reviewedMd: "",
    approved: null,
    hasSocialSection: true,
    hasCurtoSection: true,
    socialUmMentionsBrand: false,
    carouselSlots: ["capa", "p1", "p2", "p3", "p4", "cta"],
    carouselStale: false,
    coverTitleDrift: null,
    ...over,
  };
}

describe("buildUseMelhorRefreshPlan (#10469)", () => {
  it("em dia → sem passos (idempotente)", () => {
    const p = buildUseMelhorRefreshPlan({ previousUrl: "https://a.com/x", status: status() }, DIR);
    assert.deepEqual(p.steps, []);
    assert.equal(p.rewrite_text, false);
    assert.equal(p.regenerate_carousel, false);
  });
  it("item trocado → reescreve texto e carrossel, com source_text_path", () => {
    const p = buildUseMelhorRefreshPlan({ previousUrl: "https://old.com", status: status() }, DIR);
    const all = p.steps.join("\n");
    assert.equal(p.rewrite_text, true);
    assert.equal(p.regenerate_carousel, true);
    assert.match(all, /editorial-rules\.md/);
    assert.match(all, /data\/editions\/261019\/_internal\/src\.txt/);
    assert.match(all, /gen-carousel-cards\.ts --edition-dir data\/editions\/261019\/ --force/);
  });
  it("só carrossel defasado → não reescreve texto; N slides vem do carimbo", () => {
    const p = buildUseMelhorRefreshPlan(
      { previousUrl: "https://a.com/x", status: status({ carouselStale: true, carouselSlots: ["capa", "p1", "cta"] }) },
      DIR,
    );
    assert.equal(p.rewrite_text, false);
    assert.equal(p.regenerate_carousel, true);
    assert.equal(p.carousel_slides, 3);
    assert.ok(!p.steps.join("\n").includes("social-writer"));
  });
  it("desligado ou sem item → sem passos", () => {
    const off = status();
    off.config = { enabled: false, time: null } as UseMelhorPostStatusInput["config"];
    assert.deepEqual(buildUseMelhorRefreshPlan({ previousUrl: null, status: off }, DIR).steps, []);
    const none = status({ state: { enabled: true, item: null } as unknown as UseMelhorPostStatusInput["state"] });
    assert.deepEqual(buildUseMelhorRefreshPlan({ previousUrl: "x", status: none }, DIR).steps, []);
  });
});
