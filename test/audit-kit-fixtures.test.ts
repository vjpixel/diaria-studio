/**
 * test/audit-kit-fixtures.test.ts (#6336)
 *
 * `runAudit` recebe deps injetadas — sem rede real, sem tocar KIT_API_KEY do
 * ambiente. Cobre os 3 exit codes documentados no CLI:
 *   0 — limpo; 1 — fixture ativo encontrado; 2 — infra indisponível.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAudit, type AuditDeps } from "../scripts/audit-kit-fixtures.ts";
import { resolveKitConfig } from "../scripts/lib/kit-config.ts";

function silentLog(): AuditDeps["log"] {
  return () => {};
}

describe("runAudit (#6336)", () => {
  it("exit 0 quando nenhum assinante bate padrão de fixture", async () => {
    // Só roda de verdade se KIT_API_KEY estiver no ambiente do worktree — senão
    // cai no branch de config ausente. Injeta config resolution via deps
    // customizadas: fetchSubscribers nunca depende do resultado de
    // resolveKitConfig real, mas runAudit chama resolveKitConfig() internamente
    // antes de qualquer fetch — sem KIT_API_KEY no ambiente de teste isso
    // devolveria sempre code 2. Para isolar o teste do ambiente, seta a var
    // temporariamente.
    const prev = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test_key_6336";
    try {
      const deps: AuditDeps = {
        fetchSubscribers: async () => [
          { id: 1, email_address: "leitor.real@empresa.com.br", state: "active" },
        ],
        log: silentLog(),
      };
      const result = await runAudit(deps);
      assert.equal(result.code, 0);
    } finally {
      if (prev === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = prev;
    }
  });

  it("exit 1 quando ≥1 fixture está active", async () => {
    const prev = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test_key_6336";
    try {
      const deps: AuditDeps = {
        fetchSubscribers: async () => [
          { id: 1, email_address: "ana@example.com", state: "active" },
        ],
        log: silentLog(),
      };
      const result = await runAudit(deps);
      assert.equal(result.code, 1);
      if (result.code === 1) assert.match(result.report, /ana@example\.com/);
    } finally {
      if (prev === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = prev;
    }
  });

  it("fixture cancelado (não active) não bloqueia — exit 0", async () => {
    const prev = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test_key_6336";
    try {
      const deps: AuditDeps = {
        fetchSubscribers: async () => [
          { id: 1, email_address: "ana@example.com", state: "cancelled" },
        ],
        log: silentLog(),
      };
      const result = await runAudit(deps);
      assert.equal(result.code, 0);
    } finally {
      if (prev === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = prev;
    }
  });

  it("exit 2 quando KIT_API_KEY ausente — nunca chama fetchSubscribers", async () => {
    const prev = process.env.KIT_API_KEY;
    delete process.env.KIT_API_KEY;
    try {
      assert.equal(resolveKitConfig().ok, false, "precondição: sem KIT_API_KEY resolveKitConfig deve falhar");
      let called = false;
      const deps: AuditDeps = {
        fetchSubscribers: async () => {
          called = true;
          return [];
        },
        log: silentLog(),
      };
      const result = await runAudit(deps);
      assert.equal(result.code, 2);
      assert.equal(called, false, "não deveria chamar a API sem credencial resolvida");
    } finally {
      if (prev === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = prev;
    }
  });

  it("exit 2 quando a API falha (fetchSubscribers lança)", async () => {
    const prev = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test_key_6336";
    try {
      const deps: AuditDeps = {
        fetchSubscribers: async () => {
          throw new Error("network down");
        },
        log: silentLog(),
      };
      const result = await runAudit(deps);
      assert.equal(result.code, 2);
      if (result.code === 2) assert.match(result.reason, /network down/);
    } finally {
      if (prev === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = prev;
    }
  });
});
