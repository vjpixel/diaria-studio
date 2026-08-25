/**
 * test/kit-config.test.ts (#463)
 *
 * Mesma cobertura de `test/beehiiv-config.test.ts` pro par Kit — o único
 * desvio de contrato é `KitConfig` não ter `publicationId` (uma API key já
 * resolve pra uma conta única no Kit, confirmado ao vivo no #6047).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kitApiBase, resolveKitConfig } from "../scripts/lib/kit-config.ts";

describe("kitApiBase", () => {
  it("default é a API pública do Kit v4", () => {
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).KIT_API_URL;
    const orig = process.env.KIT_API_URL;
    delete process.env.KIT_API_URL;
    try {
      assert.equal(kitApiBase(), "https://api.kit.com/v4");
    } finally {
      if (orig !== undefined) process.env.KIT_API_URL = orig;
    }
  });

  it("KIT_API_URL (env) faz override", () => {
    const orig = process.env.KIT_API_URL;
    process.env.KIT_API_URL = "http://localhost:9999/mock-kit";
    try {
      assert.equal(kitApiBase(), "http://localhost:9999/mock-kit");
    } finally {
      if (orig === undefined) delete process.env.KIT_API_URL;
      else process.env.KIT_API_URL = orig;
    }
  });
});

describe("resolveKitConfig", () => {
  it("KIT_API_KEY presente → ok:true com a key", () => {
    const result = resolveKitConfig({ KIT_API_KEY: "kit_test123" });
    assert.deepEqual(result, { ok: true, config: { apiKey: "kit_test123" } });
  });

  it("KIT_API_KEY ausente → ok:false com motivo explícito, nunca lança", () => {
    const result = resolveKitConfig({});
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /KIT_API_KEY não definida/);
  });

  it("KIT_API_KEY vazia (string) é tratada como ausente", () => {
    const result = resolveKitConfig({ KIT_API_KEY: "" });
    assert.equal(result.ok, false);
  });

  it("não lê process.env quando env é injetado explicitamente", () => {
    const originalKey = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "kit_real_env_key";
    try {
      const result = resolveKitConfig({ KIT_API_KEY: "kit_injected_key" });
      assert.deepEqual(result, { ok: true, config: { apiKey: "kit_injected_key" } });
    } finally {
      if (originalKey === undefined) delete process.env.KIT_API_KEY;
      else process.env.KIT_API_KEY = originalKey;
    }
  });
});
