/**
 * #9283 — regressão: cadastro no apex vindo de post social
 * (`diar.ia.br/?utm_source=linkedin&utm_medium=social`) era gravado como
 * `utm_source=diaria-apex` porque a allowlist do cliente só aceitava canais
 * pagos + clarice. Social orgânico agora passa no triplo do apex, mas NUNCA
 * vira `origemPaga` em outros sources.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import { isAllowedClientSocialUtmSource } from "../scripts/lib/shared/client-utm-allowlist.ts";

describe("apex aceita utm_source social orgânico (#9283)", () => {
  for (const src of ["linkedin", "instagram", "facebook", "threads", "twitter"]) {
    it(`apex + ${src} → grava ${src}, não diaria-apex`, () => {
      const utm = resolveSubscribeUtm("apex", { source: src, medium: "social", campaign: "edicao" });
      assert.equal(utm.source, src);
      assert.equal(utm.medium, "social");
      assert.equal(utm.campaign, "edicao");
      assert.equal(utm.origemPaga, "");
    });
  }

  it("sufixo com traço passa; substring solta não", () => {
    assert.equal(isAllowedClientSocialUtmSource("linkedin-pessoal"), true);
    assert.equal(isAllowedClientSocialUtmSource("linkedinx"), false);
    assert.equal(isAllowedClientSocialUtmSource(""), false);
  });

  it("social em source não-apex nunca vira origemPaga", () => {
    const utm = resolveSubscribeUtm("arquivo", { source: "linkedin" });
    assert.equal(utm.origemPaga, "");
  });

  it("valor fora das duas listas continua caindo no default diaria-apex", () => {
    assert.equal(resolveSubscribeUtm("apex", { source: "spam" }).source, "diaria-apex");
  });
});
