/**
 * test/studio-state.test.ts (#3555) — cobertura de scripts/studio-ui/studio-state.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStudioState,
  currentStageFromDoc,
  findLatestPlanPath,
  listEditionSummaries,
  pickCurrentEdition,
  stageLabelFor,
  summarizePlan,
  type StudioEditionSummary,
} from "../scripts/studio-ui/studio-state.ts";
import { saveDoc, makeInitialDoc, applyUpdate } from "../scripts/update-stage-status.ts";
import { runChatTurn, type QueryFn } from "../scripts/studio-ui/studio-chat.ts";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function setupRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "studio-state-"));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeEditionFiles(root: string, aammdd: string, files: string[]): void {
  for (const f of files) {
    const full = join(root, "data", "editions", aammdd, f);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
  }
}

describe("stageLabelFor (#3555)", () => {
  it("mapeia stage numérico para o label canônico", () => {
    assert.equal(stageLabelFor(1), "Pesquisa");
    assert.equal(stageLabelFor(4), "Revisão");
  });
  it("'done' e 'unknown' têm labels dedicados", () => {
    assert.equal(stageLabelFor("done"), "Concluída");
    assert.equal(stageLabelFor("unknown"), "Desconhecido");
  });
});

describe("currentStageFromDoc (#3555)", () => {
  it("retorna o primeiro stage 1-6 não-done", () => {
    const doc = makeInitialDoc("260716");
    const updated = applyUpdate(doc, { stage: 1, status: "done" });
    assert.equal(currentStageFromDoc(updated), 2);
  });
  it("retorna 'done' quando todos os stages 1-6 estão done", () => {
    let doc = makeInitialDoc("260716");
    for (let s = 1; s <= 6; s++) doc = applyUpdate(doc, { stage: s, status: "done" });
    assert.equal(currentStageFromDoc(doc), "done");
  });
  it("retorna 'unknown' quando não há linhas 1-6", () => {
    assert.equal(currentStageFromDoc({ edition: "x", rows: [], generated_at: "" }), "unknown");
  });
});

describe("listEditionSummaries (#3555)", () => {
  it("edição sem stage-status.json vira hasStageStatus=false, currentStage='unknown'", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["01-categorized.md"]);
      const summaries = listEditionSummaries(root);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].edition, "260716");
      assert.equal(summaries[0].hasStageStatus, false);
      assert.equal(summaries[0].currentStage, "unknown");
    } finally {
      cleanup();
    }
  });

  it("edição com stage-status.json resolve currentStage a partir do doc", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["_internal/01-approved.json"]);
      const editionDir = join(root, "data", "editions", "260716");
      let doc = makeInitialDoc("260716");
      doc = applyUpdate(doc, { stage: 1, status: "done" });
      saveDoc(editionDir, doc);

      const summaries = listEditionSummaries(root);
      assert.equal(summaries[0].hasStageStatus, true);
      assert.equal(summaries[0].currentStage, 2);
      assert.equal(summaries[0].stageLabel, "Escrita");
    } finally {
      cleanup();
    }
  });

  it("marca gatesPending [4] quando stage 4 tem prereqs prontos e output ausente", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["02-reviewed.md", "03-social.md"]);
      const summaries = listEditionSummaries(root);
      assert.deepEqual(summaries[0].gatesPending, [4]);
    } finally {
      cleanup();
    }
  });

  it("ordena mais recente primeiro e respeita `limit`", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260701", ["01-categorized.md"]);
      makeEditionFiles(root, "260716", ["01-categorized.md"]);
      makeEditionFiles(root, "260705", ["01-categorized.md"]);
      const summaries = listEditionSummaries(root, { limit: 2 });
      assert.deepEqual(
        summaries.map((s) => s.edition),
        ["260716", "260705"],
      );
    } finally {
      cleanup();
    }
  });
});

describe("pickCurrentEdition (#3555)", () => {
  const base: Omit<StudioEditionSummary, "edition" | "gatesPending" | "currentStage"> = {
    editionDir: "d",
    stageLabel: "x",
    hasStageStatus: true,
  };

  it("prioriza edição com gate pendente", () => {
    const editions: StudioEditionSummary[] = [
      { ...base, edition: "260715", currentStage: 3, gatesPending: [] },
      { ...base, edition: "260714", currentStage: 4, gatesPending: [4] },
    ];
    assert.equal(pickCurrentEdition(editions), "260714");
  });

  it("sem gate, escolhe a mais recente não-done", () => {
    const editions: StudioEditionSummary[] = [
      { ...base, edition: "260716", currentStage: "done", gatesPending: [] },
      { ...base, edition: "260715", currentStage: 2, gatesPending: [] },
    ];
    assert.equal(pickCurrentEdition(editions), "260715");
  });

  it("todas done: escolhe a mais recente (primeira da lista)", () => {
    const editions: StudioEditionSummary[] = [
      { ...base, edition: "260716", currentStage: "done", gatesPending: [] },
      { ...base, edition: "260715", currentStage: "done", gatesPending: [] },
    ];
    assert.equal(pickCurrentEdition(editions), "260716");
  });

  it("lista vazia: null", () => {
    assert.equal(pickCurrentEdition([]), null);
  });
});

describe("findLatestPlanPath (#3555)", () => {
  it("null quando data/overnight não existe", () => {
    const { root, cleanup } = setupRoot();
    try {
      assert.equal(findLatestPlanPath(root, "overnight"), null);
    } finally {
      cleanup();
    }
  });

  it("acha o plan.json da sessão mais recente por AAMMDD", () => {
    const { root, cleanup } = setupRoot();
    try {
      mkdirSync(join(root, "data", "overnight", "260710"), { recursive: true });
      writeFileSync(join(root, "data", "overnight", "260710", "plan.json"), "{}");
      mkdirSync(join(root, "data", "overnight", "260715"), { recursive: true });
      writeFileSync(join(root, "data", "overnight", "260715", "plan.json"), "{}");
      const found = findLatestPlanPath(root, "overnight");
      assert.ok(found?.includes("260715"));
    } finally {
      cleanup();
    }
  });

  it("pula sessões sem plan.json escrito ainda", () => {
    const { root, cleanup } = setupRoot();
    try {
      mkdirSync(join(root, "data", "overnight", "260715"), { recursive: true }); // sem plan.json
      mkdirSync(join(root, "data", "overnight", "260710"), { recursive: true });
      writeFileSync(join(root, "data", "overnight", "260710", "plan.json"), "{}");
      const found = findLatestPlanPath(root, "overnight");
      assert.ok(found?.includes("260710"));
    } finally {
      cleanup();
    }
  });
});

describe("summarizePlan (#3555)", () => {
  it("resume issues por status", () => {
    const { root, cleanup } = setupRoot();
    try {
      const planPath = join(root, "data", "overnight", "260710", "plan.json");
      mkdirSync(join(planPath, ".."), { recursive: true });
      writeFileSync(
        planPath,
        JSON.stringify({
          started_at: "2026-07-10T01:00:00Z",
          issues: [{ status: "merged" }, { status: "merged" }, { status: "pulada" }],
        }),
      );
      const summary = summarizePlan(root, planPath);
      assert.ok(summary);
      assert.equal(summary!.sessionId, "260710");
      assert.equal(summary!.totalIssues, 3);
      assert.deepEqual(summary!.counts, { merged: 2, pulada: 1 });
      assert.equal(summary!.startedAt, "2026-07-10T01:00:00Z");
    } finally {
      cleanup();
    }
  });

  it("JSON corrompido retorna null, nunca lança (fail-soft)", () => {
    const { root, cleanup } = setupRoot();
    try {
      const planPath = join(root, "data", "overnight", "260710", "plan.json");
      mkdirSync(join(planPath, ".."), { recursive: true });
      writeFileSync(planPath, "{ not json");
      assert.equal(summarizePlan(root, planPath), null);
    } finally {
      cleanup();
    }
  });
});

describe("buildStudioState (#3555)", () => {
  it("monta o snapshot completo sem lançar quando não há dados", () => {
    const { root, cleanup } = setupRoot();
    try {
      const state = buildStudioState(root);
      assert.equal(state.currentEdition, null);
      assert.deepEqual(state.editions, []);
      assert.deepEqual(state.gatesPending, []);
      assert.equal(state.overnight, null);
      assert.equal(state.develop, null);
      assert.deepEqual(state.chatPermissionsPending, []);
      assert.ok(state.generatedAt);
    } finally {
      cleanup();
    }
  });

  it("chatPermissionsPending (#3557): reflete um gate AskUserQuestion aberto pelo chat drawer", async () => {
    const { root, cleanup } = setupRoot();
    try {
      assert.deepEqual(buildStudioState(root).chatPermissionsPending, []);

      const fakeQuery: QueryFn = (params) => {
        async function* gen() {
          const canUseTool = params.options?.canUseTool as CanUseTool;
          // nunca resolvido nesta rodada — só precisamos que o gate FIQUE
          // pendente pra observar `buildStudioState` enquanto isso.
          void canUseTool(
            "AskUserQuestion",
            {
              questions: [
                {
                  question: "Qual rumo?",
                  header: "Rumo",
                  multiSelect: false,
                  options: [
                    { label: "A", description: "a" },
                    { label: "B", description: "b" },
                  ],
                },
              ],
            },
            { signal: new AbortController().signal, toolUseID: "tu-state-1", requestId: "req-1" },
          );
          // o `finally` de runChatTurn só varre gates AINDA sem resposta —
          // pra observar o estado pendente de fora, o turno precisa continuar
          // "vivo" (sem terminar) enquanto o teste consulta buildStudioState.
          await new Promise(() => {}); // nunca resolve — mantém o turno em aberto de propósito.
          yield { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s1" } as unknown as SDKMessage;
        }
        return gen() as unknown as ReturnType<QueryFn>;
      };

      // dispara sem aguardar — o turno fica pendurado de propósito (ver
      // comentário acima), então não faz sentido (nem é seguro) dar `await`.
      void runChatTurn({ message: "oi", cwd: root, queryFn: fakeQuery, onEvent: () => {} });
      await new Promise((r) => setImmediate(r));

      const state = buildStudioState(root);
      assert.equal(state.chatPermissionsPending.length, 1);
      assert.equal(state.chatPermissionsPending[0].toolUseId, "tu-state-1");
      assert.equal(state.chatPermissionsPending[0].firstQuestion, "Qual rumo?");
    } finally {
      cleanup();
    }
  });

  it("agrega gatesPending de múltiplas edições", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260710", ["02-reviewed.md", "03-social.md"]); // gate 4
      makeEditionFiles(root, "260711", [
        "_internal/.step-5-done.json", // gate 6 prereq
      ]);
      const state = buildStudioState(root);
      assert.deepEqual(
        state.gatesPending.sort((a, b) => a.edition.localeCompare(b.edition)),
        [
          { edition: "260710", stage: 4 },
          { edition: "260711", stage: 6 },
        ],
      );
    } finally {
      cleanup();
    }
  });

  it("usa now() injetado", () => {
    const { root, cleanup } = setupRoot();
    try {
      const fixed = new Date("2026-07-16T12:00:00.000Z");
      const state = buildStudioState(root, { now: () => fixed });
      assert.equal(state.generatedAt, "2026-07-16T12:00:00.000Z");
    } finally {
      cleanup();
    }
  });
});
