/**
 * test/cleanup-preflight-test-subscribers.test.ts (#5545)
 *
 * Regra #633: cobre a lógica pura de parsing/formatação da limpeza de
 * cadastros de teste. A função de I/O (`cleanupOne`, não exportada — módulo
 * é CLI-first) é coberta indiretamente pelos testes de
 * `fetchBeehiivSubscriptionUtm`/`deleteBeehiivSubscription` em
 * `test/preflight-utm.test.ts`, que este script consome sem lógica extra.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEmailList,
  formatCleanupSummary,
  type CleanupResult,
} from "../scripts/cleanup-preflight-test-subscribers.ts";

describe("parseEmailList (#5545)", () => {
  it("parseia lista simples separada por vírgula", () => {
    assert.deepEqual(parseEmailList("a@x.com,b@x.com,c@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("ignora espaços e segmentos vazios", () => {
    assert.deepEqual(parseEmailList(" a@x.com , ,b@x.com,"), ["a@x.com", "b@x.com"]);
  });

  it("lista vazia para string vazia", () => {
    assert.deepEqual(parseEmailList(""), []);
  });

  it("aceita 1 e-mail só", () => {
    assert.deepEqual(parseEmailList("a@x.com"), ["a@x.com"]);
  });
});

describe("formatCleanupSummary (#5545)", () => {
  it("mensagem dedicada para lista vazia", () => {
    assert.equal(formatCleanupSummary([], true), "(nenhum e-mail informado)");
  });

  it("dry-run: reporta 'SERIA deletado' e o aviso de --execute", () => {
    const results: CleanupResult[] = [
      { email: "a@x.com", action: "would_delete", id: "sub_1", status: "pending" },
    ];
    const out = formatCleanupSummary(results, true);
    assert.match(out, /SERIA deletado \(id=sub_1, status=pending\)/);
    assert.match(out, /--dry-run: nenhuma escrita foi feita/);
  });

  it("execute: reporta 'deletado' sem o aviso de dry-run", () => {
    const results: CleanupResult[] = [{ email: "a@x.com", action: "deleted", id: "sub_1", status: "pending" }];
    const out = formatCleanupSummary(results, false);
    assert.match(out, /a@x\.com: deletado \(id=sub_1\)\./);
    assert.doesNotMatch(out, /--dry-run/);
    assert.match(out, /Limpeza concluída\./);
  });

  it("já ausente é reportado como sucesso idempotente, não erro", () => {
    const results: CleanupResult[] = [{ email: "a@x.com", action: "already_absent", id: null, status: null }];
    const out = formatCleanupSummary(results, true);
    assert.match(out, /já ausente na Beehiiv — nada a fazer\./);
  });

  it("falha de delete inclui o motivo", () => {
    const results: CleanupResult[] = [
      { email: "a@x.com", action: "delete_failed", id: "sub_1", status: "pending", error: "HTTP 500" },
    ];
    const out = formatCleanupSummary(results, false);
    assert.match(out, /FALHA ao deletar \(id=sub_1\) — HTTP 500/);
  });

  it("mistura de resultados — cada linha reflete a ação correta", () => {
    const results: CleanupResult[] = [
      { email: "a@x.com", action: "already_absent", id: null, status: null },
      { email: "b@x.com", action: "deleted", id: "sub_2", status: "active" },
    ];
    const out = formatCleanupSummary(results, false);
    assert.match(out, /a@x\.com: já ausente/);
    assert.match(out, /b@x\.com: deletado \(id=sub_2\)\./);
  });
});
