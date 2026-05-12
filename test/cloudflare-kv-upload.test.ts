/**
 * cloudflare-kv-upload.test.ts (#1119)
 *
 * Cobre validações de input de `uploadImageToWorkerKV` (sem fazer network IO).
 * Garantias: credenciais faltantes → erro claro; namespace ID obrigatório.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uploadImageToWorkerKV } from "../scripts/lib/cloudflare-kv-upload.ts";

describe("uploadImageToWorkerKV — validação de input (#1119)", () => {
  it("falha quando kvNamespaceId está vazio", async () => {
    await assert.rejects(
      async () =>
        uploadImageToWorkerKV("/tmp/fake.jpg", "key", {
          kvNamespaceId: "",
          accountId: "abc",
          token: "tok",
        }),
      /kvNamespaceId obrigatório/,
    );
  });

  it("falha quando accountId+token faltam (e env vazio)", async () => {
    // Limpa env temporariamente
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () =>
          uploadImageToWorkerKV("/tmp/fake.jpg", "key", {
            kvNamespaceId: "ns",
          }),
        /CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN/,
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("usa cfg.accountId/token quando passado explicitamente (não exige env)", async () => {
    // Mesmo sem env, se cfg tem accountId+token, a validação inicial passa.
    // Depois falha no fs.readFileSync (arquivo /tmp/nonexistent.jpg) — esse é
    // o erro esperado, confirmando que passou da validação de credentials.
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () =>
          uploadImageToWorkerKV(
            "/tmp/diaria-test-cloudflare-nonexistent.jpg",
            "key",
            { kvNamespaceId: "ns", accountId: "abc", token: "tok" },
          ),
        (err: Error) => !/CLOUDFLARE_ACCOUNT_ID/.test(err.message),
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });
});
