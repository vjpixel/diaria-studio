/**
 * retrospectiva-worker-secret-sync.test.ts (#8046)
 *
 * Testa o sync do secret `KIT_API_KEY` do Worker `workers/retrospectiva`.
 *
 * HARD CONSTRAINT: NUNCA chama a API Cloudflare real nem o CLI `wrangler`.
 * Toda comunicação é mockada via o parâmetro `fetchFn` (mesmo padrão de
 * `test/check-cloudflare-token.test.ts`).
 *
 * Regressão do bug em si (#8046): o secret deployado ficando desatualizado
 * em relação ao `.env`/Doppler não tem teste possível SEM acesso à conta
 * Cloudflare real (o próprio incidente foi um estado externo divergindo do
 * repo) — o teste de regressão aqui cobre o MECANISMO que passa a existir
 * para corrigir isso (o script grava o valor do `.env` no Worker via PUT
 * idempotente), não o incidente histórico específico.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RETROSPECTIVA_WORKER_SCRIPT_NAME,
  RETROSPECTIVA_WORKER_SECRET_NAME,
  syncRetrospectivaWorkerSecret,
  verifyRetrospectivaWorkerSecret,
} from "../scripts/lib/retrospectiva-worker-secret-sync.ts";
import { maskSecretPreview } from "../scripts/sync-retrospectiva-worker-secret.ts";

type FetchFn = typeof fetch;

function mockFetch(
  status: number,
  body: unknown,
  opts?: { captureRequest?: (url: string, init?: RequestInit) => void },
): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    opts?.captureRequest?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as FetchFn;
}

function throwingFetch(message: string): FetchFn {
  return (async () => {
    throw new Error(message);
  }) as FetchFn;
}

describe("syncRetrospectivaWorkerSecret (#8046)", () => {
  it("A) secretValue ausente → missing_secret_value, nunca chama fetch", async () => {
    let called = false;
    const fetchFn = mockFetch(200, {}, { captureRequest: () => (called = true) });
    const result = await syncRetrospectivaWorkerSecret(
      { secretValue: "", accountId: "acc", token: "tok" },
      fetchFn,
    );
    assert.equal(result.status, "missing_secret_value");
    assert.equal(called, false);
  });

  it("B) credenciais ausentes → missing_credentials, nunca chama fetch", async () => {
    let called = false;
    const fetchFn = mockFetch(200, {}, { captureRequest: () => (called = true) });
    const result = await syncRetrospectivaWorkerSecret(
      { secretValue: "kit_abc123", accountId: "", token: "" },
      fetchFn,
    );
    assert.equal(result.status, "missing_credentials");
    assert.equal(called, false);
  });

  it("C) PUT 200 → synced, envia name/text/type corretos, nunca vaza o valor na mensagem", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchFn = mockFetch(200, { success: true }, {
      captureRequest: (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
      },
    });
    const result = await syncRetrospectivaWorkerSecret(
      { secretValue: "kit_super_secret_value", accountId: "my-account", token: "my-token" },
      fetchFn,
    );
    assert.equal(result.status, "synced");
    assert.match(capturedUrl, /\/accounts\/my-account\/workers\/scripts\/retrospectiva\/secrets$/);
    assert.deepEqual(capturedBody, {
      name: RETROSPECTIVA_WORKER_SECRET_NAME,
      text: "kit_super_secret_value",
      type: "secret_text",
    });
    assert.equal(result.message.includes("kit_super_secret_value"), false);
  });

  it("D) PUT retorna 401 → api_error, carrega corpo cru pra diagnóstico", async () => {
    const fetchFn = mockFetch(401, { errors: [{ message: "Authentication error" }] });
    const result = await syncRetrospectivaWorkerSecret(
      { secretValue: "kit_abc", accountId: "acc", token: "bad-token" },
      fetchFn,
    );
    assert.equal(result.status, "api_error");
    assert.match(result.apiError ?? "", /Authentication error/);
  });

  it("E) fetch lança (rede fora do ar) → api_error, nunca propaga a exceção", async () => {
    const fetchFn = throwingFetch("ECONNRESET");
    const result = await syncRetrospectivaWorkerSecret(
      { secretValue: "kit_abc", accountId: "acc", token: "tok" },
      fetchFn,
    );
    assert.equal(result.status, "api_error");
    assert.match(result.message, /ECONNRESET/);
  });

  it("F) usa scriptName/secretName customizados quando passados", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchFn = mockFetch(200, { success: true }, {
      captureRequest: (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
      },
    });
    await syncRetrospectivaWorkerSecret(
      { secretValue: "v", accountId: "acc", token: "tok", scriptName: "outro-worker", secretName: "OUTRO_SECRET" },
      fetchFn,
    );
    assert.match(capturedUrl, /\/workers\/scripts\/outro-worker\/secrets$/);
    assert.equal(capturedBody.name, "OUTRO_SECRET");
  });
});

describe("verifyRetrospectivaWorkerSecret (#8046)", () => {
  it("A) credenciais ausentes → missing_credentials", async () => {
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "", token: "" }, mockFetch(200, {}));
    assert.equal(result.status, "missing_credentials");
  });

  it("B) secret name presente na lista → present, expõe secretNames mas nunca valores", async () => {
    const fetchFn = mockFetch(200, { result: [{ name: "KIT_API_KEY" }, { name: "OTHER" }] });
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "acc", token: "tok" }, fetchFn);
    assert.equal(result.status, "present");
    assert.deepEqual(result.secretNames, ["KIT_API_KEY", "OTHER"]);
  });

  it("C) secret name ausente da lista → absent", async () => {
    const fetchFn = mockFetch(200, { result: [{ name: "OTHER" }] });
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "acc", token: "tok" }, fetchFn);
    assert.equal(result.status, "absent");
  });

  it("D) API retorna erro → api_error", async () => {
    const fetchFn = mockFetch(500, { errors: [{ message: "Internal error" }] });
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "acc", token: "tok" }, fetchFn);
    assert.equal(result.status, "api_error");
  });

  it("E) fetch lança → api_error, nunca propaga", async () => {
    const fetchFn = throwingFetch("timeout");
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "acc", token: "tok" }, fetchFn);
    assert.equal(result.status, "api_error");
    assert.match(result.message, /timeout/);
  });

  it("F) resposta com result malformado (não array) → trata como lista vazia, absent", async () => {
    const fetchFn = mockFetch(200, { result: null });
    const result = await verifyRetrospectivaWorkerSecret({ accountId: "acc", token: "tok" }, fetchFn);
    assert.equal(result.status, "absent");
    assert.deepEqual(result.secretNames, []);
  });
});

describe("maskSecretPreview (#8046)", () => {
  it("A) valor vazio → '(vazio)'", () => {
    assert.equal(maskSecretPreview(""), "(vazio)");
  });

  it("B) valor curto (<=8 chars) → mascarado totalmente, nunca ecoa o valor", () => {
    const masked = maskSecretPreview("short1");
    assert.equal(masked, "***");
  });

  it("C) valor longo → só os 8 primeiros chars + reticências, nunca o valor completo", () => {
    const masked = maskSecretPreview("kit_1234567890abcdef");
    assert.equal(masked, "kit_1234...");
    assert.equal(masked.includes("567890abcdef"), false);
  });
});

describe("constantes exportadas (#8046)", () => {
  it("nome do Worker/secret batem com o que workers/retrospectiva/README.md documenta", () => {
    assert.equal(RETROSPECTIVA_WORKER_SCRIPT_NAME, "retrospectiva");
    assert.equal(RETROSPECTIVA_WORKER_SECRET_NAME, "KIT_API_KEY");
  });
});
