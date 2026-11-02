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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAudienceTagId } from "../scripts/lib/kit-diaria-audience.ts";
import { describeInvalidSkip, parseSkipFlag } from "../scripts/lib/publish-consent.ts";
import { mainCli } from "../scripts/build-publish-consent.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#11225 canal Kit diária e ramo Beehiiv aposentados", () => {
  it("os scripts do canal paralelo não existem mais", () => {
    for (const p of [
      "scripts/kit-diaria-stage5-dispatch.ts",
      "scripts/schedule-kit-diaria.ts",
      "scripts/lib/kit-diaria-channel.ts",
    ]) {
      assert.equal(existsSync(resolve(ROOT, p)), false, p);
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

  it("`--skip kit` é recusado, apontando `--skip newsletter`, inclusive no meio de uma lista", () => {
    assert.equal(parseSkipFlag("kit"), null);
    assert.equal(parseSkipFlag("brevo,kit"), null);
    assert.match(describeInvalidSkip("brevo,kit"), /use --skip newsletter/);
    assert.doesNotMatch(describeInvalidSkip("xpto"), /use --skip newsletter/);
    assert.equal(parseSkipFlag("newsletter")?.newsletter, "manual");
  });

  it("CLI: `--skip kit` sai 1 sem gravar consent e explica no stderr", () => {
    const out = resolve(ROOT, "test", "_nao-deve-existir-skip-kit-11225.json");
    const original = console.error;
    const errors: string[] = [];
    console.error = (m: string) => void errors.push(m);
    try {
      assert.equal(mainCli(["--edition", "260101", "--skip", "kit", "--out", out]), 1);
    } finally {
      console.error = original;
    }
    assert.match(errors.join("\n"), /use --skip newsletter/);
    assert.equal(existsSync(out), false);
  });

  it("nenhum playbook oferece `--skip kit` como canal", () => {
    const skill = read(".claude/skills/diaria-5-publicacao/SKILL.md");
    assert.doesNotMatch(skill, /`kit`, `youtube`|brevo,kit|twitter, brevo, kit/);
  });

  it("gate do Stage 6 lê `review_status`, que existe em KitReviewRecord; `review_completed` não", () => {
    const stage6 = read(".claude/agents/orchestrator-stage-6.md");
    assert.doesNotMatch(stage6, /review_completed/);
    assert.match(stage6, /`review_status === "ok"`/);
    assert.doesNotMatch(read("scripts/lib/kit-review-record.ts"), /review_completed/);
  });

  it("review-test-email: `platform` ausente vale kit, e o Stage 5 passa explícito", () => {
    const agent = read(".claude/agents/review-test-email.md");
    assert.match(agent, /Se `platform` ausente\*\* → tratar como `"kit"`/);
    assert.doesNotMatch(agent, /newsletter\.backend/);
    assert.doesNotMatch(agent, /ausente ou `"beehiiv"`/);
    assert.match(read(".claude/agents/orchestrator-stage-5.md"), /Disparar `review-test-email` passando `platform: "kit"`/);
  });

  it("nada promete mais o bloqueio do guard de slug do WhatsApp depois do Stage 4", () => {
    assert.doesNotMatch(read(".claude/agents/orchestrator-stage-4.md"), /o guard que de fato BLOQUEIA/);
    assert.doesNotMatch(read("context/publishers/beehiiv-playbook.md"), /GATE-BLOCKING/);
    assert.equal(existsSync(resolve(ROOT, "scripts/check-whatsapp-slug-guard.ts")), false, "removido no #11775");
    assert.doesNotMatch(read(".claude/skills/diaria-5-publicacao/SKILL.md"), /guard de slug do bloco WhatsApp/);
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
