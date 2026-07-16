/**
 * test/studio-waves.test.ts (#3562, entrega 2) — cobertura das funções
 * puras de `scripts/studio-ui/studio-waves.ts`: extração de arquivos citados,
 * classificação best-effort elegível/bloqueada/ambígua, agrupamento em
 * clusters de conflito e composição da onda proposta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFilePaths,
  classifyDispatchTrack,
  buildConflictClusters,
  composeWave,
  buildWaveProposal,
  type WaveItem,
} from "../scripts/studio-ui/studio-waves.ts";

describe("extractFilePaths (#3562)", () => {
  it("extrai paths em code-span", () => {
    const text = "Estender `scripts/studio-ui/studio-issues.ts` (é seu) e `context/overnight-dispatch-rules.md`.";
    assert.deepEqual(extractFilePaths(text), ["context/overnight-dispatch-rules.md", "scripts/studio-ui/studio-issues.ts"]);
  });

  it("extrai paths nus com prefixo de diretório-raiz conhecido", () => {
    const text = "Mexe em scripts/lib/publish-state.ts e também test/studio-issues.test.ts.";
    assert.deepEqual(extractFilePaths(text), ["scripts/lib/publish-state.ts", "test/studio-issues.test.ts"]);
  });

  it("remove pontuação de trailing (vírgula, ponto, parêntese)", () => {
    const text = "Ver `scripts/studio-ui/server.ts`, e (`context/editorial-rules.md`).";
    assert.deepEqual(extractFilePaths(text), ["context/editorial-rules.md", "scripts/studio-ui/server.ts"]);
  });

  it("dedup entre code-span e path nu do mesmo arquivo", () => {
    const text = "`scripts/foo.ts` é o mesmo arquivo que scripts/foo.ts mencionado sem backtick.";
    assert.deepEqual(extractFilePaths(text), ["scripts/foo.ts"]);
  });

  it("ignora tokens sem prefixo de diretório-raiz conhecido (falso-negativo é seguro)", () => {
    const text = "Isso não é path: 10/20 nem foo/bar.ts (sem prefixo reconhecido).";
    assert.deepEqual(extractFilePaths(text), []);
  });

  it("null/undefined/vazio -> array vazio, sem lançar", () => {
    assert.deepEqual(extractFilePaths(null), []);
    assert.deepEqual(extractFilePaths(undefined), []);
    assert.deepEqual(extractFilePaths(""), []);
  });
});

describe("classifyDispatchTrack (#3562)", () => {
  it("label de bloqueio real -> bloqueada", () => {
    assert.equal(classifyDispatchTrack(["external-blocker", "enhancement"], "qualquer corpo"), "bloqueada");
    assert.equal(classifyDispatchTrack(["on-hold"], ""), "bloqueada");
    assert.equal(classifyDispatchTrack(["kit-migration"], ""), "bloqueada");
    assert.equal(classifyDispatchTrack(["not-this-week"], ""), "bloqueada");
    assert.equal(classifyDispatchTrack(["beehiiv"], ""), "bloqueada");
  });

  it("marcador textual de decisão em aberto sem label de bloqueio -> ambigua", () => {
    assert.equal(classifyDispatchTrack(["enhancement"], "Precisamos decidir entre A e B"), "ambigua");
    assert.equal(classifyDispatchTrack([], "existe um trade-off real aqui"), "ambigua");
  });

  it("sem sinal nenhum -> elegivel", () => {
    assert.equal(classifyDispatchTrack(["bug", "P2"], "corpo qualquer sem ambiguidade"), "elegivel");
  });

  it("label de bloqueio vence marcador de ambiguidade quando ambos presentes", () => {
    assert.equal(classifyDispatchTrack(["on-hold"], "precisamos decidir entre A e B"), "bloqueada");
  });
});

describe("buildConflictClusters (#3562)", () => {
  it("issues sem arquivo em comum viram singletons", () => {
    const items: WaveItem[] = [
      { id: 1, files: ["scripts/a.ts"] },
      { id: 2, files: ["scripts/b.ts"] },
    ];
    const clusters = buildConflictClusters(items);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters.map((c) => c.ids), [[1], [2]]);
  });

  it("issues com arquivo em comum viram 1 cluster", () => {
    const items: WaveItem[] = [
      { id: 1, files: ["scripts/a.ts", "scripts/shared.ts"] },
      { id: 2, files: ["scripts/b.ts", "scripts/shared.ts"] },
      { id: 3, files: ["scripts/c.ts"] },
    ];
    const clusters = buildConflictClusters(items);
    assert.equal(clusters.length, 2);
    const multi = clusters.find((c) => c.ids.length > 1);
    assert.ok(multi);
    assert.deepEqual(multi!.ids, [1, 2]);
    assert.deepEqual(multi!.files, ["scripts/a.ts", "scripts/b.ts", "scripts/shared.ts"]);
  });

  it("transitividade: A-B via arquivo X, B-C via arquivo Y -> 1 cluster com os 3", () => {
    const items: WaveItem[] = [
      { id: 1, files: ["x.ts"] },
      { id: 2, files: ["x.ts", "y.ts"] },
      { id: 3, files: ["y.ts"] },
    ];
    const clusters = buildConflictClusters(items);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].ids.sort(), [1, 2, 3]);
  });

  it("issues sem NENHUM arquivo detectado nunca colidem entre si", () => {
    const items: WaveItem[] = [
      { id: 1, files: [] },
      { id: 2, files: [] },
    ];
    const clusters = buildConflictClusters(items);
    assert.equal(clusters.length, 2);
  });

  it("preserva a ordem de aparição dentro do cluster (permite priorizar representante)", () => {
    const items: WaveItem[] = [
      { id: 5, files: ["shared.ts"] },
      { id: 2, files: ["shared.ts"] },
    ];
    const clusters = buildConflictClusters(items);
    assert.deepEqual(clusters[0].ids, [5, 2]); // 5 apareceu primeiro no input
  });
});

describe("composeWave (#3562)", () => {
  it("1 representante por cluster + todos os singletons, dentro do teto", () => {
    const clusters = buildConflictClusters([
      { id: 1, files: ["a.ts"] },
      { id: 2, files: ["a.ts"] },
      { id: 3, files: ["b.ts"] },
    ]);
    const proposal = composeWave(clusters, { maxConcurrency: 6 });
    assert.deepEqual(proposal.wave.sort((a, b) => a - b), [1, 3]);
    assert.deepEqual(proposal.deferred, [2]);
    assert.equal(proposal.overCapacity, false);
  });

  it("corta a onda no teto de concorrência e adia o excedente", () => {
    const items: WaveItem[] = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, files: [] }));
    const clusters = buildConflictClusters(items);
    const proposal = composeWave(clusters, { maxConcurrency: 6 });
    assert.equal(proposal.wave.length, 6);
    assert.equal(proposal.overCapacity, true);
    assert.equal(proposal.deferred.length, 2);
  });

  it("default de maxConcurrency é 6 (mesmo teto do /diaria-develop, #2754)", () => {
    const clusters = buildConflictClusters([{ id: 1, files: [] }]);
    const proposal = composeWave(clusters);
    assert.equal(proposal.maxConcurrency, 6);
  });
});

describe("buildWaveProposal (#3562)", () => {
  it("filtra issues bloqueada/ambigua fora da análise de cluster", () => {
    const proposal = buildWaveProposal([
      { number: 1, files: [], priority: "P1", dispatchTrack: "elegivel" },
      { number: 2, files: [], priority: "P0", dispatchTrack: "bloqueada" },
      { number: 3, files: [], priority: "P2", dispatchTrack: "ambigua" },
    ]);
    assert.deepEqual(proposal.consideredIds, [1]);
    assert.deepEqual(proposal.wave, [1]);
  });

  it("ordena elegíveis por prioridade (P0 primeiro) antes de montar clusters", () => {
    const proposal = buildWaveProposal([
      { number: 10, files: [], priority: "P3", dispatchTrack: "elegivel" },
      { number: 20, files: [], priority: "P0", dispatchTrack: "elegivel" },
      { number: 30, files: [], priority: "P1", dispatchTrack: "elegivel" },
    ]);
    assert.deepEqual(proposal.consideredIds, [20, 30, 10]);
  });

  it("desempata por número quando a prioridade é igual", () => {
    const proposal = buildWaveProposal([
      { number: 30, files: [], priority: "P2", dispatchTrack: "elegivel" },
      { number: 10, files: [], priority: "P2", dispatchTrack: "elegivel" },
    ]);
    assert.deepEqual(proposal.consideredIds, [10, 30]);
  });

  it("representante do cluster é o de maior prioridade, não o de menor número", () => {
    // #20 (P0) e #5 (P3) colidem no mesmo arquivo — a ordenação por
    // prioridade prévia garante que #20 vira o representante da onda.
    const proposal = buildWaveProposal([
      { number: 5, files: ["shared.ts"], priority: "P3", dispatchTrack: "elegivel" },
      { number: 20, files: ["shared.ts"], priority: "P0", dispatchTrack: "elegivel" },
    ]);
    assert.deepEqual(proposal.wave, [20]);
    assert.deepEqual(proposal.deferred, [5]);
  });

  it("issue sem prioridade fica atrás das priorizadas", () => {
    const proposal = buildWaveProposal([
      { number: 1, files: [], priority: null, dispatchTrack: "elegivel" },
      { number: 2, files: [], priority: "P3", dispatchTrack: "elegivel" },
    ]);
    assert.deepEqual(proposal.consideredIds, [2, 1]);
  });
});
