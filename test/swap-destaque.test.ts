/**
 * test/swap-destaque.test.ts (#2499)
 *
 * Cobre helpers puros + integração filesystem do swap-destaque.ts.
 * Testa o cenário real da issue: promover item de bucket secundário (RADAR)
 * a destaque + rebaixar/remover destaque existente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSocialHashFresh } from "../scripts/lib/invariant-checks/stage-4.ts";
import { hashFromApprovedFile, writeSocialSourceHash } from "../scripts/lib/social-source-hash.ts";
import { refreshSocialHash } from "../scripts/refresh-social-hash.ts";
import {
  extractUrl,
  extractTitle,
  buildSwapDestaqueSteps,
  refreshTituloSubtituloInMd,
  swapInApprovedJson,
  mirrorCappedSwapFallback,
  removeDestaqueBlockFromMd,
  deleteDestaqueImages,
  deleteDestaquePrompts,
  parseSwapArgs,
} from "../scripts/swap-destaque.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HIGHLIGHT_D1 = {
  rank: 1,
  score: 90,
  bucket: "lancamento",
  url: "https://example.com/d1",
  title_options: ["Título D1 opção 1", "Título D1 opção 2"],
};

const HIGHLIGHT_D2 = {
  rank: 2,
  score: 80,
  bucket: "radar",
  url: "https://example.com/d2",
  title_options: ["Título D2 opção 1"],
};

const HIGHLIGHT_D3 = {
  rank: 3,
  score: 70,
  bucket: "radar",
  url: "https://example.com/d3",
  title_options: ["Título D3 opção 1"],
};

const RADAR_ITEM_0 = {
  url: "https://example.com/radar-0",
  title: "Item RADAR 0",
};

const RADAR_ITEM_1 = {
  url: "https://example.com/radar-1",
  title: "Item RADAR 1",
};

/** Creates a minimal 02-reviewed.md with 3 DESTAQUE blocks */
function makeReviewedMd(): string {
  return `---
intentional_error:
  location: "DESTAQUE 2, parágrafo 1"
  category: factual
  description: "Erro de teste"
  correct_value: "valor correto"
---

Intro texto.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Artigo D1](https://example.com/d1)**

Texto do destaque 1. Por que isso importa: relevância 1.

---

**DESTAQUE 2 | 📡 RADAR**

**[Artigo D2](https://example.com/d2)**

Texto do destaque 2. Por que isso importa: relevância 2.

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Artigo D3](https://example.com/d3)**

Texto do destaque 3. Por que isso importa: relevância 3.

---

**📡 RADAR**

[Link radar](https://example.com/r)

Descrição radar.
`;
}

// ---------------------------------------------------------------------------
// Helper: create temp edition dir with fixtures
// ---------------------------------------------------------------------------

function makeTempEdition(opts: {
  withMd?: boolean;
  withImages?: boolean;
  withPrompts?: boolean;
  withSocialHash?: boolean;
  customApproved?: Record<string, unknown>;
  withCapped?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-destaque-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  const approved: Record<string, unknown> = opts.customApproved ?? {
    highlights: [HIGHLIGHT_D1, HIGHLIGHT_D2, HIGHLIGHT_D3],
    runners_up: [],
    lancamento: [],
    radar: [RADAR_ITEM_0, RADAR_ITEM_1],
    use_melhor: [],
    video: [],
  };

  writeFileSync(join(internalDir, "01-approved.json"), JSON.stringify(approved, null, 2));

  if (opts.withCapped !== false) {
    // Write capped version (same highlights for simplicity in tests)
    const capped = {
      ...approved,
      highlights: (approved.highlights as unknown[]).slice(),
    };
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify(capped, null, 2));
  }

  if (opts.withMd) {
    writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd());
  }

  if (opts.withImages) {
    writeFileSync(join(dir, "04-d1-2x1.jpg"), "img-d1-2x1");
    writeFileSync(join(dir, "04-d1-1x1.jpg"), "img-d1-1x1");
    writeFileSync(join(dir, "04-d2-1x1.jpg"), "img-d2-1x1");
    writeFileSync(join(dir, "04-d3-1x1.jpg"), "img-d3-1x1");
  }

  if (opts.withPrompts) {
    writeFileSync(join(internalDir, "02-d1-prompt.md"), "---\ndestaque_url: https://example.com/d1\n---\nPrompt d1.");
    writeFileSync(join(internalDir, "02-d2-prompt.md"), "---\ndestaque_url: https://example.com/d2\n---\nPrompt d2.");
    writeFileSync(join(internalDir, "02-d3-prompt.md"), "---\ndestaque_url: https://example.com/d3\n---\nPrompt d3.");
    writeFileSync(join(internalDir, "02-d1-sd-prompt.json"), '{"prompt":"sd d1"}');
  }

  if (opts.withSocialHash) {
    writeFileSync(
      join(internalDir, ".social-source-hash.json"),
      JSON.stringify({ hash: "oldhash123" }),
    );
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Tests: extractUrl
// ---------------------------------------------------------------------------

describe("extractUrl (#2499)", () => {
  it("flat shape: reads .url", () => {
    assert.equal(extractUrl({ url: "https://a.com" }), "https://a.com");
  });

  it("nested shape: reads .article.url over .url", () => {
    assert.equal(
      extractUrl({ url: "https://outer.com", article: { url: "https://inner.com" } }),
      "https://outer.com", // flat .url takes precedence (we read .url first)
    );
  });

  it("nested shape only: falls back to article.url when no top-level url", () => {
    assert.equal(
      extractUrl({ article: { url: "https://nested.com" } }),
      "https://nested.com",
    );
  });

  it("returns empty string when no url found", () => {
    assert.equal(extractUrl({ title: "no url" }), "");
  });
});

// ---------------------------------------------------------------------------
// Tests: extractTitle
// ---------------------------------------------------------------------------

describe("extractTitle (#2499)", () => {
  it("prefers title_options[0]", () => {
    assert.equal(
      extractTitle({ title_options: ["First", "Second"], title: "Other" }),
      "First",
    );
  });

  it("falls back to .title", () => {
    assert.equal(extractTitle({ title: "My Title" }), "My Title");
  });

  it("falls back to article.title_options[0]", () => {
    assert.equal(
      extractTitle({ article: { title_options: ["Nested First"] } }),
      "Nested First",
    );
  });

  it("returns placeholder when no title found", () => {
    assert.equal(extractTitle({ url: "https://a.com" }), "(sem título)");
  });
});

// ---------------------------------------------------------------------------
// Tests: swapInApprovedJson (core logic)
// ---------------------------------------------------------------------------

describe("swapInApprovedJson (#2499)", () => {
  it("promotes radar[0] to D1, keeps D1 in radar (not dropped)", () => {
    const data: Record<string, unknown> = {
      highlights: [
        { ...HIGHLIGHT_D1 },
        { ...HIGHLIGHT_D2 },
        { ...HIGHLIGHT_D3 },
      ],
      radar: [{ ...RADAR_ITEM_0 }, { ...RADAR_ITEM_1 }],
    };

    const result = swapInApprovedJson(data, "radar", 0, 0, false);
    assert.equal(result.ok, true);

    const highlights = data.highlights as Record<string, unknown>[];
    const radar = data.radar as Record<string, unknown>[];

    // D1 position now has RADAR_ITEM_0
    assert.equal(extractUrl(highlights[0]), "https://example.com/radar-0");
    // D2 and D3 unchanged
    assert.equal(extractUrl(highlights[1]), "https://example.com/d2");
    assert.equal(extractUrl(highlights[2]), "https://example.com/d3");
    // Old D1 demoted → prepended to radar
    assert.equal(extractUrl(radar[0]), "https://example.com/d1");
    // RADAR_ITEM_0 removed from radar
    assert.equal(extractUrl(radar[1]), "https://example.com/radar-1");
    assert.equal(radar.length, 2); // 0 removed, 1 added = same length
  });

  it("promotes radar[0] to D3, drops D3 (--drop)", () => {
    const data: Record<string, unknown> = {
      highlights: [
        { ...HIGHLIGHT_D1 },
        { ...HIGHLIGHT_D2 },
        { ...HIGHLIGHT_D3 },
      ],
      radar: [{ ...RADAR_ITEM_0 }, { ...RADAR_ITEM_1 }],
    };

    const result = swapInApprovedJson(data, "radar", 0, 2, true);
    assert.equal(result.ok, true);

    const highlights = data.highlights as Record<string, unknown>[];
    const radar = data.radar as Record<string, unknown>[];

    // D3 position now has RADAR_ITEM_0
    assert.equal(extractUrl(highlights[2]), "https://example.com/radar-0");
    // Old D3 NOT in radar (dropped)
    const radarUrls = radar.map(extractUrl);
    assert.ok(!radarUrls.includes("https://example.com/d3"), "D3 should not be in radar when dropped");
    // RADAR_ITEM_1 still present
    assert.equal(radar.length, 1);
    assert.equal(extractUrl(radar[0]), "https://example.com/radar-1");
  });

  it("promotes radar[1] to D2, radar shrinks by 1 item", () => {
    const data: Record<string, unknown> = {
      highlights: [
        { ...HIGHLIGHT_D1 },
        { ...HIGHLIGHT_D2 },
        { ...HIGHLIGHT_D3 },
      ],
      radar: [{ ...RADAR_ITEM_0 }, { ...RADAR_ITEM_1 }],
    };

    swapInApprovedJson(data, "radar", 1, 1, false);

    const highlights = data.highlights as Record<string, unknown>[];
    const radar = data.radar as Record<string, unknown>[];

    assert.equal(extractUrl(highlights[1]), "https://example.com/radar-1");
    // Old D2 prepended to radar; RADAR_ITEM_1 removed → net 2 items still
    assert.equal(extractUrl(radar[0]), "https://example.com/d2");
    assert.equal(radar.length, 2);
  });

  it("returns ok:false when highlights[] absent", () => {
    const data: Record<string, unknown> = { radar: [{ ...RADAR_ITEM_0 }] };
    const result = swapInApprovedJson(data, "radar", 0, 0, false);
    assert.equal(result.ok, false);
    // No mutation
    assert.ok(!Object.hasOwn(data, "highlights") || !Array.isArray(data.highlights));
  });

  it("returns ok:false when demotePos out of range (pre-condition invalid → no mutation)", () => {
    const data: Record<string, unknown> = {
      highlights: [{ ...HIGHLIGHT_D1 }], // only 1 highlight
      radar: [{ ...RADAR_ITEM_0 }],
    };
    const before = JSON.stringify(data);
    const result = swapInApprovedJson(data, "radar", 0, 2, false); // pos 2 = D3, doesn't exist
    assert.equal(result.ok, false);
    // JSON unchanged (atomicity: pre-condition failed before any mutation)
    assert.equal(JSON.stringify(data), before);
  });

  it("returns ok:false when promoteIdx out of range (pre-condition invalid → no mutation)", () => {
    const data: Record<string, unknown> = {
      highlights: [{ ...HIGHLIGHT_D1 }, { ...HIGHLIGHT_D2 }, { ...HIGHLIGHT_D3 }],
      radar: [{ ...RADAR_ITEM_0 }], // only 1 item
    };
    const before = JSON.stringify(data);
    const result = swapInApprovedJson(data, "radar", 5, 0, false); // idx 5 doesn't exist
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(data), before);
  });

  it("returns ok:false when source bucket absent (pre-condition invalid → no mutation)", () => {
    const data: Record<string, unknown> = {
      highlights: [{ ...HIGHLIGHT_D1 }],
      // no radar bucket
    };
    const before = JSON.stringify(data);
    const result = swapInApprovedJson(data, "radar", 0, 0, false);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(data), before);
  });

  it("promotes runners_up item to D1", () => {
    const runner = { url: "https://example.com/runner-0", title: "Runner Item" };
    const data: Record<string, unknown> = {
      highlights: [{ ...HIGHLIGHT_D1 }, { ...HIGHLIGHT_D2 }],
      runners_up: [runner],
    };
    const result = swapInApprovedJson(data, "runners_up", 0, 0, false);
    assert.equal(result.ok, true);

    const highlights = data.highlights as Record<string, unknown>[];
    assert.equal(extractUrl(highlights[0]), "https://example.com/runner-0");
    // Old D1 prepended to runners_up
    const runnersUp = data.runners_up as Record<string, unknown>[];
    assert.equal(extractUrl(runnersUp[0]), "https://example.com/d1");
  });
});

// ---------------------------------------------------------------------------
// Tests: removeDestaqueBlockFromMd
// ---------------------------------------------------------------------------

describe("removeDestaqueBlockFromMd (#2499)", () => {
  it("replaces DESTAQUE 1 block with placeholder containing promoted title+url", () => {
    const md = makeReviewedMd();
    const result = removeDestaqueBlockFromMd(
      md,
      1,
      "Novo Item RADAR",
      "https://example.com/radar-0",
    );
    assert.ok(result.includes("DESTAQUE 1"), "still has DESTAQUE 1 header");
    assert.ok(result.includes("Novo Item RADAR"), "placeholder has promoted title");
    assert.ok(result.includes("https://example.com/radar-0"), "placeholder has promoted URL");
    assert.ok(result.includes("TEXTO PENDENTE"), "placeholder indicates re-render needed");
    // Original D1 text removed
    assert.ok(!result.includes("Artigo D1"), "original D1 title should be removed");
    assert.ok(!result.includes("Texto do destaque 1"), "original D1 body should be removed");
    // D2 and D3 preserved
    assert.ok(result.includes("Artigo D2"), "D2 preserved");
    assert.ok(result.includes("Artigo D3"), "D3 preserved");
    // RADAR section preserved
    assert.ok(result.includes("**📡 RADAR**"), "RADAR section preserved");
  });

  it("replaces DESTAQUE 3 block while preserving D1, D2, and RADAR", () => {
    const md = makeReviewedMd();
    const result = removeDestaqueBlockFromMd(
      md,
      3,
      "Promoção do RADAR",
      "https://example.com/new-d3",
    );
    assert.ok(result.includes("Artigo D1"), "D1 preserved");
    assert.ok(result.includes("Artigo D2"), "D2 preserved");
    assert.ok(result.includes("Promoção do RADAR"), "placeholder has promoted title");
    assert.ok(!result.includes("Artigo D3"), "old D3 removed from newsletter block");
    assert.ok(result.includes("**📡 RADAR**"), "RADAR section preserved");
  });

  it("returns original MD when position doesn't exist", () => {
    const md = makeReviewedMd();
    const result = removeDestaqueBlockFromMd(md, 3, "T", "https://u.com");
    // With only 3 blocks and position 3, it should replace block 3
    // (the test fixture has 3 blocks, so this IS valid — let's test with position 4)
    const md2 = "**DESTAQUE 1 | X**\n\n**[Link](https://a.com)**\n\nTexto.";
    const result2 = removeDestaqueBlockFromMd(md2, 3, "T", "https://u.com");
    assert.equal(result2, md2, "no-op when position doesn't exist");
  });
});

// ---------------------------------------------------------------------------
// Tests: deleteDestaqueImages
// ---------------------------------------------------------------------------

describe("deleteDestaqueImages (#2499)", () => {
  it("deletes 04-d1-*.jpg files", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-imgs-"));
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "data");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "data");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data"); // should NOT be deleted

      const deleted = deleteDestaqueImages(dir, 1, false);
      assert.equal(deleted.length, 2);
      assert.ok(!existsSync(join(dir, "04-d1-2x1.jpg")), "d1 2x1 deleted");
      assert.ok(!existsSync(join(dir, "04-d1-1x1.jpg")), "d1 1x1 deleted");
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")), "d2 untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run does not delete files", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-imgs-dry-"));
    try {
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data");
      const deleted = deleteDestaqueImages(dir, 2, true);
      assert.equal(deleted.length, 1, "reports what would be deleted");
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")), "file still exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when no files match", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-imgs-empty-"));
    try {
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data");
      const deleted = deleteDestaqueImages(dir, 3, false); // d3, but only d2 exists
      assert.equal(deleted.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: deleteDestaquePrompts
// ---------------------------------------------------------------------------

describe("deleteDestaquePrompts (#2499)", () => {
  it("deletes 02-d1-prompt.md, sd-prompt.json, draft.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-prompts-"));
    try {
      writeFileSync(join(dir, "02-d1-prompt.md"), "p1");
      writeFileSync(join(dir, "02-d1-sd-prompt.json"), "sd1");
      writeFileSync(join(dir, "02-d2-prompt.md"), "p2"); // should NOT be deleted

      const deleted = deleteDestaquePrompts(dir, 1, false);
      assert.equal(deleted.length, 2);
      assert.ok(!existsSync(join(dir, "02-d1-prompt.md")));
      assert.ok(!existsSync(join(dir, "02-d1-sd-prompt.json")));
      assert.ok(existsSync(join(dir, "02-d2-prompt.md")), "d2 untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run does not delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-prompts-dry-"));
    try {
      writeFileSync(join(dir, "02-d3-prompt.md"), "p3");
      const deleted = deleteDestaquePrompts(dir, 3, true);
      assert.equal(deleted.length, 1);
      assert.ok(existsSync(join(dir, "02-d3-prompt.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: parseSwapArgs
// ---------------------------------------------------------------------------

describe("parseSwapArgs (#2499)", () => {
  it("parses valid args with --promote radar:0 --demote d1", () => {
    const args = parseSwapArgs([
      "--edition", "260623",
      "--promote", "radar:0",
      "--demote", "d1",
    ]);
    assert.equal(args.edition, "260623");
    assert.equal(args.promote.bucket, "radar");
    assert.equal(args.promote.idx, 0);
    assert.equal(args.demote, "d1");
    assert.equal(args.drop, false);
    assert.equal(args.dryRun, false);
  });

  it("parses --drop and --dry-run flags", () => {
    const args = parseSwapArgs([
      "--edition", "260623",
      "--promote", "runners_up:2",
      "--demote", "d3",
      "--drop",
      "--dry-run",
    ]);
    assert.equal(args.drop, true);
    assert.equal(args.dryRun, true);
    assert.equal(args.demote, "d3");
  });

  it("parses --edition-dir override", () => {
    const args = parseSwapArgs([
      "--edition", "260623",
      "--promote", "lancamento:0",
      "--demote", "d2",
      "--edition-dir", "/tmp/test",
    ]);
    assert.equal(args.editionDir, "/tmp/test");
  });

  it("all valid source buckets are accepted", () => {
    for (const bucket of ["radar", "lancamento", "use_melhor", "video", "runners_up"] as const) {
      const args = parseSwapArgs([
        "--edition", "260623",
        "--promote", `${bucket}:0`,
        "--demote", "d1",
      ]);
      assert.equal(args.promote.bucket, bucket);
    }
  });
});

describe("parseSwapArgs — default editionDir via #3491 (mesma classe de #3483/#3484)", () => {
  // Antes do #3491, sem --edition-dir (comando editor-invocado diretamente,
  // sem caller fixo que sempre passe a flag), o default construía
  // `data/editions/{AAMMDD}` à mão (layout FLAT). Numa edição já migrada pro
  // layout nested (`{AAMM}/{AAMMDD}`, #2463/#3024), isso apontava pra um dir
  // que não existe — o resto do script falha com "Edition dir não encontrado".
  it("resolve edição no layout NESTED via --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-dest-nested-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseSwapArgs([
        "--edition", "260517",
        "--promote", "radar:0",
        "--demote", "d1",
        "--editions-dir", dir,
      ]);
      assert.equal(args.editionDir, nestedEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve edição no layout FLAT legado via --editions-dir (compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-dest-flat-"));
    try {
      const flatEditionDir = join(dir, "260421");
      mkdirSync(flatEditionDir, { recursive: true });
      const args = parseSwapArgs([
        "--edition", "260421",
        "--promote", "radar:0",
        "--demote", "d1",
        "--editions-dir", dir,
      ]);
      assert.equal(args.editionDir, flatEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--edition-dir explícito continua tendo precedência sobre --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-dest-precedence-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseSwapArgs([
        "--edition", "260517",
        "--promote", "radar:0",
        "--demote", "d1",
        "--editions-dir", dir,
        "--edition-dir", "/custom/override",
      ]);
      assert.equal(args.editionDir, "/custom/override");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end filesystem integration
// ---------------------------------------------------------------------------

describe("swap-destaque e2e integration (#2499)", () => {
  it("full swap: promote radar[0] to D1, demote D1 back to radar (not dropped)", () => {
    const dir = makeTempEdition({
      withMd: true,
      withImages: true,
      withPrompts: true,
      withSocialHash: true,
      withCapped: true,
    });
    const internalDir = join(dir, "_internal");

    try {
      // Import and call main logic directly via the exported helpers
      // (avoids process.exit by calling swapInApprovedJson etc. directly)
      const approvedPath = join(internalDir, "01-approved.json");
      const approvedCappedPath = join(internalDir, "01-approved-capped.json");
      const mdPath = join(dir, "02-reviewed.md");

      // Read before state
      const before = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
      const beforeHighlights = before.highlights as Record<string, unknown>[];
      const beforeRadar = before.radar as Record<string, unknown>[];
      const oldD1Url = extractUrl(beforeHighlights[0]);
      const oldRadar0Url = extractUrl(beforeRadar[0]);

      // Simulate what the main() function does:
      // 1. Swap in approved.json
      const swapResult = swapInApprovedJson(before, "radar", 0, 0, false);
      assert.equal(swapResult.ok, true, "swap should succeed");
      writeFileSync(approvedPath, JSON.stringify(before, null, 2) + "\n");

      // 2. Swap in capped.json
      const capped = JSON.parse(readFileSync(approvedCappedPath, "utf8")) as Record<string, unknown>;
      swapInApprovedJson(capped, "radar", 0, 0, false);
      writeFileSync(approvedCappedPath, JSON.stringify(capped, null, 2) + "\n");

      // 3. Social hash NÃO é regravado no swap (#9169).

      // 4. Update 02-reviewed.md
      const md = readFileSync(mdPath, "utf8");
      const updatedMd = removeDestaqueBlockFromMd(md, 1, "Item RADAR 0", oldRadar0Url);
      writeFileSync(mdPath, updatedMd);

      // 5. Delete old D1 images
      deleteDestaqueImages(dir, 1, false);

      // 6. Delete old D1 prompts
      deleteDestaquePrompts(internalDir, 1, false);

      // --- ASSERTIONS ---

      // highlights[0] is now the old RADAR item
      const afterApproved = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
      const afterHighlights = afterApproved.highlights as Record<string, unknown>[];
      const afterRadar = afterApproved.radar as Record<string, unknown>[];

      assert.equal(
        extractUrl(afterHighlights[0]),
        oldRadar0Url,
        "D1 position now has old radar[0]",
      );
      assert.equal(
        extractUrl(afterHighlights[1]),
        "https://example.com/d2",
        "D2 unchanged",
      );
      assert.equal(
        extractUrl(afterHighlights[2]),
        "https://example.com/d3",
        "D3 unchanged",
      );

      // Old D1 is now in radar[0]
      assert.equal(
        extractUrl(afterRadar[0]),
        oldD1Url,
        "old D1 demoted back to radar[0]",
      );
      // radar[1] is old radar[1]
      assert.equal(
        extractUrl(afterRadar[1]),
        "https://example.com/radar-1",
      );

      // Hash social: não coberto aqui (esta simulação não roda o main());
      // o guard real é o teste de CLI do #9169 no fim do arquivo.

      // 02-reviewed.md has placeholder for D1
      const afterMd = readFileSync(mdPath, "utf8");
      assert.ok(afterMd.includes("TEXTO PENDENTE"), "MD has placeholder");
      assert.ok(afterMd.includes("Item RADAR 0"), "promoted title in placeholder");
      assert.ok(!afterMd.includes("Artigo D1"), "old D1 title removed from newsletter block");

      // D1 images deleted
      assert.ok(!existsSync(join(dir, "04-d1-2x1.jpg")), "d1 2x1 image deleted");
      assert.ok(!existsSync(join(dir, "04-d1-1x1.jpg")), "d1 1x1 image deleted");
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")), "d2 image untouched");
      assert.ok(existsSync(join(dir, "04-d3-1x1.jpg")), "d3 image untouched");

      // D1 prompts deleted
      assert.ok(!existsSync(join(internalDir, "02-d1-prompt.md")), "d1 prompt deleted");
      assert.ok(!existsSync(join(internalDir, "02-d1-sd-prompt.json")), "d1 sd-prompt deleted");
      assert.ok(existsSync(join(internalDir, "02-d2-prompt.md")), "d2 prompt untouched");
      assert.ok(existsSync(join(internalDir, "02-d3-prompt.md")), "d3 prompt untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("full swap: promote radar[0] to D3, drop D3 (--drop)", () => {
    const dir = makeTempEdition({
      withImages: true,
      withCapped: true,
    });
    const internalDir = join(dir, "_internal");

    try {
      const approvedPath = join(internalDir, "01-approved.json");
      const data = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;

      const result = swapInApprovedJson(data, "radar", 0, 2, true); // drop=true
      assert.equal(result.ok, true);
      writeFileSync(approvedPath, JSON.stringify(data, null, 2) + "\n");

      const after = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
      const afterHighlights = after.highlights as Record<string, unknown>[];
      const afterRadar = after.radar as Record<string, unknown>[];

      // D3 now has RADAR item
      assert.equal(extractUrl(afterHighlights[2]), "https://example.com/radar-0");
      // Old D3 NOT in radar
      const radarUrls = afterRadar.map(extractUrl);
      assert.ok(
        !radarUrls.includes("https://example.com/d3"),
        "old D3 should not be in radar when dropped",
      );
      // radar only has RADAR_ITEM_1 (RADAR_ITEM_0 was promoted, D3 was dropped)
      assert.equal(afterRadar.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomicity: invalid precondition does not mutate approved.json", () => {
    const dir = makeTempEdition({ withCapped: false });
    const internalDir = join(dir, "_internal");

    try {
      const approvedPath = join(internalDir, "01-approved.json");
      const beforeContent = readFileSync(approvedPath, "utf8");

      // Attempt swap with out-of-range index (should fail before any mutation)
      const data = JSON.parse(beforeContent) as Record<string, unknown>;
      const result = swapInApprovedJson(data, "radar", 99, 0, false); // idx 99 out of range
      assert.equal(result.ok, false, "should fail on invalid precondition");

      // Verify data was NOT mutated
      assert.equal(JSON.stringify(data), JSON.stringify(JSON.parse(beforeContent)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Regression tests: #2521
// ---------------------------------------------------------------------------

describe("swapInApprovedJson fallback-capped regression (#2521 Bug 1)", () => {
  /**
   * Regression for #2521 Bug 1:
   * When cappedSwap.ok=false (bucket absent/short in capped JSON), the fallback
   * must ALSO return the demoted item to the bucket (when --drop omitted),
   * mirroring the approved.json logic.
   */
  it("fallback (cappedSwap.ok=false, no --drop): returns demoted item to bucket in capped JSON", () => {
    // Capped JSON has radar bucket ABSENT — swapInApprovedJson returns ok:false.
    // The fallback code must still create/prepend the demoted item to the bucket.
    const cappedData: Record<string, unknown> = {
      highlights: [
        { ...HIGHLIGHT_D1 },
        { ...HIGHLIGHT_D2 },
        { ...HIGHLIGHT_D3 },
      ],
      // radar bucket intentionally absent → swapInApprovedJson returns ok:false
    };

    const demotePos = 0; // D1 position
    const drop = false;
    const promotedItem = { ...RADAR_ITEM_0 };

    // Confirm swapInApprovedJson fails (triggering the fallback path)
    const attempt = swapInApprovedJson(cappedData, "radar", 0, demotePos, drop);
    assert.equal(attempt.ok, false, "swapInApprovedJson should fail when bucket absent");

    // #2521 review: exercita o CÓDIGO REAL (mirrorCappedSwapFallback), não uma
    // re-implementação inline — deletar o fallback de main() faz este teste falhar.
    const cappedHighlights = cappedData.highlights as Record<string, unknown>[];
    const fb = mirrorCappedSwapFallback(cappedData, "radar", demotePos, drop, promotedItem);
    assert.equal(fb.synced, true, "fallback deve sincronizar quando highlights[] cobre demotePos");

    // Verify: highlights[0] is now the promoted item
    assert.equal(
      extractUrl(cappedHighlights[0]),
      "https://example.com/radar-0",
      "promoted item must be in highlights[0]",
    );
    // Verify: demoted item is now in the radar bucket (was absent, now created)
    const resultBucket = cappedData["radar"] as Record<string, unknown>[];
    assert.ok(Array.isArray(resultBucket), "radar bucket must be created when absent");
    assert.equal(
      extractUrl(resultBucket[0]),
      "https://example.com/d1",
      "demoted D1 must be prepended to radar bucket even when bucket was absent in capped JSON",
    );
  });

  it("fallback (cappedSwap.ok=false, --drop): does NOT add demoted item to bucket", () => {
    // When --drop is true, even the fallback must not return the demoted item.
    const cappedData: Record<string, unknown> = {
      highlights: [
        { ...HIGHLIGHT_D1 },
        { ...HIGHLIGHT_D2 },
        { ...HIGHLIGHT_D3 },
      ],
      // radar bucket short (only 1 item at idx 0, but promoteIdx=99 → fail)
      radar: [{ ...RADAR_ITEM_0 }],
    };

    const demotePos = 0;
    const drop = true;
    const promotedItem = { ...RADAR_ITEM_1 };

    const attempt = swapInApprovedJson(cappedData, "radar", 99, demotePos, drop); // idx 99 → fail
    assert.equal(attempt.ok, false, "swapInApprovedJson should fail with out-of-range idx");

    // #2521 review: código real (mirrorCappedSwapFallback) com drop=true — não
    // deve devolver o rebaixado ao bucket.
    const fb = mirrorCappedSwapFallback(cappedData, "radar", demotePos, drop, promotedItem);
    assert.equal(fb.synced, true);

    // radar bucket unchanged (demoted item NOT added, since drop=true)
    const resultBucket = cappedData["radar"] as Record<string, unknown>[];
    const urls = resultBucket.map(extractUrl);
    assert.ok(
      !urls.includes("https://example.com/d1"),
      "demoted item must NOT be in bucket when --drop is true",
    );
    assert.equal(resultBucket.length, 1, "bucket unchanged when --drop=true");
  });

  it("highlights[] curto demais pro demotePos → synced:false + warning (fail-loud, #2521 review)", () => {
    // Capped com highlights[] de 1 item, mas demotePos=2 (slot inexistente) →
    // não dá pra espelhar o swap; deve avisar em vez de divergir em silêncio.
    const cappedData: Record<string, unknown> = {
      highlights: [{ ...HIGHLIGHT_D1 }],
      radar: [{ ...RADAR_ITEM_0 }],
    };
    const fb = mirrorCappedSwapFallback(cappedData, "radar", 2, false, { ...RADAR_ITEM_1 });
    assert.equal(fb.synced, false, "não sincroniza quando o slot demotePos não existe");
    assert.match(
      fb.warning ?? "",
      /demotePos=2|slot inexistente|divergência/i,
      "deve emitir warning explícito (fail-loud)",
    );
    assert.equal((cappedData.highlights as unknown[]).length, 1, "highlights[] não cresce (sem slot fantasma)");
  });
});

describe("removeDestaqueBlockFromMd fail-loud regression (#2521 Bug 2)", () => {
  /**
   * Regression for #2521 Bug 2:
   * When the MD has no '---' separators, blockRe finds no blocks.
   * The function must emit a console.error warning instead of returning the
   * unchanged MD silently — so the editor knows the placeholder was NOT inserted.
   */
  it("emits console.error when only 1 block found but position 3 requested (no '---' between destaques)", () => {
    // Without '---' separators between DESTAQUE blocks, blockRe matches one
    // giant block from the first DESTAQUE to EOF. Requesting position 3 (which
    // doesn't exist as a separate block) must emit a fail-loud error.
    const mdNoSep = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**[Artigo](https://example.com/d1)**",
      "",
      "Texto sem separadores entre blocos.",
      "",
      "**DESTAQUE 2 | 📡 RADAR**",
      "",
      "**[Artigo2](https://example.com/d2)**",
      "",
      "Texto do destaque 2.",
    ].join("\n");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    let result: string;
    try {
      // Position 3 requested but only 1 block found (no separators → merged)
      result = removeDestaqueBlockFromMd(mdNoSep, 3, "Item Novo", "https://example.com/novo");
    } finally {
      console.error = origError;
    }

    // Must return original MD unchanged (placeholder NOT inserted for pos 3)
    assert.equal(result!, mdNoSep, "must return original MD when position exceeds block count");
    // Must emit at least one console.error mentioning the problem
    assert.ok(errors.length > 0, "must emit console.error when position exceeds block count");
    assert.ok(
      errors.some((e) => /placeholder.*NÃO|bloco|posição|separadores/i.test(e)),
      `expected warning about missing position, got: ${errors.join(" | ")}`,
    );
  });

  it("emits console.error when blocks found but position exceeds count", () => {
    // MD with only 1 DESTAQUE block + separator, but requesting position 3
    const mdOnlyOne = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**[Artigo](https://example.com/d1)**",
      "",
      "Texto do destaque.",
      "",
      "---",
      "",
      "**📡 RADAR**",
      "",
      "Seção de radar.",
    ].join("\n");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    let result: string;
    try {
      result = removeDestaqueBlockFromMd(mdOnlyOne, 3, "Item Promovido", "https://example.com/novo");
    } finally {
      console.error = origError;
    }

    assert.equal(result!, mdOnlyOne, "must return original MD unchanged");
    assert.ok(errors.length > 0, "must emit console.error when position exceeds block count");
    assert.ok(
      errors.some((e) => /placeholder.*NÃO|bloco|posição|separadores/i.test(e)),
      `expected warning about missing position, got: ${errors.join(" | ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// #9169: hash social compatível com o check do Stage 4 + ordem dos re-renders
// (espelho do #9149 no swap-destaques.ts)
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "swap-destaque.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", SCRIPT, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

describe("swap-destaque.ts × social-hash-fresh (#9169)", () => {
  it("não recarimba o hash no swap (guard do #1413 segue armado) e splice + refresh-social-hash fazem o check passar", () => {
    const dir = makeTempEdition({ withMd: true });
    const internalDir = join(dir, "_internal");
    try {
      // Estado pré-swap: social gerado e carimbado pela lib (como o merge-social-md faz).
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto d1 antigo.\n");
      writeSocialSourceHash(internalDir, hashFromApprovedFile(join(internalDir, "01-approved.json")));
      const hashBefore = readFileSync(join(internalDir, ".social-source-hash.json"), "utf8");
      assert.deepEqual(checkSocialHashFresh(dir), []);

      const { status, stdout, stderr } = runCli([
        "--edition", "260929", "--edition-dir", dir,
        "--promote", "radar:0", "--demote", "d1",
      ]);
      assert.equal(status, 0, stderr);

      // Hash intocado: o 03-social.md ainda descreve o D1 antigo, o check TEM que acusar.
      assert.equal(readFileSync(join(internalDir, ".social-source-hash.json"), "utf8"), hashBefore);
      const parsed = JSON.parse(stdout);
      assert.ok(!parsed.modified.rewritten.some((p: string) => p.endsWith(".social-source-hash.json")));
      const stale = checkSocialHashFresh(dir);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].rule, "social-hash-fresh");
      assert.equal(stale[0].severity, "error");

      // Splice do ## d1 novo e SÓ ENTÃO o recarimbo destrava o check.
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto d1 novo.\n");
      refreshSocialHash(dir);
      assert.deepEqual(checkSocialHashFresh(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap sem hash prévio não cria .social-source-hash.json", () => {
    const dir = makeTempEdition({});
    try {
      const { status, stderr } = runCli([
        "--edition", "260929", "--edition-dir", dir,
        "--promote", "radar:1", "--demote", "d2",
      ]);
      assert.equal(status, 0, stderr);
      assert.ok(!existsSync(join(dir, "_internal", ".social-source-hash.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rerenders_needed começa pelo refresh-destaque-sources (#9102) e recarimba o hash só depois do splice do social", () => {
    const steps = buildSwapDestaqueSteps("/ed/260929", 3, "Z");
    assert.match(steps[0], /refresh-destaque-sources\.ts --edition-dir \/ed\/260929 /);
    assert.ok(buildSwapDestaqueSteps("/ed/260929/", 1, "t").every((s) => !s.includes("260929//")));
    const iWriter = steps.findIndex((s) => /writer-destaque/.test(s) && /DESTAQUE 3/.test(s));
    const iSocial = steps.findIndex((s) => /social-writer/.test(s));
    const iHash = steps.findIndex((s) => /refresh-social-hash\.ts/.test(s));
    assert.ok(iWriter > 0, "writer-destaque vem depois do refresh de fontes");
    assert.ok(/source_text_path/.test(steps[iWriter]));
    assert.ok(iSocial > iWriter);
    assert.ok(iHash > iSocial, "recarimbo do hash vem depois do splice do social");
    assert.ok(!steps.some((s) => /merge-social-md/.test(s)));
    // comando de imagem completo e válido (review #9177): prompt reescrito + --destaque d{N}
    assert.ok(steps.some((s) => /02-d3-prompt\.md/.test(s) && /--editorial .* --out-dir .* --destaque d3/.test(s)));
  });
});

describe("refreshTituloSubtituloInMd (#9601)", () => {
  const md = (d3: string) =>
    `TÍTULO\n\nTitulo D1\n\nSUBTÍTULO\n\nTitulo D2 | ${d3}\n\n---\n\n` +
    `**DESTAQUE 1 | PESQUISA**\n\n**[Titulo D1](https://a.com/1)**\n\ncorpo\n\n---\n\n` +
    `**DESTAQUE 2 | MERCADO**\n\n**[Titulo D2](https://a.com/2)**\n\ncorpo\n\n---\n\n` +
    `**DESTAQUE 3 | IA**\n\n**[${d3}](https://a.com/3)**\n\ncorpo\n\n---\n\n**📰 RADAR**\n\nx\n`;

  it("SUBTÍTULO acompanha o placeholder do swap", () => {
    const swapped = removeDestaqueBlockFromMd(md("D3 antigo"), 3, "Kolibri novo", "https://k.com");
    const out = refreshTituloSubtituloInMd(swapped);
    assert.match(out, /Titulo D2 \| Kolibri novo/);
    assert.doesNotMatch(out.split("---")[0], /D3 antigo/);
  });

  it("sem bloco TÍTULO/SUBTÍTULO é no-op", () => {
    const bare = "**DESTAQUE 1 | X**\n\n**[A](https://a.com)**\n";
    assert.equal(refreshTituloSubtituloInMd(bare), bare);
  });
});
