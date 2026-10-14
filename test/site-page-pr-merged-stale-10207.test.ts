/**
 * test/site-page-pr-merged-stale-10207.test.ts (#10207)
 *
 * O invariante `site-page-pr-merged` (backstop do sentinel `.step-6-done.json`)
 * devolvia `[]` assim que `merged === true`, sem conferir defasagem — aprovava
 * o que a trava `check-site-page-pr-gate.ts` reprova com exit 5. Cenário: PR de
 * `/p/A` mergeado → D1 retitulado pra B → §6c-site pulado → sentinel gravado →
 * e-mail linka `/p/B` → 404. Agora os dois usam a mesma `sitePageStaleness`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSitePagePrGate } from "../scripts/check-site-page-pr-gate.ts";
import { writeSitePageState, type GhRunner } from "../scripts/publish-edition-site-page.ts";
import { checkSitePagePrMerged } from "../scripts/lib/invariant-checks/stage-6.ts";
import { seoSlug } from "../scripts/lib/slug.ts";

const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/10200";
const OLD_TITLE = "Governo lança plano de IA";
const NEW_TITLE = "Governo recua do plano de IA";
const never: GhRunner = (args) => {
  throw new Error(`gh não deveria ser consultado: ${args.join(" ")}`);
};
const liveNever = () => {
  throw new Error("gh pr view não deveria ser consultado");
};

function reviewed(d1Title: string): string {
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
    `**[${d1Title}](https://example.com/a)**`,
    "",
    "Corpo do destaque.",
    "",
    "Por que isso importa:",
    "",
    "Porque sim.",
    "",
    "---",
    "",
  ].join("\n");
}

function edition(d1Title?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-10207-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (d1Title !== undefined) writeFileSync(join(dir, "02-reviewed.md"), reviewed(d1Title));
  writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
  return dir;
}
const statePath = (dir: string) => join(dir, "_internal", "site-page-published.json");
const readState = (dir: string) => JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
const writeState = (dir: string, s: Record<string, unknown>) => writeFileSync(statePath(dir), JSON.stringify(s));

describe("#10207: site-page-pr-merged acusa página defasada mesmo com o PR mergeado", () => {
  it("REGRESSÃO: merged:true com slug do D1 antigo → violação error (a trava diz stale)", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "stale");
    const v = checkSitePagePrMerged(dir, liveNever);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "site-page-pr-merged");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /DEFASADA/);
    assert.match(v[0].message, new RegExp(seoSlug(NEW_TITLE)));
    rmSync(dir, { recursive: true, force: true });
  });

  it("merged:true com insumos mudados depois da publicação (sourceDigest) → violação", () => {
    const dir = edition(OLD_TITLE);
    writeSitePageState(dir, { code: 0, slug: seoSlug(OLD_TITLE), bytes: 1, published: true, prUrl: PR_URL, merged: true });
    assert.deepEqual(checkSitePagePrMerged(dir, liveNever), []);
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v2 corrigida</html>");
    const v = checkSitePagePrMerged(dir, liveNever);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /insumos da página/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("merged:true e página em dia → limpo, sem consultar o gh", () => {
    const dir = edition(OLD_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.deepEqual(checkSitePagePrMerged(dir, liveNever), []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("defasada + PR aberto → a violação de defasagem (não a de merge) é a reportada", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: false });
    const v = checkSitePagePrMerged(dir, () => "OPEN");
    assert.equal(v.length, 1);
    assert.match(v[0].message, /DEFASADA/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("D1 não derivável (sem 02-reviewed.md) → checagem de slug pulada, igual à trava", () => {
    const dir = edition();
    writeState(dir, { code: 0, slug: "qualquer", published: true, prUrl: PR_URL, merged: true });
    assert.deepEqual(checkSitePagePrMerged(dir, liveNever), []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--expected-slug da trava é registrado no state e o invariante confere contra ele (fallback com --slug do post)", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: "slug-do-post", published: true, prUrl: PR_URL, merged: true });
    // Sem o registro, o invariante cai no D1 e acusa.
    assert.equal(checkSitePagePrMerged(dir, liveNever).length, 1);
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, expectedSlug: "slug-do-post" }).kind, "merged");
    assert.equal(readState(dir).expectedSlug, "slug-do-post");
    assert.equal(readState(dir).prUrl, PR_URL, "o resto do state é preservado");
    assert.deepEqual(checkSitePagePrMerged(dir, liveNever), []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("bypass da trava rebaixa a defasagem pra warning (igual ao caso não-mergeado)", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "republicação falhou" }).kind, "bypassed");
    const v = checkSitePagePrMerged(dir, liveNever);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /republicação falhou/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("staleness injetável: checagem default não roda quando o chamador fornece a sua", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.deepEqual(checkSitePagePrMerged(dir, liveNever, () => null), []);
    rmSync(dir, { recursive: true, force: true });
  });
});
