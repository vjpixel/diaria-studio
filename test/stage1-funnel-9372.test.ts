/**
 * test/stage1-funnel-9372.test.ts (#9372)
 *
 * Registro confiável do Stage 1: snapshot congelado do gate 1
 * (`01-approved.gate1.json`) + manifesto do funil (`stage1-funnel.json`),
 * gravados write-once no sentinel do Stage 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FUNNEL_STAGES,
  buildStage1Funnel,
  captureStage1Records,
  readGate1Approved,
  GATE1_SNAPSHOT_FILE,
  FUNNEL_MANIFEST_FILE,
  type FunnelStageInput,
} from "../scripts/lib/stage1-funnel.ts";
import { captureStage1RecordsOnSentinel } from "../scripts/pipeline-sentinel.ts";

const A = "https://a.com/1";
const B = "https://b.com/dup";
const C = "https://c.com/old";
const D = "https://d.com/member";
const E = "https://e.com/low";
const F = "https://f.com/cut";
const G = "https://g.com/top";

const art = (url: string) => ({ url, title: url });
const pool = (radar: string[], extra: Record<string, unknown> = {}) => ({ lancamento: [], radar: radar.map(art), use_melhor: [], video: [], ...extra });

/** Funil sintético completo, mtimes crescentes na ordem das etapas. */
function fullInputs(): FunnelStageInput[] {
  const byId: Record<string, unknown> = {
    collected: [A, B, C, D, E, F, G].map(art),
    verify: [A, B, C, D, E, F, G].map(art),
    aggregator_expand: { articles: [A, B, C, D, E, F, G].map(art) },
    dedup: { kept: [A, C, D, E, F, G].map(art), removed: [{ url: B, title: B, dedup_note: "URL publicada em 260929" }] },
    categorize: pool([A, C, D, E, F, G]),
    cluster: { ...pool([A, C, E, F, G]), clusters: [{ top_url: A, member_urls: [A, D] }] },
    date_window: { kept: pool([A, E, F, G]), removed: [{ url: C, reason: "date_window", detail: "published_at 2026-07-15 < cutoff" }] },
    date_review: { categorized: pool([A, E, F, G]), stats: { removals: [] } },
    scoring_pool: { categorized: pool([A, E, F, G]) },
    scored: { all_scored: [{ url: A, score: 80 }, { url: E, score: 12 }, { url: F, score: 60 }, { url: G, score: 90 }] },
    finalize: pool([A, F, G]),
    post_select: { highlights: [{ article: art(G) }], runners_up: [], ...pool([A, F]) },
    gate1: { highlights: [{ article: art(G) }], runners_up: [], ...pool([A]) },
  };
  return FUNNEL_STAGES.map((s, i) => ({ json: byId[s.id] ?? null, mtimeMs: 1_000_000 + i * 10_000 }));
}

describe("buildStage1Funnel (#9372)", () => {
  it("atribui a etapa de saída e o motivo de cada URL", () => {
    const m = buildStage1Funnel("261001", fullInputs(), { now: new Date("2026-10-01T00:00:00Z") });
    const by = new Map(m.items.map((i) => [i.url, i]));
    assert.equal(by.get(G)!.outcome, "approved");
    assert.equal(by.get(A)!.outcome, "approved");
    assert.deepEqual([by.get(B)!.exit_stage, by.get(B)!.reason], ["dedup", "dedup: URL publicada em 260929"]);
    assert.equal(by.get(D)!.exit_stage, "cluster");
    assert.match(by.get(D)!.reason!, /mesmo evento que https:\/\/a\.com\/1/);
    assert.equal(by.get(C)!.exit_stage, "date_window");
    assert.match(by.get(C)!.reason!, /cutoff/);
    assert.equal(by.get(E)!.exit_stage, "finalize");
    assert.match(by.get(E)!.reason!, /score 12/);
    assert.deepEqual([by.get(F)!.exit_stage, by.get(F)!.reason], ["gate1", "cortado no gate 1 do editor"]);
    assert.equal(m.totals.approved, 2);
    assert.equal(m.totals.ambiguous, 0);
    assert.deepEqual(m.warnings, []);
  });

  it("etapa ausente: a saída que passa por ela fica ambígua, nunca inventada", () => {
    const inputs = fullInputs();
    const idx = FUNNEL_STAGES.findIndex((s) => s.id === "date_window");
    inputs[idx] = { json: null, mtimeMs: null };
    const m = buildStage1Funnel("261001", inputs);
    const c = m.items.find((i) => i.url === C)!;
    assert.equal(c.exit_stage, "date_review");
    assert.equal(c.ambiguous, true);
    assert.ok(m.warnings.some((w) => w.includes("tmp-filtered.json ausente")));
  });

  it("arquivo reescrito depois da etapa seguinte (rerun) vira stale_order e sai das transições", () => {
    const inputs = fullInputs();
    const idx = FUNNEL_STAGES.findIndex((s) => s.id === "categorize");
    // tmp-categorized regravado DEPOIS do clustering, com um item que nunca existiu ali
    inputs[idx] = { json: pool([A, C, D, E, F, G, "https://late.com/x"]), mtimeMs: 9_999_999 };
    const m = buildStage1Funnel("261001", inputs);
    const st = m.stages.find((s) => s.id === "categorize")!;
    assert.equal(st.stale_order, true);
    assert.ok(m.warnings.some((w) => w.includes("tmp-categorized.json é mais novo")));
    assert.equal(m.items.some((i) => i.url === "https://late.com/x"), false, "item só do arquivo stale não entra no universo");
  });

  it("URL que aparece no meio do funil é contada em entered_mid_funnel (contagens que não fecham ficam visíveis)", () => {
    const inputs = fullInputs();
    const gi = FUNNEL_STAGES.length - 1;
    inputs[gi] = { json: { highlights: [{ article: art(G) }], ...pool([A, "https://inbox.com/editor"]) }, mtimeMs: inputs[gi].mtimeMs };
    const m = buildStage1Funnel("261001", inputs);
    assert.equal(m.stages[gi].entered_mid_funnel, 1);
  });

  it("URL trocada na verificação (resolvedFrom) não vira saída na coleta", () => {
    const inputs = fullInputs();
    inputs[0] = { json: [...[A, B, C, D, E, F].map(art), art("https://sho.rt/g")], mtimeMs: inputs[0].mtimeMs };
    inputs[1] = { json: [...[A, B, C, D, E, F].map(art), { url: G, title: G, resolvedFrom: "https://sho.rt/g" }], mtimeMs: inputs[1].mtimeMs };
    const m = buildStage1Funnel("261001", inputs);
    assert.equal(m.items.some((i) => i.url === "https://sho.rt/g"), false);
    assert.equal(m.items.find((i) => i.url === G)!.outcome, "approved");
  });

  it("rejeita número errado de entradas", () => {
    assert.throws(() => buildStage1Funnel("261001", []), /esperava/);
  });
});

function writeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage1-funnel-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const inputs = fullInputs();
  FUNNEL_STAGES.forEach((s, i) => {
    if (inputs[i].json === null) return;
    const p = join(dir, s.file);
    writeFileSync(p, JSON.stringify(inputs[i].json), "utf8");
    const t = new Date(inputs[i].mtimeMs! );
    utimesSync(p, t, t);
  });
  return dir;
}

describe("captureStage1Records (#9372)", () => {
  it("congela o 01-approved do gate 1: reescrita posterior (Stage 4) não altera o snapshot", () => {
    const dir = writeEditionDir();
    try {
      const r1 = captureStage1Records(dir, "261001");
      assert.deepEqual(r1, { gate1_snapshot: "created", funnel_manifest: "created" });
      const frozen = readFileSync(join(dir, GATE1_SNAPSHOT_FILE), "utf8");

      // Stage 4: editor inclui item e troca destaque — 01-approved.json reescrito.
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ article: art(F) }], ...pool([A, "https://incluido.com/stage4"]) }));
      const r2 = captureStage1Records(dir, "261001");
      assert.deepEqual(r2, { gate1_snapshot: "exists", funnel_manifest: "exists" });
      assert.equal(readFileSync(join(dir, GATE1_SNAPSHOT_FILE), "utf8"), frozen);

      const gate1 = readGate1Approved(dir)!;
      assert.equal(gate1.frozen, true);
      assert.equal(JSON.stringify(gate1.json).includes("incluido.com"), false, "leitor canônico devolve o gate 1, não o arquivo vivo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("manifesto é imutável: rerun que sobrescreve tmp-* não muda o registro", () => {
    const dir = writeEditionDir();
    try {
      captureStage1Records(dir, "261001");
      const before = readFileSync(join(dir, FUNNEL_MANIFEST_FILE), "utf8");
      const m = JSON.parse(before);
      assert.equal(m.trigger, "pipeline-sentinel-step-1");
      assert.equal(m.gate1_frozen, true);
      writeFileSync(join(dir, "_internal", "tmp-dedup-output.json"), JSON.stringify({ kept: [], removed: [] }));
      captureStage1Records(dir, "261001");
      assert.equal(readFileSync(join(dir, FUNNEL_MANIFEST_FILE), "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sentinel do Stage 1 reescrito depois do Stage 2: NÃO congela o 01-approved vivo como gate 1", () => {
    const dir = writeEditionDir();
    try {
      writeFileSync(join(dir, "_internal", ".step-2-done.json"), JSON.stringify({ step: 2, completed_at: "2026-10-01T00:00:00Z", outputs: [] }));
      const r = captureStage1Records(dir, "261001");
      assert.equal(r.gate1_snapshot, "too-late");
      assert.equal(existsSync(join(dir, GATE1_SNAPSHOT_FILE)), false);
      assert.equal(JSON.parse(readFileSync(join(dir, FUNNEL_MANIFEST_FILE), "utf8")).gate1_frozen, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem snapshot congelado, readGate1Approved cai no arquivo vivo marcando frozen=false", () => {
    const dir = writeEditionDir();
    try {
      const g = readGate1Approved(dir)!;
      assert.equal(g.frozen, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hook do sentinel: layout fora da diária (sem 01-categorized.json) é skipped, nada escrito", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage1-funnel-mensal-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{}");
      assert.equal(captureStage1RecordsOnSentinel(dir, "2609-10"), "skipped");
      assert.equal(existsSync(join(dir, GATE1_SNAPSHOT_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hook do sentinel grava os dois registros na edição diária", () => {
    const dir = writeEditionDir();
    try {
      const r = captureStage1RecordsOnSentinel(dir, "261001");
      assert.deepEqual(r, { gate1_snapshot: "created", funnel_manifest: "created" });
      assert.ok(existsSync(join(dir, FUNNEL_MANIFEST_FILE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
