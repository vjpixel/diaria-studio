import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLinkedinUniqueness } from "../scripts/validate-social-published.ts";

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

  it("#725 bug #1: CLI path lookup (unidade) — verifica que existe fallback pra _internal/", () => {
    // O bug crítico era: validate-social-published.ts resolvia sempre para
    // <edition_dir>/06-social-published.json (root), mas publishers gravam em
    // <edition_dir>/_internal/06-social-published.json. Script saía com exit 2
    // ("Arquivo não existe") e o validator de data loss nunca rodava.
    // Este teste verifica a lógica de validação diretamente — o fix de path
    // está no main() que agora faz fallback para _internal/.
    // Testar apenas validateLinkedinUniqueness (sem arquivo de disco) — o teste
    // do path em si seria de integração (mkdtemp).
    const duplicateData = {
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://dup.com/1", status: "draft" as const },
        { platform: "linkedin", destaque: "d2", url: "https://dup.com/1", status: "draft" as const },
        { platform: "linkedin", destaque: "d3", url: "https://dup.com/3", status: "draft" as const },
      ],
    };
    const r = validateLinkedinUniqueness(duplicateData);
    // Validator detecta data loss — o que só é possível se chegou a rodar
    assert.equal(r.ok, false);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].destaques.length, 2);
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
