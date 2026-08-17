/**
 * test/meta-capi-batch-send-5504.test.ts (#5504, item (b) do escopo)
 *
 * `scripts/meta-capi-batch-send.ts` — seleção de candidatos do snapshot
 * Beehiiv (`selectCapiCandidates`, pure), índice de idempotência
 * (`loadCapiSentIndex`/`saveCapiSentIndex`) e a orquestração
 * (`runCapiBatch`) com `sendFn` injetado — NUNCA toca rede real nem o
 * módulo `meta-capi.ts` de verdade neste arquivo (guard de publicação do
 * overnight/develop: nenhum script que tocaria Meta ao vivo roda aqui).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectCapiCandidates,
  loadCapiSentIndex,
  saveCapiSentIndex,
  runCapiBatch,
  DEFAULT_WINDOW_DAYS,
  CAPI_BATCH_EVENT_SOURCE_URL,
  type CapiSentIndex,
} from "../scripts/meta-capi-batch-send.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

const NOW = 1_755_000_000; // âncora fixa, pra determinismo

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "leitor@example.com",
    status: "active",
    created: NOW - 60 * 60, // 1h atrás
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "test",
    referring_site: "",
    ...overrides,
  };
}

describe("#5504 — selectCapiCandidates (pure)", () => {
  it("inclui subscriber active dentro da janela", () => {
    const result = selectCapiCandidates([sub()], { windowDays: DEFAULT_WINDOW_DAYS, nowSeconds: NOW });
    assert.equal(result.length, 1);
  });

  it("exclui status != active (ex: pending, invalid)", () => {
    const result = selectCapiCandidates(
      [sub({ status: "pending" }), sub({ status: "invalid" }), sub({ status: "active" })],
      { windowDays: DEFAULT_WINDOW_DAYS, nowSeconds: NOW },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "active");
  });

  it("exclui created fora da janela (mais antigo que windowDays)", () => {
    const tooOld = sub({ created: NOW - 8 * 24 * 60 * 60 }); // 8 dias atrás, janela default 7
    const result = selectCapiCandidates([tooOld], { windowDays: 7, nowSeconds: NOW });
    assert.equal(result.length, 0);
  });

  it("inclui created bem na borda da janela (exatamente windowDays atrás)", () => {
    const edge = sub({ created: NOW - 7 * 24 * 60 * 60 });
    const result = selectCapiCandidates([edge], { windowDays: 7, nowSeconds: NOW });
    assert.equal(result.length, 1);
  });

  it("exclui created no futuro (além de nowSeconds — dado corrompido/relógio divergente)", () => {
    const future = sub({ created: NOW + 1000 });
    const result = selectCapiCandidates([future], { windowDays: 7, nowSeconds: NOW });
    assert.equal(result.length, 0);
  });

  it("exclui subscriber sem `created` numérico válido (defensivo contra shape inesperado)", () => {
    const malformed = sub({ created: undefined as unknown as number });
    const result = selectCapiCandidates([malformed], { windowDays: 7, nowSeconds: NOW });
    assert.equal(result.length, 0);
  });

  it("lista vazia → lista vazia (sem lançar)", () => {
    assert.deepEqual(selectCapiCandidates([], { windowDays: 7, nowSeconds: NOW }), []);
  });

  it("windowDays maior amplia a janela aceita", () => {
    const old = sub({ created: NOW - 20 * 24 * 60 * 60 });
    assert.equal(selectCapiCandidates([old], { windowDays: 7, nowSeconds: NOW }).length, 0);
    assert.equal(selectCapiCandidates([old], { windowDays: 30, nowSeconds: NOW }).length, 1);
  });
});

describe("#5504 — índice de idempotência (loadCapiSentIndex / saveCapiSentIndex)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-capi-idx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("path ausente → {} (fail-soft, nunca lança)", () => {
    assert.deepEqual(loadCapiSentIndex(join(dir, "nope.json")), {});
  });

  it("JSON corrompido → {} (fail-soft)", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{ isto não é json", "utf8");
    assert.deepEqual(loadCapiSentIndex(p), {});
  });

  it("JSON válido mas não é um objeto (ex: array) → {} (fail-soft)", () => {
    const p = join(dir, "array.json");
    writeFileSync(p, "[1,2,3]", "utf8");
    assert.deepEqual(loadCapiSentIndex(p), {});
  });

  it("roundtrip save → load preserva o conteúdo", () => {
    const p = join(dir, "sub", "index.json"); // diretório ainda não existe
    const index: CapiSentIndex = { abc123: { sentAt: "2026-08-16T00:00:00.000Z" } };
    saveCapiSentIndex(p, index);
    assert.deepEqual(loadCapiSentIndex(p), index);
  });
});

describe("#5504 — runCapiBatch (orquestração, sendFn injetado — sem rede real)", () => {
  let root: string;
  let sentIndexPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meta-capi-snapshot-"));
    sentIndexPath = join(root, "_meta-capi-sent.json");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSnapshot(date: string, subscribers: BeehiivBackupSubscriber[]): void {
    const dir = join(root, date);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "subscribers.jsonl"), subscribers.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  }

  it("nenhum snapshot disponível → resumo zerado, snapshotDate null, nunca lança", async () => {
    const summary = await runCapiBatch({ root, sentIndexPath, nowSeconds: NOW, log: () => {} });
    assert.equal(summary.snapshotDate, null);
    assert.equal(summary.candidates, 0);
    assert.equal(summary.sent, 0);
  });

  it("dry-run: identifica candidatos mas NUNCA chama sendFn nem grava o índice", async () => {
    writeSnapshot("2026-08-14", [sub(), sub({ email: "b@example.com" })]);
    let sendCalls = 0;
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      dryRun: true,
      sendFn: async () => {
        sendCalls++;
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.candidates, 2);
    assert.equal(summary.sent, 0);
    assert.equal(sendCalls, 0, "dry-run nunca deveria invocar sendFn");
    assert.equal(loadCapiSentIndex(sentIndexPath) && Object.keys(loadCapiSentIndex(sentIndexPath)).length, 0);
  });

  it("envio real: chama sendFn 1x por candidato e grava o event_id no índice", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com" }), sub({ email: "b@example.com" })]);
    const sentEmails: string[] = [];
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      dryRun: false,
      accessToken: "tok",
      sendFn: async (input) => {
        sentEmails.push(input.email);
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(summary.sent, 2);
    assert.equal(summary.failed, 0);
    assert.equal(sentEmails.length, 2);
    const index = loadCapiSentIndex(sentIndexPath);
    assert.equal(Object.keys(index).length, 2);
  });

  it("idempotência: candidato já no índice (mesmo event_id) NÃO é reenviado numa 2ª chamada", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com", created: NOW - 3600 })]);
    let calls = 0;
    const runOnce = () =>
      runCapiBatch({
        root,
        sentIndexPath,
        nowSeconds: NOW,
        accessToken: "tok",
        sendFn: async () => {
          calls++;
          return { ok: true, status: 200 };
        },
        log: () => {},
      });
    const first = await runOnce();
    assert.equal(first.sent, 1);
    assert.equal(first.alreadySent, 0);

    const second = await runOnce();
    assert.equal(second.sent, 0, "já estava no índice — não deveria reenviar");
    assert.equal(second.alreadySent, 1);
    assert.equal(calls, 1, "sendFn só deveria ter sido chamado 1 vez no total (1ª chamada), não 2");
  });

  it("resultado not_configured do sendFn conta como skippedNotConfigured, não como falha, e NÃO entra no índice", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com" })]);
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      sendFn: async () => ({ ok: false, status: 503, reason: "not_configured" }),
      log: () => {},
    });
    assert.equal(summary.skippedNotConfigured, 1);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(loadCapiSentIndex(sentIndexPath), {});
  });

  it("falha de envio (meta_error/network_error) conta como failed e NÃO entra no índice — nunca lança", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com" })]);
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      sendFn: async () => ({ ok: false, status: 500, reason: "meta_error" }),
      log: () => {},
    });
    assert.equal(summary.failed, 1);
    assert.deepEqual(loadCapiSentIndex(sentIndexPath), {});
  });

  it("--limit corta o número de envios desta execução, sem descartar os demais (ficam pra próxima rodada)", async () => {
    writeSnapshot("2026-08-14", [
      sub({ email: "a@example.com" }),
      sub({ email: "b@example.com" }),
      sub({ email: "c@example.com" }),
    ]);
    let calls = 0;
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      accessToken: "tok",
      limit: 1,
      sendFn: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(summary.candidates, 3);
    assert.equal(summary.toSend, 1);
    assert.equal(summary.sent, 1);
    assert.equal(calls, 1);
  });

  it("usa o snapshot mais RECENTE quando nenhum --snapshot é passado", async () => {
    writeSnapshot("2026-08-10", [sub({ email: "old-snapshot@example.com" })]);
    writeSnapshot("2026-08-14", [sub({ email: "new-snapshot@example.com" })]);
    const seen: string[] = [];
    const summary = await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      accessToken: "tok",
      sendFn: async (input) => {
        seen.push(input.email);
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(summary.snapshotDate, "2026-08-14");
    assert.deepEqual(seen, ["new-snapshot@example.com"]);
  });

  it("eventSourceUrl do batch é sempre a home pública (única origem coberta pelo item (b))", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com" })]);
    let seenUrl = "";
    await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      accessToken: "tok",
      sendFn: async (input) => {
        seenUrl = input.eventSourceUrl;
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(seenUrl, CAPI_BATCH_EVENT_SOURCE_URL);
  });

  it("actionSource do batch é sempre 'system_generated' (não é um clique de navegador no momento do envio)", async () => {
    writeSnapshot("2026-08-14", [sub({ email: "a@example.com" })]);
    let seenActionSource = "";
    await runCapiBatch({
      root,
      sentIndexPath,
      nowSeconds: NOW,
      accessToken: "tok",
      sendFn: async (input) => {
        seenActionSource = input.actionSource;
        return { ok: true, status: 200 };
      },
      log: () => {},
    });
    assert.equal(seenActionSource, "system_generated");
  });
});
