/**
 * test/site-page-pr-gate-stale-bypass-10190.test.ts (#10190, #10191)
 *
 * #10190: o §5b-site congela slug e conteúdo da página no início da Etapa 5.
 * Se o título do D1 muda depois (loop de fix do §5f, `kit-draft-fresh`), o
 * e-mail sai apontando pra `/p/{slug-novo}` com a página em `/p/{slug-velho}`.
 * A trava do Stage 6 agora devolve `stale` (exit 5) — mesmo com o PR já
 * mergeado — e o playbook republica pelo fallback.
 *
 * #10191: `--bypass-reason` registra o bypass (`prGateBypass`) e devolve
 * `bypassed` (exit 0); os invariantes da página caem pra `warning`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  exitCodeForVerdict,
  runSitePagePrGate,
  sitePageStaleness,
} from "../scripts/check-site-page-pr-gate.ts";
import { sitePageSourceDigest, writeSitePageState, type GhRunner } from "../scripts/publish-edition-site-page.ts";
import { checkSitePagePrMerged, checkSitePagePublished } from "../scripts/lib/invariant-checks/stage-6.ts";
import { seoSlug } from "../scripts/lib/slug.ts";

const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/10200";
const HEAD = "a".repeat(40);
const FAILING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
const view = (entries: unknown[], state = "OPEN") =>
  JSON.stringify({ statusCheckRollup: entries, mergeable: "MERGEABLE", state, headRefOid: HEAD });
const never: GhRunner = (args) => {
  throw new Error(`gh não deveria ser consultado: ${args.join(" ")}`);
};

function reviewed(d1Title: string, titulo = "Assunto da edição", corpo = "Corpo do destaque."): string {
  return [
    "TÍTULO",
    titulo,
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
    corpo,
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
  const dir = mkdtempSync(join(tmpdir(), "diaria-10190-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (d1Title !== undefined) writeFileSync(join(dir, "02-reviewed.md"), reviewed(d1Title));
  writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
  return dir;
}
const statePath = (dir: string) => join(dir, "_internal", "site-page-published.json");
const readState = (dir: string) => JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
const writeState = (dir: string, s: Record<string, unknown>) => writeFileSync(statePath(dir), JSON.stringify(s));

const OLD_TITLE = "Governo lança plano de IA";
const NEW_TITLE = "Governo recua do plano de IA";

describe("#10190: página defasada → 'stale' (exit 5)", () => {
  it("REGRESSÃO: D1 mudou depois do §5b-site — PR já MERGED com o slug velho ainda é 'stale', sem consultar o gh", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true, status: "merged" });
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, sleep: () => {} });
    assert.equal(verdict.kind, "stale");
    assert.equal(exitCodeForVerdict(verdict), 5);
    assert.match((verdict as { reason: string }).reason, new RegExp(seoSlug(NEW_TITLE)));
    rmSync(dir, { recursive: true, force: true });
  });

  it("slug igual ao do D1 atual → segue o fluxo normal (merged)", () => {
    const dir = edition(OLD_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--expected-slug sobrepõe o D1 (fallback Beehiiv publicou com o slug do post)", () => {
    const dir = edition(NEW_TITLE);
    writeState(dir, { code: 0, slug: "slug-do-post", published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, expectedSlug: "slug-do-post" }).kind, "merged");
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, expectedSlug: "outro" }).kind, "stale");
    rmSync(dir, { recursive: true, force: true });
  });

  it("sem 02-reviewed.md (D1 não derivável) → checagem de slug pulada, comportamento anterior", () => {
    const dir = edition();
    writeState(dir, { code: 0, slug: "qualquer", published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("conteúdo: newsletter-final.html mudou depois da publicação → 'stale'; state sem sourceDigest não confere", () => {
    const dir = edition(OLD_TITLE);
    writeSitePageState(dir, { code: 0, slug: seoSlug(OLD_TITLE), bytes: 1, published: true, prUrl: PR_URL, merged: true });
    assert.equal(typeof readState(dir).sourceDigest, "string");
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "merged");
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v2 corrigida</html>");
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "stale");
    const legacy = { ...readState(dir) };
    delete legacy.sourceDigest;
    writeState(dir, legacy);
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "merged");
    rmSync(dir, { recursive: true, force: true });
  });

  it("sitePageSourceDigest: muda com TÍTULO, não com o corpo do 02-reviewed.md (que não entra na página)", () => {
    const dir = edition(OLD_TITLE);
    const d0 = sitePageSourceDigest(dir);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed(OLD_TITLE, "Assunto da edição", "Corpo REESCRITO."));
    assert.equal(sitePageSourceDigest(dir), d0);
    writeFileSync(join(dir, "02-reviewed.md"), reviewed(OLD_TITLE, "Outro assunto"));
    assert.notEqual(sitePageSourceDigest(dir), d0);
    rmSync(join(dir, "_internal", "newsletter-final.html"));
    assert.equal(sitePageSourceDigest(dir), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeSitePageState só grava sourceDigest quando a página foi publicada", () => {
    const dir = edition(OLD_TITLE);
    writeSitePageState(dir, { code: 3, reason: "push falhou" });
    assert.equal(readState(dir).sourceDigest, undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sitePageStaleness: slug ausente no state com slug esperado é defasagem", () => {
    assert.match(sitePageStaleness({}, "novo", undefined) ?? "", /ausente/);
    assert.equal(sitePageStaleness({ slug: "x", sourceDigest: "a" }, undefined, "a"), null);
  });
});

describe("#10191: --bypass-reason", () => {
  it("CI vermelho + bypass → 'bypassed' (exit 0), prGateBypass gravado; invariante vira warning", () => {
    const dir = edition(OLD_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: false });
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([FAILING]);
      throw new Error("não pode mergear");
    };
    const now = new Date("2026-10-14T21:00:00Z");
    assert.equal(runSitePagePrGate("/repo", dir, { gh, sleep: () => {} }).kind, "blocked");
    assert.deepEqual(checkSitePagePrMerged(dir, () => "OPEN").map((v) => v.severity), ["error"]);

    const verdict = runSitePagePrGate("/repo", dir, { gh, sleep: () => {}, bypassReason: "flake no CI", now });
    assert.equal(verdict.kind, "bypassed");
    assert.equal(exitCodeForVerdict(verdict), 0);
    assert.equal((verdict as { bypassed: { kind: string } }).bypassed.kind, "blocked");
    const s = readState(dir);
    assert.deepEqual(s.prGateBypass, {
      reason: "flake no CI",
      verdict: "blocked",
      verdictReason: (verdict as { bypassed: { reason: string } }).bypassed.reason,
      at: now.toISOString(),
    });
    assert.equal(s.prUrl, PR_URL, "o resto do state é preservado");
    const v = checkSitePagePrMerged(dir, () => "OPEN");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /flake no CI/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sem state (guard de merge tag, --no-gates) + bypass → cria state com prGateBypass; site-page-published vira warning", () => {
    const dir = edition(OLD_TITLE);
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never }).kind, "no-pr");
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "--no-gates: sem PR" });
    assert.equal(verdict.kind, "bypassed");
    const s = readState(dir);
    assert.equal(s.published, false);
    assert.equal((s.prGateBypass as { verdict: string }).verdict, "no-pr");
    assert.deepEqual(checkSitePagePublished(dir).map((x) => x.severity), ["warning"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("merged + bypass → 'merged', nada gravado; bypass em branco não vale", () => {
    const dir = edition(OLD_TITLE);
    writeState(dir, { code: 0, slug: seoSlug(OLD_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "x" }).kind, "merged");
    assert.equal(readState(dir).prGateBypass, undefined);
    writeState(dir, { code: 0, slug: seoSlug(NEW_TITLE), published: true, prUrl: PR_URL, merged: true });
    assert.equal(runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "   " }).kind, "stale");
    rmSync(dir, { recursive: true, force: true });
  });

  it("republicação (writeSitePageState) apaga o bypass anterior — nova tentativa volta a travar", () => {
    const dir = edition(OLD_TITLE);
    runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "sem PR" });
    assert.ok(readState(dir).prGateBypass);
    writeSitePageState(dir, { code: 0, slug: seoSlug(OLD_TITLE), bytes: 1, published: true, prUrl: PR_URL, merged: false });
    assert.equal(readState(dir).prGateBypass, undefined);
    assert.deepEqual(checkSitePagePrMerged(dir, () => "OPEN").map((v) => v.severity), ["error"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
