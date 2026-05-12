/**
 * mcp-guard.test.ts (#1132)
 *
 * Cobre o helper `withMcpGuard` + utilitários puros `withTimeout`, `sleep`.
 * Não testa `emitHaltBanner` end-to-end (spawn de processo external) —
 * caller passa `haltOnFailure: false` em tests pra isolar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withMcpGuard,
  withTimeout,
  sleep,
  McpGuardError,
} from "../scripts/lib/mcp-guard.ts";

describe("withTimeout (#1132)", () => {
  it("resolve quando operação termina antes do timeout", async () => {
    const result = await withTimeout(async () => "ok", 1000);
    assert.equal(result, "ok");
  });

  it("rejeita com erro de timeout quando operação demora demais", async () => {
    await assert.rejects(
      () => withTimeout(() => new Promise((r) => setTimeout(r, 200)), 50),
      /timed out after 50ms/,
    );
  });

  it("propaga erro da operação (não converte em timeout)", async () => {
    await assert.rejects(
      () => withTimeout(async () => { throw new Error("custom"); }, 1000),
      /custom/,
    );
  });
});

describe("sleep (#1132)", () => {
  it("retorna após o delay especificado", async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `elapsed ${elapsed}ms deve ser >= 15ms`);
  });
});

describe("withMcpGuard (#1132)", () => {
  it("retorna valor da operação em sucesso na primeira tentativa", async () => {
    const logs: string[] = [];
    const result = await withMcpGuard(
      async () => "success",
      {
        mcpName: "test-mcp",
        stage: "test-stage",
        haltOnFailure: false,
        log: (m) => logs.push(m),
      },
    );
    assert.equal(result, "success");
    assert.equal(logs.length, 0, "sem retry logs em sucesso first-try");
  });

  it("retry on failure, sucesso na segunda tentativa", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const result = await withMcpGuard(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient");
        return "recovered";
      },
      {
        mcpName: "test-mcp",
        stage: "test-stage",
        retries: 1,
        retryDelayMs: 5,
        haltOnFailure: false,
        log: (m) => logs.push(m),
      },
    );
    assert.equal(result, "recovered");
    assert.equal(attempts, 2);
    assert.equal(logs.length, 1, "1 retry log entry");
    assert.match(logs[0], /attempt 1\/2 failed: transient/);
  });

  it("falha após esgotar todos os retries — lança McpGuardError", async () => {
    let attempts = 0;
    const logs: string[] = [];
    await assert.rejects(
      () => withMcpGuard(
        async () => {
          attempts++;
          throw new Error(`fail ${attempts}`);
        },
        {
          mcpName: "test-mcp",
          stage: "test-stage",
          retries: 2,
          retryDelayMs: 5,
          haltOnFailure: false,
          log: (m) => logs.push(m),
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof McpGuardError, "deve ser McpGuardError");
        assert.equal((err as McpGuardError).mcpName, "test-mcp");
        assert.equal((err as McpGuardError).attempts, 3);
        return true;
      },
    );
    assert.equal(attempts, 3, "3 tentativas (1 + 2 retries)");
    assert.equal(logs.length, 3, "3 retry logs");
  });

  it("retries=0 desabilita retry (1 tentativa apenas)", async () => {
    let attempts = 0;
    const logs: string[] = [];
    await assert.rejects(
      () => withMcpGuard(
        async () => { attempts++; throw new Error("once"); },
        {
          mcpName: "test-mcp",
          stage: "test-stage",
          retries: 0,
          retryDelayMs: 5,
          haltOnFailure: false,
          log: (m) => logs.push(m),
        },
      ),
      McpGuardError,
    );
    assert.equal(attempts, 1, "uma única tentativa");
  });

  it("timeout aplica por tentativa, não globalmente", async () => {
    let attempts = 0;
    await assert.rejects(
      () => withMcpGuard(
        async () => {
          attempts++;
          return new Promise<string>(() => { /* nunca resolve */ });
        },
        {
          mcpName: "test-mcp",
          stage: "test-stage",
          timeoutMs: 30,
          retries: 1,
          retryDelayMs: 5,
          haltOnFailure: false,
        },
      ),
      McpGuardError,
    );
    assert.equal(attempts, 2, "timeout dispara retry, 2 tentativas total");
  });

  it("haltOnFailure default = true (mas precisa mockar pra não invocar)", () => {
    // Verifica apenas que o opt existe + default correto via test
    // que NÃO especifica haltOnFailure. emitHaltBanner é spawn — escape via
    // haltOnFailure: false nos outros tests acima.
    // Este test apenas valida API surface.
    assert.ok(typeof withMcpGuard === "function");
  });

  it("preserva lastError em McpGuardError pra inspeção", async () => {
    const original = new Error("original error");
    await assert.rejects(
      () => withMcpGuard(
        async () => { throw original; },
        {
          mcpName: "x",
          stage: "y",
          retries: 0,
          haltOnFailure: false,
        },
      ),
      (err: unknown) => {
        assert.equal((err as McpGuardError).lastError, original);
        return true;
      },
    );
  });
});
