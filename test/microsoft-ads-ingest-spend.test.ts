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

import { authConfigFromEnv, MICROSOFT_ADS_CANAL } from "../scripts/microsoft-ads-ingest-spend.ts";
import { CHANNEL_KEY_SPECS, RESERVED_CHANNEL_NAMES } from "../scripts/lib/shared/channel-key-specs.ts";

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

describe("#7544 — MICROSOFT_ADS_CANAL trava contra drift de nome de canal", () => {
  it("MICROSOFT_ADS_CANAL bate com uma entrada real de CHANNEL_KEY_SPECS (não apenas RESERVED_CHANNEL_NAMES)", () => {
    // Defeito original (#7544): o script escrevia "Microsoft Advertising"
    // (só RESERVED_CHANNEL_NAMES, sem spec cadastrada) — a linha caía no
    // caminho "canal desconhecido" mesmo com gasto real. O canal ESCRITO
    // precisa ter spec ativa em CHANNEL_KEY_SPECS, senão a asserção abaixo
    // falha como erro de teste (não como aviso em stderr no runtime).
    const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
    assert.ok(
      specCanais.includes(MICROSOFT_ADS_CANAL),
      `MICROSOFT_ADS_CANAL="${MICROSOFT_ADS_CANAL}" não tem spec em CHANNEL_KEY_SPECS ` +
        `(canais com spec: ${JSON.stringify(specCanais)}) — a ingestão cairia no caminho ` +
        `"canal desconhecido" (unknownCanais) mesmo com gasto real. Se a spec "(teste 2608)" ` +
        `saiu (decisão #5862), atualizar MICROSOFT_ADS_CANAL junto.`,
    );
  });

  it("um canal fora de RESERVED_CHANNEL_NAMES/CHANNEL_KEY_SPECS falha esta asserção (prova que o guard pega o defeito original)", () => {
    const driftedCanal = "Microsoft Advertising"; // valor antigo, causa raiz do #7544
    const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
    const hasSpec = specCanais.includes(driftedCanal);
    const isReserved = (RESERVED_CHANNEL_NAMES as readonly string[]).includes(driftedCanal);
    // "Microsoft Advertising" é RESERVADO mas não tem spec — reservado sozinho
    // não basta pro relatório reconhecer o canal como medido.
    assert.equal(isReserved, true, "sanity check: RESERVED_CHANNEL_NAMES deveria seguir citando o nome canônico legado");
    assert.equal(hasSpec, false, "sanity check: o valor antigo não deveria ter spec própria — é essa lacuna que causa o defeito 2 da #7544");
  });
});
