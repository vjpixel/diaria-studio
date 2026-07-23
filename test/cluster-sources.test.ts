import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toClusterSource,
  compareCompleteness,
  pickCanonical,
  foldCluster,
  type ClusterArticle,
} from "../scripts/lib/cluster-sources.ts";

function art(over: Partial<ClusterArticle>): ClusterArticle {
  return { url: "https://x/" + Math.random().toString(36).slice(2), ...over };
}

describe("toClusterSource (#3920)", () => {
  it("extrai url/title/source/published_at", () => {
    const cs = toClusterSource({
      url: "https://a.com/x",
      title: "Título A",
      source: "TechCrunch",
      published_at: "2026-07-20",
    });
    assert.deepEqual(cs, {
      url: "https://a.com/x",
      title: "Título A",
      source: "TechCrunch",
      published_at: "2026-07-20",
    });
  });

  it("published_at cai em date quando ausente", () => {
    const cs = toClusterSource({ url: "https://a.com/x", date: "2026-07-19" });
    assert.equal(cs.published_at, "2026-07-19");
  });

  it("source é trimado (não vaza espaços do snippet da fonte)", () => {
    assert.equal(toClusterSource({ url: "https://a.com/x", source: "  Reuters  " }).source, "Reuters");
    assert.equal(
      toClusterSource({ url: "https://a.com/x", source_name: "  The Verge  " }).source,
      "The Verge",
    );
  });

  it("source cai em source_name (discovery) quando source ausente", () => {
    const cs = toClusterSource({ url: "https://a.com/x", source_name: "The Verge" });
    assert.equal(cs.source, "The Verge");
  });

  it("source cai no hostname da URL quando nenhum campo de veículo existe", () => {
    const cs = toClusterSource({ url: "https://www.techcrunch.com/x" });
    assert.equal(cs.source, "techcrunch.com");
  });

  it("omite title vazio; source vem do hostname (fallback)", () => {
    const cs = toClusterSource({ url: "https://a.com/x", title: "  ", source: "" });
    assert.deepEqual(cs, { url: "https://a.com/x", source: "a.com" });
  });
});

describe("compareCompleteness (#3920)", () => {
  it("maior summary é mais completo (ordena antes)", () => {
    const a = art({ summary: "x".repeat(300) });
    const b = art({ summary: "x".repeat(100) });
    assert.ok(compareCompleteness(a, b) < 0);
    assert.ok(compareCompleteness(b, a) > 0);
  });

  it("empate de summary → fonte cadastrada antes de discovered", () => {
    const reg = art({ summary: "same", discovered_source: false });
    const disc = art({ summary: "same", discovered_source: true });
    assert.ok(compareCompleteness(reg, disc) < 0);
  });

  it("empate de summary+source → título mais longo antes", () => {
    const long = art({ summary: "s", title: "título bem mais longo" });
    const short = art({ summary: "s", title: "curto" });
    assert.ok(compareCompleteness(long, short) < 0);
  });

  it("empate total → 0", () => {
    const a = art({ summary: "s", title: "t", discovered_source: false });
    const b = art({ summary: "s", title: "t", discovered_source: false });
    assert.equal(compareCompleteness(a, b), 0);
  });
});

describe("pickCanonical (#3920)", () => {
  it("escolhe o de maior summary como canônico", () => {
    const big = art({ url: "https://big", summary: "x".repeat(500) });
    const mid = art({ url: "https://mid", summary: "x".repeat(200) });
    const small = art({ url: "https://small", summary: "x".repeat(10) });
    const { canonical, others } = pickCanonical([small, big, mid]);
    assert.equal(canonical.url, "https://big");
    assert.deepEqual(others.map((o) => o.url).sort(), ["https://mid", "https://small"]);
  });

  it("empate total preserva ordem de entrada (mantém vencedor atual do dedup)", () => {
    const first = art({ url: "https://first", summary: "s", title: "t" });
    const second = art({ url: "https://second", summary: "s", title: "t" });
    const { canonical } = pickCanonical([first, second]);
    assert.equal(canonical.url, "https://first");
  });

  it("lança em cluster vazio", () => {
    assert.throws(() => pickCanonical([]), /vazio/);
  });
});

describe("foldCluster (#3920)", () => {
  it("anexa perdedores como cluster_sources[] no canônico", () => {
    const winner = art({ url: "https://w", summary: "x".repeat(300), source: "A" });
    const l1 = art({ url: "https://l1", summary: "x".repeat(100), source: "B", title: "B t" });
    const l2 = art({ url: "https://l2", summary: "x".repeat(50), source: "C", title: "C t" });
    const { canonical } = foldCluster([winner, l1, l2]);
    assert.equal(canonical.url, "https://w");
    assert.equal(canonical.cluster_sources?.length, 2);
    const urls = canonical.cluster_sources!.map((c) => c.url).sort();
    assert.deepEqual(urls, ["https://l1", "https://l2"]);
  });

  it("dedup idempotente contra cluster_sources pré-existente (por url)", () => {
    const winner = art({
      url: "https://w",
      summary: "x".repeat(300),
      cluster_sources: [{ url: "https://l1", source: "B" }],
    });
    const l1 = art({ url: "https://l1", summary: "x".repeat(100) });
    const { canonical } = foldCluster([winner, l1]);
    // l1 já estava — não duplica
    assert.equal(canonical.cluster_sources?.length, 1);
  });

  it("cluster de 1 → sem cluster_sources", () => {
    const solo = art({ url: "https://solo", summary: "s" });
    const { canonical } = foldCluster([solo]);
    assert.equal(canonical.cluster_sources, undefined);
  });
});
