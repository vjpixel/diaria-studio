/**
 * test/subagent-usage-metrics.test.ts (#10476)
 *
 * Regressão da rodada overnight 261018d: 16 subagentes despachados, 3 reviews
 * consolidados, e ZERO eventos `subagent_metrics`/`review_metrics` no run-log
 * — a emissão dependia de o coordenador rodar `log-event.ts` à mão. O script
 * `subagent-usage-metrics.ts` deriva os eventos dos transcripts locais dos
 * subagentes; estes testes travam (a) que uma sessão com subagentes produz os
 * eventos sem nenhuma emissão manual, (b) a classificação por `agentType`,
 * (c) a dedup por `message.id` e (d) a idempotência.
 *
 * Fixtures em tmpdir — nunca toca `~/.claude/projects/` real nem
 * `data/run-log.jsonl` de produção.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifySubagent,
  collectSubagentMetrics,
  extractRefs,
  planEvents,
  summarizeTranscript,
  FLEET_REVIEW_METRICS_MESSAGE,
  REVIEW_METRICS_MESSAGE,
  SUBAGENT_METRICS_MESSAGE,
  TOKEN_INSTRUMENTATION_EMPTY_MESSAGE,
  type SubagentRecord,
} from "../scripts/subagent-usage-metrics.ts";
import { encodeProjectDirName } from "../scripts/lib/session-transcript.ts";
import { logEvent } from "../scripts/lib/run-log.ts";
import {
  checkOvernightTokenInstrumentation,
  TOKEN_INSTRUMENTATION_EMPTY_MESSAGE as CHECK_EMPTY_MESSAGE,
} from "../scripts/check-overnight-token-instrumentation.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

function assistantLine(opts: {
  id: string;
  ts: string;
  input?: number;
  cacheRead?: number;
  output?: number;
  toolUseId?: string;
  stopReason?: string | null;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    isSidechain: true,
    message: {
      id: opts.id,
      model: "claude-opus-5-5",
      stop_reason: opts.stopReason ?? null,
      content: opts.toolUseId ? [{ type: "tool_use", id: opts.toolUseId, name: "Bash", input: {} }] : [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  });
}

/** Cria `{root}/.home/.claude/projects/{enc(root)}/{SESSION}.jsonl` + `subagents/`. */
function makeSession(root: string, subagents: { id: string; agentType: string; description: string; lines: string[] }[]): string {
  const home = join(root, ".home");
  const dir = join(home, ".claude", "projects", encodeProjectDirName(root));
  mkdirSync(join(dir, SESSION, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), assistantLine({ id: "coord", ts: "2026-10-18T17:00:00.000Z", input: 10 }) + "\n");
  for (const s of subagents) {
    writeFileSync(
      join(dir, SESSION, "subagents", `agent-${s.id}.meta.json`),
      JSON.stringify({ agentType: s.agentType, description: s.description }),
    );
    writeFileSync(join(dir, SESSION, "subagents", `agent-${s.id}.jsonl`), s.lines.join("\n") + "\n");
  }
  return home;
}

function readRunLog(root: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(root, "data", "run-log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function record(agentId: string, agentType: string, description: string, tokens: number | null, first = "2026-10-18T18:00:00.000Z"): SubagentRecord {
  return {
    agentId,
    meta: { agentType, description },
    summary: { tokens, toolUses: 1, firstTimestamp: first, lastTimestamp: first, finished: true },
  };
}

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

describe("classifySubagent (#10476)", () => {
  it("dev-implementador e dev-fixer viram subagent_metrics com o papel do agentType", () => {
    assert.deepEqual(classifySubagent({ agentType: "dev-implementador", description: "Implementar #10440" }), {
      message: SUBAGENT_METRICS_MESSAGE,
      papel: "dev-implementador",
    });
    assert.deepEqual(classifySubagent({ agentType: "dev-fixer", description: "Fixer PR #10445 findings" }), {
      message: SUBAGENT_METRICS_MESSAGE,
      papel: "dev-fixer",
    });
  });

  it("dev-fixer de CI vermelho vira papel ci-retry (#9875)", () => {
    assert.deepEqual(classifySubagent({ agentType: "dev-fixer", description: "Fix CI vermelho PR #10445" }), {
      message: SUBAGENT_METRICS_MESSAGE,
      papel: "ci-retry",
    });
  });

  it("revisor sem PR no description = review consolidado; com PR = fleet pré-merge", () => {
    assert.equal(
      classifySubagent({ agentType: "pr-review-toolkit:code-reviewer", description: "Review consolidado pós-rodada" }).message,
      REVIEW_METRICS_MESSAGE,
    );
    assert.equal(classifySubagent({ agentType: "dev-revisor", description: "Review 1.5b da mini-rodada" }).message, REVIEW_METRICS_MESSAGE);
    assert.equal(
      classifySubagent({ agentType: "pr-review-toolkit:silent-failure-hunter", description: "Review PR 10474" }).message,
      FLEET_REVIEW_METRICS_MESSAGE,
    );
  });
});

describe("review via fallback adhoc-opus-medium (#10547)", () => {
  it("adhoc-opus-medium com review no description é revisor; sem review segue subagent_metrics", () => {
    assert.equal(
      classifySubagent({ agentType: "adhoc-opus-medium", description: "Review consolidado pós-rodada" }).message,
      REVIEW_METRICS_MESSAGE,
    );
    assert.equal(
      classifySubagent({ agentType: "adhoc-opus-medium", description: "Revisão 1.5b da mini-rodada" }).message,
      REVIEW_METRICS_MESSAGE,
    );
    assert.equal(
      classifySubagent({ agentType: "adhoc-opus-medium", description: "Review PR #10474 (fleet fallback)" }).message,
      FLEET_REVIEW_METRICS_MESSAGE,
    );
    assert.deepEqual(classifySubagent({ agentType: "adhoc-opus-medium", description: "Ler thread da #10200" }), {
      message: SUBAGENT_METRICS_MESSAGE,
      papel: "adhoc-opus-medium",
    });
    // Só o fallback documentado — dev-implementador com "review" no description continua implementação.
    assert.equal(
      classifySubagent({ agentType: "dev-implementador", description: "Implementar #1 (review de prompt)" }).message,
      SUBAGENT_METRICS_MESSAGE,
    );
  });

  it("sessão sem plugin: review em adhoc-opus-medium emite review_metrics e não grava marcador no_reviewers", () => {
    const { events, markers } = planEvents(
      [
        record("i1", "dev-implementador", "Implementar #10", 1000),
        record("r1", "adhoc-opus-medium", "Review consolidado pós-rodada", 5000, "2026-10-18T19:00:00.000Z"),
      ],
      [],
      "261019",
      undefined,
      NOW,
    );
    const review = events.find((e) => e.message === REVIEW_METRICS_MESSAGE);
    assert.equal(review?.details.review_tokens, 5000);
    assert.equal(review?.details.depth, 0);
    assert.equal(
      events.some((e) => e.message === SUBAGENT_METRICS_MESSAGE && e.details.papel === "adhoc-opus-medium"),
      false,
    );
    assert.deepEqual(markers, []);
  });
});

describe("extractRefs (#10476)", () => {
  it("separa issue (#N) de PR (PR #N)", () => {
    assert.deepEqual(extractRefs("Implementar lote #10443 + #10442"), { issues: [10443, 10442], prs: [] });
    assert.deepEqual(extractRefs("Fixer PR #10445 findings"), { issues: [], prs: [10445] });
    assert.deepEqual(extractRefs("Review PR 10474 (#10468)"), { issues: [10468], prs: [10474] });
  });
});

describe("summarizeTranscript (#10476)", () => {
  it("deduplica usage por message.id (o harness repete o usage a cada bloco da resposta)", () => {
    const content = [
      assistantLine({ id: "m1", ts: "2026-10-18T18:00:00.000Z", input: 100, cacheRead: 1000, output: 10 }),
      assistantLine({ id: "m1", ts: "2026-10-18T18:00:01.000Z", input: 100, cacheRead: 1000, output: 10, toolUseId: "t1" }),
      assistantLine({ id: "m2", ts: "2026-10-18T18:05:00.000Z", input: 5, cacheRead: 2000, output: 20, toolUseId: "t2" }),
      "{ linha truncada",
    ].join("\n");
    const s = summarizeTranscript(content);
    assert.equal(s.tokens, 1110 + 2025);
    assert.equal(s.toolUses, 2);
    assert.equal(s.firstTimestamp, "2026-10-18T18:00:00.000Z");
    assert.equal(s.lastTimestamp, "2026-10-18T18:05:00.000Z");
  });

  it("sem usage → tokens null (nunca zero)", () => {
    const s = summarizeTranscript(JSON.stringify({ type: "user", timestamp: "2026-10-18T18:00:00.000Z" }));
    assert.equal(s.tokens, null);
  });
});

describe("planEvents — dedup e idempotência (#10476)", () => {
  it("pula subagente cujo agent_id já está no run-log (rodar 2× não duplica)", () => {
    const existing = [
      JSON.stringify({ edition: "261018d", message: "subagent_metrics", details: { agent_id: "a1", papel: "dev-implementador" } }),
    ];
    const { events, skipped } = planEvents(
      [record("a1", "dev-implementador", "Implementar #1", 10), record("a2", "dev-implementador", "Implementar #2", 20)],
      existing,
      "261018d",
    );
    assert.equal(skipped, 1);
    assert.deepEqual(events.map((e) => e.details.agent_id), ["a2"]);
  });

  it("evento manual (sem agent_id) de mesmo papel + issue suprime o do script", () => {
    const existing = [
      JSON.stringify({ edition: "261018d", message: "subagent_metrics", details: { unidade: "#1", issues: [1], papel: "dev-implementador", subagent_tokens: 5 } }),
      JSON.stringify({ edition: "261018d", message: "review_metrics", details: { depth: 0, review_tokens: 5 } }),
    ];
    const { events } = planEvents(
      [
        record("a1", "dev-implementador", "Implementar #1", 10, "2026-10-18T18:00:00.000Z"),
        record("r0", "pr-review-toolkit:code-reviewer", "Review consolidado", 30, "2026-10-18T19:00:00.000Z"),
        record("r1", "pr-review-toolkit:code-reviewer", "Review 1.5b", 40, "2026-10-18T20:00:00.000Z"),
      ],
      existing,
      "261018d",
    );
    assert.deepEqual(
      events.map((e) => [e.message, e.details.agent_id, e.details.depth ?? null]),
      [[REVIEW_METRICS_MESSAGE, "r1", 1]],
    );
  });

  it("--since descarta subagentes de antes da janela (continuo atravessa dias)", () => {
    const { events } = planEvents(
      [
        record("old", "dev-implementador", "Implementar #1", 10, "2026-10-17T18:00:00.000Z"),
        record("new", "dev-implementador", "Implementar #2", 10, "2026-10-18T18:00:00.000Z"),
      ],
      [],
      "261018",
      "2026-10-18T00:00:00.000Z",
    );
    assert.deepEqual(events.map((e) => e.details.agent_id), ["new"]);
  });

  it("transcript sem usage → evento com tokens null + source unavailable (nunca omitido)", () => {
    const { events } = planEvents([record("a1", "dev-implementador", "Implementar #1", null)], [], "261018d");
    assert.equal(events.length, 1);
    assert.equal(events[0].details.subagent_tokens, null);
    assert.equal(events[0].details.source, "unavailable");
    assert.equal(events[0].details.reason, "no_usage_entries");
  });
});

describe("collectSubagentMetrics — cenário real da 261018d (#10476)", () => {
  it("sessão com implementador + fixer + review gera os 3 tipos sem nenhuma emissão manual, e a checagem fecha OK", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-usage-metrics-"));
    const home = makeSession(root, [
      {
        id: "impl",
        agentType: "dev-implementador",
        description: "Implementar #10440 cluster Stage 1",
        lines: [
          assistantLine({ id: "m1", ts: "2026-10-18T17:51:50.000Z", input: 2, cacheRead: 85000, output: 100, toolUseId: "t1" }),
          assistantLine({ id: "m1", ts: "2026-10-18T17:51:51.000Z", input: 2, cacheRead: 85000, output: 100 }),
          assistantLine({ id: "m2", ts: "2026-10-18T17:59:37.000Z", input: 3, cacheRead: 90000, output: 200, toolUseId: "t2", stopReason: "end_turn" }),
        ],
      },
      {
        id: "fix",
        agentType: "dev-fixer",
        description: "Fixer PR #10445 findings",
        lines: [assistantLine({ id: "f1", ts: "2026-10-18T18:10:00.000Z", input: 1, cacheRead: 1000, output: 10, stopReason: "end_turn" })],
      },
      {
        id: "rev",
        agentType: "pr-review-toolkit:code-reviewer",
        description: "Review consolidado pós-rodada",
        lines: [assistantLine({ id: "r1", ts: "2026-10-18T19:00:00.000Z", input: 1, cacheRead: 5000, output: 50, stopReason: "end_turn" })],
      },
    ]);

    // Antes: nenhum evento — o estado exato da 261018d.
    assert.equal(checkOvernightTokenInstrumentation("261018d", root).counts.subagent_metrics, 0);

    const outcome = collectSubagentMetrics({ edition: "261018d", sessionId: SESSION, rootDir: root, homeDir: home, nowMs: NOW });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.subagents, 3);
    assert.equal(outcome.inFlight, 0);
    assert.deepEqual(outcome.markers, []);
    assert.equal(outcome.events.some((e) => "finished" in e.details), false);
    const byAgent = Object.fromEntries(outcome.events.map((e) => [e.details.agent_id, e]));
    assert.equal(byAgent.impl.message, SUBAGENT_METRICS_MESSAGE);
    assert.equal(byAgent.impl.details.papel, "dev-implementador");
    assert.deepEqual(byAgent.impl.details.issues, [10440]);
    assert.equal(byAgent.impl.details.subagent_tokens, 85102 + 90203);
    assert.equal(byAgent.impl.details.tool_uses, 2);
    assert.equal(byAgent.impl.details.duration_ms, 467000);
    assert.equal(byAgent.impl.details.source, "subagent_transcript");
    assert.equal(byAgent.fix.details.papel, "dev-fixer");
    assert.equal(byAgent.fix.details.unidade, "PR #10445");
    assert.equal(byAgent.rev.message, REVIEW_METRICS_MESSAGE);
    assert.equal(byAgent.rev.details.depth, 0);

    // Grava como o CLI faz; a checagem da Fase 2 passa a ver os dois tipos e
    // uma 2ª execução não duplica nada.
    for (const ev of outcome.events) {
      logEvent({ edition: "261018d", stage: null, agent: "overnight", level: "info", message: ev.message, details: ev.details }, root);
    }
    const check = checkOvernightTokenInstrumentation("261018d", root);
    assert.equal(check.counts.subagent_metrics, 2);
    assert.equal(check.counts.review_metrics, 1);
    const again = collectSubagentMetrics({ edition: "261018d", sessionId: SESSION, rootDir: root, homeDir: home });
    assert.equal(again.status === "ok" ? again.events.length : -1, 0);
    assert.equal(readRunLog(root).length, 3);
  });

  it("sem session id → unavailable (nada a gravar), nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-usage-metrics-"));
    assert.deepEqual(collectSubagentMetrics({ edition: "x", sessionId: null, rootDir: root }), {
      status: "unavailable",
      reason: "no_session_id",
    });
  });

  it("sessão sem transcript nenhum → unavailable session_transcript_not_found (nada a afirmar)", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-usage-metrics-"));
    const home = join(root, ".home");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    assert.deepEqual(collectSubagentMetrics({ edition: "x", sessionId: SESSION, rootDir: root, homeDir: home }), {
      status: "unavailable",
      reason: "session_transcript_not_found",
    });
    assert.deepEqual(readRunLog(root), []);
  });

  // #10483 finding 5: rodada sem nenhum dispatch não pode virar "coordenador esqueceu".
  it("sessão com transcript e sem subagents/ → marcadores vazios, e a checagem não acusa esquecimento", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-usage-metrics-"));
    const home = join(root, ".home");
    const dir = join(home, ".claude", "projects", encodeProjectDirName(root));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION}.jsonl`), "\n");
    const outcome = collectSubagentMetrics({ edition: "261019", sessionId: SESSION, rootDir: root, homeDir: home, nowMs: NOW });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.deepEqual(outcome.events, []);
    assert.deepEqual(
      outcome.markers.map((m) => [m.message, m.details.tipo, m.details.reason]),
      [
        [TOKEN_INSTRUMENTATION_EMPTY_MESSAGE, SUBAGENT_METRICS_MESSAGE, "no_subagents"],
        [TOKEN_INSTRUMENTATION_EMPTY_MESSAGE, REVIEW_METRICS_MESSAGE, "no_reviewers"],
      ],
    );
    for (const ev of outcome.markers) {
      logEvent({ edition: "261019", stage: null, agent: "overnight", level: "info", message: ev.message, details: ev.details }, root);
    }
    logEvent(
      { edition: "261019", stage: null, agent: "overnight", level: "info", message: "coordinator_tokens_estimate", details: {} },
      root,
    );
    const check = checkOvernightTokenInstrumentation("261019", root);
    assert.equal(check.verdict.status, "ok");
    assert.doesNotMatch(check.section, /esqueceu/);
    assert.match(check.section, /Sem subagente despachado/);
    // Idempotente: rodar de novo não regrava o marcador.
    const again = collectSubagentMetrics({ edition: "261019", sessionId: SESSION, rootDir: root, homeDir: home, nowMs: NOW });
    assert.deepEqual(again.status === "ok" ? again.markers : null, []);
  });

  it("marcador do checador e do script usam o mesmo literal", () => {
    assert.equal(CHECK_EMPTY_MESSAGE, TOKEN_INSTRUMENTATION_EMPTY_MESSAGE);
  });
});

describe("subagente em voo (#10483 finding 1)", () => {
  it("summarizeTranscript: end_turn final = terminado; tool_use final ou user depois do end_turn = em voo", () => {
    const done = [
      assistantLine({ id: "a", ts: "2026-10-19T10:00:00.000Z", toolUseId: "t1", stopReason: "tool_use" }),
      JSON.stringify({ type: "user", timestamp: "2026-10-19T10:00:01.000Z" }),
      assistantLine({ id: "b", ts: "2026-10-19T10:00:02.000Z", stopReason: "end_turn" }),
    ];
    assert.equal(summarizeTranscript(done.join("\n")).finished, true);
    assert.equal(
      summarizeTranscript([...done.slice(0, 1), JSON.stringify({ type: "user", timestamp: "2026-10-19T10:00:01.000Z" })].join("\n")).finished,
      false,
    );
    // Retomado por SendMessage depois de terminar: volta a estar em voo.
    const resumed = [...done, JSON.stringify({ type: "user", timestamp: "2026-10-19T11:00:00.000Z" })];
    assert.equal(summarizeTranscript(resumed.join("\n")).finished, false);
  });

  it("planEvents pula o em voo recente (sem marcador do tipo) e emite o morto com finished:false", () => {
    const live = { ...record("live", "dev-implementador", "Implementar #1", 10, "2026-10-19T11:50:00.000Z") };
    live.summary = { ...live.summary, finished: false };
    const dead = { ...record("dead", "dev-implementador", "Implementar #2", 20, "2026-10-19T09:00:00.000Z") };
    dead.summary = { ...dead.summary, finished: false };
    const { events, inFlight, markers } = planEvents([live, dead], [], "261019", undefined, NOW);
    assert.equal(inFlight, 1);
    assert.deepEqual(events.map((e) => [e.details.agent_id, e.details.finished]), [["dead", false]]);
    // Implementador existe (mesmo em voo) → só o marcador de review vazio.
    assert.deepEqual(markers.map((m) => m.details.tipo), [REVIEW_METRICS_MESSAGE]);
  });

  it("evento já gravado do tipo na edição suprime o marcador", () => {
    const existing = [JSON.stringify({ edition: "261019", message: "review_metrics", details: { depth: 0 } })];
    const { markers } = planEvents([record("a", "dev-implementador", "Implementar #1", 1)], existing, "261019", undefined, NOW);
    assert.deepEqual(markers, []);
  });

  it("#11164: grava session_id em eventos e marcadores; review de OUTRA sessão não suprime o marcador desta", () => {
    const existing = [
      JSON.stringify({ edition: "261025", message: "review_metrics", details: { depth: 0, session_id: "sessao-300" } }),
    ];
    const { events, markers } = planEvents(
      [record("z1", "dev-implementador", "Implementar #1", 5)],
      existing,
      "261025",
      undefined,
      NOW,
      "sessao-zenbook",
    );
    assert.deepEqual(events.map((e) => e.details.session_id), ["sessao-zenbook"]);
    assert.deepEqual(markers.map((m) => [m.details.tipo, m.details.session_id]), [
      [REVIEW_METRICS_MESSAGE, "sessao-zenbook"],
    ]);
    // Mesma sessão (ou evento legado sem session_id) continua suprimindo.
    const same = planEvents([record("z2", "dev-implementador", "Implementar #2", 5)], existing, "261025", undefined, NOW, "sessao-300");
    assert.deepEqual(same.markers, []);
  });
});
