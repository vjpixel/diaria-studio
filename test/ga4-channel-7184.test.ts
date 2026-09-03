/**
 * test/ga4-channel-7184.test.ts (#7184, fatia 12 do épico #7172)
 *
 * Cobre `scripts/lib/metrics/ga4-channel.ts` (classificação de sessões GA4 +
 * allowlist de hostName + reconciliação sessões↔cadastros). Módulo puro —
 * nenhum teste toca rede/disco.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GA4_HOSTNAME_ALLOWLIST,
  classifyGa4Channel,
  filterByHostAllowlist,
  aggregateGa4SessionsByClasse,
  computeConversaoPorClasse,
  type Ga4ChannelRow,
} from "../scripts/lib/metrics/ga4-channel.ts";

describe("#7184 — classifyGa4Channel", () => {
  it("medium cpc → pago (google/bing/microsoft ads)", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "google", sessionMedium: "cpc" }), "pago");
    assert.equal(classifyGa4Channel({ sessionSource: "bing", sessionMedium: "cpc" }), "pago");
  });

  it("medium paid_social → pago (meta ads)", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "facebook", sessionMedium: "paid_social" }), "pago");
    assert.equal(classifyGa4Channel({ sessionSource: "instagram", sessionMedium: "paid_social" }), "pago");
  });

  it("source sendinblue/brevo-diaria → reativacao", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "sendinblue", sessionMedium: "email" }), "reativacao");
    assert.equal(classifyGa4Channel({ sessionSource: "brevo-diaria", sessionMedium: "email" }), "reativacao");
  });

  it("source clarice/email → iniciativa (probe da issue: 111 sessões)", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "clarice", sessionMedium: "email" }), "iniciativa");
  });

  it("newsletter/email (canal próprio) → indeterminado — nunca aquisição nova", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "newsletter", sessionMedium: "email" }), "indeterminado");
  });

  it("linkedin sempre organico (armadilha 1 de acquisition-class.ts), independente do medium", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "linkedin", sessionMedium: "referral" }), "organico");
    assert.equal(classifyGa4Channel({ sessionSource: "linkedin.com", sessionMedium: "social" }), "organico");
  });

  it("medium organic (busca) → organico", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "google", sessionMedium: "organic" }), "organico");
  });

  it("direct/(none) → indeterminado, nunca organico por omissão", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "(direct)", sessionMedium: "(none)" }), "indeterminado");
  });

  it("medium referral (fora das regras explícitas) → organico", () => {
    assert.equal(classifyGa4Channel({ sessionSource: "tagassistant.google.com", sessionMedium: "referral" }), "organico");
  });

  it("combinação sem NENHUM sinal cai em indeterminado, nunca lança", () => {
    assert.equal(classifyGa4Channel({}), "indeterminado");
  });

  it("normaliza case/espaço (GA4 é case-sensitive na prática, mas o módulo não deve depender disso)", () => {
    assert.equal(classifyGa4Channel({ sessionSource: " Google ", sessionMedium: "CPC" }), "pago");
  });
});

describe("#7184 — filterByHostAllowlist", () => {
  const rows: Ga4ChannelRow[] = [
    { hostName: "diar.ia.br", sessions: "195", sessionSource: "google", sessionMedium: "organic" },
    { hostName: "diaria.beehiiv.com", sessions: "11", sessionSource: "(direct)", sessionMedium: "(none)" },
    { hostName: "eia.diar.ia.br", sessions: "98", sessionSource: "google", sessionMedium: "organic" },
    { hostName: "umapenca.com", sessions: "1", sessionSource: "(direct)", sessionMedium: "(none)" },
  ];

  it("mantém só hosts da allowlist (default: GA4_HOSTNAME_ALLOWLIST)", () => {
    const { included } = filterByHostAllowlist(rows);
    assert.deepEqual(
      included.map((r) => r.hostName),
      ["diar.ia.br", "diaria.beehiiv.com"],
    );
  });

  it("hosts fora da allowlist somam em unclassifiedHosts, nunca descartados em silêncio", () => {
    const { unclassifiedHosts } = filterByHostAllowlist(rows);
    assert.deepEqual(unclassifiedHosts, { "eia.diar.ia.br": 98, "umapenca.com": 1 });
  });

  it("linha sem hostName cai como host vazio, fora da allowlist", () => {
    const { included, unclassifiedHosts } = filterByHostAllowlist([{ sessions: "5" }]);
    assert.equal(included.length, 0);
    assert.equal(unclassifiedHosts[""], 5);
  });

  it("aceita allowlist custom (não hardcoded ao default)", () => {
    const { included } = filterByHostAllowlist(rows, ["umapenca.com"]);
    assert.deepEqual(
      included.map((r) => r.hostName),
      ["umapenca.com"],
    );
  });

  it("GA4_HOSTNAME_ALLOWLIST é diar.ia.br + diaria.beehiiv.com, nada mais (denominador correto = 206 no probe da issue)", () => {
    assert.deepEqual([...GA4_HOSTNAME_ALLOWLIST], ["diar.ia.br", "diaria.beehiiv.com"]);
  });
});

describe("#7184 — aggregateGa4SessionsByClasse", () => {
  it("soma sessions por classe sobre linhas já filtradas pela allowlist", () => {
    const rows: Ga4ChannelRow[] = [
      { sessionSource: "google", sessionMedium: "cpc", sessions: "5" },
      { sessionSource: "google", sessionMedium: "cpc", sessions: "3" },
      { sessionSource: "linkedin", sessionMedium: "referral", sessions: "10" },
      { sessionSource: "(direct)", sessionMedium: "(none)", sessions: "20" },
    ];
    const porClasse = aggregateGa4SessionsByClasse(rows);
    assert.equal(porClasse.pago, 8);
    assert.equal(porClasse.organico, 10);
    assert.equal(porClasse.indeterminado, 20);
    assert.equal(porClasse.reativacao, 0);
    assert.equal(porClasse.iniciativa, 0);
  });

  it("sessions ausente/não-numérico conta como 0, nunca NaN", () => {
    const porClasse = aggregateGa4SessionsByClasse([{ sessionSource: "google", sessionMedium: "cpc", sessions: "abc" }]);
    assert.equal(porClasse.pago, 0);
    assert.ok(Number.isFinite(porClasse.pago));
  });
});

describe("#7184 — computeConversaoPorClasse (sem-par nunca vira 0%/Infinity)", () => {
  it("classe com sessões E cadastros → status ok, conversao = cadastros/sessoes", () => {
    const rows = computeConversaoPorClasse(
      { pago: 100, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
      { pago: 4, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
    );
    assert.deepEqual(rows, [{ classe: "pago", sessoes: 100, cadastros: 4, conversao: 0.04, status: "ok" }]);
  });

  it("classe com sessão e SEM cadastro (majoritário, ex: tagassistant.google.com) → sem-par (só GA4), conversao null", () => {
    const rows = computeConversaoPorClasse(
      { pago: 0, reativacao: 0, iniciativa: 0, organico: 50, indeterminado: 0 },
      { pago: 0, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
    );
    assert.deepEqual(rows, [{ classe: "organico", sessoes: 50, cadastros: 0, conversao: null, status: "sem-par (só GA4)" }]);
  });

  it("classe com cadastro e SEM sessão → sem-par (só cadastro), conversao null, nunca Infinity", () => {
    const rows = computeConversaoPorClasse(
      { pago: 0, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
      { pago: 0, reativacao: 2, iniciativa: 0, organico: 0, indeterminado: 0 },
    );
    assert.deepEqual(rows, [{ classe: "reativacao", sessoes: 0, cadastros: 2, conversao: null, status: "sem-par (só cadastro)" }]);
  });

  it("classe ausente dos dois lados nunca aparece na saída", () => {
    const rows = computeConversaoPorClasse(
      { pago: 5, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
      { pago: 1, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classe, "pago");
  });
});
