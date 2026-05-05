import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectApprovedUrls,
  flattenCategorized,
  filterCarryOver,
} from "../scripts/load-carry-over.ts";
import { getPreviousEditionDate, listEditions } from "../scripts/lib/edition-utils.ts";

describe("collectApprovedUrls", () => {
  it("coleta URLs de highlights + buckets, suportando flat e nested", () => {
    const urls = collectApprovedUrls({
      highlights: [
        { url: "https://a.com" },
        { article: { url: "https://b.com" } },
      ],
      lancamento: [{ article: { url: "https://c.com" } }],
      pesquisa: [{ url: "https://d.com" }],
      noticias: [],
    });
    assert.equal(urls.size, 4);
    assert.ok(urls.has("https://a.com"));
    assert.ok(urls.has("https://b.com"));
    assert.ok(urls.has("https://c.com"));
    assert.ok(urls.has("https://d.com"));
  });

  it("retorna set vazio para approved nulo", () => {
    assert.equal(collectApprovedUrls(null).size, 0);
  });
});

describe("flattenCategorized", () => {
  it("achata runners_up + buckets em um array único", () => {
    const all = flattenCategorized({
      runners_up: [
        { article: { url: "https://r1.com", score: 70 } },
        { url: "https://r2.com", score: 65 } as { url: string; score: number },
      ],
      lancamento: [{ url: "https://l1.com", score: 80 }],
      pesquisa: [{ url: "https://p1.com", score: 75 }],
      noticias: [
        { url: "https://n1.com", score: 60 },
        { url: "https://n2.com", score: 55 },
      ],
    });
    assert.equal(all.length, 6);
    const urls = all.map((a) => a.url).sort();
    assert.deepEqual(urls, [
      "https://l1.com",
      "https://n1.com",
      "https://n2.com",
      "https://p1.com",
      "https://r1.com",
      "https://r2.com",
    ]);
  });
});

describe("filterCarryOver", () => {
  const baseOpts = {
    approvedUrls: new Set<string>(),
    poolUrls: new Set<string>(),
    windowStart: "2026-04-25",
    windowEnd: "2026-04-29",
    scoreMin: 60,
  };

  it("exclui URLs aprovadas na edição anterior", () => {
    const { kept, skipped } = filterCarryOver(
      [
        { url: "https://a.com", score: 80, published_at: "2026-04-27" },
        { url: "https://b.com", score: 75, published_at: "2026-04-26" },
      ],
      { ...baseOpts, approvedUrls: new Set(["https://a.com"]) },
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://b.com");
    assert.equal(skipped[0].reason, "approved_in_prev");
  });

  it("exclui URLs já presentes no pool atual", () => {
    const { kept, skipped } = filterCarryOver(
      [{ url: "https://a.com", score: 80, published_at: "2026-04-27" }],
      { ...baseOpts, poolUrls: new Set(["https://a.com"]) },
    );
    assert.equal(kept.length, 0);
    assert.equal(skipped[0].reason, "already_in_pool");
  });

  it("exclui artigos com score abaixo do mínimo", () => {
    const { kept, skipped } = filterCarryOver(
      [
        { url: "https://a.com", score: 59, published_at: "2026-04-27" },
        { url: "https://b.com", score: 60, published_at: "2026-04-27" },
      ],
      baseOpts,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://b.com");
    assert.equal(skipped[0].reason, "score<60");
  });

  it("exclui artigos fora da janela de publicação", () => {
    const { kept, skipped } = filterCarryOver(
      [
        { url: "https://a.com", score: 80, published_at: "2026-04-20" },
        { url: "https://b.com", score: 80, published_at: "2026-04-30" },
        { url: "https://c.com", score: 80, published_at: "2026-04-27" },
      ],
      baseOpts,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://c.com");
    assert.equal(skipped.filter((s) => s.reason === "outside_window").length, 2);
  });

  it("exclui artigos sem data de publicação", () => {
    const { kept, skipped } = filterCarryOver(
      [{ url: "https://a.com", score: 80 }],
      baseOpts,
    );
    assert.equal(kept.length, 0);
    assert.equal(skipped[0].reason, "missing_date");
  });

  it("aceita 'date' como fallback quando 'published_at' ausente", () => {
    const { kept } = filterCarryOver(
      [{ url: "https://a.com", score: 80, date: "2026-04-27" }],
      baseOpts,
    );
    assert.equal(kept.length, 1);
  });
});

describe("edition-utils", () => {
  function withTempEditions(populate: (dir: string) => void): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-editions-"));
    populate(dir);
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("listEditions retorna pastas AAMMDD em ordem decrescente", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      mkdirSync(join(d, "260427"));
      mkdirSync(join(d, "260429"));
      mkdirSync(join(d, "260428"));
      mkdirSync(join(d, "not-an-edition"));
      writeFileSync(join(d, "stray.txt"), "");
    });
    try {
      assert.deepEqual(listEditions(dir), ["260429", "260428", "260427"]);
    } finally {
      cleanup();
    }
  });

  it("getPreviousEditionDate retorna a edição imediatamente anterior", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      mkdirSync(join(d, "260427"));
      mkdirSync(join(d, "260429"));
    });
    try {
      assert.equal(getPreviousEditionDate("260430", dir), "260429");
      assert.equal(getPreviousEditionDate("260429", dir), "260427");
      assert.equal(getPreviousEditionDate("260428", dir), "260427");
    } finally {
      cleanup();
    }
  });

  it("getPreviousEditionDate retorna null para edição mais antiga", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      mkdirSync(join(d, "260427"));
    });
    try {
      assert.equal(getPreviousEditionDate("260427", dir), null);
      assert.equal(getPreviousEditionDate("260420", dir), null);
    } finally {
      cleanup();
    }
  });

  it("getPreviousEditionDate lança erro para AAMMDD inválido", () => {
    assert.throws(() => getPreviousEditionDate("invalid"), /AAMMDD inválido/);
  });
});
