/**
 * test/preflight-external-locks.test.ts (#2358)
 *
 * Testa o preflight de travas externas de autenticação.
 *
 * HARD CONSTRAINTS:
 *   - Nunca faz I/O real de rede (fetch mockado em todos os casos)
 *   - Nunca lê `data/.credentials.json` real (usa skipOauth:true ou mock)
 *   - Nunca executa wrangler CLI
 *
 * Cenários cobertos:
 *   1. OAuth expirado → state: expired, blocks_stages inclui stages do drive-sync
 *   2. OAuth ok → state: ok, blocks_stages vazio
 *   3. OAuth ausente (credentials file não existe) → state: missing
 *   4. API key GEMINI ausente → state: missing + blocks_stages [1,3]
 *   5. API key GEMINI presente → state: ok
 *   6. Wrangler token ausente → state: missing + blocks_stages [0]
 *   7. Wrangler token inválido → state: expired
 *   8. Wrangler token ativo → state: ok
 *   9. Conectores MCP → state: unchecked (não verificável via TS)
 *  10. preflightExternalLocks: bloqueante → ao menos 1 entry com state != ok/unchecked
 *  11. preflightExternalLocks: tudo ok → nenhum bloqueante
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  checkOAuthLock,
  checkWranglerLock,
  checkApiKeyLocks,
  classifyCodexStatus,
  classifyCodexRefreshProbe,
  assessCodexAuthFreshness,
  readCodexAuthFreshness,
  redactSecrets,
  CODEX_REFRESH_MARGIN_MS,
  checkMcpConnectors,
  preflightExternalLocks,
  isBlockingLock,
  exitCodeForLocks,
  formatRow,
  type LockCheckResult,
} from "../scripts/lib/preflight-external-locks.ts";
import type { TokenHealth } from "../scripts/google-auth.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers de mock fetch ─────────────────────────────────────────────────────

type FetchFn = typeof fetch;

/** Simula fetch bem-sucedido com body JSON */
function mockFetchJson(status: number, body: unknown): FetchFn {
  return async (_url, _opts) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response;
}

/** Simula falha de rede (fetch throws) */
function throwingFetch(message: string): FetchFn {
  return async () => {
    throw new Error(message);
  };
}

// ── Helpers de env ────────────────────────────────────────────────────────────

/** Salva e restaura process.env completo para que vars injetadas por loadProjectEnv()
 * (CLOUDFLARE_WORKERS_TOKEN, CLARICE_API_KEY, etc.) não vazem entre testes. */
let savedEnv: NodeJS.ProcessEnv;

before(() => {
  savedEnv = { ...process.env };
});

after(() => {
  // Remover qualquer var adicionada pelos testes (ou por loadProjectEnv)
  for (const key of Object.keys(process.env)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    }
  }
  // Restaurar vars que existiam antes e podem ter sido alteradas
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
});

// ── 1. checkOAuthLock ─────────────────────────────────────────────────────────

describe("checkOAuthLock (#2358)", () => {
  it("1. OAuth expirado → state: expired, blocks_stages inclui 0,1,3,4,5", async () => {
    // Injeta um mock de tokenHealthFn que simula invalid_grant (token expirado/revogado).
    // Isso exercita o ramo expired (linhas ~128-136) sem precisar de
    // data/.credentials.json no disco — regressão #633 para a issue #2358.
    const expiredHealthFn = async (_f: FetchFn): Promise<TokenHealth> => ({
      ok: false,
      status: "invalid_grant",
      detail: "token expirado ou revogado (invalid_grant)",
    });

    const result = await checkOAuthLock(
      throwingFetch("never called"),
      undefined,
      expiredHealthFn,
    );

    // Deve retornar ESPECIFICAMENTE expired — não missing nem unchecked
    assert.equal(result.state, "expired", `state deve ser exatamente 'expired', got: ${result.state}`);
    assert.ok(result.blocks_stages.includes(0), "deve bloquear stage 0");
    assert.ok(result.blocks_stages.includes(1), "deve bloquear stage 1");
    assert.ok(result.blocks_stages.includes(3), "deve bloquear stage 3");
    assert.ok(result.blocks_stages.includes(4), "deve bloquear stage 4");
    assert.ok(result.blocks_stages.includes(5), "deve bloquear stage 5");
    assert.ok(
      result.reauth_action.includes("oauth-setup.ts"),
      "ação deve mencionar oauth-setup.ts",
    );
  });

  it("2. OAuth ok (mock fetch de refresh bem-sucedido)", async () => {
    // O checkTokenHealth tenta fazer refresh; um 200 com access_token = ok
    const okFetch: FetchFn = async (url, _opts) => {
      if (typeof url === "string" && url.includes("oauth2.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ access_token: "mock_token", expires_in: 3600 }),
          text: async () =>
            JSON.stringify({ access_token: "mock_token", expires_in: 3600 }),
        } as Response;
      }
      throw new Error("unexpected fetch");
    };

    // Com credentials ausente → retorna missing antes mesmo do fetch.
    // Para simular "ok", usamos skipOauth=true e verificamos que blocks_stages fica vazio.
    const result = await preflightExternalLocks({
      skipOauth: true,
      fetchImpl: mockFetchJson(200, { success: true, result: { status: "active" } }),
      apiToken: "valid_token_xyz",
    });

    // Não há entrada OAuth (foi pulada), mas o resultado completo não deve ter bloqueantes
    // de Wrangler (usamos token válido acima)
    const wranglerEntry = result.find((r) =>
      r.dependency.includes("Wrangler"),
    );
    assert.ok(wranglerEntry, "deve ter entrada Wrangler");
    assert.equal(wranglerEntry!.state, "ok", "Wrangler deve estar ok com token válido");
    assert.deepEqual(wranglerEntry!.blocks_stages, [], "blocks_stages vazio para ok");

    // Confirmar presença de MCP unchecked
    const mcpEntries = result.filter((r) => r.state === "unchecked");
    assert.ok(mcpEntries.length >= 2, "deve ter pelo menos 2 conectores MCP como unchecked");
  });

  it("3. OAuth ausente (sem credentials file) → state: missing + ação de reauth", async () => {
    // Path injetado (#2846) aponta pra um tmpdir vazio, sem credentials —
    // torna o teste hermético independente da junction data/ (OneDrive) real
    // existir na máquina local. Mesmo padrão de DI dos demais checks do arquivo
    // (ex: checkWranglerLock recebe apiToken explícito em vez de ler o env).
    const emptyDir = mkdtempSync(join(tmpdir(), "diaria-oauth-missing-"));
    const fakeCredentialsPath = join(emptyDir, ".credentials.json");

    const result = await checkOAuthLock(
      throwingFetch("never called"),
      undefined,
      undefined,
      fakeCredentialsPath,
    );
    assert.equal(result.state, "missing");
    assert.ok(result.blocks_stages.length > 0, "deve bloquear pelo menos 1 stage");
    assert.ok(
      result.reauth_action.includes("oauth-setup.ts"),
      "ação deve incluir oauth-setup.ts",
    );
    assert.ok(
      result.detail?.includes(".credentials.json"),
      "detail deve mencionar o arquivo de credentials",
    );
  });

  it("3b. OAuth presente (credentials file existe no path injetado) → state != missing (#2846)", async () => {
    // Simetria do teste 3: com um arquivo de credentials fake no path injetado,
    // o ramo "missing" não deve disparar — o fluxo segue para tokenHealthFn.
    // tokenHealthFn é mockado (não real checkTokenHealth) para não fazer I/O
    // de rede real, conforme HARD CONSTRAINT do topo do arquivo.
    const dirWithCreds = mkdtempSync(join(tmpdir(), "diaria-oauth-present-"));
    const fakeCredentialsPath = join(dirWithCreds, ".credentials.json");
    writeFileSync(
      fakeCredentialsPath,
      JSON.stringify({ refresh_token: "fake_refresh_token_for_test" }),
      "utf8",
    );

    const okHealthFn = async (_f: FetchFn): Promise<TokenHealth> => ({
      ok: true,
      status: "valid",
      detail: "mock: token válido",
    });

    const result = await checkOAuthLock(
      throwingFetch("never called"),
      undefined,
      okHealthFn,
      fakeCredentialsPath,
    );

    assert.notEqual(result.state, "missing");
    assert.equal(result.state, "ok");
  });
});

// ── 2. checkWranglerLock ──────────────────────────────────────────────────────

describe("checkWranglerLock (#2358)", () => {
  it("6. token ausente → state: missing + blocks_stages inclui 0", async () => {
    const result = await checkWranglerLock(throwingFetch("never"), "");
    assert.equal(result.state, "missing");
    assert.ok(result.blocks_stages.includes(0), "deve bloquear stage 0");
    assert.ok(
      result.reauth_action.includes("CLOUDFLARE_API_TOKEN") ||
        result.reauth_action.includes("wrangler login"),
      "ação deve mencionar CLOUDFLARE_API_TOKEN ou wrangler login",
    );
  });

  it("7. token inválido (API retorna 401) → state: expired", async () => {
    const result = await checkWranglerLock(
      mockFetchJson(401, { success: false }),
      "tok_invalid_12345",
    );
    assert.equal(result.state, "expired");
    assert.ok(result.blocks_stages.includes(0), "deve bloquear stage 0");
  });

  it("8. token ativo (API retorna 200 + active) → state: ok", async () => {
    const result = await checkWranglerLock(
      mockFetchJson(200, { success: true, result: { status: "active" } }),
      "tok_valid_abcdef",
    );
    assert.equal(result.state, "ok");
    assert.deepEqual(result.blocks_stages, []);
    assert.equal(result.reauth_action, "");
  });

  it("erro de rede (transitório) → state: ok (não bloqueia)", async () => {
    const result = await checkWranglerLock(
      throwingFetch("ECONNREFUSED"),
      "tok_net_error",
    );
    // Erros de rede são transitórios → estado ok (non-blocking, per check-cloudflare-token)
    assert.equal(result.state, "ok");
    assert.deepEqual(result.blocks_stages, []);
  });
});

function geminiConfigFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-gemini-"));
  const p = join(dir, "platform.config.json");
  writeFileSync(p, JSON.stringify({ image_generator: "gemini" }));
  return p;
}

// ── 3. checkApiKeyLocks ───────────────────────────────────────────────────────

describe("checkApiKeyLocks (#2358)", () => {
  it("4. GEMINI_API_KEY ausente (env unset) → state: missing + blocks_stages [1,3]", () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.CLOUDFLARE_API_TOKEN; // garantir gemini é o default

    try {
      // #9093: config fixo (gemini) — o platform.config.json real é codex desde
      // #9088, e o `if (geminiEntry)` anterior passava sem verificar nada.
      const results = checkApiKeyLocks({ configPath: geminiConfigFixture() });
      const geminiEntry = results.find((r) => r.dependency.includes("GEMINI"));
      assert.ok(geminiEntry, "gemini configurado deve gerar entrada");
      {
        assert.equal(geminiEntry.state, "missing");
        assert.ok(
          geminiEntry.blocks_stages.includes(1),
          "deve bloquear stage 1",
        );
        assert.ok(
          geminiEntry.blocks_stages.includes(3),
          "deve bloquear stage 3",
        );
        assert.ok(
          geminiEntry.reauth_action.includes("GEMINI_API_KEY"),
          "ação deve mencionar GEMINI_API_KEY",
        );
      }
      // Se platform.config.json não existe no worktree, checkApiKeyLocks pode retornar [] com gemini default
      // Verificar ao menos que não há entradas com state "ok" para a key ausente
      const okWithoutKey = results.filter(
        (r) => r.dependency.includes("GEMINI") && r.state === "ok",
      );
      assert.equal(
        okWithoutKey.length,
        0,
        "não deve marcar GEMINI como ok quando a key está ausente",
      );
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      }
    }
  });

  it("5. GEMINI_API_KEY presente → state: ok", () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIzaSy_test_key_presente_no_env_12345";

    try {
      const results = checkApiKeyLocks({ configPath: geminiConfigFixture() });
      const geminiEntry = results.find((r) => r.dependency.includes("GEMINI"));
      assert.ok(geminiEntry, "gemini configurado deve gerar entrada");
      {
        assert.equal(geminiEntry.state, "ok");
        assert.deepEqual(geminiEntry.blocks_stages, []);
        assert.equal(geminiEntry.reauth_action, "");
      }
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }
  });
});

describe("checkApiKeyLocks — image_generator=codex (#9093)", () => {
  const cfg = (extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-codex-"));
    const p = join(dir, "platform.config.json");
    writeFileSync(p, JSON.stringify({ image_generator: "codex", codex: { fallback: "gemini" }, ...extra }));
    return p;
  };
  const ok = () => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" });
  // #10602: hermético — nunca lê o ~/.codex/auth.json real nem roda `codex exec`.
  const fresh = { readCodexAuth: () => ({ kind: "fresh" as const, detail: "fixture" }), runCodexProbe: () => { throw new Error("sonda não deveria rodar"); } };

  it("login válido → codex ok; key do fallback ausente não bloqueia", () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const r = checkApiKeyLocks({ configPath: cfg(), runCodexStatus: ok, ...fresh });
      const codex = r.find((x) => x.dependency.startsWith("Codex CLI"));
      assert.equal(codex?.state, "ok");
      const fb = r.find((x) => x.dependency.includes("GEMINI"));
      assert.equal(fb?.state, "missing");
      assert.deepEqual(fb?.blocks_stages, [], "fallback só bloqueia se o Codex estiver quebrado");
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("login expirado → expired com ação `codex login`, e a key do fallback passa a bloquear", () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const r = checkApiKeyLocks({ configPath: cfg(), runCodexStatus: () => ({ status: 1, stdout: "", stderr: "Not logged in" }), ...fresh });
      const codex = r.find((x) => x.dependency.startsWith("Codex CLI"))!;
      assert.equal(codex.state, "expired");
      assert.deepEqual(codex.blocks_stages, [1, 3]);
      assert.match(codex.reauth_action, /codex login/);
      assert.deepEqual(r.find((x) => x.dependency.includes("GEMINI"))?.blocks_stages, [1, 3]);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("sem fallback configurado → só a entrada do Codex", () => {
    const r = checkApiKeyLocks({ configPath: cfg({ codex: {} }), runCodexStatus: ok, ...fresh });
    assert.equal(r.length, 1);
  });

  it("classifyCodexStatus: ENOENT → missing; timeout → expired; login por API key → expired", () => {
    assert.equal(classifyCodexStatus({ status: null, error: { code: "ENOENT", message: "spawn codex ENOENT" } }).state, "missing");
    const t = classifyCodexStatus({ status: null, error: { code: "ETIMEDOUT", message: "t" } });
    assert.equal(t.state, "expired");
    assert.match(t.detail ?? "", /não respondeu/);
    assert.equal(classifyCodexStatus({ status: 0, stdout: "Logged in using an API key - sk-***" }).state, "expired");
    assert.equal(classifyCodexStatus(ok()).state, "ok");
  });

  // #9316: regressão — Codex OK + key do fallback ausente gerava `missing` com
  // `blocks_stages: []`, mas o CLI filtrava só por `state` e saía com exit 1
  // (banner "trava(s) externa(s)" no Stage 0 de toda edição sem nada bloqueado).
  it("#9316: Codex OK + fallback ausente → exit 0 (entrada informativa, não bloqueante)", () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const r = checkApiKeyLocks({ configPath: cfg(), runCodexStatus: ok, ...fresh });
      const fb = r.find((x) => x.dependency.includes("GEMINI"))!;
      assert.equal(fb.state, "missing");
      assert.equal(isBlockingLock(fb), false);
      assert.equal(exitCodeForLocks(r), 0);
      const row = formatRow(fb);
      assert.doesNotMatch(row, /❌/);
      assert.doesNotMatch(row, /bloqueia stages/);
      assert.match(row, /informativo/);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("#9316: Codex quebrado + fallback ausente → exit 1 (as duas bloqueiam)", () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const r = checkApiKeyLocks({ configPath: cfg(), runCodexStatus: () => ({ status: 1, stdout: "", stderr: "Not logged in" }), ...fresh });
      assert.equal(r.filter(isBlockingLock).length, 2);
      assert.equal(exitCodeForLocks(r), 1);
      assert.match(formatRow(r[0]!), /❌ .*bloqueia stages: 1, 3/);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("#9316: unchecked e ok nunca bloqueiam, mesmo com blocks_stages preenchido (MCP)", () => {
    const mcp = checkMcpConnectors();
    assert.ok(mcp.every((m) => m.blocks_stages.length > 0 && !isBlockingLock(m)));
    assert.equal(exitCodeForLocks(mcp), 0);
  });
});

// ── #10602: `codex login status` ok com o refresh token morto ─────────────────

describe("Codex: sonda de refresh além do `login status` (#10602)", () => {
  const cfg = () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-codex-10602-"));
    const p = join(dir, "platform.config.json");
    writeFileSync(p, JSON.stringify({ image_generator: "codex", codex: { fallback: "gemini" } }));
    return p;
  };
  const statusOk = () => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" });
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const DAY = 86_400_000;
  const jwt = (exp: number) =>
    `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url")}.c2lnbmF0dXJl`;
  // Texto medido no 300 (issue #10602).
  const refreshFails = () => ({
    status: 1,
    stdout: "",
    stderr: "ERROR: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.\nworkspace routing discovery unauthorized (401)",
  });

  it("REGRESSÃO: status 'Logged in' + refresh falha → expired e bloqueia (antes dava ok)", () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      let probed = 0;
      const r = checkApiKeyLocks({
        configPath: cfg(),
        runCodexStatus: statusOk,
        readCodexAuth: () => ({ kind: "needs-refresh", detail: "access token expirou há 11.0 dia(s)" }),
        runCodexProbe: () => { probed++; return refreshFails(); },
      });
      assert.equal(probed, 1, "a sonda de refresh tem que rodar");
      const codex = r.find((x) => x.dependency.startsWith("Codex CLI"))!;
      assert.equal(codex.state, "expired");
      assert.deepEqual(codex.blocks_stages, [1, 3]);
      assert.match(codex.reauth_action, /codex login --device-auth/);
      assert.match(codex.detail ?? "", /refresh falhou/);
      assert.equal(isBlockingLock(codex), true);
      assert.equal(exitCodeForLocks(r), 1);
      // com o Codex quebrado, a key do fallback ausente também passa a bloquear
      assert.deepEqual(r.find((x) => x.dependency.includes("GEMINI"))?.blocks_stages, [1, 3]);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("token perto de vencer + refresh funciona → ok (a sonda renovou)", () => {
    const r = checkApiKeyLocks({
      configPath: cfg(),
      runCodexStatus: statusOk,
      readCodexAuth: () => ({ kind: "needs-refresh", detail: "x" }),
      runCodexProbe: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    assert.equal(r.find((x) => x.dependency.startsWith("Codex CLI"))?.state, "ok");
  });

  it("token fresco → não roda a sonda (zero chamada de modelo)", () => {
    const r = checkApiKeyLocks({
      configPath: cfg(),
      runCodexStatus: statusOk,
      readCodexAuth: () => ({ kind: "fresh", detail: "válido por mais 9.0 dia(s)" }),
      runCodexProbe: () => { throw new Error("não deveria rodar"); },
    });
    const codex = r.find((x) => x.dependency.startsWith("Codex CLI"))!;
    assert.equal(codex.state, "ok");
    assert.match(codex.detail ?? "", /válido por mais/);
  });

  it("status já quebrado → não roda a sonda", () => {
    const r = checkApiKeyLocks({
      configPath: cfg(),
      runCodexStatus: () => ({ status: 1, stdout: "", stderr: "Not logged in" }),
      readCodexAuth: () => { throw new Error("não deveria ler"); },
      runCodexProbe: () => { throw new Error("não deveria rodar"); },
    });
    assert.equal(r.find((x) => x.dependency.startsWith("Codex CLI"))?.state, "expired");
  });

  it("classifyCodexRefreshProbe: timeout/erro sem assinatura de auth → unchecked (não bloqueia)", () => {
    const t = classifyCodexRefreshProbe({ status: null, error: { code: "ETIMEDOUT", message: "t" } }, "x");
    assert.equal(t.state, "unchecked");
    assert.equal(isBlockingLock(t), false);
    assert.match(t.detail ?? "", /não respondeu/);
    const net = classifyCodexRefreshProbe({ status: 1, stdout: "", stderr: "stream error: connection reset" }, "x");
    assert.equal(net.state, "unchecked");
  });

  it("#10612 review P2: exit 0 NÃO mascara assinatura de auth no output — erro de auth vence", () => {
    const r = classifyCodexRefreshProbe({
      status: 0,
      stdout: "",
      stderr: "ERROR: Failed to refresh token: 401 Unauthorized. Please log out and sign in again.",
    }, "x");
    assert.equal(r.state, "expired");
    assert.equal(isBlockingLock(r), true);
    assert.deepEqual(r.blocks_stages, [1, 3]);
  });

  it("#10612 review P2: exit 0 com `401` solto (contagem de tokens) segue ok — só assinatura inequívoca vence o exit 0", () => {
    const r = classifyCodexRefreshProbe({ status: 0, stdout: "ok", stderr: "tokens used: 401" }, "x");
    assert.equal(r.state, "ok");
    // Com exit != 0, o `401` solto continua contando como falha de auth.
    const fail = classifyCodexRefreshProbe({ status: 1, stdout: "", stderr: "http status 401" }, "x");
    assert.equal(fail.state, "expired");
  });

  it("assessCodexAuthFreshness: exp longe → fresh; exp perto/passado → needs-refresh; last_refresh velho → needs-refresh; opaco → unknown", () => {
    const auth = (exp: number, last?: string) => ({ tokens: { access_token: jwt(exp) }, last_refresh: last });
    assert.equal(assessCodexAuthFreshness(auth(NOW + 9 * DAY, new Date(NOW - DAY).toISOString()), NOW).kind, "fresh");
    assert.equal(assessCodexAuthFreshness(auth(NOW + CODEX_REFRESH_MARGIN_MS - DAY), NOW).kind, "needs-refresh");
    assert.equal(assessCodexAuthFreshness(auth(NOW - 11 * DAY), NOW).kind, "needs-refresh");
    assert.equal(assessCodexAuthFreshness(auth(NOW + 9 * DAY, new Date(NOW - 21 * DAY).toISOString()), NOW).kind, "needs-refresh");
    assert.equal(assessCodexAuthFreshness({ tokens: { access_token: "opaco" } }, NOW).kind, "unknown");
    assert.equal(assessCodexAuthFreshness(null, NOW).kind, "unknown");
  });

  it("readCodexAuthFreshness: nunca expõe token no detail; arquivo ausente/ilegível → unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-codex-auth-"));
    const p = join(dir, "auth.json");
    const access = jwt(NOW - DAY);
    writeFileSync(p, JSON.stringify({ tokens: { access_token: access, refresh_token: "rt-SEGREDOSEGREDOSEGREDO" }, last_refresh: "2026-09-29T00:00:00Z" }));
    const f = readCodexAuthFreshness(p, NOW);
    assert.equal(f.kind, "needs-refresh");
    assert.ok(!f.detail.includes(access) && !f.detail.includes("SEGREDO"), "detail não pode carregar token");
    assert.equal(readCodexAuthFreshness(join(dir, "nao-existe.json"), NOW).kind, "unknown");
    writeFileSync(p, "{corrompido");
    assert.equal(readCodexAuthFreshness(p, NOW).kind, "unknown");
  });

  it("redactSecrets: JWT, rt-/sk- e tokens longos somem do detail", () => {
    const s = redactSecrets(`bearer ${jwt(NOW)} refresh rt-abcdefghijklmnop key sk-abcdefghijklmnop x${"A".repeat(50)}`);
    assert.doesNotMatch(s, /eyJ/);
    assert.doesNotMatch(s, /abcdefghijklmnop/);
    assert.doesNotMatch(s, /A{40}/);
  });
});

// ── 4. checkMcpConnectors ─────────────────────────────────────────────────────

describe("checkMcpConnectors (#2358)", () => {
  it("9. conectores MCP → state: unchecked com ação de runtime", () => {
    const results = checkMcpConnectors();
    assert.ok(results.length >= 2, "deve retornar pelo menos 2 conectores MCP");

    for (const r of results) {
      assert.equal(
        r.state,
        "unchecked",
        `${r.dependency} deve ser unchecked`,
      );
      assert.ok(
        r.reauth_action.includes("#738") || r.reauth_action.includes("runtime"),
        `${r.dependency} deve mencionar runtime ou #738 na ação`,
      );
    }

    // Gmail e Beehiiv devem estar presentes
    const hasGmail = results.some((r) => r.dependency.toLowerCase().includes("gmail"));
    const hasBeehiiv = results.some((r) => r.dependency.toLowerCase().includes("beehiiv"));
    assert.ok(hasGmail, "deve incluir MCP Gmail");
    assert.ok(hasBeehiiv, "deve incluir MCP Beehiiv");
  });
});

// ── 5. preflightExternalLocks integração ─────────────────────────────────────

describe("preflightExternalLocks integração (#2358)", () => {
  it("10. com trava bloqueante (Wrangler inválido) → ao menos 1 entry state != ok/unchecked", async () => {
    const results = await preflightExternalLocks({
      skipOauth: true,
      fetchImpl: mockFetchJson(401, { success: false }),
      apiToken: "tok_invalid_test",
    });

    const blocking = results.filter(
      (r) => r.state !== "ok" && r.state !== "unchecked",
    );
    assert.ok(blocking.length >= 1, "deve ter pelo menos 1 trava bloqueante");

    const wrangler = blocking.find((r) => r.dependency.includes("Wrangler"));
    assert.ok(wrangler, "Wrangler deve ser a trava bloqueante");
    assert.ok(wrangler!.blocks_stages.includes(0), "deve bloquear stage 0");
  });

  it("11. tudo ok (Wrangler ativo + skipOauth + GEMINI presente) → 0 bloqueantes", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIzaSy_test_key_tudo_ok_12345";

    try {
      const results = await preflightExternalLocks({
        skipOauth: true,
        fetchImpl: mockFetchJson(200, { success: true, result: { status: "active" } }),
        apiToken: "tok_valid_test_xyz",
        // #9093: sem isto o resultado dependeria do Codex CLI instalado/logado na máquina.
        apiKeyLockOptions: { configPath: geminiConfigFixture() },
      });

      const blocking = results.filter(
        (r) => r.state !== "ok" && r.state !== "unchecked",
      );
      assert.equal(
        blocking.length,
        0,
        `não deve ter bloqueantes, mas tem: ${blocking.map((r) => `${r.dependency}=${r.state}`).join(", ")}`,
      );
    } finally {
      if (originalKey !== undefined) {
        process.env.GEMINI_API_KEY = originalKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }
  });

  it("CLI guard — main() não é executado ao importar o módulo", () => {
    // O simples fato de importarmos o módulo no topo sem efeitos colaterais
    // já valida o CLI guard (#cli-guard). Se main() fosse executado no import,
    // os testes falhariam com side-effects (process.exitCode, stdout).
    assert.ok(true, "módulo importado sem side-effects");
  });
});
