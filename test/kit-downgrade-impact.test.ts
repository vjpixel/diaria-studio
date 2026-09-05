/**
 * test/kit-downgrade-impact.test.ts (#7365)
 *
 * Cobre o miolo puro de `scripts/lib/kit-downgrade-impact.ts` —
 * `compareKitDowngradeImpact` — com fixtures, sem rede e sem `KIT_API_KEY`.
 * Regressão-alvo: o cenário que a issue #7365 existe para detectar — cada
 * um dos 5 recursos some/degrada isoladamente, e a comparação aponta
 * exatamente qual.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KIT_DOWNGRADE_BASELINE_20260903,
  compareKitDowngradeImpact,
  formatKitDowngradeReport,
  type KitDowngradeCurrentState,
} from "../scripts/lib/kit-downgrade-impact.ts";

/** Estado atual "espelho fiel" da baseline — nenhum drift, tudo igual ao
 *  que a issue capturou em 03/09/2026 (mais contagens informativas maiores,
 *  o que é esperado com o tempo e não deve reprovar nada). */
function healthyCurrentState(): KitDowngradeCurrentState {
  return {
    fetchedAt: "2026-09-08T09:00:00.000Z",
    planType: "free",
    subscriberLimit: 10000,
    sendingAddresses: [
      { email_address: "vjpixel@gmail.com", is_default: false, is_verified: true, is_dmarc_configured: false },
      { email_address: "oi@news.diar.ia.br", is_default: true, is_verified: true, is_dmarc_configured: true },
    ],
    sequences: [
      { id: 2876508, name: "Boas-vindas", email_count: 3, active: true, subscriber_count: 40 },
    ],
    tags: [
      { id: 22837324, name: "rampa-kit" },
      { id: 22726726, name: "diaria-test-email" },
    ],
    customFields: [
      { id: 1349084, key: "utm_source" },
      { id: 1349085, key: "utm_medium" },
      { id: 1349086, key: "utm_campaign" },
      { id: 1349090, key: "referring_site" },
    ],
    broadcastsAccessible: true,
  };
}

describe("compareKitDowngradeImpact — estado saudável (#7365)", () => {
  it("tudo igual à baseline → overallOk true, todos os checks ok", () => {
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, healthyCurrentState());
    assert.equal(result.overallOk, true);
    assert.equal(result.checks.length, 5);
    for (const check of result.checks) {
      assert.equal(check.status, "ok", `${check.key} deveria ser ok: ${check.detail}`);
    }
  });

  it("plan_type mudou pra free mas isso sozinho não reprova nada (não é um dos 5 checks)", () => {
    const current = healthyCurrentState();
    current.planType = "free";
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    assert.equal(result.overallOk, true);
  });
});

describe("compareKitDowngradeImpact — sending address (#7365 passo 1)", () => {
  it("endereço oi@news.diar.ia.br some de sending_addresses → missing", () => {
    const current = healthyCurrentState();
    current.sendingAddresses = current.sendingAddresses.filter((a) => a.email_address !== "oi@news.diar.ia.br");
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sending_address")!;
    assert.equal(check.status, "missing");
    assert.equal(result.overallOk, false);
  });

  it("is_dmarc_configured vira false → changed, menciona a rampa Gmail no detail", () => {
    const current = healthyCurrentState();
    current.sendingAddresses = current.sendingAddresses.map((a) =>
      a.email_address === "oi@news.diar.ia.br" ? { ...a, is_dmarc_configured: false } : a,
    );
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sending_address")!;
    assert.equal(check.status, "changed");
    assert.match(check.detail, /rampa Gmail/);
    assert.equal(result.overallOk, false);
  });

  it("is_default vira false (sem tocar DMARC/verified) → ainda reprova como changed", () => {
    const current = healthyCurrentState();
    current.sendingAddresses = current.sendingAddresses.map((a) =>
      a.email_address === "oi@news.diar.ia.br" ? { ...a, is_default: false } : a,
    );
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sending_address")!;
    assert.equal(check.status, "changed");
    assert.match(check.detail, /is_default/);
  });
});

describe("compareKitDowngradeImpact — sequence de boas-vindas (#7365 passo 2)", () => {
  it("sequence desaparece da listagem → missing", () => {
    const current = healthyCurrentState();
    current.sequences = [];
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sequence_boas_vindas")!;
    assert.equal(check.status, "missing");
    assert.equal(result.overallOk, false);
  });

  it("active vira false → changed", () => {
    const current = healthyCurrentState();
    current.sequences = current.sequences.map((s) => ({ ...s, active: false }));
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sequence_boas_vindas")!;
    assert.equal(check.status, "changed");
    assert.match(check.detail, /active/);
  });

  it("email_count cai de 3 para 1 (um e-mail da sequence foi removido) → changed", () => {
    const current = healthyCurrentState();
    current.sequences = current.sequences.map((s) => ({ ...s, email_count: 1 }));
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sequence_boas_vindas")!;
    assert.equal(check.status, "changed");
    assert.match(check.detail, /email_count/);
  });

  it("achado por id mesmo se o nome mudar", () => {
    const current = healthyCurrentState();
    current.sequences = current.sequences.map((s) => ({ ...s, name: "Boas-vindas (renomeada)" }));
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sequence_boas_vindas")!;
    assert.equal(check.status, "ok");
  });

  it("id não bate mas o NOME bate → fallback por nome acha a sequence (ok)", () => {
    const current = healthyCurrentState();
    current.sequences = current.sequences.map((s) => ({ ...s, id: 999999 }));
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "sequence_boas_vindas")!;
    assert.equal(check.status, "ok");
  });
});

describe("compareKitDowngradeImpact — tag rampa-kit (#7365 passo 3)", () => {
  it("tag ausente → missing", () => {
    const current = healthyCurrentState();
    current.tags = current.tags.filter((t) => t.name !== "rampa-kit");
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "tag_rampa_kit")!;
    assert.equal(check.status, "missing");
    assert.equal(result.overallOk, false);
  });
});

describe("compareKitDowngradeImpact — custom fields KIT_UTM_* (#7365 passo 3)", () => {
  it("utm_campaign ausente → missing, nomeia a chave que sumiu", () => {
    const current = healthyCurrentState();
    current.customFields = current.customFields.filter((f) => f.key !== "utm_campaign");
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "custom_fields_utm")!;
    assert.equal(check.status, "missing");
    assert.match(check.detail, /utm_campaign/);
    assert.equal(result.overallOk, false);
  });

  it("todos ausentes → nomeia as 4 chaves", () => {
    const current = healthyCurrentState();
    current.customFields = [];
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "custom_fields_utm")!;
    assert.equal(check.status, "missing");
    for (const key of KIT_DOWNGRADE_BASELINE_20260903.requiredCustomFieldKeys) {
      assert.match(check.detail, new RegExp(key));
    }
  });

  it("campos extras (fora do escopo da issue) não afetam o veredito", () => {
    const current = healthyCurrentState();
    current.customFields.push({ id: 999, key: "apoio_nivel" });
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "custom_fields_utm")!;
    assert.equal(check.status, "ok");
  });
});

describe("compareKitDowngradeImpact — acesso à API de broadcasts (#7365 passo 4)", () => {
  it("broadcastsAccessible false → error, carrega a mensagem original", () => {
    const current = healthyCurrentState();
    current.broadcastsAccessible = false;
    current.broadcastsError = "Kit API /broadcasts -> 403: forbidden";
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const check = result.checks.find((c) => c.key === "broadcasts_api_access")!;
    assert.equal(check.status, "error");
    assert.match(check.detail, /403/);
    assert.equal(result.overallOk, false);
  });
});

describe("compareKitDowngradeImpact — múltiplas quebras simultâneas", () => {
  it("sending address E tag quebram juntos → 2 checks não-ok, resto ok", () => {
    const current = healthyCurrentState();
    current.sendingAddresses = current.sendingAddresses.filter((a) => a.email_address !== "oi@news.diar.ia.br");
    current.tags = [];
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    assert.equal(result.overallOk, false);
    const failing = result.checks.filter((c) => c.status !== "ok").map((c) => c.key);
    assert.deepEqual(new Set(failing), new Set(["sending_address", "tag_rampa_kit"]));
  });
});

describe("formatKitDowngradeReport", () => {
  it("inclui plan_type, o veredito geral e uma linha por check", () => {
    const current = healthyCurrentState();
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const report = formatKitDowngradeReport(result, current);
    assert.match(report, /plan_type atual: free/);
    assert.match(report, /tudo OK/);
    for (const check of result.checks) {
      assert.match(report, new RegExp(check.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("estado quebrado imprime RESULTADO de falha", () => {
    const current = healthyCurrentState();
    current.tags = [];
    const result = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);
    const report = formatKitDowngradeReport(result, current);
    assert.match(report, /pelo menos 1 item quebrou/);
  });
});
