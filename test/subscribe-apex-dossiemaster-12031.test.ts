/**
 * #12031 — regressão: cadastro via `diar.ia.br/?utm_source=dossiemaster` (box do
 * Dossiê Master) caía em `diaria-apex` porque `dossiemaster` não estava em
 * nenhuma allowlist. Mesmo caminho do #10315.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import { CLIENT_UTM_INTERNAL_ORGANIC_SOURCES, isAllowedClientInternalUtmSource, isAllowedClientUtmSource } from "../scripts/lib/shared/client-utm-allowlist.ts";
import { DOSSIEMASTER_UTM_SOURCE, findUtmEmitter, knownUtmSources } from "../scripts/lib/shared/utm-registry.ts";

describe("apex aceita utm_source do Dossiê Master (#12031)", () => {
  it("o literal da allowlist é o mesmo source do registry", () => {
    assert.ok((CLIENT_UTM_INTERNAL_ORGANIC_SOURCES as readonly string[]).includes(DOSSIEMASTER_UTM_SOURCE));
  });

  it("catalogado no inventário (#5205)", () => {
    assert.ok(knownUtmSources().includes("dossiemaster"));
    assert.equal(findUtmEmitter("dossiemaster")?.source, "dossiemaster");
  });

  for (const medium of ["topo", "rodape"]) {
    it(`apex + dossiemaster/${medium} grava o triplo do link, não diaria-apex`, () => {
      const utm = resolveSubscribeUtm("apex", { source: "dossiemaster", medium, campaign: "cadastro" });
      assert.equal(utm.source, "dossiemaster");
      assert.equal(utm.medium, medium);
      assert.equal(utm.campaign, "cadastro");
      assert.equal(utm.origemPaga, "");
    });
  }

  it("nunca vira origemPaga e respeita a fronteira de traço", () => {
    assert.equal(isAllowedClientUtmSource("dossiemaster"), false);
    assert.equal(isAllowedClientInternalUtmSource("dossiemasterx"), false);
    assert.equal(resolveSubscribeUtm("apex", { source: "dossiemasterx" }).source, "diaria-apex");
  });
});
