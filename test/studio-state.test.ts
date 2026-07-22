/**
 * test/studio-state.test.ts (#3555) — cobertura de scripts/studio-ui/studio-state.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStudioState,
  currentStageFromDoc,
  findLatestPlanPath,
  isEditionPublishedOrScheduled,
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

  it("#3802: stage 3 órfão em 'running' + 4-6 done, mas 05-published.json publicado → 'done', não 3", () => {
    const { root, cleanup } = setupRoot();
    try {
      const aammdd = "260703";
      makeEditionFiles(root, aammdd, [
        "_internal/05-published.json",
        "04-d1-1x1.jpg", // evidência adicional de que a edição seguiu adiante
      ]);
      const editionDir = join(root, "data", "editions", aammdd);
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({
          status: "published",
          scheduled_at: "2026-07-03T06:00:00Z",
          published_at: "2026-07-03T06:00:00Z",
        }),
      );

      let doc = makeInitialDoc(aammdd);
      doc = applyUpdate(doc, { stage: 1, status: "done" });
      doc = applyUpdate(doc, { stage: 2, status: "done" });
      // Stage 3 nunca recebeu --status done (falha silenciosa na chamada real, #3802) —
      // fica órfão em "running", sem `end`/`duration_ms`.
      doc = applyUpdate(doc, { stage: 3, status: "running", start: "2026-07-02T18:02:14Z" });
      doc = applyUpdate(doc, { stage: 4, status: "done" });
      doc = applyUpdate(doc, { stage: 5, status: "done" });
      doc = applyUpdate(doc, { stage: 6, status: "done" });

      // Sem o guard, cairia no primeiro not-done por número = stage 3.
      assert.equal(currentStageFromDoc(doc, editionDir), "done");
    } finally {
      cleanup();
    }
  });

  it("sem editionDirAbs (uso doc-only), continua reportando o stage órfão (comportamento preservado)", () => {
    let doc = makeInitialDoc("260703");
    doc = applyUpdate(doc, { stage: 1, status: "done" });
    doc = applyUpdate(doc, { stage: 2, status: "done" });
    doc = applyUpdate(doc, { stage: 3, status: "running" });
    doc = applyUpdate(doc, { stage: 4, status: "done" });
    doc = applyUpdate(doc, { stage: 5, status: "done" });
    doc = applyUpdate(doc, { stage: 6, status: "done" });
    assert.equal(currentStageFromDoc(doc), 3);
  });
});

describe("isEditionPublishedOrScheduled (#3802)", () => {
  it("false quando 05-published.json não existe", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["01-categorized.md"]);
      assert.equal(
        isEditionPublishedOrScheduled(join(root, "data", "editions", "260716")),
        false,
      );
    } finally {
      cleanup();
    }
  });

  it("true quando status === 'published'", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["_internal/05-published.json"]);
      const editionDir = join(root, "data", "editions", "260716");
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "published" }),
      );
      assert.equal(isEditionPublishedOrScheduled(editionDir), true);
    } finally {
      cleanup();
    }
  });

  it("true quando scheduled_at está setado (mesmo sem status='published')", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["_internal/05-published.json"]);
      const editionDir = join(root, "data", "editions", "260716");
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "draft", scheduled_at: "2026-07-17T06:00:00Z" }),
      );
      assert.equal(isEditionPublishedOrScheduled(editionDir), true);
    } finally {
      cleanup();
    }
  });

  it("false quando nem status='published' nem scheduled_at (ex: ainda em draft)", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["_internal/05-published.json"]);
      const editionDir = join(root, "data", "editions", "260716");
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "draft" }),
      );
      assert.equal(isEditionPublishedOrScheduled(editionDir), false);
    } finally {
      cleanup();
    }
  });

  it("false em JSON corrompido (fail-soft, não lança)", () => {
    const { root, cleanup } = setupRoot();
    try {
      makeEditionFiles(root, "260716", ["_internal/05-published.json"]);
      const editionDir = join(root, "data", "editions", "260716");
      writeFileSync(join(editionDir, "_internal", "05-published.json"), "{ not json");
      assert.equal(isEditionPublishedOrScheduled(editionDir), false);
    } finally {
      cleanup();
    }
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

  it("#3802: edição publicada com stage 3 órfão 'running' vira currentStage 'done', não 3", () => {
    const { root, cleanup } = setupRoot();
    try {
      const aammdd = "260703";
      makeEditionFiles(root, aammdd, ["_internal/05-published.json"]);
      const editionDir = join(root, "data", "editions", aammdd);
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "published", scheduled_at: "2026-07-03T06:00:00Z" }),
      );

      let doc = makeInitialDoc(aammdd);
      doc = applyUpdate(doc, { stage: 1, status: "done" });
      doc = applyUpdate(doc, { stage: 2, status: "done" });
      doc = applyUpdate(doc, { stage: 3, status: "running", start: "2026-07-02T18:02:14Z" });
      doc = applyUpdate(doc, { stage: 4, status: "done" });
      doc = applyUpdate(doc, { stage: 5, status: "done" });
      doc = applyUpdate(doc, { stage: 6, status: "done" });
      saveDoc(editionDir, doc);

      const summaries = listEditionSummaries(root);
      assert.equal(summaries[0].currentStage, "done");
      assert.equal(summaries[0].stageLabel, "Concluída");
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

describe("findLatestPlanPath — sufixo de rodada + ordenação por mtime (#3841)", () => {
  it("diretório com sufixo de letra minúscula (260721b) agora É reconhecido como candidato válido", () => {
    const { root, cleanup } = setupRoot();
    try {
      mkdirSync(join(root, "data", "overnight", "260721b"), { recursive: true });
      writeFileSync(join(root, "data", "overnight", "260721b", "plan.json"), "{}");
      const found = findLatestPlanPath(root, "overnight");
      // Pré-fix: AAMMDD_RE (6 dígitos exatos) excluía este diretório inteiro
      // e a função retornava null mesmo havendo um plan.json de verdade.
      assert.ok(found?.includes("260721b"));
    } finally {
      cleanup();
    }
  });

  it("entre 260721 (mtime mais antigo) e 260721b (mtime mais recente), escolhe 260721b", () => {
    const { root, cleanup } = setupRoot();
    try {
      const planA = join(root, "data", "overnight", "260721", "plan.json");
      const planB = join(root, "data", "overnight", "260721b", "plan.json");
      mkdirSync(join(planA, ".."), { recursive: true });
      mkdirSync(join(planB, ".."), { recursive: true });
      writeFileSync(planA, "{}");
      writeFileSync(planB, "{}");
      const older = new Date("2026-07-21T14:34:00Z"); // overnight 14:34 BRT, já encerrada
      const newer = new Date("2026-07-21T22:42:00Z"); // 2º overnight 19:42 BRT, ainda rodando
      utimesSync(planA, older, older);
      utimesSync(planB, newer, newer);
      const found = findLatestPlanPath(root, "overnight");
      assert.ok(found?.includes("260721b"));
    } finally {
      cleanup();
    }
  });

  it("cenário inverso: 260721 com mtime MAIS recente que 260722 (rodada nova já começou mas ainda sem sufixo) — escolhe por mtime, não por nome", () => {
    const { root, cleanup } = setupRoot();
    try {
      // Nome lexicograficamente MAIOR ("260722") mas mtime mais ANTIGO —
      // se a implementação regredisse pra ordenação por nome, isto pegaria.
      const planLexBigger = join(root, "data", "overnight", "260722", "plan.json");
      const planActuallyNewer = join(root, "data", "overnight", "260721", "plan.json");
      mkdirSync(join(planLexBigger, ".."), { recursive: true });
      mkdirSync(join(planActuallyNewer, ".."), { recursive: true });
      writeFileSync(planLexBigger, "{}");
      writeFileSync(planActuallyNewer, "{}");
      const older = new Date("2026-07-21T08:00:00Z");
      const newer = new Date("2026-07-22T02:00:00Z");
      utimesSync(planLexBigger, older, older);
      utimesSync(planActuallyNewer, newer, newer);
      const found = findLatestPlanPath(root, "overnight")!.split("\\").join("/");
      assert.ok(found.endsWith("260721/plan.json"), `esperava terminar em 260721/plan.json, achou: ${found}`);
    } finally {
      cleanup();
    }
  });

  it("sem regressão: mistura de diretórios só-numéricos e com sufixo, sem ambiguidade de mtime, ainda escolhe o mais recente corretamente", () => {
    const { root, cleanup } = setupRoot();
    try {
      const dirs = ["260719", "260720", "260720b", "260721"];
      const base = new Date("2026-07-19T10:00:00Z").getTime();
      dirs.forEach((dir, i) => {
        const planPath = join(root, "data", "overnight", dir, "plan.json");
        mkdirSync(join(planPath, ".."), { recursive: true });
        writeFileSync(planPath, "{}");
        const t = new Date(base + i * 60 * 60 * 1000); // cada uma 1h mais nova que a anterior
        utimesSync(planPath, t, t);
      });
      const found = findLatestPlanPath(root, "overnight")!.split("\\").join("/");
      assert.ok(found.endsWith("260721/plan.json"), `esperava a última criada (260721), achou: ${found}`);
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

  it("#3802: reprodução do incidente — edição de 17 dias atrás com stage órfão não vira 'currentEdition' quando edições recentes já estão 'done'", () => {
    const { root, cleanup } = setupRoot();
    try {
      // Edição antiga (260703) com stage 3 órfão em "running", mas de fato
      // publicada e agendada há semanas (achado #3802, 260720).
      const oldAammdd = "260703";
      makeEditionFiles(root, oldAammdd, ["_internal/05-published.json"]);
      const oldDir = join(root, "data", "editions", oldAammdd);
      writeFileSync(
        join(oldDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "published", scheduled_at: "2026-07-03T06:00:00Z" }),
      );
      let oldDoc = makeInitialDoc(oldAammdd);
      oldDoc = applyUpdate(oldDoc, { stage: 1, status: "done" });
      oldDoc = applyUpdate(oldDoc, { stage: 2, status: "done" });
      oldDoc = applyUpdate(oldDoc, { stage: 3, status: "running", start: "2026-07-02T18:02:14Z" });
      oldDoc = applyUpdate(oldDoc, { stage: 4, status: "done" });
      oldDoc = applyUpdate(oldDoc, { stage: 5, status: "done" });
      oldDoc = applyUpdate(oldDoc, { stage: 6, status: "done" });
      saveDoc(oldDir, oldDoc);

      // Edições recentes, corretamente 'done' de ponta a ponta.
      for (const aammdd of ["260718", "260719"]) {
        const dir = join(root, "data", "editions", aammdd);
        let doc = makeInitialDoc(aammdd);
        for (let s = 1; s <= 6; s++) doc = applyUpdate(doc, { stage: s, status: "done" });
        makeEditionFiles(root, aammdd, []);
        saveDoc(dir, doc);
      }

      const state = buildStudioState(root);
      // Sem o guard, o scan (mais recente → mais antigo) encontraria só
      // edições 'done' em 260718/260719, mas 260703 apareceria com
      // currentStage=3 (não 'done') — pickCurrentEdition a escolheria como
      // "corrente" mesmo sendo a mais antiga da lista.
      assert.notEqual(state.currentEdition, oldAammdd);
      assert.equal(state.currentEdition, "260719"); // mais recente, todas done
      const oldSummary = state.editions.find((e) => e.edition === oldAammdd);
      assert.equal(oldSummary?.currentStage, "done");
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
