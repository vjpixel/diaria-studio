/**
 * test/split-session-signals-9374.test.ts
 *
 * #9374 — sessão dividida (Etapas 1–4 × 5–6):
 *
 * 1. O auto-reporter do Stage 6 (2ª sessão) não via nada da 1ª: halts, MCP
 *    caindo, reclamações do editor no gate 4 ficavam só no contexto. Agora a
 *    1ª sessão grava `_internal/session-1-handoff.json` e o
 *    `collect-edition-signals.ts` vira isso em signal `session1_handoff`.
 * 2. O A/B do Jev contava `editor-requests.jsonl` como métrica de correção
 *    do gate 4 mesmo com o baseline quebrado (#9356) — subnotificação
 *    tratada como medida. Agora vira `null` + aviso até o backfill.
 * 3. Métrica editorial (`edition-manual-edits.ts`) estratificada por braço.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SESSION1_HANDOFF_FILE,
  appendHandoffEntry,
  closeHandoff,
  parseHandoff,
  readHandoff,
  summarizeHandoffForStage6,
} from "../scripts/lib/session-handoff.ts";
import { collectSignals, signalsFromSessionHandoff } from "../scripts/collect-edition-signals.ts";
import { armFromProfile, computeMetrics, type EditionRaw, type Tri } from "../scripts/lib/jev-ab-report.ts";
import { loadEdition } from "../scripts/jev-ab-report.ts";
import { summarizeSeries, type EditionManualEdits } from "../scripts/edition-manual-edits.ts";
import { STAGE4_BACKFILL_MARKER } from "../scripts/lib/editor-request-snapshots.ts";
import { closeSessionHandoffOnStage4Sentinel } from "../scripts/pipeline-sentinel.ts";

const ROOT = resolve(import.meta.dirname, "..");

function tmpEdition(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "split-9374-"));
  const dir = join(root, "data", "editions", "2610", "261001");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return { root, dir };
}

describe("handoff da 1ª sessão (#9374)", () => {
  it("add acumula entradas e close carimba sem perder nada", () => {
    const { root, dir } = tmpEdition();
    try {
      appendHandoffEntry(dir, "261001", { kind: "mcp_drop", stage: 0, summary: "Gmail MCP caiu no 0n", component: "mcp__claude_ai_Gmail" });
      appendHandoffEntry(dir, "261001", { kind: "retry", stage: 2, summary: "writer-destaque d2 refeito" });
      const doc = closeHandoff(dir, "261001", new Date("2026-10-01T20:00:00Z"));
      assert.equal(doc.entries.length, 2);
      assert.equal(doc.closed_at, "2026-10-01T20:00:00.000Z");
      assert.equal(doc.entries[0].severity, "medium");
      assert.equal(doc.entries[1].severity, "low");
      const r = readHandoff(dir);
      assert.equal(r.state, "ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa stage fora da 1ª sessão e nunca sobrescreve arquivo corrompido", () => {
    const { root, dir } = tmpEdition();
    try {
      assert.throws(() => appendHandoffEntry(dir, "261001", { kind: "halt", stage: 5, summary: "x" }), /stage inválido/);
      writeFileSync(join(dir, SESSION1_HANDOFF_FILE), "{not json");
      assert.throws(() => closeHandoff(dir, "261001"), /ilegível/);
      assert.equal(readFileSync(join(dir, SESSION1_HANDOFF_FILE), "utf8"), "{not json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parseHandoff descarta entrada inválida sem derrubar o resto", () => {
    const r = parseHandoff({
      edition: "261001",
      entries: [
        { kind: "halt", stage: 1, summary: "ok", severity: "high", recorded_at: "t" },
        { kind: "nope", stage: 1, summary: "x", severity: "low", recorded_at: "t" },
      ],
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.entries.length, 1);
      assert.equal(r.invalidEntries, 1);
    }
  });

  it("resumo do Stage 6 distingue ausente de fechado-sem-ocorrência", () => {
    assert.match(summarizeHandoffForStage6({ state: "absent" }), /ausente/);
    assert.match(
      summarizeHandoffForStage6({ state: "ok", value: { edition: "261001", entries: [], closed_at: "t" }, invalidEntries: 0 }),
      /nenhuma ocorrência/,
    );
  });

  it("signals: agrupa por (kind, component) e preserva a pior severidade", () => {
    const sigs = signalsFromSessionHandoff({
      state: "ok",
      invalidEntries: 0,
      value: {
        edition: "261001",
        entries: [
          { kind: "mcp_drop", stage: 0, summary: "a", severity: "medium", component: "gmail", recorded_at: "1" },
          { kind: "mcp_drop", stage: 2, summary: "b", severity: "high", component: "gmail", recorded_at: "2" },
          { kind: "editor_complaint", stage: 4, summary: "writer inventou número", severity: "medium", recorded_at: "3" },
        ],
      },
    });
    assert.equal(sigs.length, 2);
    const mcp = sigs.find((s) => s.details.handoff_kind === "mcp_drop")!;
    assert.equal(mcp.severity, "high");
    assert.equal(mcp.details.count, 2);
    assert.deepEqual(mcp.details.stages, [0, 2]);
    assert.equal(signalsFromSessionHandoff({ state: "absent" }).length, 0);
    assert.equal(signalsFromSessionHandoff({ state: "corrupt", error: "x" })[0].kind, "session1_handoff");
  });

  it("cenário da issue: collectSignals no Stage 6 vê o que a 1ª sessão registrou", () => {
    const { root, dir } = tmpEdition();
    try {
      appendHandoffEntry(dir, "261001", { kind: "halt", stage: 3, summary: "gen-carousel-cards abortou" });
      closeHandoff(dir, "261001");
      const draft = collectSignals({ rootDir: root, editionDir: dir, edition: "261001" });
      const s = draft.signals.filter((x) => x.kind === "session1_handoff");
      assert.equal(s.length, 1);
      assert.match(s[0].title, /Stage 3.*halt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI add/close/summary ponta a ponta", () => {
    const { root, dir } = tmpEdition();
    try {
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/session-handoff.ts"), ...args], { encoding: "utf8", cwd: ROOT });
      assert.equal(run("add", "--edition-dir", dir, "--kind", "problem", "--stage", "1", "--summary", "scorer sem fontes").status, 0);
      assert.equal(run("add", "--edition-dir", dir, "--kind", "bogus", "--stage", "1", "--summary", "x").status, 2);
      assert.equal(run("close", "--edition-dir", dir).status, 0);
      const out = run("summary", "--edition-dir", dir);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /1 ocorrência\(s\).*1 problem/);
      const doc = JSON.parse(readFileSync(join(dir, SESSION1_HANDOFF_FILE), "utf8"));
      assert.equal(doc.edition, "261001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("A/B do Jev com captura quebrada (#9374/#9356)", () => {
  const ok = <T>(value: T): Tri<T> => ({ state: "ok", value });
  const base = (bl?: EditionRaw["editorRequestBaseline"]): EditionRaw => ({
    edition: "260925",
    exists: true,
    profile: { state: "absent" },
    editorRequests: ok({ rows: [{ stage: 4 }, { stage: 6 }], invalidLines: 0 }),
    stageRows: ok([]),
    ...(bl ? { editorRequestBaseline: bl } : {}),
  });

  it("baseline quebrado sem backfill: correções do gate 4 viram null + aviso de reprocessar", () => {
    const { m, warnings } = computeMetrics(base({ status: "missing", backfilled: false }));
    assert.equal(m.gate4Corrections, null);
    assert.ok(warnings.some((w) => /#9356/.test(w) && /backfill-stage4/.test(w)));
  });

  it("baseline quebrado COM backfill, ou ok, conta normalmente", () => {
    assert.equal(computeMetrics(base({ status: "late", backfilled: true })).m.gate4Corrections, 1);
    assert.equal(computeMetrics(base({ status: "ok", backfilled: false })).m.gate4Corrections, 1);
    assert.equal(computeMetrics(base()).m.gate4Corrections, 1);
  });

  it("loadEdition lê saúde do baseline e marcador de backfill do disco", () => {
    const { root, dir } = tmpEdition();
    try {
      let e = loadEdition("261001", dir);
      assert.deepEqual(e.editorRequestBaseline, { status: "missing", backfilled: false });
      writeFileSync(join(dir, STAGE4_BACKFILL_MARKER), "{}");
      e = loadEdition("261001", dir);
      assert.equal(e.editorRequestBaseline?.backfilled, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("métrica editorial estratificada por braço (#9374)", () => {
  it("armFromProfile usa o mesmo critério do relatório A/B", () => {
    assert.equal(armFromProfile({ state: "absent" }), "A");
    assert.equal(armFromProfile({ state: "ok", value: { profile: "all", features: ["x"] } }), "B");
    assert.equal(armFromProfile({ state: "corrupt" }), "unknown");
  });

  it("summarizeSeries separa A e B", () => {
    const mk = (edition: string, arm: "A" | "B", zero: boolean | null): EditionManualEdits => ({
      edition,
      arm,
      baseline_status: "ok",
      gates: {} as EditionManualEdits["gates"],
      manual_edit_count: zero === false ? 1 : 0,
      zero_manual_edits: zero,
    });
    const s = summarizeSeries([mk("260921", "B", false), mk("260922", "A", true), mk("260923", "B", true)]);
    assert.deepEqual(s.by_arm.B, { editions: 2, zero: 1, with_edits: 1, unknown: 0 });
    assert.deepEqual(s.by_arm.A, { editions: 1, zero: 1, with_edits: 0, unknown: 0 });
    assert.equal(s.by_arm.unknown.editions, 0);
  });
});

describe("fechamento mecânico no sentinel do Stage 4 (#9374)", () => {
  it("cria vazio+fechado quando a sessão não registrou nada", () => {
    const { root, dir } = tmpEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      assert.equal(closeSessionHandoffOnStage4Sentinel(dir, "261001"), "closed");
      const r = readHandoff(dir);
      assert.equal(r.state, "ok");
      if (r.state === "ok") {
        assert.equal(r.value.entries.length, 0);
        assert.ok(r.value.closed_at);
      }
      assert.match(summarizeHandoffForStage6(r), /nenhuma ocorrência/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("idempotente: preserva entradas e o closed_at original", () => {
    const { root, dir } = tmpEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      appendHandoffEntry(dir, "261001", { kind: "halt", stage: 2, summary: "y" });
      closeHandoff(dir, "261001", new Date("2026-10-01T10:00:00Z"));
      assert.equal(closeSessionHandoffOnStage4Sentinel(dir, "261001"), "already-closed");
      const r = readHandoff(dir);
      assert.ok(r.state === "ok" && r.value.closed_at === "2026-10-01T10:00:00.000Z" && r.value.entries.length === 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pula layout sem 02-reviewed.md (mensal) e não sobrescreve arquivo corrompido", () => {
    const { root, dir } = tmpEdition();
    try {
      assert.equal(closeSessionHandoffOnStage4Sentinel(dir, "261001"), "skipped");
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      writeFileSync(join(dir, SESSION1_HANDOFF_FILE), "{bad");
      assert.equal(closeSessionHandoffOnStage4Sentinel(dir, "261001"), "error");
      assert.equal(readFileSync(join(dir, SESSION1_HANDOFF_FILE), "utf8"), "{bad");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI `pipeline-sentinel.ts write --step 4` fecha o handoff de verdade", () => {
    const { root, dir } = tmpEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      writeFileSync(join(dir, "03-social.md"), "x");
      const res = spawnSync(
        process.execPath,
        // cwd = raiz temporária (sem node_modules): tsx resolvido pelo URL absoluto.
        ["--import", import.meta.resolve("tsx"), join(ROOT, "scripts/pipeline-sentinel.ts"), "write", "--edition", "261001", "--step", "4", "--outputs", "02-reviewed.md,03-social.md", "--dir", dir],
        { encoding: "utf8", cwd: root },
      );
      const r = readHandoff(dir);
      assert.equal(r.state, "ok", `stdout=${res.stdout} stderr=${res.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
