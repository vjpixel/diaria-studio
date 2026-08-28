/**
 * apex-cutover-verify-5125.ts (#5125)
 *
 * CLI fino sobre `scripts/lib/apex-cutover-verify.ts`: faz fetch real
 * (leitura, `GET`/`HEAD` — não escreve/publica nada, não é coberto pelo
 * guard de publicação) contra `https://diar.ia.br` e
 * `https://diaria.beehiiv.com`, monta o relatório e escreve
 * `docs/apex-cutover-status-5125.md`.
 *
 * Uso:
 *   npx tsx scripts/apex-cutover-verify-5125.ts
 *
 * Não precisa do junction `data/` (OneDrive) — diferente de
 * `corpus-index-coverage-report.ts`, este script lê o apex já cutovado via
 * HTTP, não o cache local. Funciona em qualquer worktree/sessão com
 * acesso de rede de saída.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  extractHtmlLang,
  checkArchivePostPage,
  countSitemapUrls,
  sitemapHasArchivePost,
  checkRobotsTxt,
  evaluateLegacyRedirect,
  renderApexCutoverReportMarkdown,
  allChecksPassed,
  type ApexCutoverReportInput,
} from "./lib/apex-cutover-verify.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(ROOT, "docs", "apex-cutover-status-5125.md");

const NEW_HOST = "diar.ia.br";
const LEGACY_HOST = "diaria.beehiiv.com";
const UA = "Mozilla/5.0 (compatible; diaria-studio-apex-cutover-verify/1.0)";

async function safeFetch(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { headers: { "user-agent": UA }, redirect: "manual", ...init });
  } catch (err) {
    console.error(`[apex-cutover-verify-5125] fetch falhou para ${url}: ${(err as Error).message}`);
    return null;
  }
}

function extractFirstArchivePostSlug(sitemapXml: string): string | null {
  const match = sitemapXml.match(/<loc>https?:\/\/[^/]+\/p\/([^<]+)<\/loc>/i);
  return match ? match[1] : null;
}

async function run(): Promise<void> {
  const generatedAtIso = new Date().toISOString();

  const homeResp = await safeFetch(`https://${NEW_HOST}/`, { redirect: "follow" });
  const homeHtml = homeResp ? await homeResp.text() : "";
  const homeLang = homeResp ? extractHtmlLang(homeHtml) : null;

  const sitemapResp = await safeFetch(`https://${NEW_HOST}/sitemap.xml`, { redirect: "follow" });
  const sitemapXml = sitemapResp ? await sitemapResp.text() : "";
  const sitemapUrlCount = countSitemapUrls(sitemapXml);
  const slug = extractFirstArchivePostSlug(sitemapXml);

  let postCheck: ApexCutoverReportInput["postCheck"] = null;
  let postUrl: string | null = null;
  let sitemapHasSampledPost = false;
  if (slug) {
    postUrl = `https://${NEW_HOST}/p/${slug}`;
    const postResp = await safeFetch(postUrl, { redirect: "follow" });
    if (postResp) {
      const postHtml = await postResp.text();
      postCheck = checkArchivePostPage(postHtml, postUrl);
    }
    sitemapHasSampledPost = sitemapHasArchivePost(sitemapXml, slug);
  }

  const robotsResp = await safeFetch(`https://${NEW_HOST}/robots.txt`, { redirect: "follow" });
  const robots = robotsResp ? checkRobotsTxt(await robotsResp.text()) : null;

  let legacyRedirect: ApexCutoverReportInput["legacyRedirect"] = null;
  if (slug) {
    const legacyResp = await safeFetch(`https://${LEGACY_HOST}/p/${slug}`);
    if (legacyResp) {
      legacyRedirect = evaluateLegacyRedirect(
        legacyResp.status,
        legacyResp.headers.get("location"),
        NEW_HOST,
      );
    }
  }

  const report: ApexCutoverReportInput = {
    generatedAtIso,
    homeLang,
    postCheck,
    postUrl,
    sitemapUrlCount,
    sitemapHasSampledPost,
    robots,
    legacyRedirect,
  };

  const markdown = renderApexCutoverReportMarkdown(report);
  writeFileAtomic(OUT_PATH, markdown);

  const ok = allChecksPassed(report);
  console.log(markdown);
  console.log(ok ? "[apex-cutover-verify-5125] todas as checagens passaram." : "[apex-cutover-verify-5125] alguma checagem falhou ou não pôde rodar — ver acima.");
  console.log(`[apex-cutover-verify-5125] relatório salvo em ${OUT_PATH}`);
}

if (isMainModule(import.meta.url)) {
  run().catch((err) => {
    console.error("[apex-cutover-verify-5125] erro:", err);
    process.exitCode = 1;
  });
}
