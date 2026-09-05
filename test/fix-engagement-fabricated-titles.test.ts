/**
 * fix-engagement-fabricated-titles.test.ts (#7460, item 4)
 *
 * Cobre a parte pura (`planTitleFixes`) e o fluxo de arquivo completo — o
 * script nunca inventa título: só substitui quando o cache local resolve.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planTitleFixes, FABRICATED_TITLE_RE } from "../scripts/fix-engagement-fabricated-titles.ts";
import type { EngagementManifest } from "../scripts/lib/beehiiv-engagement-manifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/fix-engagement-fabricated-titles.ts");

describe("FABRICATED_TITLE_RE", () => {
  it("casa a leva exata do #7181", () => {
    assert.ok(FABRICATED_TITLE_RE.test("Post 11/20"));
    assert.ok(FABRICATED_TITLE_RE.test("Post 20/20"));
  });
  it("não casa um título real que por acaso contenha 'Post'", () => {
    assert.ok(!FABRICATED_TITLE_RE.test("Post-mortem da migração"));
    assert.ok(!FABRICATED_TITLE_RE.test("Post 11/20 e outras histórias"));
  });
});

describe("planTitleFixes", () => {
  const manifest: EngagementManifest = {
    generated_at: "2026-01-01T00:00:00Z",
    posts: [
      { post_id: "post_A", title: "Post 11/20", status: "ok", count: 100 },
      { post_id: "post_B", title: "Post 12/20", status: "ok", count: 50 },
      { post_id: "post_C", title: "Título real de verdade", status: "ok", count: 30 },
    ],
  };

  it("substitui o título fabricado quando o lookup resolve", () => {
    const lookup = new Map([["post_A", "O assistente de IA mais falado do momento"]]);
    const { manifest: updated, fixed, unresolved } = planTitleFixes(manifest, lookup);
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].post_id, "post_A");
    assert.equal(fixed[0].new_title, "O assistente de IA mais falado do momento");
    assert.equal(updated.posts.find((p) => p.post_id === "post_A")!.title, "O assistente de IA mais falado do momento");
  });

  it("nunca inventa título — post sem lookup vai pra unresolved, título placeholder mantido", () => {
    const lookup = new Map<string, string>();
    const { manifest: updated, fixed, unresolved } = planTitleFixes(manifest, lookup);
    assert.equal(fixed.length, 0);
    assert.equal(unresolved.length, 2, "post_A e post_B são candidatos, ambos sem lookup");
    assert.equal(updated.posts.find((p) => p.post_id === "post_A")!.title, "Post 11/20", "título não mudou");
  });

  it("entry com título real (não-fabricado) nunca é candidata, mesmo com lookup disponível", () => {
    const lookup = new Map([["post_C", "Outro título qualquer"]]);
    const { fixed } = planTitleFixes(manifest, lookup);
    assert.equal(fixed.length, 0);
  });
});

describe("fix-engagement-fabricated-titles.ts — fluxo de arquivo completo", () => {
  function setupFixture() {
    const dir = mkdtempSync(join(tmpdir(), "fix-titles-"));
    const outDir = resolve(dir, "subscriber-engagement");
    const cacheDir = resolve(dir, "beehiiv-cache-posts");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "manifest.json"),
      JSON.stringify({
        generated_at: "2026-01-01T00:00:00Z",
        posts: [
          { post_id: "post_A", title: "Post 11/20", status: "ok", count: 100 },
          { post_id: "post_B", title: "Post 12/20", status: "ok", count: 50 },
        ],
      }),
    );
    writeFileSync(resolve(cacheDir, "post_A.json"), JSON.stringify({ id: "post_A", title: "Título real do post A" }));
    // post_B sem arquivo de cache — deve permanecer com o placeholder.
    return { outDir, cacheDir };
  }

  it("--dry-run não grava o manifest", () => {
    const { outDir, cacheDir } = setupFixture();
    const before = readFileSync(resolve(outDir, "manifest.json"), "utf8");
    execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir, "--cache-dir", cacheDir, "--dry-run"], { encoding: "utf8" });
    const after = readFileSync(resolve(outDir, "manifest.json"), "utf8");
    assert.equal(after, before);
  });

  it("corrige o título resolvido pelo cache, mantém o placeholder do que não resolveu", () => {
    const { outDir, cacheDir } = setupFixture();
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir, "--cache-dir", cacheDir], { encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.fixed.length, 1);
    assert.equal(report.fixed[0].post_id, "post_A");
    assert.equal(report.unresolved.length, 1);
    assert.equal(report.unresolved[0].post_id, "post_B");

    const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.posts.find((p: { post_id: string }) => p.post_id === "post_A").title, "Título real do post A");
    assert.equal(manifest.posts.find((p: { post_id: string }) => p.post_id === "post_B").title, "Post 12/20", "sem cache, placeholder mantido");
  });
});
