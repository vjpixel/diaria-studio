/**
 * diaria-subscribers-backfill-edicao-canonica.test.ts (#7204, follow-up
 * pós-#7249)
 *
 * Cobre `scripts/diaria-subscribers-backfill-edicao-canonica.ts`: dry-run
 * (nunca escreve, ROLLBACK), `--apply` (backup + escreve + guard de
 * conservação), e os 2 erros de preflight (`data/` ausente, store ausente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDiariaSubscribersDb, ensureSubscriber, recordEvent } from "../scripts/lib/diaria-subscribers-db.ts";
import { main as backfillMain } from "../scripts/diaria-subscribers-backfill-edicao-canonica.ts";

function withCapturedLog<T>(fn: () => T): { result: T; out: string } {
  const origLog = console.log;
  let out = "";
  console.log = (msg?: unknown) => {
    out += String(msg);
  };
  try {
    const result = fn();
    return { result, out };
  } finally {
    console.log = origLog;
  }
}

function seedStore(dbPath: string): void {
  const seed = openDiariaSubscribersDb(dbPath);
  const beehiivId = ensureSubscriber(seed, "beehiiv", "bh-1", "a@x.com", "2026-04-27T06:00:00.000Z");
  const kitId = ensureSubscriber(seed, "kit", null, "b@x.com", "2026-04-27T06:00:00.000Z");
  recordEvent(seed, {
    subscriberId: beehiivId,
    platform: "beehiiv",
    type: "delivered",
    externalEventId: "bh-d1",
    edicao: "post_abc",
    ts: "2026-04-27T06:00:00.000Z",
  });
  recordEvent(seed, {
    subscriberId: kitId,
    platform: "kit",
    type: "delivered",
    externalEventId: "kit-d1",
    edicao: "bcast_xyz",
    ts: "2026-04-27T06:10:00.000Z",
  });
  seed.close();
}

describe("diaria-subscribers-backfill-edicao-canonica main() — dry-run (default)", () => {
  it("relata sem escrever — edicao_canonica continua NULL no .db real (ROLLBACK)", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "backfill-canonica-dryrun-"));
    const dbDir = resolve(dataRoot, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    seedStore(dbPath);

    const { result, out } = withCapturedLog(() => backfillMain(["--db", dbPath]));
    void result;
    const payload = JSON.parse(out);
    assert.equal(payload.mode, "dry-run");
    assert.equal(payload.groups_resolved, 2);
    assert.equal(payload.rows_would_update, 2);
    assert.equal(payload.distinct_edicao_before, 2);
    assert.equal(payload.distinct_edicao_canonica_would_be, 1, "as 2 edições nativas resolvem pro MESMO dia — 1 canônica");

    // Nenhum backup criado, e o .db real continua sem edicao_canonica gravado.
    const files = readdirSync(dbDir);
    assert.ok(!files.some((f) => f.includes(".backup-")), "dry-run nunca cria backup");
    const check = openDiariaSubscribersDb(dbPath);
    const row = check.prepare("SELECT edicao_canonica FROM event LIMIT 1").get() as { edicao_canonica: string | null };
    assert.equal(row.edicao_canonica, null);
    check.close();
  });
});

describe("diaria-subscribers-backfill-edicao-canonica main() — --apply", () => {
  it("faz backup, grava edicao_canonica de verdade, guard de conservação passa", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "backfill-canonica-apply-"));
    const dbDir = resolve(dataRoot, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    seedStore(dbPath);

    const { out } = withCapturedLog(() => backfillMain(["--db", dbPath, "--apply"]));
    const payload = JSON.parse(out);
    assert.equal(payload.mode, "apply");
    assert.ok(existsSync(payload.backup), "backup precisa existir de verdade no disco");
    assert.equal(payload.rows_updated, 2);
    assert.equal(payload.conservation.ok, true);
    assert.equal(payload.conservation.events_before, payload.conservation.events_after);
    assert.equal(payload.distinct_edicao_canonica_after, 1);

    const check = openDiariaSubscribersDb(dbPath);
    const rows = check.prepare("SELECT edicao_canonica FROM event").all() as Array<{ edicao_canonica: string | null }>;
    assert.deepEqual(rows.map((r) => r.edicao_canonica).sort(), ["260427", "260427"]);
    check.close();
  });

  it("idempotente — rodar --apply 2x na 2ª execução atualiza 0 linhas", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "backfill-canonica-apply-idempotent-"));
    const dbDir = resolve(dataRoot, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    seedStore(dbPath);

    withCapturedLog(() => backfillMain(["--db", dbPath, "--apply"]));
    const { out } = withCapturedLog(() => backfillMain(["--db", dbPath, "--apply"]));
    const payload = JSON.parse(out);
    assert.equal(payload.rows_updated, 0);
    assert.equal(payload.conservation.ok, true);
  });
});

describe("diaria-subscribers-backfill-edicao-canonica main() — preflight", () => {
  it("data/ ausente: exitCode 1, mensagem clara", () => {
    const bogusRoot = resolve(tmpdir(), `backfill-canonica-no-dataroot-${Date.now()}`);
    const dbPath = resolve(bogusRoot, "diaria-subscribers", "diaria-subscribers.db");
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      backfillMain(["--db", dbPath]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("store ainda não existe: exitCode 1, mensagem clara", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "backfill-canonica-no-store-"));
    const dbDir = resolve(dataRoot, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      backfillMain(["--db", dbPath]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
