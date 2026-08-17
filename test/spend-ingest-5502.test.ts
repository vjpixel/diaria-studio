/**
 * test/spend-ingest-5502.test.ts (#5502 Parte B)
 *
 * Núcleo genérico de `scripts/lib/spend-ingest.ts` (`mergeSpendRows` +
 * `runSpendIngest`) — o motor agnóstico de canal que
 * `google-ads-ingest.ts`/`microsoft-ads-ingest.ts` adaptam. Não repete os
 * testes de `google-ads-ingest-5237.test.ts` (esses continuam cobrindo o
 * adaptador Google ponta a ponta, inalterados pelo refactor); aqui é só o
 * motor genérico com um fetcher sintético.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSpendRows, runSpendIngest, type SpendIngestFetcher } from "../scripts/lib/spend-ingest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

describe("#5502 — mergeSpendRows (motor genérico)", () => {
  const existing: SpendRow[] = [
    { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" },
    { canal: "Microsoft Advertising", mes: "2026-08", moeda: "BRL", valor: 0, fonte: "placeholder" },
  ];

  it("substitui a linha existente do mesmo (canal, mes)", () => {
    const incoming: SpendRow[] = [{ canal: "Microsoft Advertising", mes: "2026-08", moeda: "BRL", valor: 120.5, fonte: "Bing Ads Reporting API" }];
    const merged = mergeSpendRows(existing, incoming);
    assert.equal(merged.length, 2);
    const ms = merged.find((r) => r.canal === "Microsoft Advertising")!;
    assert.equal(ms.valor, 120.5);
  });

  it("preserva linhas de outros canais/meses intactas", () => {
    const incoming: SpendRow[] = [{ canal: "Microsoft Advertising", mes: "2026-09", moeda: "BRL", valor: 50, fonte: "Bing Ads" }];
    const merged = mergeSpendRows(existing, incoming);
    assert.equal(merged.length, 3);
    assert.ok(merged.some((r) => r.canal === "Google Ads"));
  });
});

describe("#5502 — runSpendIngest (orquestração genérica fetch→merge, fail-soft)", () => {
  const existingRows: SpendRow[] = [{ canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" }];

  it("caminho feliz: fetcher devolve rows -> merge atualizado", async () => {
    const fetcher: SpendIngestFetcher = async () => ({
      kind: "ok",
      rows: [{ canal: "Microsoft Advertising", mes: "2026-08", moeda: "BRL", valor: 200, fonte: "Bing Ads Reporting API" }],
      fetchedCount: 7,
    });
    const result = await runSpendIngest({ fetcher, existingRows });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.fetchedCount, 7);
      assert.ok(result.rows.some((r) => r.canal === "Microsoft Advertising" && r.valor === 200));
      assert.ok(result.rows.some((r) => r.canal === "Google Ads")); // preservado
    }
  });

  it("fetcher devolve { kind: 'error' } -> fallback, nunca lança", async () => {
    const fetcher: SpendIngestFetcher = async () => ({ kind: "error", reason: "credencial ausente" });
    const result = await runSpendIngest({ fetcher, existingRows });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.match(result.reason, /credencial ausente/);
  });

  it("fetcher devolve rows vazio -> fallback (nada pra atualizar), nunca lança", async () => {
    const fetcher: SpendIngestFetcher = async () => ({ kind: "ok", rows: [], fetchedCount: 0 });
    const result = await runSpendIngest({ fetcher, existingRows });
    assert.equal(result.kind, "fallback");
  });

  it("fetcher que lança propaga a exceção — runSpendIngest não engole erro de bug do adaptador (só falha DECLARADA vira fallback)", async () => {
    const fetcher: SpendIngestFetcher = async () => {
      throw new Error("bug do adaptador");
    };
    await assert.rejects(() => runSpendIngest({ fetcher, existingRows }), /bug do adaptador/);
  });
});
