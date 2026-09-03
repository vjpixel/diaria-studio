/**
 * claim-staleness.test.ts (#6436)
 *
 * Cobre o cenário real da issue: a sessão `continuo` reivindica uma issue,
 * re-reivindica a cada 60min sem soltar, e nunca produz PR — a claim precisa
 * envelhecer mesmo com a sessão sempre "viva".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  flattenClaims,
  findAgedClaims,
  CLAIM_STALE_AGE_MS,
  type ClaimBearingSession,
} from "../scripts/lib/claim-staleness.ts";

describe("flattenClaims", () => {
  it("achata claimed_issues de múltiplas sessões numa lista de entradas", () => {
    const sessions: ClaimBearingSession[] = [
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "abc123",
        claimed_issues: [6051, 6185],
        claimed_issues_at: { "6051": "2026-08-20T00:00:00Z", "6185": "2026-08-21T00:00:00Z" },
      },
      {
        kind: "overnight",
        machineTag: "neo",
        sessionId: "def456",
        claimed_issues: [6300],
      },
    ];
    const entries = flattenClaims(sessions);
    assert.deepEqual(entries, [
      { issueNumber: 6051, kind: "continuo", machineTag: "helios", sessionId: "abc123", claimedAt: "2026-08-20T00:00:00Z", stale: false },
      { issueNumber: 6185, kind: "continuo", machineTag: "helios", sessionId: "abc123", claimedAt: "2026-08-21T00:00:00Z", stale: false },
      { issueNumber: 6300, kind: "overnight", machineTag: "neo", sessionId: "def456", claimedAt: null, stale: false },
    ]);
  });

  it("#7263: session.stale === true é repassado pra ClaimEntry.stale", () => {
    const sessions: ClaimBearingSession[] = [
      {
        kind: "develop",
        machineTag: "helios",
        sessionId: "sess-ociosa",
        claimed_issues: [7263],
        claimed_issues_at: { "7263": "2026-09-01T00:00:00Z" },
        stale: true,
      },
    ];
    const [entry] = flattenClaims(sessions);
    assert.equal(entry?.stale, true);
  });

  it("sessão sem claimed_issues não gera entradas", () => {
    assert.deepEqual(flattenClaims([{ kind: "develop", machineTag: "neo", sessionId: "x" }]), []);
  });

  it("#6623: quando claimed_issues_effective está presente, é a fonte usada — não claimed_issues bruto", () => {
    // Cenário real do #6623: sessão STALE cujo claimed_issues bruto ainda
    // lista a issue, mas claimed_issues_effective (calculado por
    // listActiveSessions) já é vazio porque o claim não vale mais.
    // flattenClaims deve seguir claimed_issues_effective, não o bruto.
    const sessions: ClaimBearingSession[] = [
      {
        kind: "develop",
        machineTag: "neo",
        sessionId: "sess-stale",
        claimed_issues: [5998],
        claimed_issues_effective: [], // stale — o claim já não vale
        claimed_issues_at: { "5998": "2026-08-20T00:00:00Z" },
      },
    ];
    assert.deepEqual(flattenClaims(sessions), []);
  });

  it("#6623: claimed_issues_effective presente e não-vazio é usado tal qual (sessão viva)", () => {
    const sessions: ClaimBearingSession[] = [
      {
        kind: "overnight",
        machineTag: "helios",
        sessionId: "sess-viva",
        claimed_issues: [6051, 6185],
        claimed_issues_effective: [6051, 6185],
        claimed_issues_at: { "6051": "2026-08-20T00:00:00Z", "6185": "2026-08-21T00:00:00Z" },
      },
    ];
    const entries = flattenClaims(sessions);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.issueNumber), [6051, 6185]);
  });

  it("#6623: claimed_issues_effective AUSENTE cai no fallback claimed_issues bruto (fixture antiga, comportamento preservado)", () => {
    const sessions: ClaimBearingSession[] = [
      { kind: "continuo", machineTag: "helios", sessionId: "x", claimed_issues: [42] },
    ];
    assert.deepEqual(flattenClaims(sessions).map((e) => e.issueNumber), [42]);
  });
});

describe("findAgedClaims", () => {
  const NOW = Date.parse("2026-08-28T00:00:00Z");

  it("cenário real #6436: claim de 7h sem PR aberto → finding", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "5d791ef6",
        claimed_issues: [6051],
        claimed_issues_at: { "6051": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => false);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].issueNumber, 6051);
    assert.equal(findings[0].kind, "continuo");
    assert.ok(findings[0].ageMs >= CLAIM_STALE_AGE_MS);
  });

  it("claim de 7h COM PR aberto → nunca reporta (trabalho real em andamento)", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "5d791ef6",
        claimed_issues: [6051],
        claimed_issues_at: { "6051": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => true);
    assert.deepEqual(findings, []);
  });

  it("claim recente (dentro do teto) nunca reporta, mesmo sem PR", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [1],
        claimed_issues_at: { "1": new Date(NOW - 60_000).toISOString() },
      },
    ]);
    assert.deepEqual(findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => false), []);
  });

  it("claim sem claimedAt conhecido (sessão pré-#6436) nunca reporta — idade desconhecida ≠ idade excedida", () => {
    const entries = flattenClaims([
      { kind: "continuo", machineTag: "helios", sessionId: "x", claimed_issues: [1] },
    ]);
    assert.deepEqual(findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => false), []);
  });

  it("hasOpenPr indeterminado (null, gh indisponível) nunca reporta — fail-soft", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [1],
        claimed_issues_at: { "1": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    assert.deepEqual(findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => null), []);
  });

  // #6754 — falso positivo ao vivo: issue #6677 já estava CLOSED quando foi
  // reportada como "claim envelhecida sem PR aberto"; o checker nunca
  // consultava o estado da issue antes de sinalizar.
  it("#6754: issue CLOSED → nunca reporta, mesmo sem PR aberto e claim antiga", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [6677],
        claimed_issues_at: { "6677": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(
      entries,
      NOW,
      CLAIM_STALE_AGE_MS,
      () => false,
      () => true,
    );
    assert.deepEqual(findings, []);
  });

  it("#6754: issue OPEN (isIssueClosed → false) segue avaliação normal (reporta)", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [6677],
        claimed_issues_at: { "6677": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(
      entries,
      NOW,
      CLAIM_STALE_AGE_MS,
      () => false,
      () => false,
    );
    assert.equal(findings.length, 1);
  });

  it("#6754: isIssueClosed não verificável (null) → fail-soft, segue avaliação normal", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [6677],
        claimed_issues_at: { "6677": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(
      entries,
      NOW,
      CLAIM_STALE_AGE_MS,
      () => false,
      () => null,
    );
    assert.equal(findings.length, 1);
  });

  it("#6754: isIssueClosed omitido (chamador antigo) → comportamento inalterado", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [6677],
        claimed_issues_at: { "6677": new Date(NOW - 7 * 3_600_000).toISOString() },
      },
    ]);
    const findings = findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => false);
    assert.equal(findings.length, 1);
  });

  it("resultado ordenado por número de issue", () => {
    const entries = flattenClaims([
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "x",
        claimed_issues: [300, 100, 200],
        claimed_issues_at: {
          "300": new Date(NOW - 7 * 3_600_000).toISOString(),
          "100": new Date(NOW - 8 * 3_600_000).toISOString(),
          "200": new Date(NOW - 9 * 3_600_000).toISOString(),
        },
      },
    ]);
    const findings = findAgedClaims(entries, NOW, CLAIM_STALE_AGE_MS, () => false);
    assert.deepEqual(findings.map((f) => f.issueNumber), [100, 200, 300]);
  });
});
