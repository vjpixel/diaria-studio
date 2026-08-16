/**
 * test/extract-opens-catchup-status.test.ts (#4740)
 *
 * Extração JSON-aware do campo `opens_catchup` a partir do log bruto
 * (stdout+stderr mesclados) de uma run de `clarice-sync-brevo.ts --incremental`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLastJsonObjectWithKey,
  extractOpensCatchupStatus,
} from "../scripts/lib/extract-opens-catchup-status.ts";

const NOW = new Date("2026-08-07T08:30:00.000Z");

function fakeLog(summaryJson: unknown): string {
  return [
    "===== 2026-08-07T08:30:00.000Z - clarice sync diario =====",
    "----- clarice-sync-brevo --incremental -----",
    "🔄 sync incremental: 42 contatos modificados desde 2026-08-06...",
    "🔄 catch-up de opens (janela 30d) — campanhas enviadas recentemente…",
    "✅ catch-up: 3/3 campanhas na janela (0 falharam) · 12 openers · 12 contatos atualizados (0 falharam)",
    "⚙️  recomputando derivados (send_eligible + priority_points)…",
    JSON.stringify(summaryJson, null, 2),
  ].join("\n");
}

describe("extractLastJsonObjectWithKey (#4740)", () => {
  it("extrai o objeto JSON balanceado que contém a chave, ignorando linhas de progresso não-JSON", () => {
    const log = fakeLog({ mode: "incremental", opens_catchup: { ok: true } });
    const obj = extractLastJsonObjectWithKey(log, "opens_catchup");
    assert.ok(obj);
    assert.deepEqual(obj!.opens_catchup, { ok: true });
  });

  it("chaves literais dentro de strings de erro não confundem o brace-matching", () => {
    // Mensagem de erro contém `{` e `}` literais — não deve quebrar o parse.
    const log = fakeLog({
      mode: "incremental",
      opens_catchup: { ok: false, error: 'unexpected token in response: {"foo": "bar"}' },
    });
    const obj = extractLastJsonObjectWithKey(log, "opens_catchup");
    assert.ok(obj, "deve extrair mesmo com chaves dentro de string");
    assert.equal((obj!.opens_catchup as { error: string }).error, 'unexpected token in response: {"foo": "bar"}');
  });

  it("retorna null quando a chave nunca aparece em nenhum objeto JSON válido", () => {
    const log = fakeLog({ mode: "incremental", contacts_synced: 10 });
    assert.equal(extractLastJsonObjectWithKey(log, "opens_catchup"), null);
  });

  it("retorna null em texto sem nenhum JSON balanceado", () => {
    const log = "só linhas de progresso\nsem nenhum blob JSON aqui\n";
    assert.equal(extractLastJsonObjectWithKey(log, "opens_catchup"), null);
  });

  it("pega o ÚLTIMO objeto com a chave quando há mais de um no texto", () => {
    const log = `${JSON.stringify({ opens_catchup: { ok: false, error: "primeira tentativa" } })}\ntexto no meio\n${JSON.stringify({ opens_catchup: { ok: true } })}`;
    const obj = extractLastJsonObjectWithKey(log, "opens_catchup");
    assert.deepEqual(obj!.opens_catchup, { ok: true });
  });
});

describe("extractOpensCatchupStatus (#4740)", () => {
  it("opens_catchup.ok=true → status ok", () => {
    const log = fakeLog({ opens_catchup: { ok: true, result: { campaignsInWindow: 3 } } });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.deepEqual(r, { status: "ok", checked_at: NOW.toISOString() });
  });

  it("REGRESSÃO (#5401): opens_catchup.ok=true mas result.campaignsFailed>0 → status error, não ok (cobertura parcial não fica invisível)", () => {
    const log = fakeLog({
      opens_catchup: { ok: true, result: { campaignsInWindow: 49, campaignsFailed: 1 } },
    });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.equal(r.status, "error");
    assert.equal(
      (r as { error: string }).error,
      "cobertura parcial: 1/49 campanha(s) na janela falharam no export",
    );
  });

  it("#5401: opens_catchup.ok=true com result.contactsFailed>0 mas campaignsFailed=0 → continua ok (404 pontual não é falha de cobertura de campanha)", () => {
    const log = fakeLog({
      opens_catchup: { ok: true, result: { campaignsInWindow: 3, campaignsFailed: 0, contactsFailed: 2 } },
    });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.equal(r.status, "ok");
  });

  it("opens_catchup.ok=false → status error com a mensagem", () => {
    const log = fakeLog({ opens_catchup: { ok: false, error: "listSentCampaigns rejeitou: 429" } });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.deepEqual(r, { status: "error", error: "listSentCampaigns rejeitou: 429", checked_at: NOW.toISOString() });
  });

  it("opens_catchup=null (modo full, ou --no-catch-opens) → not_run, nunca error", () => {
    const log = fakeLog({ mode: "full", opens_catchup: null });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.equal(r.status, "not_run");
  });

  it("summary não encontrado no log (sync crashou antes de imprimir) → not_run (fail-soft)", () => {
    const r = extractOpensCatchupStatus("erro fatal: algo quebrou antes do summary\n", NOW);
    assert.equal(r.status, "not_run");
  });

  it("checked_at usa o timestamp passado, não Date.now() implícito", () => {
    const log = fakeLog({ opens_catchup: { ok: true } });
    const r = extractOpensCatchupStatus(log, NOW);
    assert.equal(r.checked_at, "2026-08-07T08:30:00.000Z");
  });
});
