/**
 * test/control-edition-guard.test.ts (#5547 item 3)
 *
 * Cobre `scripts/lib/control-edition-guard.ts` — o guard de ruído
 * concorrente da edição de controle. É o "item de maior valor da unidade"
 * segundo a #5547: existe pra nunca deixar passar despercebido o erro
 * medido no #5413 (29% de inflação por sessão concorrente na 260814).
 * Regressão específica: uma medição com `sessions_excluded > 0` OU com
 * outra sessão overnight/develop ativa no `session-registry.ts`
 * TEM que sair marcada `contaminated: true` — nunca silenciosamente limpa.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTranscriptContamination,
  checkSessionRegistryNoise,
  assessConcurrentNoise,
} from "../scripts/lib/control-edition-guard.ts";
import { makeInitialDoc, applyUpdate, type StageStatusDoc } from "../scripts/update-stage-status.ts";
import { registerSession, endSession } from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "control-edition-guard-"));
  roots.push(dir);
  return dir;
}

function docWithRow(overrides: Partial<Parameters<typeof applyUpdate>[1]> = {}): StageStatusDoc {
  const doc = makeInitialDoc("260814");
  return applyUpdate(
    doc,
    {
      stage: 4,
      status: "done",
      tokens_in: 100,
      tokens_out: 10,
      session_filter: "current_session",
      sessions_excluded: 0,
      ...overrides,
    },
    "2026-08-14T12:00:00.000Z",
  );
}

describe("checkTranscriptContamination", () => {
  it("clean quando todo stage capturado tem sessions_excluded=0 e filtro current_session", () => {
    const doc = docWithRow();
    const check = checkTranscriptContamination(doc);
    assert.equal(check.clean, true);
    assert.equal(check.total_sessions_excluded, 0);
    assert.deepEqual(check.stages_with_excluded_sessions, []);
    assert.deepEqual(check.stages_with_unfiltered_fallback, []);
  });

  it("NÃO clean quando sessions_excluded > 0 — regressão do erro medido no #5413", () => {
    const doc = docWithRow({ sessions_excluded: 3 });
    const check = checkTranscriptContamination(doc);
    assert.equal(check.clean, false);
    assert.equal(check.total_sessions_excluded, 3);
    assert.deepEqual(check.stages_with_excluded_sessions, [4]);
  });

  it("NÃO clean quando session_filter cai em all_sessions (filtro não isolou)", () => {
    const doc = docWithRow({ session_filter: "all_sessions", sessions_excluded: 0 });
    const check = checkTranscriptContamination(doc);
    assert.equal(check.clean, false);
    assert.deepEqual(check.stages_with_unfiltered_fallback, [4]);
  });

  it("soma sessions_excluded de MÚLTIPLOS stages", () => {
    let doc = docWithRow({ sessions_excluded: 2 });
    doc = applyUpdate(
      doc,
      { stage: 5, status: "done", tokens_in: 50, session_filter: "current_session", sessions_excluded: 1 },
      "2026-08-14T13:00:00.000Z",
    );
    const check = checkTranscriptContamination(doc);
    assert.equal(check.total_sessions_excluded, 3);
    assert.deepEqual(check.stages_with_excluded_sessions.sort(), [4, 5]);
  });

  it("stage sem captura nenhuma (tokens_in e session_filter ausentes) não conta pra sinal, só é listado", () => {
    const doc = makeInitialDoc("260814"); // todas rows pending, sem tokens_in
    const check = checkTranscriptContamination(doc);
    assert.equal(check.clean, true);
    assert.ok(check.stages_without_capture.length > 0);
  });
});

describe("checkSessionRegistryNoise", () => {
  it("clean quando não há sessão overnight/develop ativa", () => {
    const repoRoot = tmpRepo();
    const check = checkSessionRegistryNoise(repoRoot);
    assert.equal(check.clean, true);
    assert.deepEqual(check.other_active_sessions, []);
  });

  it("NÃO clean quando há outra sessão develop/overnight registrada e ativa", () => {
    const repoRoot = tmpRepo();
    registerSession(repoRoot, "develop", "session-outra-abc", { tag: "maquina-x" });
    const check = checkSessionRegistryNoise(repoRoot);
    assert.equal(check.clean, false);
    assert.equal(check.other_active_sessions.length, 1);
    assert.equal(check.other_active_sessions[0].sessionId, "session-outra-abc");
    assert.equal(check.other_active_sessions[0].kind, "develop");
  });

  it("exclui a PRÓPRIA sessão (a que está fazendo a medição) do sinal de ruído", () => {
    const repoRoot = tmpRepo();
    registerSession(repoRoot, "develop", "session-propria", { tag: "maquina-x" });
    const check = checkSessionRegistryNoise(repoRoot, { excludeSessionId: "session-propria" });
    assert.equal(check.clean, true);
  });

  it("sessão encerrada (endSession) some da lista — não conta como ruído", () => {
    const repoRoot = tmpRepo();
    registerSession(repoRoot, "overnight", "session-encerrada", { tag: "maquina-x" });
    endSession(repoRoot, "overnight", "session-encerrada", "maquina-x");
    const check = checkSessionRegistryNoise(repoRoot);
    assert.equal(check.clean, true);
  });
});

describe("assessConcurrentNoise — veredito combinado (#5547 item 3)", () => {
  it("contaminated=false quando os dois sinais estão limpos", () => {
    const repoRoot = tmpRepo();
    const doc = docWithRow();
    const verdict = assessConcurrentNoise(doc, repoRoot);
    assert.equal(verdict.contaminated, false);
    assert.deepEqual(verdict.reasons, []);
  });

  it("contaminated=true quando SÓ o sinal de transcript acusa ruído", () => {
    const repoRoot = tmpRepo();
    const doc = docWithRow({ sessions_excluded: 5 });
    const verdict = assessConcurrentNoise(doc, repoRoot);
    assert.equal(verdict.contaminated, true);
    assert.ok(verdict.reasons.some((r) => r.includes("excluída")));
  });

  it("contaminated=true quando SÓ o sinal de registry acusa ruído", () => {
    const repoRoot = tmpRepo();
    registerSession(repoRoot, "overnight", "session-concorrente", { tag: "maquina-y" });
    const doc = docWithRow();
    const verdict = assessConcurrentNoise(doc, repoRoot);
    assert.equal(verdict.contaminated, true);
    assert.ok(verdict.reasons.some((r) => r.includes("session-registry")));
  });

  it("NUNCA descarta a medição em silêncio — o dado completo (transcript_check/registry_check) sempre acompanha o veredito", () => {
    const repoRoot = tmpRepo();
    const doc = docWithRow({ sessions_excluded: 1 });
    const verdict = assessConcurrentNoise(doc, repoRoot);
    assert.ok(verdict.transcript_check);
    assert.ok(verdict.registry_check);
    assert.equal(typeof verdict.transcript_check.total_sessions_excluded, "number");
  });

  it("dupla contaminação: reasons lista os DOIS motivos, não só o primeiro", () => {
    const repoRoot = tmpRepo();
    registerSession(repoRoot, "develop", "session-dupla", { tag: "maquina-z" });
    const doc = docWithRow({ sessions_excluded: 2 });
    const verdict = assessConcurrentNoise(doc, repoRoot);
    assert.equal(verdict.contaminated, true);
    assert.equal(verdict.reasons.length, 2);
  });
});
