/**
 * test/google-auth-oauth-signal.test.ts (#5980)
 *
 * `fetchWithRetry` (scripts/lib/fetch-retry.ts) gera um AbortSignal por
 * tentativa e o caller (ex: `pullGsc` em seo-pull.ts) o repassa como
 * `options.signal` para `gFetch`. Antes do #5980, esse signal só cobria o
 * fetch de dados em si — a fase de obtenção/refresh de token OAuth dentro
 * de `gFetch` (`getAccessToken`/`forceRefreshAccessToken`) não recebia o
 * signal, então um hang no endpoint OAuth do Google não era limitado pelo
 * timeout do caller (mesma classe de falha do #5943, num passo anterior).
 *
 * Este teste cobre:
 * 1. `getAccessToken(signal)` repassa o signal ao fetch de refresh.
 * 2. `getAccessToken()` sem signal continua funcionando (todos os outros
 *    callers existentes, que não passam signal, não regridem).
 * 3. `gFetch` extrai `options.signal` e o repassa tanto ao refresh inicial
 *    (via `getAccessToken`) quanto ao refresh forçado pós-401 (via
 *    `forceRefreshAccessToken`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAccessToken,
  gFetch,
  CREDENTIALS_PATH_TEST_OVERRIDE_ENV,
  type GoogleCredentials,
} from "../scripts/google-auth.ts";

let tmpDir: string;
let credsPath: string;
let originalFetch: typeof fetch;
let originalEnv: string | undefined;

function writeCreds(overrides: Partial<GoogleCredentials> = {}): void {
  const creds: GoogleCredentials = {
    client_id: "test-client-id",
    client_secret: "test-client-secret",
    access_token: "old-access-token",
    refresh_token: "test-refresh-token",
    expiry_ms: Date.now() + 3_600_000, // válido por padrão — não força refresh em getAccessToken()
    ...overrides,
  };
  writeFileSync(credsPath, JSON.stringify(creds, null, 2), "utf8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "google-auth-signal-test-"));
  credsPath = join(tmpDir, "credentials.json");
  originalEnv = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = credsPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getAccessToken(signal) — #5980", () => {
  it("repassa o signal recebido ao fetch de refresh do token OAuth", async () => {
    writeCreds({ expiry_ms: Date.now() - 1000 }); // expirado → força refresh
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    const token = await getAccessToken(controller.signal);

    assert.equal(token, "new-token");
    assert.equal(capturedSignal, controller.signal);
  });

  it("sem signal — comportamento idêntico ao pré-#5980 (todos os outros callers)", async () => {
    writeCreds({ expiry_ms: Date.now() - 1000 }); // expirado → força refresh
    let capturedSignal: AbortSignal | null | undefined = "unset" as unknown as undefined;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    const token = await getAccessToken();

    assert.equal(token, "new-token");
    assert.equal(capturedSignal, undefined);
  });

  it("token ainda válido — nenhum fetch de refresh é feito (signal ignorado, não usado)", async () => {
    writeCreds({ access_token: "still-valid-token" }); // expiry_ms no futuro (default)
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const token = await getAccessToken(new AbortController().signal);

    assert.equal(token, "still-valid-token");
    assert.equal(fetchCalled, false);
  });
});

describe("gFetch — options.signal cobre a fase de token OAuth (#5980)", () => {
  it("repassa options.signal ao refresh forçado pós-401", async () => {
    writeCreds(); // token válido — getAccessToken() não bate no endpoint OAuth
    const controller = new AbortController();
    const dataUrl = "https://example.googleapis.com/v1/data";
    const tokenCallSignals: (AbortSignal | null | undefined)[] = [];
    const dataCallCount = { n: 0 };

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === dataUrl) {
        dataCallCount.n += 1;
        if (dataCallCount.n === 1) {
          // 1ª tentativa: token "expirado" do lado do servidor → 401
          return new Response("unauthorized", { status: 401 });
        }
        // 2ª tentativa (pós-refresh): sucesso
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // qualquer outra URL é o endpoint de token OAuth
      tokenCallSignals.push(init?.signal);
      return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    const res = await gFetch(dataUrl, { signal: controller.signal });

    assert.equal(res.status, 200);
    assert.equal(dataCallCount.n, 2);
    // forceRefreshAccessToken() chamou o endpoint de token exatamente 1x, com o signal do caller.
    assert.equal(tokenCallSignals.length, 1);
    assert.equal(tokenCallSignals[0], controller.signal);
  });

  it("sem options.signal — comportamento idêntico ao pré-#5980 (callers existentes)", async () => {
    writeCreds();
    const dataUrl = "https://example.googleapis.com/v1/data";
    const tokenCallSignals: (AbortSignal | null | undefined)[] = [];
    const dataCallCount = { n: 0 };

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === dataUrl) {
        dataCallCount.n += 1;
        if (dataCallCount.n === 1) return new Response("unauthorized", { status: 401 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      tokenCallSignals.push(init?.signal);
      return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    const res = await gFetch(dataUrl); // sem options — path de todos os outros callers de google-auth.ts

    assert.equal(res.status, 200);
    assert.equal(tokenCallSignals.length, 1);
    assert.equal(tokenCallSignals[0], undefined);
  });
});
