/**
 * #9502 — regressão: cadastro via `/assinar?utm_source=retrospectiva-mensal`
 * (CTA da Retrospectiva do Mês) era gravado como `diaria-apex` porque o
 * servidor descartava source fora das allowlists paga/social. Source interno
 * passa no triplo do apex, mas NUNCA vira `origemPaga`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import {
  CLIENT_UTM_SOURCE_ALLOWED_PREFIXES,
  isAllowedClientInternalUtmSource,
  isAllowedClientUtmSource,
} from "../scripts/lib/shared/client-utm-allowlist.ts";

describe("apex aceita utm_source orgânico interno (#9502)", () => {
  for (const src of ["retrospectiva-mensal", "retrospectiva-anual"]) {
    it(`apex + ${src} → grava ${src}, não diaria-apex`, () => {
      const utm = resolveSubscribeUtm("apex", { source: src, medium: "web", campaign: `${src}-2609` });
      assert.equal(utm.source, src);
      assert.equal(utm.medium, "web");
      assert.equal(utm.campaign, `${src}-2609`);
      assert.equal(utm.origemPaga, "");
    });
    it(`${src} em source não-apex nunca vira origemPaga`, () => {
      assert.equal(resolveSubscribeUtm("arquivo", { source: src }).origemPaga, "");
      assert.equal(isAllowedClientUtmSource(src), false);
    });
  }

  it("lista interna é disjunta da allowlist paga", () => {
    for (const p of CLIENT_UTM_SOURCE_ALLOWED_PREFIXES) assert.equal(isAllowedClientInternalUtmSource(p), false);
  });

  it("fronteira de traço: substring solta não passa", () => {
    assert.equal(isAllowedClientInternalUtmSource("retrospectiva-mensalx"), false);
    assert.equal(isAllowedClientInternalUtmSource("retrospectiva"), false);
    assert.equal(resolveSubscribeUtm("apex", { source: "retrospectiva" }).source, "diaria-apex");
  });
});
