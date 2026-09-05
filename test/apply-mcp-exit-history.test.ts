/**
 * apply-mcp-exit-history.test.ts (#7248)
 *
 * Cobre `applyExitHistoryPage` — write JSONL mesclado + avanço do
 * checkpoint de paginação. Sem rede — a extração real via MCP só é
 * chamável de dentro de uma sessão Claude.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  applyExitHistoryPage,
  extractExitHistoryPayload,
  UnrecognizedExitHistoryPayloadError,
} from "../scripts/apply-mcp-exit-history.ts";
import type { ExitHistoryManifest } from "../scripts/lib/beehiiv-exit-history.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apply-mcp-exit-history-"));
  return { outDir: resolve(dir, "exit-history") };
}

function readManifest(outDir: string): ExitHistoryManifest {
  return JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
}

function readJsonl(outDir: string): unknown[] {
  return readFileSync(resolve(outDir, "subscribers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("extractExitHistoryPayload — tolerância de input", () => {
  it("aceita a resposta crua da MCP { pagination, subscriptions }", () => {
    const { rows, pagination } = extractExitHistoryPayload({
      pagination: { page: 1, per_page: 100, total: 847, total_pages: 9 },
      subscriptions: [{ id: "sub_1", status: "inactive" }],
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(pagination, { page: 1, per_page: 100, total: 847, total_pages: 9 });
  });

  it("aceita { data: [...] } sem pagination", () => {
    const { rows, pagination } = extractExitHistoryPayload({ data: [{ id: "sub_1" }] });
    assert.equal(rows.length, 1);
    assert.deepEqual(pagination, { page: undefined, per_page: undefined, total: undefined, total_pages: undefined });
  });

  it("aceita array nu", () => {
    const { rows } = extractExitHistoryPayload([{ id: "sub_1" }]);
    assert.equal(rows.length, 1);
  });

  it("aceita { pagination: {...} } sem subscriptions/data — página genuinamente vazia (pagination reconhecível é o sinal de forma válida)", () => {
    const { rows, pagination } = extractExitHistoryPayload({
      pagination: { page: 3, per_page: 100, total: 200, total_pages: 3 },
    });
    assert.deepEqual(rows, []);
    assert.deepEqual(pagination, { page: 3, per_page: 100, total: 200, total_pages: 3 });
  });

  // #7426 fleet review finding 1 (silent-failure-hunter, alta confiança): payload
  // sem subscriptions[]/data[]/pagination reconhecível é uma falha DURA, não
  // mais um colapso silencioso pra {rows: [], pagination: {}} — senão um corpo
  // de erro/rate-limit da MCP encaminhado por engano vira "0 linhas, exit 0",
  // indistinguível de uma página genuinamente vazia (viola #738/#573).
  it("input string não reconhecido → falha dura (UnrecognizedExitHistoryPayloadError), nunca tolerante-vazio", () => {
    assert.throws(() => extractExitHistoryPayload("garbage"), UnrecognizedExitHistoryPayloadError);
  });

  it("payload de erro típico da MCP ({error: {code, message}}) → falha dura, não sucesso silencioso", () => {
    assert.throws(
      () => extractExitHistoryPayload({ error: { code: 429, message: "rate limited" } }),
      UnrecognizedExitHistoryPayloadError,
    );
  });

  it("objeto vazio ({}) → falha dura (não bate nenhuma forma esperada)", () => {
    assert.throws(() => extractExitHistoryPayload({}), UnrecognizedExitHistoryPayloadError);
  });

  it("null/undefined → falha dura", () => {
    assert.throws(() => extractExitHistoryPayload(null), UnrecognizedExitHistoryPayloadError);
    assert.throws(() => extractExitHistoryPayload(undefined), UnrecognizedExitHistoryPayloadError);
  });
});

describe("applyExitHistoryPage — write JSONL + manifest", () => {
  it("1ª página: grava só os registros usáveis (inactive + unsubscribed_on), filtra o resto", () => {
    const { outDir } = setup();
    const payload = JSON.stringify({
      pagination: { page: 1, per_page: 100, total: 2, total_pages: 1 },
      subscriptions: [
        { id: "sub_1", email: "a@b.com", status: "inactive", unsubscribed_on: "2026-09-04T01:19:07Z" },
        { id: "sub_2", email: "c@d.com", status: "pending", unsubscribed_on: null },
      ],
    });
    const result = applyExitHistoryPage(payload, outDir);
    assert.equal(result.before_count, 0);
    assert.equal(result.after_count, 1, "só o registro inactive-com-unsubscribed_on sobrevive ao filtro");
    assert.equal(result.new_or_updated, 1);
    assert.equal(result.page, 1);
    assert.equal(result.complete, true);
    assert.equal(result.next_page, 2);

    const lines = readJsonl(outDir);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { externalId: "sub_1", email: "a@b.com", unsubscribedOn: "2026-09-04T01:19:07Z" });
  });

  it("2 páginas em sequência acumulam sem sobrescrever a 1ª", () => {
    const { outDir } = setup();
    applyExitHistoryPage(
      JSON.stringify({
        pagination: { page: 1, per_page: 1, total: 2, total_pages: 2 },
        subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }],
      }),
      outDir,
    );
    const result2 = applyExitHistoryPage(
      JSON.stringify({
        pagination: { page: 2, per_page: 1, total: 2, total_pages: 2 },
        subscriptions: [{ id: "sub_2", status: "inactive", unsubscribed_on: "2026-09-02T00:00:00Z" }],
      }),
      outDir,
    );
    assert.equal(result2.before_count, 1);
    assert.equal(result2.after_count, 2, "a 2ª página é MESCLADA, não substitui a 1ª");
    assert.equal(result2.complete, true);

    const manifest = readManifest(outDir);
    assert.equal(manifest.pages_fetched, 2);
    assert.equal(manifest.complete, true);
  });

  it("página com 0 registros úteis (todos filtrados) nunca apaga o que já está em disco — só mescla", () => {
    const { outDir } = setup();
    applyExitHistoryPage(
      JSON.stringify({
        pagination: { page: 1, per_page: 1, total: 2, total_pages: 2 },
        subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }],
      }),
      outDir,
    );
    const result2 = applyExitHistoryPage(
      JSON.stringify({
        pagination: { page: 2, per_page: 1, total: 2, total_pages: 2 },
        subscriptions: [{ id: "sub_2", status: "active" }], // filtrado — sem unsubscribed_on
      }),
      outDir,
    );
    assert.equal(result2.after_count, 1, "página 2 não contribuiu registros, mas a página 1 continua intacta");
    assert.equal(result2.new_or_updated, 0);
  });

  it("re-aplicar a MESMA página (retry após erro de rede no meio) é idempotente — não duplica nem regride o checkpoint", () => {
    const { outDir } = setup();
    const page1 = JSON.stringify({
      pagination: { page: 1, per_page: 100, total: 1, total_pages: 1 },
      subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }],
    });
    applyExitHistoryPage(page1, outDir);
    const result2 = applyExitHistoryPage(page1, outDir);
    assert.equal(result2.after_count, 1, "reaplicar a mesma página não duplica o registro");
    assert.equal(result2.pages_fetched, 1);
  });

  it("payload sem pagination.page: aplica ao JSONL mas não avança o checkpoint", () => {
    const { outDir } = setup();
    const result = applyExitHistoryPage(
      JSON.stringify({ subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }] }),
      outDir,
    );
    assert.equal(result.after_count, 1, "dado aplicado mesmo sem pagination");
    assert.equal(result.page, null);
    assert.equal(result.pages_fetched, 0, "checkpoint não avança sem saber qual página era");
  });

  it("diretório de saída é criado sob demanda (data/ ausente não é erro aqui)", () => {
    const { outDir } = setup();
    assert.equal(existsSync(outDir), false);
    applyExitHistoryPage(JSON.stringify({ subscriptions: [] }), outDir);
    assert.equal(existsSync(outDir), true);
  });

  it("página aplicada com pagination.page → pagination_outcome = page-recorded", () => {
    const { outDir } = setup();
    const result = applyExitHistoryPage(
      JSON.stringify({
        pagination: { page: 1, per_page: 100, total: 1, total_pages: 1 },
        subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }],
      }),
      outDir,
    );
    assert.equal(result.pagination_outcome, "page-recorded");
  });

  it("payload sem pagination.page → pagination_outcome = missing-pagination-quirk (#7197)", () => {
    const { outDir } = setup();
    const result = applyExitHistoryPage(
      JSON.stringify({ subscriptions: [{ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-01T00:00:00Z" }] }),
      outDir,
    );
    assert.equal(result.pagination_outcome, "missing-pagination-quirk");
  });

  // #7426 fleet review finding 1: reproduz o cenário concreto do achado —
  // `echo '{"error":{"code":429,"message":"rate limited"}}' | apply-mcp-exit-history.ts`
  // hoje deve lançar (exit 1 via main()), NUNCA aplicar 0 registros com exit 0.
  it("payload de erro (rate-limit 429) → applyExitHistoryPage lança, nunca aplica silenciosamente 0 registros", () => {
    const { outDir } = setup();
    assert.throws(
      () => applyExitHistoryPage(JSON.stringify({ error: { code: 429, message: "rate limited" } }), outDir),
      UnrecognizedExitHistoryPayloadError,
    );
    // nada foi escrito em disco — a falha é anterior a qualquer write.
    assert.equal(existsSync(resolve(outDir, "subscribers.jsonl")), false);
  });

  it("página legitimamente vazia ({subscriptions: [], pagination: {...}}) continua funcionando normalmente", () => {
    const { outDir } = setup();
    const result = applyExitHistoryPage(
      JSON.stringify({ subscriptions: [], pagination: { page: 1, per_page: 100, total: 0, total_pages: 1 } }),
      outDir,
    );
    assert.equal(result.after_count, 0);
    assert.equal(result.complete, true);
    assert.equal(result.pagination_outcome, "page-recorded");
  });
});
