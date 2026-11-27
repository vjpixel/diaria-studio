/**
 * #14115 item 4 — fases do `/diaria-video-roteiro` e do `/diaria-video-montagem`
 * no `publica-phase.ts`. Antes só o `/diaria-publica` gravava fases, e o tempo
 * do roteiro e da montagem só saía do transcript. As fases novas vão no mesmo
 * arquivo da edição, sempre `--part sessao`, e o `join`/`report` de cada
 * fluxo não vê os outros (uma fase do roteiro aberta não segura o join do
 * publica nem a Etapa 5).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE_META,
  PUBLICA_PHASES,
  buildPhaseEvent,
  checkPhaseStart,
  joinCheck,
  phaseFlow,
  parsePhaseEvents,
  phaseReport,
  videoPartMainThreadIntervals,
  type PhaseEvent,
  type PhaseEventKind,
} from "../scripts/lib/diaria/publica-phases.ts";
import { checkExternalEffect } from "../scripts/lib/diaria/publica-effect-gate.ts";
import { main as phaseMain, type PhaseCliDeps } from "../scripts/publica-phase.ts";

const ROOT = join(import.meta.dirname, "..");
const ED = "261127";
const T0 = new Date("2026-11-27T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ev = (phase: string, part: string, event: PhaseEventKind, min: number, extra: { taskId?: string; background?: boolean } = {}): PhaseEvent =>
  buildPhaseEvent({ edition: ED, phase, part, event, at: at(min), attempt: 1, sessionId: "S1", ...extra });

describe("#14115 fases do roteiro e da montagem", () => {
  it("toda fase roteiro-*/montagem-* é do fluxo certo, reversível e sem recurso", () => {
    const video = PUBLICA_PHASES.filter((p) => p.startsWith("roteiro-") || p.startsWith("montagem-"));
    assert.equal(video.filter((p) => p.startsWith("roteiro-")).length, 7);
    assert.equal(video.filter((p) => p.startsWith("montagem-")).length, 9);
    for (const p of video) {
      assert.equal(phaseFlow(p), p.startsWith("roteiro-") ? "roteiro" : "montagem", p);
      assert.equal(PHASE_META[p].effect, "reversible", p);
      assert.deepEqual(PHASE_META[p].resources, [], p);
      assert.equal(PHASE_META[p].stage, null, p);
      assert.equal(checkExternalEffect({ phase: p, part: "sessao", store: null, currentPlanSha256: null, host: "h" }).ok, true, p);
    }
    for (const p of PUBLICA_PHASES.filter((x) => !video.includes(x))) assert.equal(phaseFlow(p), "publica", p);
  });

  it("prefixo do nome ⇔ fluxo, para toda fase", () => {
    for (const p of PUBLICA_PHASES) {
      const expected = p.startsWith("roteiro-") ? "roteiro" : p.startsWith("montagem-") ? "montagem" : "publica";
      assert.equal(phaseFlow(p), expected, p);
      assert.equal(PHASE_META[p].flow, expected, p);
    }
  });

  it("fase do roteiro/montagem só com --part sessao e sem recurso extra", () => {
    assert.throws(() => ev("montagem-build", "vertical", "start", 0), /só com --part sessao/);
    assert.throws(() => ev("roteiro-escrita", "horizontal", "start", 0), /só com --part sessao/);
    assert.throws(
      () => buildPhaseEvent({ edition: ED, phase: "roteiro-escrita", part: "sessao", event: "start", at: T0, attempt: 1, extraResources: ["chrome"] }),
      /não segura recurso/,
    );
    assert.equal(ev("montagem-build", "sessao", "start", 0).phase, "montagem-build");
  });

  it("parse: fase do roteiro com parte de vídeo e fase desconhecida viram problema (nunca somem)", () => {
    const good = JSON.stringify(ev("roteiro-escrita", "sessao", "start", 0));
    const badPart = good.replace('"part":"sessao"', '"part":"horizontal"');
    const unknown = good.replace("roteiro-escrita", "roteiro-futura");
    const r = parsePhaseEvents([good, badPart, unknown].join("\n"));
    assert.equal(r.events.length, 1);
    assert.match(r.problems[0], /só com --part sessao/);
    assert.match(r.problems[1], /desconhecida .*sync-code/);
  });

  it("fase da montagem aberta não bloqueia a Etapa 5 nem entra na janela do vídeo", () => {
    const events = [ev("montagem-gate2", "sessao", "start", 0)];
    assert.deepEqual(checkPhaseStart({ events, candidate: ev("stage5", "sessao", "start", 5) }), []);
    assert.deepEqual(videoPartMainThreadIntervals(events, "S1", at(60).getTime()), []);
  });

  it("join: o do publica ignora a fase do roteiro aberta; o do roteiro acusa", () => {
    const events = [ev("roteiro-iteracao", "sessao", "start", 0), ev("fetch", "horizontal", "start", 1), ev("fetch", "horizontal", "end", 2)];
    assert.equal(joinCheck(events, { step5: false, step6: false }).ok, true);
    const r = joinCheck(events, { step5: false, step6: false }, {}, "roteiro");
    assert.equal(r.ok, false);
    assert.match(r.problems.join(), /roteiro-iteracao\/sessao/);
  });

  it("report por fluxo: indisponíveis só do fluxo pedido; espera separada da execução", () => {
    const events = [
      ev("montagem-transcricao", "sessao", "start", 0),
      ev("montagem-transcricao", "sessao", "end", 10),
      ev("montagem-gate2", "sessao", "start", 10),
      ev("montagem-gate2", "sessao", "end", 25),
      ev("fetch", "horizontal", "start", 30),
      ev("fetch", "horizontal", "end", 31),
    ];
    const m = phaseReport(ED, events, {}, "montagem");
    assert.deepEqual(m.rows.map((r) => r.phase), ["montagem-transcricao", "montagem-gate2"]);
    assert.ok(m.unavailable.includes("montagem-build"));
    assert.ok(!m.unavailable.includes("upload"));
    assert.equal(m.active_ms, 10 * 60_000);
    assert.equal(m.wait_ms, 15 * 60_000);
    const p = phaseReport(ED, events);
    assert.deepEqual(p.rows.map((r) => r.phase), ["fetch"]);
    assert.ok(!p.unavailable.some((x) => x.startsWith("montagem-") || x.startsWith("roteiro-")));
  });
});

describe("#14115 CLI: start/end/join/report com --flow", () => {
  let dir: string;
  let out: string[];
  let errs: string[];
  let clock: Date;
  const deps = (): PhaseCliDeps => ({
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    now: () => clock,
    env: { CLAUDE_CODE_SESSION_ID: "S1" },
    host: "h",
    pid: 4242,
    isPidAlive: () => true,
    runLog: () => {},
    videoGate: () => ({ status: "ok", blocking: false, warning: null }),
    spawnCommand: async () => ({ code: 0, signal: null }),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "publica-14115-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    out = [];
    errs = [];
    clock = T0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("o passo do roteiro grava início e fim, e o join do roteiro fecha", async () => {
    assert.equal(await phaseMain(["start", ED, "--phase", "roteiro-escrita", "--part", "sessao", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--flow", "roteiro", "--edition-dir", dir], deps()), 1);
    clock = at(20);
    assert.equal(await phaseMain(["end", ED, "--phase", "roteiro-escrita", "--part", "sessao", "--edition-dir", dir], deps()), 0);
    out = [];
    assert.equal(await phaseMain(["join", ED, "--flow", "roteiro", "--edition-dir", dir], deps()), 0);
    assert.equal(JSON.parse(out[0]).flow, "roteiro");
    out = [];
    assert.equal(await phaseMain(["report", ED, "--flow", "roteiro", "--edition-dir", dir], deps()), 0);
    const rep = JSON.parse(out[0]);
    assert.equal(rep.flow, "roteiro");
    assert.equal(rep.rows[0].duration_ms, 20 * 60_000);
    assert.match(readFileSync(join(dir, "_internal", "publica-phases.jsonl"), "utf8"), /roteiro-escrita/);
  });

  it("join sem --flow (o do publica) ignora a fase do roteiro aberta", async () => {
    assert.equal(await phaseMain(["start", ED, "--phase", "roteiro-iteracao", "--part", "sessao", "--edition-dir", dir], deps()), 0);
    assert.equal(await phaseMain(["join", ED, "--edition-dir", dir], deps()), 0, errs.join("\n"));
  });

  it("parte de vídeo numa fase da montagem e --flow inválido são erro de uso", async () => {
    assert.equal(await phaseMain(["start", ED, "--phase", "montagem-build", "--part", "vertical", "--edition-dir", dir], deps()), 2);
    assert.equal(await phaseMain(["report", ED, "--flow", "video", "--edition-dir", dir], deps()), 2);
  });
});

describe("#14115 as skills de vídeo usam o publica-phase.ts", () => {
  for (const [skill, flow] of [
    ["diaria-video-roteiro", "roteiro"],
    ["diaria-video-montagem", "montagem"],
  ] as const) {
    const text = readFileSync(join(ROOT, ".claude", "skills", skill, "SKILL.md"), "utf8");
    it(`${skill}: start/end por fase, join e report do fluxo`, () => {
      assert.match(text, /npx tsx scripts\/publica-phase\.ts start \{AAMMDD\} --phase \{fase\} --part sessao/);
      assert.match(text, /npx tsx scripts\/publica-phase\.ts end \{AAMMDD\} --phase \{fase\} --part sessao/);
      assert.ok(text.includes(`join {AAMMDD} --flow ${flow}`));
      assert.ok(text.includes(`report {AAMMDD} --flow ${flow}`));
    });
    it(`${skill}: toda fase do fluxo aparece na tabela, e nenhuma fase da tabela é desconhecida`, () => {
      const section = text.split("## Telemetria por fase (#14115)")[1]?.split(/\n## /)[0] ?? "";
      const table = section.split("\n").filter((l) => l.startsWith("|")).join("\n");
      assert.ok(table, `tabela da seção Telemetria ausente em ${skill}`);
      const own = PUBLICA_PHASES.filter((p) => phaseFlow(p) === flow);
      for (const p of own) assert.ok(table.includes(`\`${p}\``), `${p} ausente da tabela de ${skill}`);
      const cited = [...table.matchAll(new RegExp(`\`(${flow}-[a-z0-9-]+)\``, "g"))].map((m) => m[1]);
      for (const c of cited) assert.ok((PUBLICA_PHASES as readonly string[]).includes(c), `${c} citado em ${skill} não existe`);
    });
  }
});
