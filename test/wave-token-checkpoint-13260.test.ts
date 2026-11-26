/**
 * #13260 — o checkpoint de token do coordenador overnight não depende mais de
 * o coordenador lembrar: `record-overnight-wave.ts` grava o
 * `coordinator_tokens_estimate` da onda junto com a onda (rodada 261115f saiu
 * só com a estimativa da Fase 2).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { waveCheckpointTarget } from "../scripts/record-overnight-wave.ts";
import { checkOvernightTokenInstrumentation } from "../scripts/check-overnight-token-instrumentation.ts";

const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "wave-tok-13260-"));
  roots.push(d);
  return d;
};

describe("#13260 waveCheckpointTarget (puro)", () => {
  it("plano da rodada real: edição = pasta da rodada, run-log da raiz, fase da onda", () => {
    const t = waveCheckpointTarget("/r/data/overnight/261116b/plan.json", { session_id: "plan-sess" }, 3, {});
    // `resolve` porque a função resolve o caminho do plano: no Windows "/r" vira "C:\r" (#13738).
    assert.deepEqual(t, { ok: true, rootDir: resolve("/r"), edition: "261116b", phase: "onda w3", sessionId: "plan-sess" });
  });

  it("sessão do ambiente vence a do plano (é a dona do transcript)", () => {
    const t = waveCheckpointTarget("/r/data/overnight/261116/plan.json", { session_id: "plan-sess" }, 1, { CLAUDE_CODE_SESSION_ID: "env-sess" });
    assert.equal(t.ok && t.sessionId, "env-sess");
  });

  it("plano fora de data/overnight/{rodada}/ não grava (teste, cópia em /tmp)", () => {
    assert.equal(waveCheckpointTarget("/tmp/x/plan.json", {}, 1, {}).ok, false);
    assert.equal(waveCheckpointTarget("/r/data/develop/261116/plan.json", {}, 1, {}).ok, false);
    assert.equal(waveCheckpointTarget("/r/data/overnight/261116/outro.json", {}, 1, {}).ok, false);
  });
});

describe("#13260 CLI: a onda grava o checkpoint como efeito colateral", () => {
  const run = (plan: string, units: string, cwd: string) =>
    spawnSync(process.execPath, [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), resolve(ROOT, "scripts/record-overnight-wave.ts"), "--plan", plan, "--units", units], {
      cwd,
      encoding: "utf8",
      // HOME isolado: sem transcript, o evento sai `tokens: null` com reason — nunca lê a sessão real.
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, CLAUDE_CODE_SESSION_ID: "sess-13260" },
    });

  it("cada onda nova grava 1 evento; onda repetida (no-op) não grava; a checagem da Fase 2 o enxerga", () => {
    const root = tmp();
    const round = join(root, "data", "overnight", "261116z");
    mkdirSync(round, { recursive: true });
    const plan = join(round, "plan.json");
    writeFileSync(plan, JSON.stringify({ session_id: "sess-13260", issues: [] }));
    const r1 = run(plan, "1;2", root);
    assert.equal(r1.status, 0, r1.stderr);
    run(plan, "1;2", root); // mesma onda: dedup, sem checkpoint novo
    const r2 = run(plan, "3", root);
    assert.equal(r2.status, 0, r2.stderr);
    const events = readFileSync(join(root, "data", "run-log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.message === "coordinator_tokens_estimate");
    assert.deepEqual(events.map((e) => [e.edition, e.agent, e.details.phase, e.details.session_id]), [
      ["261116z", "overnight", "onda w1", "sess-13260"],
      ["261116z", "overnight", "onda w2", "sess-13260"],
    ]);
    assert.equal(events[0].details.tokens, null);
    assert.ok(events[0].details.reason, "sem transcript, a lacuna sai com reason");
    const check = checkOvernightTokenInstrumentation("261116z", root, { sessionId: "sess-13260" });
    assert.equal(check.counts.coordinator_tokens_estimate, 2);
  });

  it("plano fora da rodada real: onda gravada, nenhum run-log criado", () => {
    const root = tmp();
    const plan = join(root, "plan.json");
    writeFileSync(plan, JSON.stringify({ issues: [] }));
    const r = run(plan, "1", root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /checkpoint de token não gravado/);
    assert.equal(existsSync(join(root, "data", "run-log.jsonl")), false);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves.length, 1);
  });
});
