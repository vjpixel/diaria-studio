/**
 * test/analyze-writer-inserted-links.test.ts (#4848)
 *
 * Cobertura de regressão para a classificação writer-inserted vs scored e a
 * agregação SEPARADA de clique/link por origem — decisão do editor (sessão
 * develop 260810b): Opção 2, aceitar link contextual do writer como desenho,
 * medir separado sem contaminar a média do pool pontuado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editionToDate,
  listEditionsWithPublishedLinks,
  loadPublishedLinksForEdition,
  buildCtrIndex,
  aggregateByOrigin,
  computeOriginStats,
  renderReport,
  type OriginAgg,
} from "../scripts/analyze-writer-inserted-links.ts";
import type { CtrRow } from "../scripts/analyze-scorer-impact.ts";
import type { PublishedLink } from "../scripts/lib/link-layout.ts";

// ─── editionToDate ──────────────────────────────────────────────────────────

describe("editionToDate", () => {
  it("AAMMDD → YYYY-MM-DD", () => {
    assert.equal(editionToDate("260810"), "2026-08-10");
    assert.equal(editionToDate("260101"), "2026-01-01");
  });
  it("formato inválido → null", () => {
    assert.equal(editionToDate("xx"), null);
    assert.equal(editionToDate("2608100"), null);
    assert.equal(editionToDate(""), null);
  });
});

// ─── fixtures de edições em disco ──────────────────────────────────────────

function writePublishedLinks(editionsDir: string, edition: string, links: PublishedLink[]): void {
  const internalDir = join(editionsDir, edition, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "published-links.json"), JSON.stringify(links, null, 2));
}

describe("listEditionsWithPublishedLinks", () => {
  it("lista só diretórios AAMMDD que têm published-links.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      writePublishedLinks(dir, "260810", [{ url: "https://a.com/1", bloco: "destaque", origin: "scored" }]);
      writePublishedLinks(dir, "260809", [{ url: "https://a.com/2", bloco: "radar", origin: "writer_inserted" }]);
      // edição sem published-links.json (pré-#4841) — não deve aparecer
      mkdirSync(join(dir, "260808", "_internal"), { recursive: true });
      // diretório auxiliar não-AAMMDD (ex: replay-scorer-a) — deve ser ignorado
      mkdirSync(join(dir, "replay-scorer-a", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "replay-scorer-a", "_internal", "published-links.json"),
        "[]",
      );
      const editions = listEditionsWithPublishedLinks(dir);
      assert.deepEqual(editions, ["260809", "260810"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("editionsDir ausente → []", () => {
    assert.deepEqual(listEditionsWithPublishedLinks(join(tmpdir(), "nao-existe-4848")), []);
  });
});

describe("loadPublishedLinksForEdition (fail-soft)", () => {
  it("lê e filtra entradas com origem válida", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      writePublishedLinks(dir, "260810", [
        { url: "https://a.com/1", bloco: "destaque", origin: "scored" },
        { url: "https://a.com/2", bloco: "destaque", origin: "writer_inserted" },
        // entrada malformada (origem inválida) — filtrada silenciosamente
        { url: "https://a.com/3", bloco: "destaque", origin: "lixo" } as unknown as PublishedLink,
      ]);
      const links = loadPublishedLinksForEdition(dir, "260810");
      assert.deepEqual(
        links.map((l) => l.url),
        ["https://a.com/1", "https://a.com/2"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo ausente → [] (nunca lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      assert.deepEqual(loadPublishedLinksForEdition(dir, "260810"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido → [] (nunca lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      const internalDir = join(dir, "260810", "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "published-links.json"), "{ isso não é um array");
      assert.deepEqual(loadPublishedLinksForEdition(dir, "260810"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── buildCtrIndex + aggregateByOrigin: o coração da separação #4848 ───────

function ctrRow(overrides: Partial<CtrRow> = {}): CtrRow {
  return {
    date: "2026-08-10",
    base_url: "https://a.com/1",
    unique_opens: 100,
    unique_verified_clicks: 5,
    ctr_pct: 5,
    category: "Aplicação",
    origin: "BR",
    ...overrides,
  };
}

describe("buildCtrIndex", () => {
  it("indexa por data|url-canonicalizado; 1ª ocorrência vence em colisão", () => {
    const idx = buildCtrIndex([
      ctrRow({ base_url: "https://a.com/1?utm_source=x", unique_opens: 100, unique_verified_clicks: 5 }),
      ctrRow({ base_url: "https://a.com/1", unique_opens: 999, unique_verified_clicks: 999 }),
    ]);
    assert.equal(idx.size, 1);
    const row = idx.get("2026-08-10|https://a.com/1");
    assert.ok(row);
    assert.equal(row!.unique_opens, 100);
  });
});

describe("aggregateByOrigin — agrega SEPARADO por origem, nunca mistura na mesma conta", () => {
  it("classifica writer-inserted vs scored e soma opens/clicks por população", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      writePublishedLinks(dir, "260810", [
        { url: "https://a.com/scored-1", bloco: "destaque", origin: "scored" },
        { url: "https://a.com/writer-1", bloco: "destaque", origin: "writer_inserted" },
        { url: "https://a.com/writer-2", bloco: "radar", origin: "writer_inserted" },
        // sem match no CTR table — deve contar como unmatched, não entrar nas somas
        { url: "https://a.com/sem-clique", bloco: "destaque", origin: "scored" },
      ]);

      const ctrIndex = buildCtrIndex([
        ctrRow({ base_url: "https://a.com/scored-1", unique_opens: 1000, unique_verified_clicks: 10 }),
        ctrRow({ base_url: "https://a.com/writer-1", unique_opens: 1000, unique_verified_clicks: 30 }),
        ctrRow({ base_url: "https://a.com/writer-2", unique_opens: 1000, unique_verified_clicks: 10 }),
      ]);

      const report = aggregateByOrigin(["260810"], dir, ctrIndex);

      assert.equal(report.total_links, 4);
      assert.equal(report.matched_links, 3);
      assert.equal(report.unmatched_links, 1);

      const scored = report.byOrigin.scored;
      assert.equal(scored.links_matched, 1);
      assert.equal(scored.links_unmatched, 1);
      assert.equal(scored.opens, 1000);
      assert.equal(scored.clicks, 10);

      const writer = report.byOrigin.writer_inserted;
      assert.equal(writer.links_matched, 2);
      assert.equal(writer.links_unmatched, 0);
      assert.equal(writer.opens, 2000);
      assert.equal(writer.clicks, 40);

      // As duas populações nunca se tocam: scored não inclui nada de writer e vice-versa.
      assert.equal(scored.opens + writer.opens, 3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição sem link nenhum não quebra a agregação (soma zero)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editions-"));
    try {
      writePublishedLinks(dir, "260810", []);
      const report = aggregateByOrigin(["260810"], dir, buildCtrIndex([]));
      assert.equal(report.total_links, 0);
      assert.equal(report.byOrigin.scored.links_matched, 0);
      assert.equal(report.byOrigin.writer_inserted.links_matched, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeOriginStats", () => {
  it("clicks_per_link e ctr_pooled_pct calculados a partir das somas — reproduz a métrica da issue", () => {
    const agg: OriginAgg = {
      origin: "writer_inserted",
      links_matched: 43,
      links_unmatched: 0,
      opens: 10000,
      clicks: 5599, // 5599/43 ≈ 130.2/link, batendo a ordem de grandeza citada na issue (1,302 clique/link em outra unidade de medida — o que importa é a fórmula)
    };
    const stats = computeOriginStats(agg);
    assert.equal(stats.links, 43);
    assert.ok(Math.abs(stats.clicks_per_link! - 5599 / 43) < 1e-9);
    assert.ok(Math.abs(stats.ctr_pooled_pct! - (5599 / 10000) * 100) < 1e-9);
  });

  it("0 links matched → clicks_per_link e ctr_pooled_pct são null (nunca dividir por zero)", () => {
    const agg: OriginAgg = { origin: "scored", links_matched: 0, links_unmatched: 5, opens: 0, clicks: 0 };
    const stats = computeOriginStats(agg);
    assert.equal(stats.clicks_per_link, null);
    assert.equal(stats.ctr_pooled_pct, null);
  });
});

// ─── renderReport: nunca mistura as duas populações na mesma linha/média ──

describe("renderReport", () => {
  it("emite uma linha por origem, nunca uma média combinada", () => {
    const report = {
      editions: ["260810"],
      total_links: 2,
      matched_links: 2,
      unmatched_links: 0,
      byOrigin: {
        scored: { origin: "scored" as const, links_matched: 1, links_unmatched: 0, opens: 100, clicks: 5 },
        writer_inserted: {
          origin: "writer_inserted" as const,
          links_matched: 1,
          links_unmatched: 0,
          opens: 100,
          clicks: 15,
        },
      },
    };
    const md = renderReport(report);
    assert.match(md, /\| scored \|/);
    assert.match(md, /\| writer_inserted \|/);
    // nenhuma linha "combined"/"total" misturando as duas populações na tabela de clique/link
    assert.doesNotMatch(md, /\| (combined|total|geral) \|/i);
    assert.match(md, /writer_inserted rende/);
  });

  it("sem edições instrumentadas ainda: relatório explica o motivo sem quebrar", () => {
    const report = {
      editions: [],
      total_links: 0,
      matched_links: 0,
      unmatched_links: 0,
      byOrigin: {
        scored: { origin: "scored" as const, links_matched: 0, links_unmatched: 0, opens: 0, clicks: 0 },
        writer_inserted: {
          origin: "writer_inserted" as const,
          links_matched: 0,
          links_unmatched: 0,
          opens: 0,
          clicks: 0,
        },
      },
    };
    const md = renderReport(report);
    assert.match(md, /Nenhuma edição instrumentada ainda/);
  });
});
