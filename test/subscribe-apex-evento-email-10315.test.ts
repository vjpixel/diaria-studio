/**
 * #10315 — regressão: cadastro via `diar.ia.br/?utm_source=evento-email` (P.S.
 * dos e-mails pra quem comprou ingresso de evento) era gravado como
 * `diaria-apex` porque `evento-email` não estava em nenhuma allowlist. Mesmo
 * caminho do #9502: passa no triplo do apex, nunca vira `origemPaga`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import {
  CLIENT_UTM_INTERNAL_ORGANIC_SOURCES,
  isAllowedClientInternalUtmSource,
  isAllowedClientUtmSource,
} from "../scripts/lib/shared/client-utm-allowlist.ts";
import {
  EVENTO_EMAIL_UTM_MEDIUM,
  EVENTO_EMAIL_UTM_SOURCE,
  buildEventoEmailCampaign,
} from "../scripts/lib/shared/utm-registry.ts";

describe("apex aceita utm_source dos e-mails de evento (#10315)", () => {
  it("o literal da allowlist é o mesmo source do registry", () => {
    assert.ok((CLIENT_UTM_INTERNAL_ORGANIC_SOURCES as readonly string[]).includes(EVENTO_EMAIL_UTM_SOURCE));
  });

  it("campaign por evento: evento-email-{ano}-{slug}", () => {
    assert.equal(buildEventoEmailCampaign("2026", "agente-ia"), "evento-email-2026-agente-ia");
  });

  it("apex + evento-email → grava o triplo do link, não diaria-apex", () => {
    const campaign = buildEventoEmailCampaign("2026", "agente-ia");
    const utm = resolveSubscribeUtm("apex", {
      source: EVENTO_EMAIL_UTM_SOURCE,
      medium: EVENTO_EMAIL_UTM_MEDIUM,
      campaign,
    });
    assert.equal(utm.source, "evento-email");
    assert.equal(utm.medium, "email");
    assert.equal(utm.campaign, campaign);
    assert.equal(utm.origemPaga, "");
  });

  it("evento-email em source não-apex nunca vira origemPaga", () => {
    assert.equal(resolveSubscribeUtm("arquivo", { source: EVENTO_EMAIL_UTM_SOURCE }).origemPaga, "");
    assert.equal(isAllowedClientUtmSource(EVENTO_EMAIL_UTM_SOURCE), false);
  });

  it("fronteira de traço: substring solta não passa", () => {
    assert.equal(isAllowedClientInternalUtmSource("evento-emailx"), false);
    assert.equal(isAllowedClientInternalUtmSource("evento"), false);
    assert.equal(resolveSubscribeUtm("apex", { source: "evento" }).source, "diaria-apex");
  });
});
