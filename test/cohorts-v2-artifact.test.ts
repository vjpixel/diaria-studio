/**
 * cohorts-v2-artifact.test.ts (#4451 achado 6 do fleet review em #4479)
 *
 * Testes PUROS, sem I/O (#633) — cobrem `extractCohortsArtifact`,
 * `describeDegradedSignal`, `evaluateDegradedGate` e `buildCohortsV2Artifact`
 * de `scripts/lib/cohorts-v2-artifact.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCohortsArtifact,
  describeDegradedSignal,
  evaluateDegradedGate,
  buildCohortsV2Artifact,
  type CohortsV2Diagnostics,
} from "../scripts/lib/cohorts-v2-artifact.ts";
import type { EngagementCohorts } from "../scripts/lib/dashboard-kv-types.ts";

const GEN = "2026-08-06T00:00:00.000Z";

function makeCohorts(overrides: Partial<EngagementCohorts> = {}): EngagementCohorts {
  return {
    generatedAt: GEN,
    universe: 100,
    opened2plus: 40,
    opened1: 20,
    received1_opened0: 15,
    received2_opened0: 20,
    exits: 5,
    exitsBreakdown: { bounced: 2, optedOut: 3 },
    maxReceived: 6,
    ...overrides,
  };
}

function makeDiagnostics(overrides: Partial<CohortsV2Diagnostics> = {}): CohortsV2Diagnostics {
  return {
    campaignsTotal: 10,
    campaignsFromCache: 8,
    campaignsFetched: 2,
    campaignsFailedCount: 0,
    adminOptOutsAvailable: true,
    adminOptOutsApplied: 3,
    ...overrides,
  };
}

// ─── extractCohortsArtifact ───────────────────────────────────────────────

test("extractCohortsArtifact: formato v1/v2-antigo (EngagementCohorts cru) → diagnostics undefined", () => {
  const raw = makeCohorts();
  const { cohorts, diagnostics } = extractCohortsArtifact(raw);
  assert.deepEqual(cohorts, raw);
  assert.equal(diagnostics, undefined);
});

test("extractCohortsArtifact: formato v2 novo (wrapper cohorts+diagnostics) → extrai os dois", () => {
  const cohorts = makeCohorts();
  const diagnostics = makeDiagnostics();
  const raw = { cohorts, diagnostics };
  const out = extractCohortsArtifact(raw);
  assert.deepEqual(out.cohorts, cohorts);
  assert.deepEqual(out.diagnostics, diagnostics);
});

test("extractCohortsArtifact: nunca lança em formato antigo (null, primitivo, objeto qualquer)", () => {
  assert.doesNotThrow(() => extractCohortsArtifact(makeCohorts()));
  // Um objeto que só TEM "cohorts" (sem "diagnostics") não casa o duck-type — tratado como cru.
  const partial = { cohorts: makeCohorts() };
  const out = extractCohortsArtifact(partial);
  assert.equal(out.diagnostics, undefined);
  // cohorts vira o objeto inteiro (não desembrulha) — é o comportamento correto pra "não é o wrapper".
  assert.deepEqual(out.cohorts, partial);
});

// ─── describeDegradedSignal ───────────────────────────────────────────────

test("describeDegradedSignal: diagnostics undefined (arquivo v1/v2-antigo) → null (nada a avaliar)", () => {
  assert.equal(describeDegradedSignal(undefined), null);
});

test("describeDegradedSignal: adminOptOutsAvailable=true → null", () => {
  assert.equal(describeDegradedSignal(makeDiagnostics({ adminOptOutsAvailable: true })), null);
});

test("describeDegradedSignal: store indisponível → mensagem cita o motivo real", () => {
  const msg = describeDegradedSignal(
    makeDiagnostics({ adminOptOutsAvailable: false, adminOptOutsUnavailableReason: "SQLITE_BUSY" }),
  );
  assert.ok(msg?.includes("SQLITE_BUSY"));
});

test("describeDegradedSignal: --no-admin-optouts explícito (sem unavailableReason) → mensagem cita a flag", () => {
  const msg = describeDegradedSignal(
    makeDiagnostics({ adminOptOutsAvailable: false, adminOptOutsUnavailableReason: undefined }),
  );
  assert.ok(msg?.includes("--no-admin-optouts"));
});

// ─── evaluateDegradedGate ─────────────────────────────────────────────────

test("evaluateDegradedGate: nenhum lado degradado → não bloqueia, sem warnings", () => {
  const a = { diagnostics: undefined };
  const b = { diagnostics: makeDiagnostics({ adminOptOutsAvailable: true }) };
  const gate = evaluateDegradedGate(a, b, false);
  assert.equal(gate.blocked, false);
  assert.deepEqual(gate.warnings, []);
});

test("evaluateDegradedGate: lado b degradado, allowDegraded=false → bloqueia com 1 warning", () => {
  const a = { diagnostics: undefined };
  const b = { diagnostics: makeDiagnostics({ adminOptOutsAvailable: false, adminOptOutsUnavailableReason: "store ausente" }) };
  const gate = evaluateDegradedGate(a, b, false);
  assert.equal(gate.blocked, true);
  assert.equal(gate.warnings.length, 1);
});

test("evaluateDegradedGate: lado b degradado, allowDegraded=true → NÃO bloqueia, mas warning continua reportado", () => {
  const a = { diagnostics: undefined };
  const b = { diagnostics: makeDiagnostics({ adminOptOutsAvailable: false, adminOptOutsUnavailableReason: "store ausente" }) };
  const gate = evaluateDegradedGate(a, b, true);
  assert.equal(gate.blocked, false);
  assert.equal(gate.warnings.length, 1); // avisa mesmo permitindo — operador não pediu silêncio, só override
});

test("evaluateDegradedGate: os DOIS lados degradados → 2 warnings", () => {
  const degraded = { diagnostics: makeDiagnostics({ adminOptOutsAvailable: false, adminOptOutsUnavailableReason: "x" }) };
  const gate = evaluateDegradedGate(degraded, degraded, false);
  assert.equal(gate.blocked, true);
  assert.equal(gate.warnings.length, 2);
});

// ─── buildCohortsV2Artifact ───────────────────────────────────────────────

test("buildCohortsV2Artifact: monta cohorts+diagnostics a partir do resultado de buildCohortsV2", () => {
  const cohorts = makeCohorts();
  const artifact = buildCohortsV2Artifact({
    cohorts,
    campaignsTotal: 5,
    campaignsFromCache: 3,
    campaignsFetched: 2,
    campaignsFailed: [{ campaignId: 9, campaignName: "x", error: "boom" }],
    adminOptOutsApplied: 4,
    adminOptOutsAvailable: true,
  });
  assert.deepEqual(artifact.cohorts, cohorts);
  assert.equal(artifact.diagnostics.campaignsTotal, 5);
  assert.equal(artifact.diagnostics.campaignsFromCache, 3);
  assert.equal(artifact.diagnostics.campaignsFetched, 2);
  assert.equal(artifact.diagnostics.campaignsFailedCount, 1); // deriva o COUNT do array, não o array inteiro
  assert.equal(artifact.diagnostics.adminOptOutsApplied, 4);
  assert.equal(artifact.diagnostics.adminOptOutsAvailable, true);
  assert.equal(artifact.diagnostics.adminOptOutsUnavailableReason, undefined);
});

test("buildCohortsV2Artifact: round-trip com extractCohortsArtifact reconstrói o mesmo shape", () => {
  const cohorts = makeCohorts();
  const artifact = buildCohortsV2Artifact({
    cohorts,
    campaignsTotal: 1,
    campaignsFromCache: 0,
    campaignsFetched: 1,
    campaignsFailed: [],
    adminOptOutsApplied: 0,
    adminOptOutsAvailable: false,
    adminOptOutsUnavailableReason: "store não encontrado",
  });
  // Simula persistir (JSON.stringify) e reler (JSON.parse) — round-trip real de disco.
  const roundTripped = JSON.parse(JSON.stringify(artifact));
  const { cohorts: c2, diagnostics: d2 } = extractCohortsArtifact(roundTripped);
  assert.deepEqual(c2, cohorts);
  assert.equal(d2?.adminOptOutsAvailable, false);
  assert.equal(d2?.adminOptOutsUnavailableReason, "store não encontrado");
});
