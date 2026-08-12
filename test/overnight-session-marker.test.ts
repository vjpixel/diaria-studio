import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activeSessionPath,
  machineTag,
  startSession,
  endSession,
  setPhase,
} from "../scripts/overnight-session-marker.ts";

// #3322: write/remove side do marker que .claude/hooks/pr-create-review.mjs
// (isOvernightRoundActive) consome — ver docblock de overnight-session-marker.ts
// pro racional do split write-side/read-side.

describe("machineTag (#3322)", () => {
  it("nunca lança, retorna string não-vazia", () => {
    const tag = machineTag();
    assert.equal(typeof tag, "string");
    assert.ok(tag.length > 0);
  });

  it("só contém caracteres seguros pra nome de arquivo", () => {
    assert.match(machineTag(), /^[a-zA-Z0-9_-]+$/);
  });
});

describe("activeSessionPath (#3322)", () => {
  it("monta o path esperado sob data/overnight/", () => {
    const path = activeSessionPath("/repo", "my-host");
    assert.equal(path, join("/repo", "data", "overnight", ".active-session-my-host.json"));
  });

  it("usa machineTag() como default quando tag não é passado", () => {
    const path = activeSessionPath("/repo");
    assert.match(path, /\.active-session-[a-zA-Z0-9_-]+\.json$/);
  });
});

describe("startSession / endSession (#3322)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(tmpdir(), `overnight-session-marker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }

  it("startSession cria data/overnight/ se não existir, e grava started_at", () => {
    const root = freshRoot();
    assert.equal(existsSync(join(root, "data", "overnight")), false);

    startSession(root, "2026-07-11T02:00:00.000Z");

    const path = activeSessionPath(root);
    assert.ok(existsSync(path));
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.started_at, "2026-07-11T02:00:00.000Z");
  });

  // #4450: --start sempre grava phase: "briefing" — é o guard mecânico que
  // .claude/hooks/block-askuserquestion-overnight-autonomous.mjs consome pra
  // decidir se um AskUserQuestion pode passar (só em "briefing"/ausente).
  it("startSession grava phase: 'briefing' por padrão (#4450)", () => {
    const root = freshRoot();
    startSession(root, "2026-07-11T02:00:00.000Z");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.phase, "briefing");
  });

  it("startSession é idempotente — segunda chamada sobrescreve started_at", () => {
    const root = freshRoot();
    startSession(root, "2026-07-11T02:00:00.000Z");
    startSession(root, "2026-07-11T05:00:00.000Z");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.started_at, "2026-07-11T05:00:00.000Z");
  });

  it("endSession remove o marker", () => {
    const root = freshRoot();
    startSession(root, "2026-07-11T02:00:00.000Z");
    assert.ok(existsSync(activeSessionPath(root)));

    endSession(root);

    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("endSession é idempotente — no-op se o marker já não existe", () => {
    const root = freshRoot();
    assert.doesNotThrow(() => endSession(root));
    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("startSession não mexe em outros arquivos já presentes em data/overnight/", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight", "260710"), { recursive: true });
    const otherFile = join(root, "data", "overnight", "260710", "plan.json");
    writeFileSync(otherFile, "{}", "utf8");

    startSession(root, "2026-07-11T02:00:00.000Z");

    assert.ok(existsSync(otherFile));
    assert.ok(existsSync(activeSessionPath(root)));
  });
});

// #4450: guard mecânico da Regra 1 do overnight (zero perguntas pós-briefing)
// — setPhase é o write-side que .claude/hooks/block-askuserquestion-overnight-autonomous.mjs
// consome via leitura direta do marker (nunca importa este módulo — mesma
// separação write/read-side de isOvernightRoundActive em pr-create-review.mjs).
describe("setPhase (#4450)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `overnight-session-marker-setphase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  it("atualiza phase pra 'autonomous' preservando started_at", () => {
    const root = freshRoot();
    startSession(root, "2026-08-01T02:00:00.000Z");

    const updated = setPhase(root, "autonomous");

    assert.equal(updated, true);
    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.phase, "autonomous");
    assert.equal(content.started_at, "2026-08-01T02:00:00.000Z");
  });

  it("é idempotente — chamar duas vezes com o mesmo valor não quebra nada", () => {
    const root = freshRoot();
    startSession(root, "2026-08-01T02:00:00.000Z");

    assert.equal(setPhase(root, "autonomous"), true);
    assert.equal(setPhase(root, "autonomous"), true);

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.phase, "autonomous");
  });

  it("permite voltar de 'autonomous' pra 'briefing' (não é uma via de mão única)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-01T02:00:00.000Z");
    setPhase(root, "autonomous");

    setPhase(root, "briefing");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.phase, "briefing");
  });

  it("preserva campos além de started_at/phase (ex: plan.json futuro reaproveitando o marker)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-01T02:00:00.000Z");
    // Simula um campo adicional gravado por outra parte do sistema no futuro —
    // setPhase nunca deve descartar campos que não conhece.
    const path = activeSessionPath(root);
    const current = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...current, extra_field: "preservar" }), "utf8");

    setPhase(root, "autonomous");

    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.extra_field, "preservar");
    assert.equal(content.phase, "autonomous");
  });

  it("falha graciosamente (retorna false, nunca lança) quando --start nunca rodou", () => {
    const root = freshRoot();
    assert.equal(existsSync(activeSessionPath(root)), false);

    assert.doesNotThrow(() => {
      const result = setPhase(root, "autonomous");
      assert.equal(result, false);
    });
    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("falha graciosamente quando o marker existente é JSON corrompido", () => {
    const root = freshRoot();
    const path = activeSessionPath(root);
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(path, "{not valid json", "utf8");

    assert.doesNotThrow(() => {
      const result = setPhase(root, "autonomous");
      assert.equal(result, false);
    });
  });

  it("falha graciosamente quando o marker já foi removido por endSession", () => {
    const root = freshRoot();
    startSession(root, "2026-08-01T02:00:00.000Z");
    endSession(root);

    assert.equal(setPhase(root, "autonomous"), false);
  });
});

// #5156: campo `session_id` — opcional, injetado por
// .claude/hooks/inject-session-id.mjs (a skill nunca sabe o próprio
// session_id). Ausência preserva o formato antigo (retrocompat com qualquer
// rodada já em progresso no momento em que este campo foi introduzido).
describe("session_id (#5156)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `overnight-session-marker-sessionid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  it("startSession sem sessionId → marker NÃO carrega o campo (formato antigo preservado)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal("session_id" in content, false);
  });

  it("startSession com sessionId → grava session_id no marker", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z", "sessao-overnight-abc");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.session_id, "sessao-overnight-abc");
    assert.equal(content.phase, "briefing");
  });

  it("setPhase sem sessionId preserva o session_id já presente, intocado", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z", "sessao-overnight-abc");

    setPhase(root, "autonomous");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.session_id, "sessao-overnight-abc");
    assert.equal(content.phase, "autonomous");
  });

  it("setPhase com sessionId grava/atualiza o campo (ex: resume que só sabe o session_id agora)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z"); // sem session_id, formato antigo

    setPhase(root, "autonomous", "sessao-resume-xyz");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.session_id, "sessao-resume-xyz");
    assert.equal(content.phase, "autonomous");
  });

  it("startSession idempotente (2ª chamada) sem sessionId apaga um session_id gravado antes (mesmo contrato de overwrite total já documentado)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z", "sessao-overnight-abc");
    startSession(root, "2026-08-12T05:00:00.000Z"); // resume sem re-passar a flag

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal("session_id" in content, false);
  });
});
