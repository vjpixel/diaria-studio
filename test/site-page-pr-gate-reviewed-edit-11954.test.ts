/**
 * test/site-page-pr-gate-reviewed-edit-11954.test.ts (#11954)
 *
 * Edição 261103: o PR da página foi mergeado no §5b-site; depois o editor
 * mexeu no box "Vencedores do É IA?" em `02-reviewed.md`. O publisher do Kit
 * lê o `.md` direto, então `newsletter-final.html` (fonte da página) não foi
 * regerado — o `sourceDigest` continuou igual e a trava devolveu `merged`
 * com a página antiga. Agora o state grava `reviewedDigest` e a trava (e o
 * invariante `site-page-pr-merged`) devolvem `stale` quando ele diverge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exitCodeForVerdict, runSitePagePrGate, sitePageStaleness } from "../scripts/check-site-page-pr-gate.ts";
import {
  sitePageReviewedDigest,
  sitePageSourceDigest,
  writeSitePageState,
  type GhRunner,
} from "../scripts/publish-edition-site-page.ts";
import { checkSitePagePrMerged } from "../scripts/lib/invariant-checks/stage-6.ts";
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

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-11954-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana e Bruno."));
  writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
  return dir;
}
const statePath = (dir: string) => join(dir, "_internal", "site-page-published.json");
const readState = (dir: string) => JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;

/** Publicação confirmada no §5b-site + merge registrado (como o waiter grava). */
function publishAndMerge(dir: string): void {
  writeSitePageState(dir, { code: 0, slug: seoSlug(D1), bytes: 1, published: true, prUrl: PR_URL, merged: true });
  const s = readState(dir);
  writeFileSync(statePath(dir), JSON.stringify({ ...s, merged: true, status: "merged" }));
}

describe("#11954: 02-reviewed.md editado depois do merge → 'stale'", () => {
  it("writeSitePageState grava reviewedDigest na publicação confirmada", () => {
    const dir = edition();
    publishAndMerge(dir);
    assert.equal(readState(dir).reviewedDigest, sitePageReviewedDigest(dir));
  });

  it("REGRESSÃO: box editado no .md sem re-render do HTML — trava devolve 'stale' (exit 5), não 'merged', sem consultar o gh", () => {
    const dir = edition();
    publishAndMerge(dir);
    const digestBefore = sitePageSourceDigest(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana, Bruno e Carla."));
    // O cenário real: o sourceDigest NÃO mudou (HTML não re-renderizado).
    assert.equal(sitePageSourceDigest(dir), digestBefore);
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "stale");
    assert.equal(exitCodeForVerdict(verdict), 5);
    assert.match(verdict.kind === "stale" ? verdict.reason : "", /02-reviewed\.md mudou/);
  });

  it("invariante site-page-pr-merged acusa o mesmo caso (backstop do sentinel)", () => {
    const dir = edition();
    publishAndMerge(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana, Bruno e Carla."));
    const v = checkSitePagePrMerged(dir, () => {
      throw new Error("gh não deveria ser consultado");
    });
    assert.equal(v.length, 1);
    assert.match(v[0].message, /02-reviewed\.md mudou/);
  });

  it(".md sem mudança (só CRLF) → segue 'merged'", () => {
    const dir = edition();
    publishAndMerge(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed("Parabéns a Ana e Bruno.").replace(/\n/g, "\r\n"));
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "merged");
  });

  it("state anterior ao #11954 (sem reviewedDigest) não é acusado", () => {
    assert.equal(sitePageStaleness({ slug: "x", sourceDigest: "a" }, "x", "a", "qualquer"), null);
    assert.match(sitePageStaleness({ slug: "x", reviewedDigest: "a" }, "x", undefined, "b") ?? "", /02-reviewed/);
    assert.equal(sitePageStaleness({ slug: "x", reviewedDigest: "a" }, "x", undefined, undefined), null);
  });
});
