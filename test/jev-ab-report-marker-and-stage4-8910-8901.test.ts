/**
 * test/jev-ab-report-marker-and-stage4-8910-8901.test.ts
 *
 * Dois fixes no jev-ab-report:
 *
 * (#8910) O aviso "marcador anterior ao Stage 1" comparava o marcador
 * `.jev-profile.json` (escrito pela skill ANTES do Stage 0) contra o início
 * do Stage 1 (que só começa depois do Stage 0 inteiro rodar, 1-5 min) — isso
 * disparava falso positivo em quase toda edição legítima do braço B. O fix
 * compara contra `run_started_at` (início real da run) com tolerância de
 * 5min, e nunca avisa quando o artefato do dedup já confirmou profile_env=all
 * sem shadow.
 *
 * (#8901 residual) Aviso opcional quando o `end` da Etapa 4 em
 * `stage-status.json` é anterior ao sentinel `.step-4-done.json` além de uma
 * tolerância pequena — sintoma do bug #8899 (fim marcado cedo demais
 * subnotifica tokens/custo da Etapa 4).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type EditionRaw, type Tri } from "../scripts/lib/jev-ab-report.ts";

const ok = <T>(value: T): Tri<T> => ({ state: "ok", value });
const absent = <T>(): Tri<T> => ({ state: "absent" });

function stageRow(stage: number, extra: Record<string, unknown> = {}) {
  return { stage, ...extra };
}

function branchBEdition(opts: {
  writtenAt: string;
  runStartedAt: string;
  stage1Start?: string;
  dedupArtifact?: unknown;
}): EditionRaw {
  return {
    edition: "260922",
    exists: true,
    profile: ok({ profile: "all", features: ["dedup_grayzone"], shadow: false, written_at: opts.writtenAt }),
    editorRequests: absent(),
    stageRows: ok([
      stageRow(1, { start: opts.stage1Start, duration_ms: 60000, pipeline_ms: 60000 }),
    ]),
    dedupArtifact: opts.dedupArtifact !== undefined ? ok(opts.dedupArtifact) : absent(),
    runStartedAt: ok(opts.runStartedAt),
  };
}

describe("#8910 — marcador anterior à run: comparar contra run_started_at, não Stage 1", () => {
  it("edição real 260922: marcador 17:56:49, run_started_at 17:59:00, Stage 1 18:00:30 — NÃO avisa", () => {
    const e = branchBEdition({
      writtenAt: "2026-09-22T17:56:49Z",
      runStartedAt: "2026-09-22T17:59:00Z",
      stage1Start: "2026-09-22T18:00:30Z",
      dedupArtifact: { profile_env: "all", shadow: false },
    });
    const { warnings } = computeMetrics(e);
    assert.ok(
      !warnings.some((w) => w.includes("marcador anterior")),
      `não devia avisar: ${JSON.stringify(warnings)}`
    );
  });

  it("edição real 260925: marcador 18:37:42, run_started_at 18:41:07 (3m25s) — NÃO avisa", () => {
    const e = branchBEdition({
      writtenAt: "2026-09-25T18:37:42Z",
      runStartedAt: "2026-09-25T18:41:07Z",
      dedupArtifact: { profile_env: "all", shadow: false },
    });
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("marcador anterior")));
  });

  it("retomada real: marcador horas antes de run_started_at, sem confirmação do dedup — AVISA", () => {
    const e = branchBEdition({
      writtenAt: "2026-09-20T10:00:00Z",
      runStartedAt: "2026-09-22T17:59:00Z",
      dedupArtifact: { profile_env: "shadow", shadow: true },
    });
    const { warnings } = computeMetrics(e);
    assert.ok(warnings.some((w) => w.includes("marcador anterior")));
  });

  it("mesmo com gap grande, se o dedup NÃO confirmou o perfil, o aviso de falta de confirmação já cobre — o de marcador antigo ainda pode disparar", () => {
    const e = branchBEdition({
      writtenAt: "2026-09-20T10:00:00Z",
      runStartedAt: "2026-09-22T17:59:00Z",
      dedupArtifact: undefined,
    });
    const { warnings } = computeMetrics(e);
    assert.ok(warnings.some((w) => w.includes("marcador anterior")));
    assert.ok(warnings.some((w) => w.includes("sem dedup-grayzone-jev.json")));
  });

  it("gap grande MAS dedup confirma profile_env=all sem shadow — não avisa marcador antigo", () => {
    const e = branchBEdition({
      writtenAt: "2026-09-20T10:00:00Z",
      runStartedAt: "2026-09-22T17:59:00Z",
      dedupArtifact: { profile_env: "all", shadow: false },
    });
    const { warnings } = computeMetrics(e);
    // O piso de 5min já não dispararia sozinho aqui (gap de dias), mas o
    // teste garante que a confirmação do dedup também suprime mesmo em gaps grandes.
    assert.ok(!warnings.some((w) => w.includes("marcador anterior")));
  });

  it("sem run_started_at disponível — não quebra, não avisa por falta de dado pra comparar", () => {
    const e: EditionRaw = {
      edition: "260922",
      exists: true,
      profile: ok({ profile: "all", features: ["dedup_grayzone"], shadow: false, written_at: "2026-09-22T17:56:49Z" }),
      editorRequests: absent(),
      stageRows: ok([stageRow(1, { start: "2026-09-22T18:00:30Z" })]),
      dedupArtifact: ok({ profile_env: "all", shadow: false }),
      runStartedAt: absent(),
    };
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("marcador anterior")));
  });
});

describe("#8901 residual — Etapa 4 implausível frente ao sentinel .step-4-done.json (#8899)", () => {
  function editionWithStage4(end: string | undefined, sentinelCompletedAt: string | undefined): EditionRaw {
    return {
      edition: "260928",
      exists: true,
      profile: absent(),
      editorRequests: absent(),
      stageRows: ok([stageRow(4, { start: "2026-09-28T10:00:00Z", end, duration_ms: 60000, pipeline_ms: 60000 })]),
      step4Sentinel: sentinelCompletedAt !== undefined ? ok({ completed_at: sentinelCompletedAt }) : absent(),
    };
  }

  it("sentinel completa 10min depois do end registrado — AVISA (sintoma #8899)", () => {
    const e = editionWithStage4("2026-09-28T10:30:00Z", "2026-09-28T10:40:00Z");
    const { warnings } = computeMetrics(e);
    assert.ok(warnings.some((w) => w.includes("Etapa 4") && w.includes("#8899")));
  });

  it("sentinel completa poucos segundos depois do end (dentro da tolerância) — não avisa", () => {
    const e = editionWithStage4("2026-09-28T10:30:00Z", "2026-09-28T10:30:30Z");
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("#8899")));
  });

  it("sentinel ausente — não avisa (nada pra comparar)", () => {
    const e = editionWithStage4("2026-09-28T10:30:00Z", undefined);
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("#8899")));
  });

  it("stage 4 sem `end` — não avisa (nada pra comparar)", () => {
    const e = editionWithStage4(undefined, "2026-09-28T10:40:00Z");
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("#8899")));
  });
});
