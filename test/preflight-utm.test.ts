/**
 * test/preflight-utm.test.ts (#5545)
 *
 * Regra #633: teste de regressão pro núcleo puro + I/O (mockado) do gate de
 * pré-voo do teste de 3 canais — parsing de `--emails`, avaliação PASSOU/
 * FALHOU por braço, leitura/exclusão de subscription na Beehiiv.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PREFLIGHT_UTM_ARMS,
  PREFLIGHT_ARM_IDS,
  parseArmEmailPairs,
  evaluateArm,
  allPassed,
  formatVerdictTable,
  fetchBeehiivSubscriptionUtm,
  deleteBeehiivSubscription,
  type ArmVerdict,
} from "../scripts/lib/preflight-utm.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// PREFLIGHT_UTM_ARMS
// ---------------------------------------------------------------------------

describe("PREFLIGHT_UTM_ARMS (#5545)", () => {
  it("tem exatamente os 3 braços esperados, na ordem do protocolo", () => {
    assert.deepEqual(
      PREFLIGHT_UTM_ARMS.map((a) => a.id),
      ["google-ads", "microsoft-ads", "meta-ads"],
    );
  });

  it("utm_source de cada braço é exatamente o id (sufixo -ads)", () => {
    for (const arm of PREFLIGHT_UTM_ARMS) {
      assert.equal(arm.utmSource, arm.id);
    }
  });

  it("nenhum braço usa utm_source proibido (facebook/instagram — já orgânico)", () => {
    for (const arm of PREFLIGHT_UTM_ARMS) {
      assert.notEqual(arm.utmSource, "facebook");
      assert.notEqual(arm.utmSource, "instagram");
    }
  });

  it("PREFLIGHT_ARM_IDS espelha os ids de PREFLIGHT_UTM_ARMS", () => {
    assert.deepEqual(PREFLIGHT_ARM_IDS, PREFLIGHT_UTM_ARMS.map((a) => a.id));
  });
});

// ---------------------------------------------------------------------------
// parseArmEmailPairs
// ---------------------------------------------------------------------------

describe("parseArmEmailPairs (#5545)", () => {
  it("parseia os 3 braços separados por vírgula", () => {
    const out = parseArmEmailPairs(
      "google-ads=a@x.com,microsoft-ads=b@x.com,meta-ads=c@x.com",
    );
    assert.deepEqual(out, { "google-ads": "a@x.com", "microsoft-ads": "b@x.com", "meta-ads": "c@x.com" });
  });

  it("aceita 1 braço só", () => {
    const out = parseArmEmailPairs("google-ads=a@x.com");
    assert.deepEqual(out, { "google-ads": "a@x.com" });
  });

  it("ignora espaços ao redor de cada par", () => {
    const out = parseArmEmailPairs(" google-ads=a@x.com , meta-ads=c@x.com ");
    assert.deepEqual(out, { "google-ads": "a@x.com", "meta-ads": "c@x.com" });
  });

  it("lança em par sem '='", () => {
    assert.throws(() => parseArmEmailPairs("google-ads-a@x.com"), /esperado "braço=email"/);
  });

  it("lança em braço vazio", () => {
    assert.throws(() => parseArmEmailPairs("=a@x.com"), /não podem ser vazios/);
  });

  it("lança em email vazio", () => {
    assert.throws(() => parseArmEmailPairs("google-ads="), /não podem ser vazios/);
  });

  it("lança em braço desconhecido", () => {
    assert.throws(() => parseArmEmailPairs("tiktok-ads=a@x.com"), /braço desconhecido "tiktok-ads"/);
  });

  it("ignora segmentos vazios (vírgula dupla, trailing)", () => {
    const out = parseArmEmailPairs("google-ads=a@x.com,,meta-ads=c@x.com,");
    assert.deepEqual(out, { "google-ads": "a@x.com", "meta-ads": "c@x.com" });
  });
});

// ---------------------------------------------------------------------------
// evaluateArm — o critério de aprovação da #5522
// ---------------------------------------------------------------------------

describe("evaluateArm (#5545)", () => {
  const arm = PREFLIGHT_UTM_ARMS[0]; // google-ads / cpc

  it("PASSOU: utm_source exato + utm_campaign sobrevivente", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", {
      id: "sub_1",
      status: "active",
      utm_source: "google-ads",
      utm_medium: "cpc",
      utm_campaign: "preflight-2608",
    });
    assert.equal(v.found, true);
    assert.equal(v.passed, true);
  });

  it("FALHOU: utm_source é direct (não exato)", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", {
      id: "sub_1",
      status: "active",
      utm_source: "direct",
      utm_medium: null,
      utm_campaign: "preflight-2608",
    });
    assert.equal(v.passed, false);
  });

  it("FALHOU: utm_source vazio/ausente (null)", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", {
      id: "sub_1",
      status: "active",
      utm_source: null,
      utm_medium: null,
      utm_campaign: "preflight-2608",
    });
    assert.equal(v.passed, false);
  });

  it("FALHOU: utm_source herdado de outro braço (achado ao vivo #5522 — atribuição first-touch)", () => {
    // Reproduz o achado real: braço microsoft-ads/meta-ads herdando
    // utm_source=google-ads do 1º cadastro da sessão de navegador.
    const microsoftArm = PREFLIGHT_UTM_ARMS[1];
    const v = evaluateArm(microsoftArm, "teste-ms@x.com", "preflight-2608", {
      id: "sub_2",
      status: "active",
      utm_source: "google-ads",
      utm_medium: "cpc",
      utm_campaign: "preflight-2608",
    });
    assert.equal(v.found, true);
    assert.equal(v.passed, false);
    assert.equal(v.obtainedSource, "google-ads");
    assert.equal(v.expectedSource, "microsoft-ads");
  });

  it("FALHOU: utm_campaign não sobreviveu (diferente do esperado)", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", {
      id: "sub_1",
      status: "active",
      utm_source: "google-ads",
      utm_medium: "cpc",
      utm_campaign: "outra-campanha",
    });
    assert.equal(v.passed, false);
  });

  it("NÃO ENCONTRADO: subscription null (404)", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", null);
    assert.equal(v.found, false);
    assert.equal(v.passed, false);
    assert.equal(v.obtainedSource, null);
  });

  it("utm_medium é reportado mas não decide o veredito (não é gate)", () => {
    const v = evaluateArm(arm, "teste@x.com", "preflight-2608", {
      id: "sub_1",
      status: "active",
      utm_source: "google-ads",
      utm_medium: "algo-diferente-de-cpc",
      utm_campaign: "preflight-2608",
    });
    assert.equal(v.passed, true);
    assert.equal(v.obtainedMedium, "algo-diferente-de-cpc");
  });
});

// ---------------------------------------------------------------------------
// allPassed / formatVerdictTable
// ---------------------------------------------------------------------------

describe("allPassed (#5545)", () => {
  it("false para lista vazia", () => {
    assert.equal(allPassed([]), false);
  });

  it("true só quando TODOS os braços passaram", () => {
    const v1: ArmVerdict = {
      arm: "google-ads",
      email: "a@x.com",
      expectedSource: "google-ads",
      expectedMedium: "cpc",
      expectedCampaign: "preflight-2608",
      obtainedSource: "google-ads",
      obtainedMedium: "cpc",
      obtainedCampaign: "preflight-2608",
      found: true,
      passed: true,
    };
    const v2: ArmVerdict = { ...v1, arm: "microsoft-ads", passed: false, obtainedSource: "google-ads" };
    assert.equal(allPassed([v1]), true);
    assert.equal(allPassed([v1, v2]), false);
  });
});

describe("formatVerdictTable (#5545)", () => {
  it("mensagem dedicada para lista vazia", () => {
    assert.equal(formatVerdictTable([]), "(nenhum braço avaliado)");
  });

  it("inclui PASSOU/FALHOU/NÃO ENCONTRADO conforme o veredito", () => {
    const base: ArmVerdict = {
      arm: "google-ads",
      email: "a@x.com",
      expectedSource: "google-ads",
      expectedMedium: "cpc",
      expectedCampaign: "preflight-2608",
      obtainedSource: "google-ads",
      obtainedMedium: "cpc",
      obtainedCampaign: "preflight-2608",
      found: true,
      passed: true,
    };
    const failed: ArmVerdict = { ...base, arm: "microsoft-ads", passed: false, obtainedSource: "google-ads" };
    const notFound: ArmVerdict = { ...base, arm: "meta-ads", found: false, passed: false, obtainedSource: null, obtainedCampaign: null };
    const table = formatVerdictTable([base, failed, notFound]);
    assert.match(table, /\[google-ads\][\s\S]*veredito: PASSOU/);
    assert.match(table, /\[microsoft-ads\][\s\S]*veredito: FALHOU/);
    assert.match(table, /\[meta-ads\][\s\S]*veredito: NÃO ENCONTRADO/);
  });
});

// ---------------------------------------------------------------------------
// fetchBeehiivSubscriptionUtm (I/O, mockado)
// ---------------------------------------------------------------------------

describe("fetchBeehiivSubscriptionUtm (#5545)", () => {
  it("retorna null em 404", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    const result = await fetchBeehiivSubscriptionUtm("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(result, null);
  });

  it("extrai id/status/utm_* do corpo data", async () => {
    const fetchImpl = (async () =>
      jsonRes(200, {
        data: {
          id: "sub_123",
          status: "active",
          utm_source: "meta-ads",
          utm_medium: "paid_social",
          utm_campaign: "preflight-2608",
        },
      })) as typeof fetch;
    const result = await fetchBeehiivSubscriptionUtm("pub_1", "key", "a@x.com", fetchImpl);
    assert.deepEqual(result, {
      id: "sub_123",
      status: "active",
      utm_source: "meta-ads",
      utm_medium: "paid_social",
      utm_campaign: "preflight-2608",
    });
  });

  it("campos utm ausentes/vazios viram null (não string vazia)", async () => {
    const fetchImpl = (async () =>
      jsonRes(200, { data: { id: "sub_1", status: "pending", utm_source: "", utm_medium: null } })) as typeof fetch;
    const result = await fetchBeehiivSubscriptionUtm("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(result?.utm_source, null);
    assert.equal(result?.utm_medium, null);
    assert.equal(result?.utm_campaign, null);
  });

  it("lança em HTTP não-2xx diferente de 404", async () => {
    const fetchImpl = (async () => jsonRes(500, { error: "boom" })) as typeof fetch;
    await assert.rejects(
      () => fetchBeehiivSubscriptionUtm("pub_1", "key", "a@x.com", fetchImpl),
      /Beehiiv API 500/,
    );
  });

  it("retorna null quando o corpo não tem data", async () => {
    const fetchImpl = (async () => jsonRes(200, {})) as typeof fetch;
    const result = await fetchBeehiivSubscriptionUtm("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// deleteBeehiivSubscription (I/O, mockado)
// ---------------------------------------------------------------------------

describe("deleteBeehiivSubscription (#5545)", () => {
  it("resolve em 204", async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await assert.doesNotReject(() => deleteBeehiivSubscription("pub_1", "key", "sub_1", fetchImpl));
  });

  it("resolve (idempotente) em 404", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    await assert.doesNotReject(() => deleteBeehiivSubscription("pub_1", "key", "sub_1", fetchImpl));
  });

  it("lança em HTTP não-2xx diferente de 404", async () => {
    const fetchImpl = (async () => new Response("erro interno", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => deleteBeehiivSubscription("pub_1", "key", "sub_1", fetchImpl),
      /Beehiiv API DELETE .*falhou \(HTTP 500\)/,
    );
  });
});
