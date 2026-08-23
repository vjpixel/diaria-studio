/**
 * test/microsoft-ads-ingest-spend.test.ts (#5928)
 *
 * Cobre `authConfigFromEnv` de `scripts/microsoft-ads-ingest-spend.ts` —
 * lógica NOVA nesta PR (prioridade Google > Azure AD, diagnóstico de
 * variáveis ausentes) que `google-ads-ingest-spend.ts` não tem (lá é um
 * check flat "tudo obrigatório", por isso nunca precisou de teste próprio).
 * Salva/restaura as env vars relevantes em cada teste — nunca lê/escreve
 * `.env` real, nunca chama a API.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { authConfigFromEnv } from "../scripts/microsoft-ads-ingest-spend.ts";

const RELEVANT_VARS = [
  "MICROSOFT_ADS_DEVELOPER_TOKEN",
  "MICROSOFT_ADS_CUSTOMER_ID",
  "MICROSOFT_ADS_ACCOUNT_ID",
  "MICROSOFT_ADS_CLIENT_ID",
  "MICROSOFT_ADS_REFRESH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN",
] as const;

const ALWAYS_REQUIRED = {
  MICROSOFT_ADS_DEVELOPER_TOKEN: "dev-token",
  MICROSOFT_ADS_CUSTOMER_ID: "12345678",
  MICROSOFT_ADS_ACCOUNT_ID: "87654321",
};
const GOOGLE_COMPLETE = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN: "google-refresh-token",
};
const AZURE_COMPLETE = {
  MICROSOFT_ADS_CLIENT_ID: "azure-client-id",
  MICROSOFT_ADS_REFRESH_TOKEN: "azure-refresh-token",
};

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of RELEVANT_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of RELEVANT_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

describe("#5928 — authConfigFromEnv (CLI, prioridade Google > Azure AD)", () => {
  it("só Google completo → auth com googleRefreshToken, clientId/refreshToken (Azure) undefined", () => {
    setEnv({ ...ALWAYS_REQUIRED, ...GOOGLE_COMPLETE });
    const out = authConfigFromEnv();
    assert.ok("auth" in out, `esperava auth, veio: ${JSON.stringify(out)}`);
    if ("auth" in out) {
      assert.equal(out.auth.googleRefreshToken, "google-refresh-token");
      assert.equal(out.auth.clientId, undefined);
      assert.equal(out.auth.refreshToken, undefined);
    }
  });

  it("só Azure AD completo → auth com clientId/refreshToken, googleRefreshToken undefined", () => {
    setEnv({ ...ALWAYS_REQUIRED, ...AZURE_COMPLETE });
    const out = authConfigFromEnv();
    assert.ok("auth" in out, `esperava auth, veio: ${JSON.stringify(out)}`);
    if ("auth" in out) {
      assert.equal(out.auth.clientId, "azure-client-id");
      assert.equal(out.auth.refreshToken, "azure-refresh-token");
      assert.equal(out.auth.googleRefreshToken, undefined);
    }
  });

  it("os 2 caminhos completos → auth carrega os 2 (o dispatcher de refreshMicrosoftAdsAccessToken decide depois, prioriza Google)", () => {
    setEnv({ ...ALWAYS_REQUIRED, ...GOOGLE_COMPLETE, ...AZURE_COMPLETE });
    const out = authConfigFromEnv();
    assert.ok("auth" in out);
    if ("auth" in out) {
      assert.equal(out.auth.googleRefreshToken, "google-refresh-token");
      assert.equal(out.auth.clientId, "azure-client-id");
    }
  });

  it("nenhum dos 2 caminhos completo → missing tem as variáveis dos 2 (Google E Azure), não só Google", () => {
    setEnv(ALWAYS_REQUIRED); // sem nenhum dos 2 grupos de identidade
    const out = authConfigFromEnv();
    assert.ok("missing" in out, `esperava missing, veio: ${JSON.stringify(out)}`);
    if ("missing" in out) {
      assert.ok(out.missing.includes("GOOGLE_CLIENT_ID"));
      assert.ok(out.missing.includes("MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN"));
      assert.ok(out.missing.includes("MICROSOFT_ADS_CLIENT_ID"));
      assert.ok(out.missing.includes("MICROSOFT_ADS_REFRESH_TOKEN"));
    }
  });

  it("Azure parcial (só MICROSOFT_ADS_CLIENT_ID, falta REFRESH_TOKEN) + Google ausente → missing inclui as 2 variáveis de Azure que faltam, não só as de Google", () => {
    setEnv({ ...ALWAYS_REQUIRED, MICROSOFT_ADS_CLIENT_ID: "azure-client-id" });
    const out = authConfigFromEnv();
    assert.ok("missing" in out);
    if ("missing" in out) {
      assert.ok(out.missing.includes("MICROSOFT_ADS_REFRESH_TOKEN"), "esperava ver a var de Azure que falta, não só as de Google");
    }
  });

  it("variável SEMPRE exigida ausente (ex: CUSTOMER_ID) vence sobre qualquer caminho de identidade estar completo", () => {
    setEnv({
      MICROSOFT_ADS_DEVELOPER_TOKEN: "dev-token",
      MICROSOFT_ADS_ACCOUNT_ID: "87654321",
      // MICROSOFT_ADS_CUSTOMER_ID ausente de propósito
      ...GOOGLE_COMPLETE,
      ...AZURE_COMPLETE,
    });
    const out = authConfigFromEnv();
    assert.ok("missing" in out);
    if ("missing" in out) {
      assert.deepEqual(out.missing, ["MICROSOFT_ADS_CUSTOMER_ID"]);
    }
  });
});
