import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isStale,
  lagMinutes,
  evaluateStaleness,
  STAGE_CHECKS,
  extractReviewedUrls,
  extractPromptUrlLocal,
  imageUrlsMatch,
  buildGetImageFresh,
} from "../scripts/check-staleness.ts";

describe("isStale (#120)", () => {
  it("detecta upstream mais novo que downstream com gap grande", () => {
    const downstream = Date.parse("2026-04-24T19:33:34Z");
    const upstream = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(isStale(downstream, upstream), true);
  });

  it("não dispara quando downstream é mais novo (caso normal)", () => {
    const downstream = Date.parse("2026-04-24T22:00:00Z");
    const upstream = Date.parse("2026-04-24T19:00:00Z");
    assert.equal(isStale(downstream, upstream), false);
  });

  it("não dispara em diferença <= tolerance (default 1s)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 500), false);
    assert.equal(isStale(t, t + 1000), false);
    assert.equal(isStale(t, t + 1001), true);
  });

  it("tolerance customizada (5s pra clock skew)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 4000, 5000), false);
    assert.equal(isStale(t, t + 6000, 5000), true);
  });

  it("timestamps idênticos não disparam", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t), false);
  });
});

describe("lagMinutes", () => {
  it("calcula minutos arredondados", () => {
    const d = Date.parse("2026-04-24T19:33:34Z");
    const u = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(lagMinutes(d, u), 160); // ~159.65 → 160
  });

  it("zero quando iguais", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(lagMinutes(t, t), 0);
  });
});

describe("evaluateStaleness — orchestration (#120)", () => {
  function mkGetter(mtimes: Record<string, number | null>) {
    return (path: string) => mtimes[path] ?? null;
  }

  it("Stage 6: 03-social.md mais antigo que 02-reviewed.md → flag", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const social = stale.find((s) => s.downstream === "03-social.md");
    assert.ok(social);
    assert.equal(social!.upstream, "02-reviewed.md");
    assert.equal(social!.lag_minutes, 160);
  });

  it("#1710: Stage 6 imagem 04-d1-2x1 mais antiga que SEU PROMPT também flag", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T18:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const img = stale.find((s) => s.downstream === "04-d1-2x1.jpg");
    assert.ok(img);
    assert.equal(img!.upstream, "_internal/02-d1-prompt.md");
  });

  it("#1710: imagem mais nova que o PROMPT mas mais velha que 02-reviewed → NÃO stale", () => {
    // O FP do #1710: editor ajusta texto no 02-reviewed pós-imagem (ou sync pull
    // toca o mtime). A imagem deriva do prompt, não do reviewed — não é stale.
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T20:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T19:00:00Z"), // prompt + velho que img
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"), // reviewed editado DEPOIS
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale.filter((s) => s.downstream.startsWith("04-d")), []);
  });

  it("Stage 6 limpo: imagens depois dos prompts + social depois do reviewed", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:30:00Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
      "04-d1-2x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d1-1x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d2-1x1.jpg": Date.parse("2026-04-24T22:36:00Z"),
      "04-d3-1x1.jpg": Date.parse("2026-04-24T22:37:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d3-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("downstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      // 03-social.md, 04-*.jpg ausentes — Stage 6 nunca rodou
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("upstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:00:00Z"),
      // 02-reviewed.md ausente — situação anômala, mas não trava
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("#1413/#1710: Stage 4 checa imagem vs prompt + 03-social.md vs 02-reviewed", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // imagem stale vs prompt
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed (#1413)
    });
    const stale = evaluateStaleness(STAGE_CHECKS["4"], get);
    // Esperado: 04-d1-2x1.jpg (stale vs prompt) + 03-social.md (stale vs reviewed) = 2
    assert.equal(stale.length, 2);
    const downstreams = stale.map((s) => s.downstream);
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("03-social.md"));
    assert.equal(stale.find((s) => s.downstream === "04-d1-2x1.jpg")!.upstream, "_internal/02-d1-prompt.md");
  });

  it("Stage não-mapeado: vazio", () => {
    const get = mkGetter({});
    const stale = evaluateStaleness(STAGE_CHECKS["99"] ?? [], get);
    assert.deepEqual(stale, []);
  });

  it("retorna múltiplas entries quando vários downstream estão stale", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d1 stale vs prompt
      "04-d2-1x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d2 stale vs prompt
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.equal(stale.length, 3); // 03-social + 04-d1-2x1 + 04-d2-1x1
  });

  it("formato ISO timestamp no output", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.match(stale[0].downstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stale[0].upstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("check_mode é sempre 'mtime'", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.equal(stale[0].check_mode, "mtime");
  });
});

describe("#2287 — image-content-fresh URL suppression", () => {
  // Helpers
  function mkGetter(mtimes: Record<string, number | null>) {
    return (path: string) => mtimes[path] ?? null;
  }

  const imgOldMtime = Date.parse("2026-06-15T08:00:00Z"); // gerada antes do reorder
  const promptNewMtime = Date.parse("2026-06-15T09:30:00Z"); // prompt renomeado = mtime novo

  const checks = [
    { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
  ];

  it("(a) imagem genuinamente stale: getImageFresh=false → stale reportado", () => {
    // Editor trocou artigo em 02-reviewed.md sem regenerar imagem.
    // getImageFresh retorna false (URL mismatch) → mtime stale deve ser reportado.
    const getMtime = mkGetter({
      "04-d1-2x1.jpg": imgOldMtime,
      "_internal/02-d1-prompt.md": promptNewMtime,
    });
    // getImageFresh=false: imagem NÃO está fresca (article-swap sem regenerar)
    const getImageFresh = (_relPath: string) => false;

    const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
    assert.equal(stale.length, 1, "(a) imagem genuinamente stale deve ser reportada");
    assert.equal(stale[0].downstream, "04-d1-2x1.jpg");
    assert.equal(stale[0].check_mode, "mtime");
  });

  it("(b) reorder pós-geração: getImageFresh=true → FP de mtime suprimido", () => {
    // Após reorder: prompts são renomeados (mtime novo), imagem não muda de conteúdo.
    // A URL do prompt bate com o artigo atual → getImageFresh=true → NÃO stale.
    const getMtime = mkGetter({
      "04-d1-2x1.jpg": imgOldMtime,
      "_internal/02-d1-prompt.md": promptNewMtime,
    });
    // getImageFresh=true: imagem está fresca (URL match, apenas prompt foi renomeado)
    const getImageFresh = (_relPath: string) => true;

    const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
    assert.deepEqual(stale, [], "(b) FP de mtime deve ser suprimido quando getImageFresh=true");
  });

  it("sem getImageFresh: imagem stale por mtime (comportamento pré-#2287)", () => {
    const getMtime = mkGetter({
      "04-d1-2x1.jpg": imgOldMtime,
      "_internal/02-d1-prompt.md": promptNewMtime,
    });
    // Sem getImageFresh: mtime puro — stale reportado (inclui FP de reorder)
    const stale = evaluateStaleness(checks, getMtime);
    assert.equal(stale.length, 1, "sem getImageFresh: mtime puro, stale reportado");
    assert.equal(stale[0].check_mode, "mtime");
  });

  it("texto (03-social.md) não é afetado por getImageFresh", () => {
    // getImageFresh só se aplica a imagens, não a arquivos de texto.
    const textChecks = [
      { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
    ];
    const getMtime = mkGetter({
      "03-social.md": Date.parse("2026-06-15T08:00:00Z"),
      "02-reviewed.md": Date.parse("2026-06-15T09:30:00Z"),
    });
    // getImageFresh sempre true — mas não deve afetar arquivos de texto
    const getImageFresh = (_relPath: string) => true;

    const stale = evaluateStaleness(textChecks, getMtime, 1000, getImageFresh);
    assert.equal(stale.length, 1, "texto stale não deve ser suprimido por getImageFresh");
    assert.equal(stale[0].downstream, "03-social.md");
    assert.equal(stale[0].check_mode, "mtime");
  });
});

describe("#2287 — extractReviewedUrls + extractPromptUrlLocal + imageUrlsMatch", () => {
  it("extractReviewedUrls extrai URLs dos destaques do reviewed.md", () => {
    const md = `
## D1 — Título destaque 1

Texto do destaque com [link](https://example.com/article-1).

## D2 — Título destaque 2

Texto com [link](https://example.com/article-2).

## D3 — Título destaque 3

[link](https://example.com/article-3)
`;
    const urls = extractReviewedUrls(md);
    assert.ok(urls.length >= 1, "deve extrair ao menos 1 URL");
    assert.ok(urls.some((u) => u.includes("example.com")), "deve ter URL de exemplo");
  });

  it("extractPromptUrlLocal extrai destaque_url do frontmatter", () => {
    const prompt = `---
destaque_url: https://example.com/article-1
---
# Prompt de imagem
Van Gogh style...`;
    assert.equal(extractPromptUrlLocal(prompt), "https://example.com/article-1");
  });

  it("extractPromptUrlLocal retorna null quando destaque_url ausente", () => {
    const prompt = `# Prompt sem frontmatter\nVan Gogh style...`;
    assert.equal(extractPromptUrlLocal(prompt), null);
  });

  it("imageUrlsMatch: mesma URL → true", () => {
    assert.equal(imageUrlsMatch("https://example.com/article", "https://example.com/article"), true);
  });

  it("imageUrlsMatch: URLs iguais exceto trailing slash → true", () => {
    assert.equal(imageUrlsMatch("https://example.com/article/", "https://example.com/article"), true);
  });

  it("imageUrlsMatch: URLs com UTM params → true (strip tracking)", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article?utm_source=newsletter",
        "https://example.com/article",
      ),
      true,
    );
  });

  it("imageUrlsMatch: URLs diferentes → false", () => {
    assert.equal(imageUrlsMatch("https://example.com/article-1", "https://example.com/article-2"), false);
  });
});

describe("#2287 — buildGetImageFresh (integração com fs real)", () => {
  it("(a) imagem stale real: prompt URL ≠ reviewed URL → getImageFresh=false → stale reportado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      // reviewed.md com D1 = article-NEW (editor trocou o artigo)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `## D1 — Título novo\n\nTexto com [link](https://example.com/article-NEW).\n`,
      );
      // prompt com destaque_url = article-OLD (imagem gerada para artigo antigo)
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `destaque_url: https://example.com/article-OLD\n# Prompt Van Gogh\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined, "buildGetImageFresh deve retornar função");

      // URL mismatch → NOT fresh → stale deve ser reportado
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        false,
        "(a) URL mismatch → getImageFresh=false → imagem stale reportada",
      );

      // Confirmar que evaluateStaleness reporta stale
      const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
      const promptNewMtime = Date.parse("2026-06-15T09:30:00Z");
      const getMtime = (rel: string) => {
        if (rel === "04-d1-2x1.jpg") return imgOldMtime;
        if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
        return null;
      };
      const checks = [{ downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] }];
      const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
      assert.equal(stale.length, 1, "(a) imagem genuinamente stale deve ser reportada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) reorder correto: prompt URL = reviewed URL → getImageFresh=true → FP suprimido", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      const articleUrl = "https://example.com/same-article";

      // reviewed.md e prompt com MESMA URL (reorder: prompt renomeado, artigo igual)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `## D1 — Título\n\nTexto com [link](${articleUrl}).\n`,
      );
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `destaque_url: ${articleUrl}\n# Prompt Van Gogh\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined, "buildGetImageFresh deve retornar função");

      // URL match → IS fresh → FP de mtime deve ser suprimido
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        true,
        "(b) URL match → getImageFresh=true → FP de mtime suprimido",
      );

      // Confirmar que evaluateStaleness NÃO reporta stale
      const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
      const promptNewMtime = Date.parse("2026-06-15T09:30:00Z");
      const getMtime = (rel: string) => {
        if (rel === "04-d1-2x1.jpg") return imgOldMtime;
        if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
        return null;
      };
      const checks = [{ downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] }];
      const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
      assert.deepEqual(stale, [], "(b) FP de mtime deve ser suprimido após reorder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reviewed.md ausente → buildGetImageFresh retorna undefined (degradação graceful)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      // Sem reviewed.md → undefined
      assert.equal(buildGetImageFresh(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prompt sem destaque_url → getImageFresh=false (não suprime)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      writeFileSync(
        join(dir, "02-reviewed.md"),
        `## D1 — Título\n\nTexto com [link](https://example.com/article-1).\n`,
      );
      // Prompt SEM destaque_url (edição legada pré-#606)
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `# Prompt Van Gogh (sem destaque_url)\nAlgum texto de prompt.\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined);
      // Sem destaque_url → null → urlsMatch não pode comparar → false
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        false,
        "prompt sem destaque_url → não suprimir (conservativo)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("STAGE_CHECKS config — fixture do desenho (#120)", () => {
  it("Stage 6 cobre 03-social.md + 4 imagens", () => {
    const downstreams = STAGE_CHECKS["6"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"));
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d1-1x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
    assert.ok(downstreams.includes("04-d3-1x1.jpg"));
  });

  it("#1710: 03-social → 02-reviewed; imagens → seu prompt (não reviewed)", () => {
    const byDown = Object.fromEntries(
      STAGE_CHECKS["6"].map((c) => [c.downstream, c.upstreams]),
    );
    assert.deepEqual(byDown["03-social.md"], ["02-reviewed.md"]);
    assert.deepEqual(byDown["04-d1-2x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d1-1x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d2-1x1.jpg"], ["_internal/02-d2-prompt.md"]);
    assert.deepEqual(byDown["04-d3-1x1.jpg"], ["_internal/02-d3-prompt.md"]);
  });

  it("#1413: Stage 4 cobre imagens + 03-social.md", () => {
    const downstreams = STAGE_CHECKS["4"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"), "social staleness deve estar coberto em S4");
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
  });

  it("Stage 3 checa só 03-social.md", () => {
    assert.equal(STAGE_CHECKS["3"].length, 1);
    assert.equal(STAGE_CHECKS["3"][0].downstream, "03-social.md");
  });
});
