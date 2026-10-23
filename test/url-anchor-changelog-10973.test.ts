/**
 * #10973: o changelog do Lovable entrega cada entrada como âncora da mesma
 * página (`docs.lovable.dev/changelog#entrada`). `canonicalize` removia o
 * fragmento, fundia as entradas numa URL só, e o dedup barrava a 2ª entrada
 * como "link repetido" por ~30 dias. O fragmento agora sobrevive só nos
 * changelogs por âncora listados em `ANCHOR_CHANGELOG_SOURCES`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, isAnchorChangelogUrl } from "../scripts/lib/url-utils.ts";
import { usedUrlKey } from "../scripts/lib/approved-urls.ts";

const ENTRY_A = "https://docs.lovable.dev/changelog#2026-10-20-agent-mode";
const ENTRY_B = "https://docs.lovable.dev/changelog#2026-10-22-figma-import";

describe("#10973 canonicalize preserva a âncora de changelog por âncora", () => {
  it("duas entradas do changelog do Lovable continuam URLs distintas", () => {
    assert.notEqual(canonicalize(ENTRY_A), canonicalize(ENTRY_B));
    assert.equal(canonicalize(ENTRY_A), ENTRY_A);
  });

  it("cenário da issue: entrada A já publicada não barra a entrada B no dedup por URL", () => {
    // Mesmo contrato do Pass 1 de scripts/dedup.ts: Set de URLs passadas
    // canonicalizadas, consultado com canonicalize(art.url).
    const pastUrls = new Set([canonicalize(ENTRY_A)]);
    assert.equal(pastUrls.has(canonicalize(ENTRY_B)), false, "entrada B nova não pode ser 'link repetido'");
    assert.equal(pastUrls.has(canonicalize(ENTRY_A)), true, "a própria entrada A continua barrada");
  });

  it("o resto da normalização segue valendo na URL com âncora (utm, host, barra final)", () => {
    assert.equal(
      canonicalize("https://DOCS.lovable.dev/changelog/?utm_source=rss#2026-10-20-agent-mode"),
      ENTRY_A,
    );
  });

  it("página do Lovable fora do changelog continua perdendo o fragmento", () => {
    assert.equal(canonicalize("https://lovable.dev/blog/post-x#section-2"), "https://lovable.dev/blog/post-x");
  });

  it("changelog de domínio fora da lista continua perdendo o fragmento", () => {
    assert.equal(canonicalize("https://example.com/changelog#v2"), "https://example.com/changelog");
  });

  it("domínio que só termina com o nome (sem ser subdomínio) não casa", () => {
    assert.equal(isAnchorChangelogUrl("evil-lovable.dev", "/changelog"), false);
    assert.equal(isAnchorChangelogUrl("docs.lovable.dev", "/changelogs"), false);
    assert.equal(isAnchorChangelogUrl("docs.lovable.dev", "/changelog"), true);
    assert.equal(isAnchorChangelogUrl("www.lovable.dev", "/changelog/2026"), true);
  });
});

describe("#10973 usedUrlKey (links usados da edição) também separa as entradas", () => {
  it("entradas distintas do changelog não colidem na chave", () => {
    assert.notEqual(usedUrlKey(ENTRY_A), usedUrlKey(ENTRY_B));
    assert.equal(usedUrlKey(ENTRY_A), usedUrlKey("https://www.docs.lovable.dev/changelog/?utm_source=x#2026-10-20-agent-mode"));
  });

  it("fora da lista o fragmento continua ignorado", () => {
    assert.equal(usedUrlKey("https://ex.com/a#top"), usedUrlKey("https://ex.com/a"));
  });
});
