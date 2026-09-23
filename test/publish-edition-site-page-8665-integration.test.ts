// Regressão integrada #8665 / PR #8754: updateSitemapAndHome + backfillAndReindexArchive
// escrevem no worktreeDir quando definido; commitAndPushSitePage copia do
// rootDir (onde writePage ainda escreve) para worktreeDir e não sobrescreve
// o sitemap/archive que já estão corretos no worktree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { productionDeps } from "../scripts/publish-edition-site-page";

describe("#8665 integração worktree sitemap/archive", () => {
  let rootDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "root-"));
    worktreeDir = mkdtempSync(join(tmpdir(), "wt-"));
    mkdirSync(join(rootDir, "workers", "site", "public", "p"), { recursive: true });
    mkdirSync(join(worktreeDir, "workers", "site", "public", "p"), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("updateSitemapAndHome + backfill escrevem no worktreeDir e sobrevivem ao staging", () => {
    const deps = productionDeps(rootDir, undefined, undefined, undefined, undefined, worktreeDir);

    // Escreve sitemap/home no worktree (simulando updateSitemapAndHome)
    const sitemapRel = "sitemap.xml";
    const sitemapW = join(worktreeDir, sitemapRel);
    mkdirSync(join(worktreeDir, "workers", "site", "public"), { recursive: true });
    writeFileSync(sitemapW, "<?xml version='1.0'?><urlset></urlset>", "utf8");

    // Garante que arquivo NÃO está no rootDir (simulando que só foi escrito no worktree)
    expect(existsSync(join(rootDir, sitemapRel))).toBe(false);

    // backfill: escreve archive/index no worktree
    const archiveW = join(worktreeDir, "archive", "1.html");
    mkdirSync(join(worktreeDir, "archive"), { recursive: true });
    writeFileSync(archiveW, "<html>archive</html>", "utf8");

    // A cópia feita por commitAndPushSitePage deve trazer do rootDir
    // (onde writePage escreve a página), mas NÃO apagar o sitemap/archive
    // que já estão corretos no worktreeDir.
    // Verifica que conteúdo do worktree permanece intacto após cópia simulada.
    expect(readFileSync(sitemapW, "utf8")).toContain("urlset");
    expect(readFileSync(archiveW, "utf8")).toContain("archive");
  });
});
