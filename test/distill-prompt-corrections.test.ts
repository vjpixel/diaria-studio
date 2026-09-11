/**
 * test/distill-prompt-corrections.test.ts (#7981)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDistillPromptCorrections, persistCadenceTriggerIfRan, MIN_DISTINCT_EDITIONS, MIN_DISTINCT_STORIES } from "../scripts/distill-prompt-corrections.ts";
import type { RequestType, RequestTarget, Resolution } from "../scripts/log-editor-request.ts";

interface EventSpec {
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  url?: string;
}

function writeEditorRequests(editionsRoot: string, edition: string, events: EventSpec[]): void {
  const internal = join(editionsRoot, edition, "_internal");
  mkdirSync(internal, { recursive: true });
  const lines = events.map((e) =>
    JSON.stringify({
      timestamp: new Date(0).toISOString(),
      edition,
      stage: 2,
      request_type: e.request_type,
      target: e.target,
      description: e.description,
      resolution: e.resolution,
      source: "derived",
      context: e.url ? { url: e.url } : undefined,
    }),
  );
  writeFileSync(join(internal, "editor-requests.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("runDistillPromptCorrections (#7981)", () => {
  it("cadence bloqueada: retorna cadence_blocked sem processar nada mais", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      const result = runDistillPromptCorrections(editionsRoot, {
        cadenceState: { triggeredAt: ["2026-09-10T12:00:00.000Z"] },
        nowIso: "2026-09-11T12:00:00.000Z",
        rootDir: editionsRoot,
      });
      assert.equal(result.status, "cadence_blocked");
      assert.equal(result.cadence.canTrigger, false);
      assert.deepEqual(result.candidates, []);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it(`request_type com menos de ${MIN_DISTINCT_EDITIONS} edições distintas: evidence-only, rejeitado`, () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      writeEditorRequests(editionsRoot, "260901", [{ request_type: "tone", target: "d1", description: "tom errado", resolution: "accepted", url: "https://a.com/1" }]);
      writeEditorRequests(editionsRoot, "260902", [{ request_type: "tone", target: "d1", description: "tom errado 2", resolution: "accepted", url: "https://a.com/2" }]);
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      const c = result.candidates.find((c) => c.requestType === "tone")!;
      assert.equal(c.lane, "evidence-only");
      assert.equal(c.accepted, false);
      assert.match(c.rejection_reasons.join(" "), /mínimo 5/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it(`≥${MIN_DISTINCT_EDITIONS} edições mas <${MIN_DISTINCT_STORIES} histórias distintas (mesma URL repetida): rejeitado`, () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 5; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "tone", target: "d1", description: "tom", resolution: "accepted", url: "https://mesma-url.com/x" }]);
      }
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      const c = result.candidates.find((c) => c.requestType === "tone")!;
      assert.equal(c.editions_count, 5);
      assert.equal(c.distinct_stories, 1);
      assert.equal(c.accepted, false);
      assert.match(c.rejection_reasons.join(" "), /mínimo 2/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("resolution=declined nunca conta como evento qualificante", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "tone", target: "d1", description: "tom", resolution: "declined", url: `https://x.com/${i}` }]);
      }
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      assert.equal(result.candidates.find((c) => c.requestType === "tone"), undefined, "declined não deveria nem aparecer como candidato");
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("request_type NÃO capture-verified (ex: link-swap) nunca entra na análise, mesmo com evidência abundante", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "link-swap", target: "d1", description: "troca de link", resolution: "accepted", url: `https://x.com/${i}` }]);
      }
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      assert.equal(result.candidates.find((c) => c.requestType === "link-swap"), undefined);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("length-cut com evidência suficiente: lane=mechanical-guard, ACEITO automaticamente, sem crítica holística", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "length-cut", target: "d1", description: "corte de texto", resolution: "accepted", url: `https://x.com/${i}` }]);
      }
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      const c = result.candidates.find((c) => c.requestType === "length-cut")!;
      assert.equal(c.lane, "mechanical-guard");
      assert.equal(c.accepted, true);
      assert.equal(c.critique, null);
      assert.ok(c.proposal && /guard mecânico/i.test(c.proposal));
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("title-length em dry-run (default): candidato NÃO aceito automaticamente — precisa --live pra rodar a crítica", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "title-length", target: "d1", description: "título longo", resolution: "accepted", url: `https://x.com/${i}` }]);
        mkdirSync(join(editionsRoot, `26090${i}`, "_internal"), { recursive: true });
        writeFileSync(
          join(editionsRoot, `26090${i}`, "_internal", "scoring-features.json"),
          JSON.stringify({ rows: [{ bucket: "highlights", title_char_count: 60, url: "https://x.com/h", title: "x".repeat(60), score: 50, score_base: 50, primary_source: false, hands_on: false, academy: false, howto_br: false, howto_br_source: false, cluster_sources_count: 0, negative_impact: false, category: null, origin: "cadastrada", recency_hours: null, domain: "x.com", has_official_link: false, novelty_vs_past_editions: null, source_reputation_ctr_30d: null, source_reputation_ctr_90d: null, feature_available_since: new Date(0).toISOString(), launch_heuristics_sha: null }] }),
          "utf8",
        );
      }
      const result = runDistillPromptCorrections(editionsRoot, {
        cadenceState: { triggeredAt: [] },
        nowIso: "2026-09-11T12:00:00.000Z",
        rootDir: editionsRoot,
        dryRun: true,
      });
      const c = result.candidates.find((c) => c.requestType === "title-length")!;
      assert.equal(c.lane, "editorial-signoff");
      assert.equal(c.accepted, false);
      assert.equal(c.critique, null);
      assert.match(c.rejection_reasons.join(" "), /dry-run/);
      assert.ok(c.proposal);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("title-length com --live e crítica 3x concordante (APROVA): ACEITO", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "title-length", target: "d1", description: "título longo", resolution: "accepted", url: `https://x.com/${i}` }]);
        mkdirSync(join(editionsRoot, `26090${i}`, "_internal"), { recursive: true });
        writeFileSync(
          join(editionsRoot, `26090${i}`, "_internal", "scoring-features.json"),
          JSON.stringify({ rows: [{ bucket: "highlights", title_char_count: 60, url: "https://x.com/h", title: "x".repeat(60), score: 50, score_base: 50, primary_source: false, hands_on: false, academy: false, howto_br: false, howto_br_source: false, cluster_sources_count: 0, negative_impact: false, category: null, origin: "cadastrada", recency_hours: null, domain: "x.com", has_official_link: false, novelty_vs_past_editions: null, source_reputation_ctr_30d: null, source_reputation_ctr_90d: null, feature_available_since: new Date(0).toISOString(), launch_heuristics_sha: null }] }),
          "utf8",
        );
      }
      const callClaudeCliFn = (() => "VEREDITO: APROVA\nJUSTIFICATIVA: parece razoável.") as any;
      const result = runDistillPromptCorrections(editionsRoot, {
        cadenceState: { triggeredAt: [] },
        nowIso: "2026-09-11T12:00:00.000Z",
        rootDir: editionsRoot,
        dryRun: false,
        socialCriticBody: "Instrução do critic.",
        callClaudeCliFn,
      });
      const c = result.candidates.find((c) => c.requestType === "title-length")!;
      assert.equal(c.accepted, true);
      assert.equal(c.critique?.consistent, true);
      assert.equal(c.critique?.majorityPasses, true);
      assert.ok(result.cost_estimate);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("tipo capture-verified sem síntese mecânica implementada (ex: eia-choice) com evidência suficiente: evidence-only, NÃO aceito, mas com sample_events preenchido", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      for (let i = 0; i < 6; i++) {
        writeEditorRequests(editionsRoot, `26090${i}`, [{ request_type: "eia-choice", target: "eia", description: "correção É IA?", resolution: "accepted", url: `https://x.com/${i}` }]);
      }
      const result = runDistillPromptCorrections(editionsRoot, { cadenceState: { triggeredAt: [] }, nowIso: "2026-09-11T12:00:00.000Z", rootDir: editionsRoot });
      const c = result.candidates.find((c) => c.requestType === "eia-choice")!;
      assert.equal(c.lane, "evidence-only");
      assert.equal(c.accepted, false);
      assert.ok(c.sample_events.length > 0);
      assert.match(c.rejection_reasons.join(" "), /síntese mecânica/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("cadence bloqueada: backtest NÃO roda (achado de review, P2 — antes rodava sempre, mesmo bloqueado)", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-orch-"));
    try {
      // corpus com dado real de overflow — se o backtest rodasse, editions_analyzed > 0.
      writeEditorRequests(editionsRoot, "260901", [{ request_type: "tone", target: "d1", description: "x", resolution: "accepted" }]);
      const result = runDistillPromptCorrections(editionsRoot, {
        cadenceState: { triggeredAt: ["2026-09-10T12:00:00.000Z"] },
        nowIso: "2026-09-11T12:00:00.000Z",
        rootDir: editionsRoot,
      });
      assert.equal(result.status, "cadence_blocked");
      assert.deepEqual(result.backtest, { editions_analyzed: 0, checks: [] });
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });
});

describe("persistCadenceTriggerIfRan (#7981) — achado de review P1 (3 agentes independentes): sem isto, o teto semanal nunca tinha efeito real", () => {
  it("grava nowIso em triggeredAt quando o disparo NÃO foi bloqueado", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "distill-persist-"));
    try {
      const cadencePath = join(rootDir, "data", "distillation-cadence.json");
      persistCadenceTriggerIfRan(cadencePath, { triggeredAt: ["2026-09-01T00:00:00.000Z"] }, "2026-09-11T12:00:00.000Z", "no_qualifying_pattern", rootDir);
      assert.equal(existsSync(cadencePath), true);
      const written = JSON.parse(readFileSync(cadencePath, "utf8"));
      assert.deepEqual(written.triggeredAt, ["2026-09-01T00:00:00.000Z", "2026-09-11T12:00:00.000Z"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("NÃO grava nada quando resultStatus === cadence_blocked (o disparo nem rodou)", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "distill-persist-"));
    try {
      const cadencePath = join(rootDir, "data", "distillation-cadence.json");
      persistCadenceTriggerIfRan(cadencePath, { triggeredAt: [] }, "2026-09-11T12:00:00.000Z", "cadence_blocked", rootDir);
      assert.equal(existsSync(cadencePath), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("2 disparos consecutivos: o 2º vê o histórico do 1º e evaluateDistillationCadence bloquearia (integração real do teto semanal)", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "distill-persist-"));
    try {
      const cadencePath = join(rootDir, "data", "distillation-cadence.json");
      persistCadenceTriggerIfRan(cadencePath, { triggeredAt: [] }, "2026-09-11T10:00:00.000Z", "no_qualifying_pattern", rootDir);
      const stateAfterFirst = JSON.parse(readFileSync(cadencePath, "utf8"));
      assert.equal(stateAfterFirst.triggeredAt.length, 1);
      // 2º disparo no mesmo dia leria este estado e evaluateDistillationCadence bloquearia — testado isoladamente em distillation-cadence-guard.test.ts; aqui confirmamos que o estado persistido é o que alimentaria essa checagem.
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
