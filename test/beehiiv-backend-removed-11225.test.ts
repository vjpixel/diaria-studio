/**
 * test/beehiiv-backend-removed-11225.test.ts (#11225)
 *
 * O envio da diária é só Kit: o ramo `publishing.newsletter.backend = "beehiiv"`
 * e o canal paralelo Kit diária (#6114/#6126) saíram. Trava para não voltarem
 * por config ou por playbook, e cobre o guard que mudou de casa
 * (`resolveAudienceTagId`, usado por `kit-ramp-cohort.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolveAudienceTagId } from "../scripts/lib/kit-diaria-audience.ts";
import { parseSkipFlag } from "../scripts/lib/publish-consent.ts";

const read = (p: string) => readFileSync(p, "utf8");

describe("#11225 canal Kit diária e ramo Beehiiv aposentados", () => {
  it("os scripts do canal paralelo não existem mais", () => {
    for (const p of [
      "scripts/kit-diaria-stage5-dispatch.ts",
      "scripts/schedule-kit-diaria.ts",
      "scripts/lib/kit-diaria-channel.ts",
    ]) {
      assert.equal(existsSync(p), false, p);
    }
  });

  it("config: sem chave `backend` de envio e `kit_diaria` reduzido à tag da rampa", () => {
    const cfg = JSON.parse(read("platform.config.json"));
    assert.equal(cfg.publishing.newsletter.backend, undefined);
    assert.equal(cfg.kit_diaria.enabled, undefined);
    assert.equal(cfg.kit_diaria.subscriber_filter_created_after, undefined);
    assert.equal(typeof cfg.kit_diaria.audience_tag, "string", "kit-ramp-cohort e kit-gmail-warmup-ramp leem a tag");
  });

  it("Stage 5 e Stage 6 não despacham a newsletter pela Beehiiv nem o canal paralelo", () => {
    const stage5 = read(".claude/agents/orchestrator-stage-5.md");
    const stage6 = read(".claude/agents/orchestrator-stage-6.md");
    assert.doesNotMatch(stage5, /Passo 5c-1: Newsletter Beehiiv/);
    assert.doesNotMatch(stage5, /kit-diaria-stage5-dispatch/);
    assert.doesNotMatch(stage6, /schedule-kit-diaria/);
    assert.doesNotMatch(stage6, /Executar Schedule do Beehiiv/);
    assert.match(stage5, /publish-newsletter-kit\.ts/);
    assert.match(stage6, /schedule-newsletter-kit\.ts/);
  });

  it("`--skip kit` antigo continua aceito, sem efeito em canal nenhum", () => {
    const c = parseSkipFlag("kit");
    assert.ok(c);
    assert.equal(c!.newsletter, "auto", "o e-mail da diária é o canal `newsletter`");
    assert.equal("kit" in c!, false);
  });
});

describe("#6126 resolveAudienceTagId — o guard contra audiência inteira", () => {
  it("tag inexistente (null) ⇒ recusa, citando o motivo real", () => {
    const r = resolveAudienceTagId("rampa-kit", null);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /audiência INTEIRA/);
      assert.match(r.reason, /rampa-kit/);
    }
  });

  it("ids inválidos são recusados, inclusive 0, que é falsy e passaria num if solto", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.equal(resolveAudienceTagId("t", bad).ok, false, `id ${bad} deveria ser recusado`);
    }
  });

  it("id válido passa", () => {
    assert.deepEqual(resolveAudienceTagId("t", 7), { ok: true, tagId: 7 });
  });
});
