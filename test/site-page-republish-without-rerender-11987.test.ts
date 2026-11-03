/**
 * test/site-page-republish-without-rerender-11987.test.ts (#11987)
 *
 * Achado do self-review da PR #11979 (#11954): o `reviewedDigest` é o
 * `02-reviewed.md` do MOMENTO da publicação. Se o fallback do §6b-site
 * republicar depois de o editor mexer no `.md` SEM re-renderizar
 * `newsletter-final.html`, o state novo casa com o `.md` editado e a trava
 * voltava a devolver `merged` com a página antiga. Agora o state também grava
 * o sha256 do `.md` que GEROU o HTML (copiado do carimbo do render, #10258),
 * e a trava/invariante acusam `stale` quando ele diverge do `.md` atual.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exitCodeForVerdict, runSitePagePrGate } from "../scripts/check-site-page-pr-gate.ts";
import { writeSitePageState, type GhRunner } from "../scripts/publish-edition-site-page.ts";
import { checkSitePagePrMerged } from "../scripts/lib/invariant-checks/stage-6.ts";
import { writeRenderSourceStamp, sha256OfFileOrNull } from "../scripts/lib/newsletter-html-freshness.ts";
import { sitePageStaleness, SITE_PAGE_HTML_RENDERED_FROM_FIELD } from "../scripts/lib/site-page-staleness.ts";
import { seoSlug } from "../scripts/lib/slug.ts";

const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/11948";
const D1 = "Governo lança plano de IA";
const never: GhRunner = (args) => {
  throw new Error(`gh não deveria ser consultado: ${args.join(" ")}`);
};

function reviewed(box: string): string {
  return [
    "TÍTULO",
    "Assunto da edição",
    "",
    "SUBTÍTULO",
    "Subtítulo da edição",
    "",
    "---",
    "",
    "**DESTAQUE 1 | BRASIL**",
    "",
    `**[${D1}](https://example.com/a)**`,
    "",
    "Corpo do destaque.",
    "",
    "Por que isso importa:",
    "",
    "Porque sim.",
    "",
    "---",
    "",
    "**Vencedores do É IA?**",
    "",
    box,
    "",
  ].join("\n");
}

const statePath = (dir: string) => join(dir, "_internal", "site-page-published.json");
const readState = (dir: string) => JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;

/** Edição com `newsletter-final.html` renderizado (e carimbado) do `.md` v1. */
function renderedEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-11987-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana e Bruno."));
  writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
  writeRenderSourceStamp(dir); // o que render-newsletter-html.ts grava (#10258)
  return dir;
}

/** Publicação confirmada + merge registrado (como o waiter grava). */
function publishAndMerge(dir: string): void {
  writeSitePageState(dir, { code: 0, slug: seoSlug(D1), bytes: 1, published: true, prUrl: PR_URL, merged: true });
  const s = readState(dir);
  writeFileSync(statePath(dir), JSON.stringify({ ...s, merged: true, status: "merged" }));
}

describe("#11987: republicação sem re-render do HTML → 'stale'", () => {
  it("writeSitePageState grava o sha256 do .md que gerou o HTML (carimbo do render)", () => {
    const dir = renderedEdition();
    publishAndMerge(dir);
    assert.equal(readState(dir)[SITE_PAGE_HTML_RENDERED_FROM_FIELD], sha256OfFileOrNull(join(dir, "02-reviewed.md")));
  });

  it("REGRESSÃO: .md editado + republicação SEM re-render → trava devolve 'stale' (exit 5), não 'merged'", () => {
    const dir = renderedEdition();
    publishAndMerge(dir);
    // Editor mexe no box depois da publicação.
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana, Bruno e Carla."));
    // Fallback do §6b-site republica sem re-renderizar o HTML: o state novo
    // grava o reviewedDigest do .md editado (o que, sozinho, faria a trava
    // do #11954 aprovar de novo).
    publishAndMerge(dir);
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "stale");
    assert.equal(exitCodeForVerdict(verdict), 5);
    assert.match(verdict.kind === "stale" ? verdict.reason : "", /#11987/);
  });

  it("invariante site-page-pr-merged acusa o mesmo caso (backstop do sentinel)", () => {
    const dir = renderedEdition();
    publishAndMerge(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana, Bruno e Carla."));
    publishAndMerge(dir);
    const v = checkSitePagePrMerged(dir, () => {
      throw new Error("gh não deveria ser consultado");
    });
    assert.equal(v.length, 1);
    assert.match(v[0].message, /#11987/);
  });

  it("re-render + republicação → 'merged' (o caminho certo segue passando)", () => {
    const dir = renderedEdition();
    publishAndMerge(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana, Bruno e Carla."));
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v2</html>");
    writeRenderSourceStamp(dir);
    publishAndMerge(dir);
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "merged");
  });

  it("sem carimbo do render (anterior ao #10258) → checagem pulada", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-11987-nostamp-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana e Bruno."));
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
    publishAndMerge(dir);
    assert.equal(readState(dir)[SITE_PAGE_HTML_RENDERED_FROM_FIELD], undefined);
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "merged");
  });

  it("pura: campo ausente no state ou sha atual ausente → não acusa", () => {
    assert.equal(sitePageStaleness({ slug: "x" }, "x", undefined, undefined, "b"), null);
    assert.equal(sitePageStaleness({ slug: "x", [SITE_PAGE_HTML_RENDERED_FROM_FIELD]: "a" }, "x", undefined, undefined, undefined), null);
    assert.equal(sitePageStaleness({ slug: "x", [SITE_PAGE_HTML_RENDERED_FROM_FIELD]: "a" }, "x", undefined, undefined, "a"), null);
    assert.match(
      sitePageStaleness({ slug: "x", [SITE_PAGE_HTML_RENDERED_FROM_FIELD]: "a" }, "x", undefined, undefined, "b") ?? "",
      /republicação sem re-render/,
    );
  });
});
