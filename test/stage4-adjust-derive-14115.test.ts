/**
 * test/stage4-adjust-derive-14115.test.ts (#14115 item 3)
 *
 * Regressão: `log-stage4-adjust-timing.ts` depende de o orchestrator, no meio
 * do loop do gate 4, capturar 3 timestamps e contar as próprias chamadas. Não
 * roda: `data/run-log.jsonl` tinha zero linhas com `withinTarget10s` até
 * 26/11/2026. A medição agora sai do transcript da sessão + ciclos do watcher
 * do preview, chamada por `capture-stage-usage.ts --stage 4` (que o playbook
 * já roda ao fechar a Etapa 4). Estes testes travam que um ajuste real vira
 * evento com `withinTarget10s` no run-log, sem o orchestrator lembrar de nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAdjustTimings,
  dropAlreadyLogged,
  parseMainThreadTimeline,
  watcherCyclesFromRunLog,
} from "../scripts/lib/stage4-adjust-derive.ts";
import { deriveStage4Adjusts } from "../scripts/capture-stage-usage.ts";
import { buildStage4TimingReport } from "../scripts/lib/stage4-timing-report.ts";
import { applyUpdate, makeInitialDoc, saveDoc } from "../scripts/update-stage-status.ts";

const EDITION = "261126";

const userPrompt = (ts: string, text = "troca o título do D2") =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const toolResult = (ts: string) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    toolUseResult: {},
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
  });
const assistantTool = (ts: string, id: string, toolId: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { id, model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolId, name: "Edit", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
const assistantText = (ts: string, id: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "feito" }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
const watcher = (changed: string, served: string, edition: string | null = EDITION) => ({
  timestamp: served,
  edition,
  stage: 4,
  agent: "serve-preview",
  message: "preview local: ciclo de reload do watcher",
  details: { file_changed_at: changed, preview_served_at: served, edit_to_preview_ms: Date.parse(served) - Date.parse(changed), within_target_10s: true },
});

/** Sessão do gate: 1 pedido com edição, 1 aprovação sem edição, 1 notificação injetada. */
const TRANSCRIPT = [
  userPrompt("2026-11-26T10:00:00.000Z"),
  assistantTool("2026-11-26T10:00:02.000Z", "r1", "tu1"),
  toolResult("2026-11-26T10:00:03.000Z"),
  // mesma resposta r2 em 2 linhas (um bloco por linha)
  assistantTool("2026-11-26T10:00:04.000Z", "r2", "tu2"),
  assistantText("2026-11-26T10:00:04.000Z", "r2"),
  toolResult("2026-11-26T10:00:05.000Z"),
  assistantText("2026-11-26T10:00:08.000Z", "r3"),
  JSON.stringify({ type: "user", timestamp: "2026-11-26T10:00:30.000Z", message: { content: "<task-notification>x</task-notification>" } }),
  JSON.stringify({ type: "user", timestamp: "2026-11-26T10:00:31.000Z", isMeta: true, message: { content: "meta" } }),
  JSON.stringify({ type: "user", timestamp: "2026-11-26T10:00:32.000Z", isSidechain: true, message: { content: "subagente" } }),
  userPrompt("2026-11-26T10:01:00.000Z", "sim"),
  assistantText("2026-11-26T10:01:02.000Z", "r4"),
].join("\n");

const CYCLES_LOG = [
  watcher("2026-11-26T10:00:05.000Z", "2026-11-26T10:00:05.300Z"),
  watcher("2026-11-26T10:00:07.000Z", "2026-11-26T10:00:07.300Z", null),
  watcher("2026-11-26T09:00:00.000Z", "2026-11-26T09:00:00.300Z"), // antes do gate
  watcher("2026-11-26T10:00:06.000Z", "2026-11-26T10:00:06.300Z", "261125"), // outra edição
];

describe("parseMainThreadTimeline", () => {
  it("só pedidos digitados contam como prompt; tool_result, meta, notificação e sidechain ficam fora", () => {
    const tl = parseMainThreadTimeline(TRANSCRIPT + "\n{linha quebrada");
    const prompts = tl.filter((e) => e.kind === "prompt").map((e) => new Date(e.ts).toISOString());
    assert.deepEqual(prompts, ["2026-11-26T10:00:00.000Z", "2026-11-26T10:01:00.000Z"]);
  });
});

describe("deriveAdjustTimings", () => {
  it("1 ajuste: pedido → 1ª edição do watcher, chamadas contadas por id, aprovação sem edição não conta", () => {
    const d = deriveAdjustTimings({
      timeline: parseMainThreadTimeline(TRANSCRIPT),
      cycles: watcherCyclesFromRunLog(CYCLES_LOG, EDITION),
      windowStartMs: Date.parse("2026-11-26T09:59:00.000Z"),
      windowEndMs: Date.parse("2026-11-26T10:05:00.000Z"),
    });
    assert.equal(d.length, 1);
    const a = d[0];
    assert.equal(a.requestedAt, "2026-11-26T10:00:00.000Z");
    assert.equal(a.editedAt, "2026-11-26T10:00:05.000Z");
    assert.equal(a.requestToEditMs, 5000);
    assert.equal(a.editToPreviewMs, 300);
    assert.equal(a.withinTarget10s, true);
    assert.equal(a.toolCalls, 2); // tu1 + tu2 até a edição
    assert.equal(a.apiCalls, 2); // r1 + r2 (r2 em 2 linhas = 1 resposta)
    assert.equal(a.apiCallsTotal, 3); // + r3 até o próximo pedido
    assert.equal(a.editsInInterval, 2); // ciclo da edição + o de edition null
  });

  it("janela inválida (gate_at = 'now' e sem start) não deriva nada", () => {
    const d = deriveAdjustTimings({ timeline: parseMainThreadTimeline(TRANSCRIPT), cycles: [], windowStartMs: NaN, windowEndMs: Date.now() });
    assert.deepEqual(d, []);
  });

  it("dropAlreadyLogged tira o que já está no run-log da mesma edição", () => {
    const d = deriveAdjustTimings({
      timeline: parseMainThreadTimeline(TRANSCRIPT),
      cycles: watcherCyclesFromRunLog(CYCLES_LOG, EDITION),
      windowStartMs: Date.parse("2026-11-26T09:59:00.000Z"),
      windowEndMs: Date.parse("2026-11-26T10:05:00.000Z"),
    });
    assert.equal(dropAlreadyLogged(d, [{ edition: EDITION, details: { requestedAt: d[0].requestedAt } }], EDITION).length, 0);
    assert.equal(dropAlreadyLogged(d, [{ edition: "261125", details: { requestedAt: d[0].requestedAt } }], EDITION).length, 1);
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "stage4-derive-14115-"));
  const transcriptsDir = join(root, "transcripts");
  mkdirSync(transcriptsDir);
  writeFileSync(join(transcriptsDir, "sess-1.jsonl"), TRANSCRIPT, "utf8");
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "run-log.jsonl"), CYCLES_LOG.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { root, transcriptsDir };
}

describe("deriveStage4Adjusts (IO) — grava no run-log o que report-stage4-timing lê", () => {
  const row = { start: "2026-11-26T09:00:00.000Z", gate_at: "2026-11-26T09:59:00.000Z", end: "2026-11-26T10:05:00.000Z" };

  it("grava 1 evento com withinTarget10s; re-rodar não duplica; o relatório lê como ajuste", () => {
    const { root, transcriptsDir } = setup();
    try {
      const args = { transcriptsDir, sessionId: "sess-1", editionId: EDITION, row, rootDir: root, dryRun: false };
      assert.deepEqual(deriveStage4Adjusts(args), { derived: 1, logged: 1 });
      assert.deepEqual(deriveStage4Adjusts(args), { derived: 1, logged: 0 });
      const lines = readFileSync(join(root, "data", "run-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const ev = lines.filter((l) => l.agent === "capture-stage-usage");
      assert.equal(ev.length, 1);
      assert.equal(ev[0].details.withinTarget10s, true);
      assert.equal(ev[0].details.source, "derived-transcript");
      // Nenhum texto de conversa vai pro log.
      assert.ok(!JSON.stringify(ev[0]).includes("troca o título"));
      const report = buildStage4TimingReport(lines, EDITION);
      assert.equal(report.adjusts.length, 1);
      assert.equal(report.adjusts[0].requestToEditMs, 5000);
      assert.equal(report.adjusts[0].toolCalls, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run deriva sem gravar; sessão sem transcript devolve error, nunca lança", () => {
    const { root, transcriptsDir } = setup();
    try {
      assert.deepEqual(deriveStage4Adjusts({ transcriptsDir, sessionId: "sess-1", editionId: EDITION, row, rootDir: root, dryRun: true }), {
        derived: 1,
        logged: 0,
      });
      const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
      assert.ok(!log.includes("capture-stage-usage"));
      const missing = deriveStage4Adjusts({ transcriptsDir, sessionId: "nope", editionId: EDITION, row, rootDir: root, dryRun: false });
      assert.equal(missing.error, "session_file_not_found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI capture-stage-usage --stage 4 arma a derivação (é o passo que o playbook já roda)", () => {
    const { root, transcriptsDir } = setup();
    try {
      const editionDir = join(root, EDITION);
      mkdirSync(editionDir);
      let doc = makeInitialDoc(EDITION, "2026-11-26T08:00:00.000Z");
      doc = applyUpdate(doc, { stage: 4, status: "done", ...row }, "2026-11-26T10:05:00.000Z");
      saveDoc(editionDir, doc);
      const projectRoot = join(import.meta.dirname, "..");
      const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-1" };
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(projectRoot, "scripts", "capture-stage-usage.ts"), "--edition-dir", editionDir, "--stage", "4", "--transcripts-dir", transcriptsDir, "--root-dir", root],
        { cwd: projectRoot, encoding: "utf8", env },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.stage4_adjusts, { derived: 1, logged: 1 });
      assert.equal(out.turn_stats.num_turns, 4);
      assert.ok(existsSync(join(root, "data", "run-log.jsonl")));
      assert.ok(readFileSync(join(root, "data", "run-log.jsonl"), "utf8").includes('"withinTarget10s":true'));
      const saved = JSON.parse(readFileSync(join(editionDir, "_internal", "stage-status.json"), "utf8"));
      const s4 = saved.rows.find((x: { stage: number }) => x.stage === 4);
      assert.equal(s4.turn_stats.num_turns, 4);
      assert.deepEqual(Object.keys(s4.model_usage), ["opus-5-5"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
