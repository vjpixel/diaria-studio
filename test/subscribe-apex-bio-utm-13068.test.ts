/**
 * #13068 — regressão: cadastro no apex vindo do Linktree pessoal do editor
 * (`diar.ia.br/assinar?utm_source=linktree&utm_medium=bio&utm_campaign=perfil-linktree-pixel`)
 * era gravado como `diaria-apex`, porque `linktree` não estava em nenhuma das
 * allowlists do cliente. A lista de bio agora é derivada de
 * `EXTERNAL_UTM_SURFACES` (`medium === "bio"`), passa só no triplo do apex e
 * nunca vira `origemPaga`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import {
  CLIENT_UTM_BIO_SOURCES,
  CLIENT_UTM_SOURCE_ALLOWED_PREFIXES,
  isAllowedClientBioUtmSource,
  isAllowedClientUtmSource,
} from "../scripts/lib/shared/client-utm-allowlist.ts";
import {
  EXTERNAL_SURFACE_MEDIUM,
  EXTERNAL_UTM_SURFACES,
  findExternalUtmSurface,
} from "../scripts/lib/shared/utm-registry.ts";

describe("apex aceita utm_source de bio externa (#13068)", () => {
  it("cenário da issue: linktree preserva o triplo inteiro", () => {
    const utm = resolveSubscribeUtm("apex", {
      source: "linktree",
      medium: "bio",
      campaign: "perfil-linktree-pixel",
    });
    assert.equal(utm.source, "linktree");
    assert.equal(utm.medium, "bio");
    assert.equal(utm.campaign, "perfil-linktree-pixel");
    assert.equal(utm.referringSite, "apex-subscribe-page");
    assert.equal(utm.origemPaga, "");
  });

  it("triplo do registry de cada superfície de bio passa intacto no apex", () => {
    for (const s of EXTERNAL_UTM_SURFACES.filter((x) => x.medium === EXTERNAL_SURFACE_MEDIUM)) {
      const utm = resolveSubscribeUtm("apex", { source: s.source, medium: s.medium, campaign: s.campaign });
      assert.equal(utm.source, s.source, s.id);
      assert.equal(utm.medium, s.medium, s.id);
      assert.equal(utm.campaign, s.campaign, s.id);
      assert.equal(utm.origemPaga, "", s.id);
    }
  });

  it("a lista é derivada do registry (superfície nova entra sem segunda lista)", () => {
    const esperado = new Set(
      EXTERNAL_UTM_SURFACES.filter((s) => s.medium === EXTERNAL_SURFACE_MEDIUM).map((s) => s.source.toLowerCase()),
    );
    assert.deepEqual(new Set(CLIENT_UTM_BIO_SOURCES), esperado);
    for (const src of ["linktree", "tiktok", "apoiase", "github", "nexo", "outraspalavras", "manualdousuario", "workshop-agente-ia"]) {
      assert.ok(CLIENT_UTM_BIO_SOURCES.includes(src), src);
    }
  });

  it("superfície fora do medium bio não entra (LinkedIn e ads têm medium próprio)", () => {
    assert.equal(findExternalUtmSurface("perfil-linkedin")?.medium, "organic_social");
    for (const paid of CLIENT_UTM_SOURCE_ALLOWED_PREFIXES) {
      assert.equal(CLIENT_UTM_BIO_SOURCES.includes(paid), false, paid);
    }
  });

  it("apoiase só manda utm_source: medium/campaign caem no default do apex", () => {
    const utm = resolveSubscribeUtm("apex", { source: "apoiase" });
    assert.equal(utm.source, "apoiase");
    assert.equal(utm.medium, "web");
    assert.equal(utm.campaign, "cadastro-apex");
  });

  it("fronteira de traço: sufixo passa, substring solta não", () => {
    assert.equal(isAllowedClientBioUtmSource("linktree-marca"), true);
    assert.equal(isAllowedClientBioUtmSource(" LinkTree "), true);
    assert.equal(isAllowedClientBioUtmSource("linktreex"), false);
    assert.equal(isAllowedClientBioUtmSource(""), false);
    assert.equal(isAllowedClientBioUtmSource(undefined), false);
  });

  it("bio nunca vira origemPaga, em nenhum source", () => {
    for (const src of CLIENT_UTM_BIO_SOURCES) {
      assert.equal(isAllowedClientUtmSource(src), false, src);
      for (const source of ["arquivo", "hub", "livros-hero", "jogar", "vote-clarice"]) {
        const utm = resolveSubscribeUtm(source, { source: src, medium: "bio", campaign: `perfil-${src}` });
        assert.equal(utm.origemPaga, "", `${source} + ${src}`);
        assert.notEqual(utm.source, src, `${source} + ${src}: triplo fixo não muda`);
      }
    }
  });

  it("valor fora de todas as listas continua caindo em diaria-apex", () => {
    assert.equal(resolveSubscribeUtm("apex", { source: "spam", medium: "bio" }).source, "diaria-apex");
  });
});
