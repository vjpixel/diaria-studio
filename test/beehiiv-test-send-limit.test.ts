/**
 * test/beehiiv-test-send-limit.test.ts (#2376)
 *
 * Testes de regressão para o helper de tracking do limite de test emails
 * por post no Beehiiv.
 *
 * Cobre os três comportamentos críticos para prevenir o bug do incidente 260619:
 * 1. incrementTestEmailCount: persiste e incrementa corretamente
 * 2. decideTestSendAction: alerta em >= 3, fallback em > 3
 * 3. markDraftVerified: seta draft_verified=true preservando outros campos
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readTestEmailCount,
  incrementTestEmailCount,
  markDraftVerified,
  decideTestSendAction,
  TEST_SEND_ALERT_THRESHOLD,
} from "../scripts/lib/beehiiv-test-send-limit.ts";

function makeFixture(initialPublished?: Record<string, unknown>): {
  dir: string;
  publishedPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "diaria-test-send-limit-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const publishedPath = resolve(dir, "_internal", "05-published.json");
  if (initialPublished !== undefined) {
    writeFileSync(publishedPath, JSON.stringify(initialPublished, null, 2) + "\n", "utf8");
  }
  return { dir, publishedPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// readTestEmailCount
// ---------------------------------------------------------------------------

describe("readTestEmailCount (#2376)", () => {
  it("retorna 0 quando 05-published.json não existe", () => {
    const { dir, cleanup } = makeFixture();
    assert.equal(readTestEmailCount(dir), 0);
    cleanup();
  });

  it("retorna 0 quando campo test_email_count ausente", () => {
    const { dir, cleanup } = makeFixture({ draft_url: "https://app.beehiiv.com/posts/x/edit", status: "draft" });
    assert.equal(readTestEmailCount(dir), 0);
    cleanup();
  });

  it("retorna valor correto quando campo presente", () => {
    const { dir, cleanup } = makeFixture({ test_email_count: 2, status: "draft" });
    assert.equal(readTestEmailCount(dir), 2);
    cleanup();
  });

  it("retorna 0 para valor negativo (defensivo)", () => {
    // Valores negativos são inválidos por definição (nonnegative no schema Zod)
    const { dir, cleanup } = makeFixture({ test_email_count: -1, status: "draft" });
    // readTestEmailCount deve rejeitar valores negativos
    assert.equal(readTestEmailCount(dir), 0);
    cleanup();
  });

  it("retorna 0 para valor não-numérico (defensivo)", () => {
    const { dir, cleanup } = makeFixture({ test_email_count: "three", status: "draft" });
    assert.equal(readTestEmailCount(dir), 0);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// incrementTestEmailCount
// ---------------------------------------------------------------------------

describe("incrementTestEmailCount (#2376)", () => {
  it("incrementa de 0 para 1 (campo ausente inicialmente)", () => {
    const { dir, cleanup } = makeFixture({
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      status: "draft",
      title: "Teste",
    });
    const next = incrementTestEmailCount(dir);
    assert.equal(next, 1);
    assert.equal(readTestEmailCount(dir), 1);
    cleanup();
  });

  it("incrementa sequencialmente: 1 → 2 → 3 → 4", () => {
    const { dir, cleanup } = makeFixture({
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      status: "draft",
      title: "Teste",
    });
    assert.equal(incrementTestEmailCount(dir), 1);
    assert.equal(incrementTestEmailCount(dir), 2);
    assert.equal(incrementTestEmailCount(dir), 3);
    assert.equal(incrementTestEmailCount(dir), 4);
    assert.equal(readTestEmailCount(dir), 4);
    cleanup();
  });

  it("preserva outros campos ao incrementar", () => {
    const initial = {
      draft_url: "https://app.beehiiv.com/posts/xyz/edit",
      status: "draft",
      title: "Meu Título",
      test_email_sent_to: "vjpixel@gmail.com",
      unfixed_issues: [],
    };
    const { dir, publishedPath, cleanup } = makeFixture(initial);
    incrementTestEmailCount(dir);
    const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
    assert.equal(data["draft_url"], initial.draft_url);
    assert.equal(data["title"], initial.title);
    assert.equal(data["test_email_sent_to"], initial.test_email_sent_to);
    assert.equal(data["test_email_count"], 1);
    cleanup();
  });

  it("retorna 0 e não cria arquivo quando 05-published.json não existe", () => {
    const { dir, cleanup } = makeFixture(); // sem initialPublished → não cria arquivo
    const result = incrementTestEmailCount(dir);
    assert.equal(result, 0);
    // O arquivo não deve ter sido criado
    const exists = existsSync(resolve(dir, "_internal", "05-published.json"));
    assert.equal(exists, false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// markDraftVerified
// ---------------------------------------------------------------------------

describe("markDraftVerified (#2376)", () => {
  it("seta draft_verified=true preservando outros campos", () => {
    const initial = {
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      status: "draft",
      title: "Título",
      test_email_count: 4,
    };
    const { dir, publishedPath, cleanup } = makeFixture(initial);
    markDraftVerified(dir);
    const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
    assert.equal(data["draft_verified"], true);
    assert.equal(data["draft_url"], initial.draft_url);
    assert.equal(data["test_email_count"], initial.test_email_count);
    assert.equal(data["title"], initial.title);
    cleanup();
  });

  it("no-op quando 05-published.json não existe (defensivo)", () => {
    const { dir, cleanup } = makeFixture();
    // Não deve lançar erro
    assert.doesNotThrow(() => markDraftVerified(dir));
    cleanup();
  });

  it("idempotente: chamar 2× não quebra nada", () => {
    const { dir, publishedPath, cleanup } = makeFixture({
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      status: "draft",
      title: "Título",
    });
    markDraftVerified(dir);
    markDraftVerified(dir);
    const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
    assert.equal(data["draft_verified"], true);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// decideTestSendAction (pure)
// ---------------------------------------------------------------------------

describe("decideTestSendAction (#2376)", () => {
  it("ok quando count < ALERT_THRESHOLD (0, 1, 2)", () => {
    for (let i = 0; i < TEST_SEND_ALERT_THRESHOLD; i++) {
      const d = decideTestSendAction(i);
      assert.equal(d.action, "ok", `count=${i} deveria ser ok`);
      assert.equal(d.count, i);
    }
  });

  it("alert quando count === ALERT_THRESHOLD (3)", () => {
    const d = decideTestSendAction(TEST_SEND_ALERT_THRESHOLD);
    assert.equal(d.action, "alert");
    assert.equal(d.count, TEST_SEND_ALERT_THRESHOLD);
    assert.ok("message" in d);
    if (d.action === "alert") {
      assert.match(d.message, /limit/i);
    }
  });

  it("use_draft_fallback quando count > ALERT_THRESHOLD (4, 5, 10)", () => {
    for (const count of [4, 5, 10]) {
      const d = decideTestSendAction(count);
      assert.equal(d.action, "use_draft_fallback", `count=${count} deveria ser use_draft_fallback`);
      assert.equal(d.count, count);
      if (d.action === "use_draft_fallback") {
        assert.match(d.message, /draft link/i);
      }
    }
  });

  it("TEST_SEND_ALERT_THRESHOLD é 3 (incidente 260619: limite atingido com 4 iterações)", () => {
    // Garantia explícita do valor do threshold — regressão se mudar
    assert.equal(TEST_SEND_ALERT_THRESHOLD, 3);
  });
});
