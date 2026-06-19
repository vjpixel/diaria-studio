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
  getStageChecksForEdition,
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
  // Formato real de 02-reviewed.md desde ~260520: **DESTAQUE N | CATEGORIA**
  // (extractReviewedUrls agora delega a extractDestaqueUrls — #2308)
  it("extractReviewedUrls extrai URLs dos destaques do reviewed.md (formato real)", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**[Título destaque 1](https://example.com/article-1)**",
      "",
      "Por que isso importa: texto.",
      "",
      "**DESTAQUE 2 | 📡 RADAR**",
      "",
      "**[Título destaque 2](https://example.com/article-2)**",
      "",
      "Por que isso importa: texto.",
      "",
      "**DESTAQUE 3 | 🛠 USE MELHOR**",
      "",
      "**[Título destaque 3](https://example.com/article-3)**",
      "",
      "Por que isso importa: texto.",
    ].join("\n");
    const urls = extractReviewedUrls(md);
    assert.equal(urls.length, 3, "deve extrair exatamente 3 URLs");
    assert.equal(urls[0], "https://example.com/article-1");
    assert.equal(urls[1], "https://example.com/article-2");
    assert.equal(urls[2], "https://example.com/article-3");
  });

  // #2308 — regressão: URL com parêntese interno (Wikipedia) NÃO é truncada.
  // A implementação local antiga usava /https?:\/\/[^\s\)\"]+/g que parava no
  // primeiro `)` → `https://en.wikipedia.org/wiki/AI_(disambiguation` (truncado).
  // extractDestaqueUrls usa /https?:\/\/[^\s\]<>"]+/ + stripUrlTrailingPunct
  // → preserva URL inteira, só remove `)` desbalanceado no fim.
  it("#2308: URL com parêntese balanceado (Wikipedia) não é truncada em extractReviewedUrls", () => {
    const wikiUrl = "https://en.wikipedia.org/wiki/AI_(disambiguation)";
    const md = [
      "**DESTAQUE 1 | 📡 RADAR**",
      "",
      `**[Inteligência artificial](${wikiUrl})**`,
      "",
      "Por que isso importa: texto.",
    ].join("\n");
    const urls = extractReviewedUrls(md);
    assert.equal(urls.length, 1, "deve extrair 1 URL");
    assert.equal(urls[0], wikiUrl, "URL com parêntese balanceado deve ser extraída inteira");
  });

  it("extractPromptUrlLocal extrai destaque_url do frontmatter", () => {
    const prompt = `---
destaque_url: https://example.com/article-1
---
# Prompt de imagem
Van Gogh style...`;
    assert.equal(extractPromptUrlLocal(prompt), "https://example.com/article-1");
  });

  // #2308: extractPromptUrlLocal agora delega a extractPromptUrl que tem
  // fallback para destaque_url: fora do frontmatter (prompts antigos pré-#606)
  it("extractPromptUrlLocal fallback body-field: destaque_url fora do frontmatter (#2308)", () => {
    const prompt = `# Prompt Van Gogh (sem bloco ---)
destaque_url: https://example.com/legacy-article
Algum texto de prompt.`;
    assert.equal(extractPromptUrlLocal(prompt), "https://example.com/legacy-article");
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

  // #2308: canonicalize() (nova impl) também strip fragment e ref_src — que
  // normalizeUrl() local não removia. Verificar que ref_src é stripped.
  it("imageUrlsMatch: URLs com ref_src param → true (canonicalize strip ref_src, #2308)", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article?ref_src=twsrc%5Etfw",
        "https://example.com/article",
      ),
      true,
    );
  });

  it("imageUrlsMatch: URLs com fragment → true (canonicalize strip fragment, #2308)", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article#section-1",
        "https://example.com/article",
      ),
      true,
    );
  });

  it("imageUrlsMatch: URLs diferentes → false", () => {
    assert.equal(imageUrlsMatch("https://example.com/article-1", "https://example.com/article-2"), false);
  });

  // #2308-finding-2: REGRESSÃO — normalizeUrl() local stripava source/medium/campaign;
  // canonicalize() não os stripava. imageUrlsMatch("url?source=rss", "url") retornava
  // false após o helper-swap — falso-positivo de staleness para URLs descobertas via RSS.
  it("#2308-finding-2: imageUrlsMatch com ?source=rss → true (regressão RSS tracking param)", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article?source=rss",
        "https://example.com/article",
      ),
      true,
      "?source= deve ser stripado (param RSS — antes stripava, regrediu em #2308)",
    );
  });

  it("#2308-finding-2: imageUrlsMatch com ?medium=email → true", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article?medium=email",
        "https://example.com/article",
      ),
      true,
    );
  });

  it("#2308-finding-2: imageUrlsMatch com ?campaign=abc → true", () => {
    assert.equal(
      imageUrlsMatch(
        "https://example.com/article?campaign=abc123",
        "https://example.com/article",
      ),
      true,
    );
  });
});

// Helper: gera 02-reviewed.md no formato real (DESTAQUE N | CATEGORIA) com 1 destaque
function makeReviewedMd(d1Url: string): string {
  return [
    "**DESTAQUE 1 | 📡 RADAR**",
    "",
    `**[Título do destaque](${d1Url})**`,
    "",
    "Por que isso importa: texto de exemplo.",
  ].join("\n");
}

// #2308-finding-6: variante com D2/D3 para cobrir freshMap multi-slot
function makeReviewedMd3(d1Url: string, d2Url: string, d3Url: string): string {
  return [
    "**DESTAQUE 1 | 📡 RADAR**",
    "",
    `**[Título D1](${d1Url})**`,
    "",
    "Por que isso importa: d1.",
    "",
    "**DESTAQUE 2 | 🚀 LANÇAMENTO**",
    "",
    `**[Título D2](${d2Url})**`,
    "",
    "Por que isso importa: d2.",
    "",
    "**DESTAQUE 3 | 🛠 USE MELHOR**",
    "",
    `**[Título D3](${d3Url})**`,
    "",
    "Por que isso importa: d3.",
  ].join("\n");
}

describe("#2287 — buildGetImageFresh (integração com fs real)", () => {
  it("(a) imagem stale real: prompt URL ≠ reviewed URL → getImageFresh=false → stale reportado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      // reviewed.md com D1 = article-NEW (editor trocou o artigo)
      // Usa formato real DESTAQUE N | (#2308: extractDestaqueUrls precisa desse header)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        makeReviewedMd("https://example.com/article-NEW"),
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
      // Usa formato real DESTAQUE N | (#2308: extractDestaqueUrls precisa desse header)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        makeReviewedMd(articleUrl),
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

      // Usa formato real DESTAQUE N | (#2308)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        makeReviewedMd("https://example.com/article-1"),
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

  // #2308-finding-2 regressão end-to-end: URL com ?source=rss não deve causar
  // false staleness. normalizeUrl() local stripava source; canonicalize() não;
  // imageUrlsMatch agora usa pré-strip local antes de delegar a urlsMatch.
  it("#2308-finding-2: ?source=rss em reviewed URL → sem false staleness (regressão RSS)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      const cleanUrl = "https://example.com/article-rss";
      const rssUrl = `${cleanUrl}?source=rss`;

      // reviewed.md tem a URL sem tracking (como publicada)
      writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd(cleanUrl));
      // prompt tem a URL com ?source=rss (como chegou via feed RSS)
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `---\ndestaque_url: ${rssUrl}\n---\n# Prompt Van Gogh\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined, "buildGetImageFresh deve retornar função");

      // ?source=rss é tracking param → deve ser stripado → URLs equivalentes → fresh
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        true,
        "#2308-finding-2: URL com ?source=rss deve ser fresh (sem FP de staleness)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2308-finding-6: D2/D3 freshMap — buildGetImageFresh com 3 destaques
  it("#2308-finding-6: D2/D3 também mapeados no freshMap", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      const d1 = "https://example.com/d1";
      const d2 = "https://example.com/d2";
      const d3 = "https://example.com/d3";
      writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd3(d1, d2, d3));
      writeFileSync(join(dir, "_internal", "02-d1-prompt.md"), `---\ndestaque_url: ${d1}\n---\n`);
      writeFileSync(join(dir, "_internal", "02-d2-prompt.md"), `---\ndestaque_url: ${d2}\n---\n`);
      writeFileSync(join(dir, "_internal", "02-d3-prompt.md"), `---\ndestaque_url: ${d3}\n---\n`);

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined);
      assert.equal(getImageFresh!("04-d1-2x1.jpg"), true, "D1 fresh");
      assert.equal(getImageFresh!("04-d1-1x1.jpg"), true, "D1 1x1 fresh");
      assert.equal(getImageFresh!("04-d2-1x1.jpg"), true, "D2 fresh");
      assert.equal(getImageFresh!("04-d3-1x1.jpg"), true, "D3 fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2308-finding-7: exercitar path de frontmatter de extractPromptUrl
  // via buildGetImageFresh (tests (a)/(b) existentes usam body-field; aqui frontmatter)
  it("#2308-finding-7: extractPromptUrl via frontmatter (--- block) funciona em buildGetImageFresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      const articleUrl = "https://example.com/with-frontmatter";
      writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd(articleUrl));
      // Formato com bloco ---...--- (frontmatter real pós-#606)
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `---\ndestaque_url: ${articleUrl}\nstyle: van-gogh\n---\n# Prompt\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined);
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        true,
        "#2308-finding-7: frontmatter path deve ser lido corretamente",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2308-finding-3: body fallback regex COM âncora ^ não deve capturar
  // `destaque_url:` mid-prose (ex: texto que menciona a chave no meio).
  // O fix: /^destaque_url:\s*(\S+)/m em vez de /destaque_url:\s*(\S+)/.
  it("#2308-finding-3: extractPromptUrlLocal não captura destaque_url mid-prose", () => {
    const prompt = `# Prompt de imagem
Instrução: use o campo destaque_url: do frontmatter para identificar.
Algum texto com destaque_url: https://wrong.example.com/mid-prose
Fim do texto.`;
    // Sem frontmatter e sem destaque_url em linha própria → deve retornar null
    // (o que havia antes: regex sem ^ capturaria "https://wrong.example.com/mid-prose"
    // caso o match encontrasse "destaque_url:" em qualquer posição da linha)
    //
    // Com o fix /^destaque_url:/m, exige que a chave esteja no início da linha.
    // A linha "Algum texto com destaque_url: ..." NÃO começa com `destaque_url:`
    // → null correto.
    assert.equal(
      extractPromptUrlLocal(prompt),
      null,
      "#2308-finding-3: destaque_url mid-prose não deve ser capturado",
    );
  });

  // #2308: regressão end-to-end — URL com parêntese balanceado (Wikipedia) não
  // deve ser truncada em extractReviewedUrls → buildGetImageFresh deve extraí-la
  // corretamente e imageUrlsMatch deve funcionar, sem false staleness.
  it("#2308: URL Wikipedia com parêntese — sem false staleness (regressão end-to-end)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });

      const wikiUrl = "https://en.wikipedia.org/wiki/AI_(disambiguation)";

      // reviewed.md com URL Wikipedia que tem parênteses balanceados
      writeFileSync(
        join(dir, "02-reviewed.md"),
        makeReviewedMd(wikiUrl),
      );
      // prompt com MESMA URL (reorder normal — não é article-swap)
      writeFileSync(
        join(dir, "_internal", "02-d1-prompt.md"),
        `---\ndestaque_url: ${wikiUrl}\n---\n# Prompt Van Gogh\n`,
      );

      const getImageFresh = buildGetImageFresh(dir);
      assert.ok(getImageFresh !== undefined, "buildGetImageFresh deve retornar função");

      // URL com parêntese deve ser extraída INTEIRA e match deve funcionar
      // → getImageFresh=true → NÃO stale (sem false positivo)
      assert.equal(
        getImageFresh!("04-d1-2x1.jpg"),
        true,
        "#2308: URL Wikipedia com parêntese balanceado deve ser fresh (sem FP de staleness)",
      );

      // Confirmar que evaluateStaleness NÃO reporta stale
      const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
      const promptNewMtime = Date.parse("2026-06-15T09:30:00Z"); // prompt mais novo (reorder)
      const getMtime = (rel: string) => {
        if (rel === "04-d1-2x1.jpg") return imgOldMtime;
        if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
        return null;
      };
      const checks = [{ downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] }];
      const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
      assert.deepEqual(stale, [], "#2308: URL Wikipedia com parêntese — sem false staleness");
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

// ---------------------------------------------------------------------------
// #2366 — getStageChecksForEdition: d3 condicional ao destaque_count
// ---------------------------------------------------------------------------

describe("getStageChecksForEdition #2366 — 2-destaque sem d3 FP", () => {
  function makeEditionDir(destaqueCount: 2 | 3): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "check-staleness-2d-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    if (destaqueCount === 2) {
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{ rank: 1 }, { rank: 2 }] }),
      );
    } else {
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{ rank: 1 }, { rank: 2 }, { rank: 3 }] }),
      );
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("edição 2-destaque: checks de Stage 4 não incluem d3", () => {
    const { dir, cleanup } = makeEditionDir(2);
    try {
      const checks = getStageChecksForEdition("4", dir);
      const d3Entries = checks.filter(
        (c) => c.downstream.includes("d3") || c.upstreams.some((u) => u.includes("d3")),
      );
      assert.equal(
        d3Entries.length,
        0,
        `edição 2-destaque não deve ter checks de d3 em Stage 4. Encontrei: ${JSON.stringify(d3Entries)}`,
      );
      // Mas d1 e d2 ainda devem estar
      const d1 = checks.find((c) => c.downstream.includes("d1"));
      const d2 = checks.find((c) => c.downstream.includes("d2"));
      assert.ok(d1, "d1 check deve estar presente em edição 2-destaque");
      assert.ok(d2, "d2 check deve estar presente em edição 2-destaque");
    } finally {
      cleanup();
    }
  });

  it("edição 2-destaque: checks de Stage 6 não incluem d3", () => {
    const { dir, cleanup } = makeEditionDir(2);
    try {
      const checks = getStageChecksForEdition("6", dir);
      const d3Entries = checks.filter(
        (c) => c.downstream.includes("d3") || c.upstreams.some((u) => u.includes("d3")),
      );
      assert.equal(d3Entries.length, 0, `Stage 6 2-destaque não deve ter checks de d3`);
    } finally {
      cleanup();
    }
  });

  it("edição 3-destaque: checks de Stage 4 ainda incluem d3", () => {
    const { dir, cleanup } = makeEditionDir(3);
    try {
      const checks = getStageChecksForEdition("4", dir);
      const d3 = checks.find((c) => c.downstream.includes("d3"));
      assert.ok(d3, "edição 3-destaque deve ter checks de d3 em Stage 4");
    } finally {
      cleanup();
    }
  });

  it("edição 2-destaque: d3 residual NÃO dispara falso-positivo de staleness", () => {
    // Cenário: edição 2-destaque, mas um 04-d3-1x1.jpg de run anterior sobrou no dir.
    // Antes do fix #2366, o check de d3 existia → mtime do d3 residual seria comparado
    // com _internal/02-d3-prompt.md (ausente → getMtime null → skip). Mas com um
    // prompt presente (de uma run anterior), dispararia FP.
    // Com getStageChecksForEdition, o check de d3 é filtrado → nunca dispara.
    const { dir, cleanup } = makeEditionDir(2);
    try {
      const checks = getStageChecksForEdition("4", dir);
      // Simular getMtime que retorna tempos para d3 (como se sobrassem arquivos antigos)
      function getMtime(relPath: string): number | null {
        if (relPath === "04-d3-1x1.jpg") return Date.parse("2026-04-24T18:00:00Z"); // d3 residual
        if (relPath === "_internal/02-d3-prompt.md") return Date.parse("2026-04-24T22:00:00Z"); // prompt "novo"
        if (relPath === "03-social.md") return Date.parse("2026-04-24T23:00:00Z"); // fresco
        if (relPath === "02-reviewed.md") return Date.parse("2026-04-24T22:00:00Z");
        return null;
      }
      const stale = evaluateStaleness(checks, getMtime);
      const d3Stale = stale.filter((s) => s.downstream.includes("d3"));
      assert.equal(
        d3Stale.length,
        0,
        `d3 residual NÃO deve disparar staleness em edição 2-destaque. Encontrei: ${JSON.stringify(d3Stale)}`,
      );
    } finally {
      cleanup();
    }
  });
});
