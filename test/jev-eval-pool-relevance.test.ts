/**
 * test/jev-eval-pool-relevance.test.ts (#8418 — medição 5 do epic #8412)
 *
 * Cobre a lógica pura de `scripts/jev-eval-pool-relevance.ts`:
 *   - `collectPoolRelevanceCandidates`: decisão `aprovado`/`descartado` a
 *     partir de `01-categorized.json` × `01-approved.json` num fixture em
 *     disco (tmp dir, sem depender de `data/editions/` real).
 *   - `evaluatePoolRelevance`: `poolFiltered` só é `true` quando AMBAS as
 *     perguntas (`about_ai`, `audience_fit`) caem abaixo do limiar — nunca
 *     por um eixo isolado (fetch injetado, sem rede real).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPoolRelevanceCandidates, evaluatePoolRelevance } from "../scripts/jev-eval-pool-relevance.ts";

function makeEdition(root: string, aammdd: string, categorized: Record<string, unknown>, approved: Record<string, unknown>) {
  const dir = join(root, "data", "editions", aammdd, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(categorized));
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved));
}

describe("collectPoolRelevanceCandidates", () => {
  it("marca aprovado quando a URL sobrevive até 01-approved.json", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-pool-relevance-"));
    try {
      makeEdition(
        root,
        "260101",
        { radar: [{ url: "https://a.example/1", title: "A", summary: "sobre IA" }, { url: "https://a.example/2", title: "B", summary: "outra" }] },
        { radar: [{ url: "https://a.example/1", title: "A", summary: "sobre IA" }] },
      );
      const { candidates, skipped } = collectPoolRelevanceCandidates(root);
      assert.equal(skipped.length, 0);
      assert.equal(candidates.length, 2);
      const byUrl = new Map(candidates.map((c) => [c.url, c]));
      assert.equal(byUrl.get("https://a.example/1")?.decision, "aprovado");
      assert.equal(byUrl.get("https://a.example/2")?.decision, "descartado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dedup por URL entre edições — 1ª ocorrência vence", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-pool-relevance-"));
    try {
      makeEdition(root, "260101", { radar: [{ url: "https://a.example/1", title: "A", summary: "x" }] }, { radar: [] });
      makeEdition(root, "260102", { radar: [{ url: "https://a.example/1", title: "A", summary: "x" }] }, { radar: [{ url: "https://a.example/1", title: "A", summary: "x" }] });
      const { candidates } = collectPoolRelevanceCandidates(root);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].decision, "descartado"); // 260101 (1ª ocorrência) venceu
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição sem os dois arquivos é ignorada, sem erro", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-pool-relevance-"));
    try {
      const dir = join(root, "data", "editions", "260101", "_internal");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "01-categorized.json"), JSON.stringify({ radar: [{ url: "https://a.example/1", title: "A" }] }));
      // sem 01-approved.json
      const { candidates, skipped } = collectPoolRelevanceCandidates(root);
      assert.equal(candidates.length, 0);
      assert.equal(skipped.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluatePoolRelevance", () => {
  function fakeFetch(byUrl: Record<string, { about_ai: number; audience_fit: number }>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const url = body.state.url as string;
      const answers = byUrl[url];
      if (!answers) throw new Error(`sem fixture para ${url}`);
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            about_ai: { type: "noul", noul: answers.about_ai, confidence: 1 },
            audience_fit: { type: "noul", noul: answers.audience_fit, confidence: 1 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
  }

  it("só filtra quando AMBOS os eixos ficam abaixo do limiar", async () => {
    const candidates = [
      { id: "https://x/1", edition: "260101", title: "t1", url: "https://x/1", summary: "s1", decision: "aprovado" as const },
      { id: "https://x/2", edition: "260101", title: "t2", url: "https://x/2", summary: "s2", decision: "descartado" as const },
      { id: "https://x/3", edition: "260101", title: "t3", url: "https://x/3", summary: "s3", decision: "descartado" as const },
    ];
    const fetchImpl = fakeFetch({
      "https://x/1": { about_ai: 0.9, audience_fit: 0.1 }, // só 1 eixo baixo — NÃO filtra
      "https://x/2": { about_ai: 0.1, audience_fit: 0.9 }, // só 1 eixo baixo — NÃO filtra
      "https://x/3": { about_ai: 0.05, audience_fit: 0.05 }, // os 2 baixos — FILTRA
    });
    const { results, errors } = await evaluatePoolRelevance(candidates, { apiKey: "test", threshold: 0.3, cacheDir: null, fetchImpl });
    assert.equal(errors.size, 0);
    const byId = new Map(results.map((r) => [r.id, r]));
    assert.equal(byId.get("https://x/1")?.poolFiltered, false);
    assert.equal(byId.get("https://x/2")?.poolFiltered, false);
    assert.equal(byId.get("https://x/3")?.poolFiltered, true);
  });
});
