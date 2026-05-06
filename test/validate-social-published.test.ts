import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLinkedinUniqueness } from "../scripts/validate-social-published.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tests do validador anti-data-loss do publish-social (#266).
 * Detecta drafts LinkedIn que foram salvos como rascunho mas sobrescreveram
 * um ao outro.
 */

describe("validateLinkedinUniqueness (#266)", () => {
  it("ok=true quando 3 LinkedIn posts têm URLs únicas", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/post/1", status: "draft" },
        { platform: "linkedin", destaque: "d2", url: "https://linkedin.com/post/2", status: "draft" },
        { platform: "linkedin", destaque: "d3", url: "https://linkedin.com/post/3", status: "draft" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 3);
    assert.equal(r.linkedin_unique_urls, 3);
    assert.equal(r.duplicates.length, 0);
  });

  it("ok=false quando 3 posts compartilham mesma URL (cenário #266)", () => {
    // Cenário real: agent reportou success em 3 drafts mas só 1 sobreviveu
    const sharedUrl = "https://linkedin.com/post/overwritten";
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: sharedUrl, status: "draft" },
        { platform: "linkedin", destaque: "d2", url: sharedUrl, status: "draft" },
        { platform: "linkedin", destaque: "d3", url: sharedUrl, status: "draft" },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.linkedin_unique_urls, 1);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].url, sharedUrl);
    assert.deepEqual(r.duplicates[0].destaques.sort(), ["d1", "d2", "d3"]);
    assert.match(r.reason ?? "", /duplicada|#266/);
  });

  it("ok=false quando 2 dos 3 posts compartilham URL (parcial)", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/post/1", status: "draft" },
        { platform: "linkedin", destaque: "d2", url: "https://linkedin.com/post/dup", status: "draft" },
        { platform: "linkedin", destaque: "d3", url: "https://linkedin.com/post/dup", status: "draft" },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.linkedin_count, 3);
    assert.equal(r.linkedin_unique_urls, 2); // 2 unique URLs entre 3 posts
    assert.equal(r.duplicates.length, 1);
  });

  it("ignora posts com status 'failed' (não conta como duplicate)", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/post/1", status: "draft" },
        { platform: "linkedin", destaque: "d2", url: null, status: "failed", reason: "linkedin_login_expired" },
        { platform: "linkedin", destaque: "d3", url: "https://linkedin.com/post/3", status: "draft" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 2); // só os successful
    assert.equal(r.linkedin_unique_urls, 2);
  });

  it("ignora posts não-LinkedIn (Facebook não conta)", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/post/1", status: "draft" },
        { platform: "facebook", destaque: "d1", url: "https://fb.com/post/1", status: "scheduled" },
        { platform: "facebook", destaque: "d2", url: "https://fb.com/post/2", status: "scheduled" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 1);
  });

  it("aceita mix draft + scheduled sem flag duplicate", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/post/1", status: "draft" },
        { platform: "linkedin", destaque: "d2", url: "https://linkedin.com/sched/2", status: "scheduled", scheduled_at: "2026-04-29T12:00:00-03:00" },
        { platform: "linkedin", destaque: "d3", url: "https://linkedin.com/sched/3", status: "scheduled", scheduled_at: "2026-04-29T16:00:00-03:00" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 3);
    assert.equal(r.linkedin_unique_urls, 3);
  });

  it("ok=true com posts vazio", () => {
    const r = validateLinkedinUniqueness({ posts: [] });
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 0);
  });

  it("posts com url null não geram duplicate spurious", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: null, status: "failed" },
        { platform: "linkedin", destaque: "d2", url: null, status: "failed" },
      ],
    });
    // Ambos failed → ignored. Sem duplicate.
    assert.equal(r.ok, true);
    assert.equal(r.linkedin_count, 0);
  });

  it("#725 bug #1 (integração): CLI encontra arquivo em _internal/ e detecta duplicates", () => {
    // Bug: script resolvia para <edition_dir>/06-social-published.json (root),
    // mas publishers gravam em <edition_dir>/_internal/. Exit 2 silenciava o
    // validator de data loss. Fix: fallback _internal/ → root.
    const dir = mkdtempSync(join(tmpdir(), "diaria-validate-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const posts = {
        posts: [
          { platform: "linkedin", destaque: "d1", url: "https://dup.com/1", status: "draft" },
          { platform: "linkedin", destaque: "d2", url: "https://dup.com/1", status: "draft" }, // duplicate
          { platform: "linkedin", destaque: "d3", url: "https://dup.com/3", status: "draft" },
        ],
      };
      // Gravar em _internal/ (caminho novo, edições recentes)
      writeFileSync(join(dir, "_internal", "06-social-published.json"), JSON.stringify(posts));
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve(ROOT, "scripts/validate-social-published.ts"), dir],
        { encoding: "utf8", cwd: ROOT },
      );
      // Exit 1 = duplicates detectados (validator rodou corretamente)
      // Exit 2 = arquivo não encontrado (bug antigo)
      assert.equal(result.status, 1, `esperado exit 1 (duplicates), got ${result.status}. stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout.trim());
      assert.equal(json.ok, false);
      assert.equal(json.duplicates.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reason cita #266 pra discoverabilidade", () => {
    const r = validateLinkedinUniqueness({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://x.com/1", status: "draft" },
        { platform: "linkedin", destaque: "d2", url: "https://x.com/1", status: "draft" },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /#266/);
  });
});
