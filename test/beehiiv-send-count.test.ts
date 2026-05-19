/**
 * test/beehiiv-send-count.test.ts (#1419)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSendCount,
  recordSend,
  decideWarnLevel,
  shouldResetWindow,
  WARN_THRESHOLD,
  BLOCK_THRESHOLD,
  getCountFilePath,
} from "../scripts/lib/beehiiv-send-count.ts";

function makeFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "diaria-send-count-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadSendCount (#1419)", () => {
  it("retorna null quando arquivo ausente", () => {
    const { dir, cleanup } = makeFixture();
    assert.equal(loadSendCount(dir), null);
    cleanup();
  });

  it("retorna estado pleno quando arquivo válido", () => {
    const { dir, cleanup } = makeFixture();
    recordSend(dir, true);
    const state = loadSendCount(dir);
    assert.ok(state);
    assert.equal(state?.count, 1);
    assert.ok(state?.first_sent_at);
    cleanup();
  });
});

describe("recordSend (#1419)", () => {
  it("incrementa counter a cada send", () => {
    const { dir, cleanup } = makeFixture();
    const s1 = recordSend(dir, true);
    assert.equal(s1.count, 1);
    const s2 = recordSend(dir, true);
    assert.equal(s2.count, 2);
    const s3 = recordSend(dir, false);
    assert.equal(s3.count, 3);
    cleanup();
  });

  it("preserva first_sent_at, atualiza last_sent_at", () => {
    const { dir, cleanup } = makeFixture();
    let t = 0;
    const clock = () => new Date(Date.UTC(2026, 4, 20, 18, 0, 0) + t * 60_000);
    t = 0;
    const s1 = recordSend(dir, true, clock);
    t = 30;
    const s2 = recordSend(dir, true, clock);
    assert.equal(s1.first_sent_at, s2.first_sent_at);
    assert.notEqual(s1.last_sent_at, s2.last_sent_at);
    cleanup();
  });

  it("history limitado a 20 últimos sends (rolling window)", () => {
    const { dir, cleanup } = makeFixture();
    for (let i = 0; i < 25; i++) recordSend(dir, true);
    const state = loadSendCount(dir);
    assert.equal(state?.count, 25);
    assert.equal(state?.history.length, 20);
    cleanup();
  });

  it("grava arquivo JSON válido", () => {
    const { dir, cleanup } = makeFixture();
    recordSend(dir, true);
    const path = getCountFilePath(dir);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.count, 1);
    cleanup();
  });
});

describe("decideWarnLevel (#1419)", () => {
  it("ok quando count < WARN_THRESHOLD", () => {
    for (let i = 0; i < WARN_THRESHOLD; i++) {
      assert.equal(decideWarnLevel(i).level, "ok");
    }
  });

  it("warn quando WARN_THRESHOLD <= count < BLOCK_THRESHOLD", () => {
    for (let i = WARN_THRESHOLD; i < BLOCK_THRESHOLD; i++) {
      const r = decideWarnLevel(i);
      assert.equal(r.level, "warn");
      assert.match(r.message, /rate.?limit/i);
    }
  });

  it("#1419: block quando count >= BLOCK_THRESHOLD (caso 260520: sends 11-14 stale)", () => {
    const r = decideWarnLevel(10);
    assert.equal(r.level, "block");
    assert.match(r.message, /aguarde/i);
    const r14 = decideWarnLevel(14);
    assert.equal(r14.level, "block");
  });
});

describe("shouldResetWindow (#1419)", () => {
  it("true quando passou > 1h desde last_sent_at", () => {
    const now = new Date("2026-05-20T20:00:00Z");
    const lastIso = "2026-05-20T18:30:00Z"; // 1h30 atrás
    assert.equal(shouldResetWindow(lastIso, now), true);
  });

  it("false quando dentro da janela 1h", () => {
    const now = new Date("2026-05-20T20:00:00Z");
    const lastIso = "2026-05-20T19:30:00Z"; // 30min atrás
    assert.equal(shouldResetWindow(lastIso, now), false);
  });

  it("true quando lastSentIso é inválido (defensive)", () => {
    assert.equal(shouldResetWindow("not-a-date"), true);
  });

  it("respeita windowMs custom", () => {
    const now = new Date("2026-05-20T20:00:00Z");
    const lastIso = "2026-05-20T19:55:00Z"; // 5min atrás
    // window padrão 1h: false
    assert.equal(shouldResetWindow(lastIso, now), false);
    // window 2min: true
    assert.equal(shouldResetWindow(lastIso, now, 2 * 60 * 1000), true);
  });
});
