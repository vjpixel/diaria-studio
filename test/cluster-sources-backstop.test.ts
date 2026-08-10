import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileClusterSources,
  type ClusterSourcesFinalistLike,
  type ClusterSourcesHighlightLike,
} from "../scripts/lib/cluster-sources-backstop.ts";
import { renderAprofundeInner } from "../scripts/lib/newsletter-render-html.ts";

// #4838: scorer-select (LLM) retranscreve `article` do finalist pro highlight
// selecionado; `cluster_sources[]` nunca é mencionado no prompt dele e pode
// ser perdido nessa retranscrição. Sem um backstop determinístico, o bônus de
// cobertura (#3920, já somado ao score ANTES do scorer-select rodar) sobrevive
// mas o bloco "Aprofunde:" nunca chega a ser emitido — bônus ativo, entrega
// que não existe.

const CLUSTER_SOURCES = [
  { url: "https://theverge.com/x", title: "Cobertura The Verge", source: "The Verge" },
  { url: "https://techcrunch.com/x", title: "Cobertura TechCrunch", source: "TechCrunch" },
];

describe("reconcileClusterSources (#4838)", () => {
  it("no-op quando o highlight já carrega cluster_sources idêntico ao finalist", () => {
    const finalists: ClusterSourcesFinalistLike[] = [
      { url: "a", article: { url: "a", title: "Vencedor do cluster", cluster_sources: CLUSTER_SOURCES } },
    ];
    const highlights: ClusterSourcesHighlightLike[] = [
      { url: "a", article: { url: "a", title: "Vencedor do cluster", cluster_sources: CLUSTER_SOURCES } },
    ];
    const out = reconcileClusterSources(highlights, finalists);
    assert.equal(out.restorations.length, 0);
    assert.equal(out.highlights, highlights, "no-op deve preservar a mesma referência de array");
  });

  it("no-op quando o finalist não tem cluster (destaque de fonte única — comportamento idêntico ao de hoje)", () => {
    const finalists: ClusterSourcesFinalistLike[] = [{ url: "a", article: { url: "a", title: "Fonte única" } }];
    const highlights: ClusterSourcesHighlightLike[] = [{ url: "a", article: { url: "a", title: "Fonte única" } }];
    const out = reconcileClusterSources(highlights, finalists);
    assert.equal(out.restorations.length, 0);
    assert.equal(out.highlights[0].article?.cluster_sources, undefined);
  });

  it("CASO REAL (#4838): scorer-select 'esqueceu' cluster_sources ao copiar o article — backstop restaura", () => {
    const finalists: ClusterSourcesFinalistLike[] = [
      {
        url: "https://oficial.com/lancamento",
        article: {
          url: "https://oficial.com/lancamento",
          title: "Empresa lança novo modelo",
          cluster_sources: CLUSTER_SOURCES,
        },
      },
    ];
    // Simula o agent transcrevendo o article, mas dropando cluster_sources.
    const highlights: ClusterSourcesHighlightLike[] = [
      {
        rank: 1,
        url: "https://oficial.com/lancamento",
        score: 92,
        article: { url: "https://oficial.com/lancamento", title: "Empresa lança novo modelo" },
      },
    ];
    const out = reconcileClusterSources(highlights, finalists);
    assert.equal(out.restorations.length, 1);
    assert.equal(out.restorations[0].url, "https://oficial.com/lancamento");
    assert.equal(out.restorations[0].restored_count, 2);
    assert.deepEqual(out.highlights[0].article?.cluster_sources, CLUSTER_SOURCES);
  });

  it("restaura também quando o highlight tem cluster_sources DIVERGENTE (subconjunto/corrompido), não só ausente", () => {
    const finalists: ClusterSourcesFinalistLike[] = [
      { url: "a", article: { url: "a", cluster_sources: CLUSTER_SOURCES } },
    ];
    const highlights: ClusterSourcesHighlightLike[] = [
      // agent reproduziu só a 1ª fonte do cluster, não as 2.
      { url: "a", article: { url: "a", cluster_sources: [CLUSTER_SOURCES[0]] } },
    ];
    const out = reconcileClusterSources(highlights, finalists);
    assert.equal(out.restorations.length, 1);
    assert.match(out.restorations[0].reason, /divergente/);
    assert.deepEqual(out.highlights[0].article?.cluster_sources, CLUSTER_SOURCES);
  });

  it("sem finalist correspondente (URL não bate) → no-op seguro, não lança", () => {
    const finalists: ClusterSourcesFinalistLike[] = [
      { url: "b", article: { url: "b", cluster_sources: CLUSTER_SOURCES } },
    ];
    const highlights: ClusterSourcesHighlightLike[] = [{ url: "a", article: { url: "a" } }];
    const out = reconcileClusterSources(highlights, finalists);
    assert.equal(out.restorations.length, 0);
    assert.equal(out.highlights[0].article?.cluster_sources, undefined);
  });

  it("integração com o render: cluster_sources restaurado pelo backstop é o que faz o bloco Aprofunde existir", () => {
    // Fecha o laço com a issue: um destaque com cluster same-story elegível
    // (finalist com cluster_sources) DEVE produzir o bloco "Aprofunde:" no
    // HTML final, mesmo que o agent scorer-select tenha "esquecido" o campo
    // ao selecionar esse destaque.
    const finalists: ClusterSourcesFinalistLike[] = [
      { url: "a", article: { url: "a", title: "Título do destaque", cluster_sources: CLUSTER_SOURCES } },
    ];
    const highlightsMissingField: ClusterSourcesHighlightLike[] = [
      { url: "a", article: { url: "a", title: "Título do destaque" } }, // campo perdido na transcrição do LLM
    ];
    const { highlights: restored } = reconcileClusterSources(highlightsMissingField, finalists);
    const clusterSourcesForWriter = restored[0].article?.cluster_sources as typeof CLUSTER_SOURCES | undefined;

    // Sem o backstop, isto seria undefined e o writer nunca emitiria o bloco.
    assert.ok(clusterSourcesForWriter, "cluster_sources deve estar presente pós-backstop");

    const html = renderAprofundeInner(clusterSourcesForWriter);
    assert.notEqual(html, "", "bloco Aprofunde deve renderizar quando há cluster same-story elegível");
    assert.match(html, /APROFUNDE|Aprofunde/);
    assert.ok(html.includes("https://theverge.com/x"));
    assert.ok(html.includes("https://techcrunch.com/x"));
  });
});
