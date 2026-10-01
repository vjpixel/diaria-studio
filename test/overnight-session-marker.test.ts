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
  readPhase,
  resolveSessionIdOrThrow,
  listActiveSessionMarkerPaths,
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

// #8174: read-side puro consumido por overnight-watchdog.ts
// (isOvernightAwaitingBriefingResponse) pra distinguir "coordenador
// bloqueado no AskUserQuestion do briefing" (sem teto de tempo) de "morreu
// no loop autônomo" (stall real).
describe("readPhase (#8174)", () => {
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `overnight-session-marker-readphase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  it("lê 'briefing' logo após startSession", () => {
    const root = freshRoot();
    startSession(root, "2026-09-16T02:00:00.000Z");
    assert.equal(readPhase(root), "briefing");
  });

  it("lê 'autonomous' depois de setPhase", () => {
    const root = freshRoot();
    startSession(root, "2026-09-16T02:00:00.000Z");
    setPhase(root, "autonomous");
    assert.equal(readPhase(root), "autonomous");
  });

  it("marker ausente (nenhuma rodada, ou já encerrada via endSession) → null, nunca lança", () => {
    const root = freshRoot();
    assert.equal(readPhase(root), null);

    startSession(root, "2026-09-16T02:00:00.000Z");
    endSession(root);
    assert.equal(readPhase(root), null);
  });

  it("JSON corrompido no disco → null, nunca lança (fail-soft, mesmo espírito de setPhase)", () => {
    const root = freshRoot();
    startSession(root, "2026-09-16T02:00:00.000Z");
    writeFileSync(activeSessionPath(root), "{ isto nao e json valido", "utf8");
    assert.equal(readPhase(root), null);
  });

  it("campo phase ausente ou com valor inesperado → null, nunca inventa uma fase", () => {
    const root = freshRoot();
    const path = activeSessionPath(root);
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(path, JSON.stringify({ started_at: "2026-09-16T02:00:00.000Z" }), "utf8");
    assert.equal(readPhase(root), null);

    writeFileSync(path, JSON.stringify({ started_at: "2026-09-16T02:00:00.000Z", phase: "algo-inesperado" }), "utf8");
    assert.equal(readPhase(root), null);
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

    // #9347: com session_id, o marker vai pro arquivo POR SESSÃO.
    const content = JSON.parse(readFileSync(activeSessionPath(root, undefined, "sessao-overnight-abc"), "utf8"));
    assert.equal(content.session_id, "sessao-overnight-abc");
    assert.equal(content.phase, "briefing");
  });

  it("setPhase sem sessionId preserva o session_id já presente, intocado", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z", "sessao-overnight-abc");

    setPhase(root, "autonomous");

    const content = JSON.parse(readFileSync(activeSessionPath(root, undefined, "sessao-overnight-abc"), "utf8"));
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

  it("startSession idempotente (2ª chamada) sem sessionId sobrescreve o legado anônimo por inteiro (mesmo contrato de overwrite total já documentado)", () => {
    const root = freshRoot();
    startSession(root, "2026-08-12T02:00:00.000Z");
    startSession(root, "2026-08-12T05:00:00.000Z");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal("session_id" in content, false);
    assert.equal(content.started_at, "2026-08-12T05:00:00.000Z");
  });
});

// #6232: --start/--phase sem session_id não passam mais despercebidos — o
// resolvedor lança por padrão (falha alta, simétrica a requireSessionId em
// scripts/lib/session-registry.ts) e só devolve undefined com o opt-in
// explícito --allow-no-session-id, sempre avisando alto no stderr.
describe("resolveSessionIdOrThrow (#6232)", () => {
  it("sessionId presente → devolve ele, sem tocar stderr", () => {
    const originalWrite = process.stderr.write;
    let wrote = false;
    process.stderr.write = (...args) => {
      wrote = true;
      return originalWrite.apply(process.stderr, args);
    };
    try {
      const result = resolveSessionIdOrThrow("sessao-abc", false);
      assert.equal(result, "sessao-abc");
      assert.equal(wrote, false);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("sessionId ausente, sem --allow-no-session-id → lança", () => {
    assert.throws(() => resolveSessionIdOrThrow(undefined, false), /--session-id ausente/);
  });

  it("sessionId ausente, com --allow-no-session-id → devolve undefined e avisa alto no stderr", () => {
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      const result = resolveSessionIdOrThrow(undefined, true);
      assert.equal(result, undefined);
      assert.match(captured, /AVISO/);
      assert.match(captured, /MÁQUINA INTEIRA/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("mensagem de erro cita a causa raiz (comando encadeado/pipado) e o opt-in", () => {
    try {
      resolveSessionIdOrThrow(undefined, false);
      assert.fail("deveria ter lançado");
    } catch (err) {
      assert.match(err.message, /encadead|pipe/);
      assert.match(err.message, /--allow-no-session-id/);
    }
  });
});

// #9347: 2 rodadas overnight simultâneas na MESMA máquina (caso suportado
// desde o #6328). Antes, o --start da 2ª sobrescrevia o marker da 1ª e o
// --end dela o apagava — o guard da Regra 1 e o desconto de effort da 1ª,
// ainda viva, desarmavam em silêncio (ocorrência 261001: 261001b × 261001c).
describe("marker por sessão — rodadas concorrentes na mesma máquina (#9347)", () => {
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(tmpdir(), `overnight-session-marker-9347-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }

  const A = "7746e03c-aaaa-4bbb-8ccc-000000000001";
  const B = "d0c01c05-aaaa-4bbb-8ccc-000000000002";
  const T0 = "2026-10-01T02:00:00.000Z";
  const T1 = "2026-10-01T03:00:00.000Z";
  const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  it("activeSessionPath com sessionId usa separador '.' (sem colisão com hostname que contém '-')", () => {
    assert.equal(
      activeSessionPath("/repo", "host", "abc-123"),
      join("/repo", "data", "overnight", ".active-session-host.abc-123.json"),
    );
    // sanitiza caracteres fora do alfabeto de nome de arquivo
    assert.match(activeSessionPath("/repo", "host", "a/b:c"), /\.active-session-host\.a_b_c\.json$/);
  });

  it("--start da 2ª rodada NÃO sobrescreve o marker da 1ª (phase/session_id intactos)", () => {
    const root = freshRoot();
    startSession(root, T0, A);
    assert.equal(setPhase(root, "autonomous", A), true);

    startSession(root, T1, B);

    const a = readJson(activeSessionPath(root, undefined, A));
    assert.equal(a.session_id, A);
    assert.equal(a.phase, "autonomous");
    assert.equal(a.started_at, T0);
    assert.equal(readJson(activeSessionPath(root, undefined, B)).phase, "briefing");
  });

  it("REGRESSÃO: --end de outra sessão não apaga o marker alheio", () => {
    const root = freshRoot();
    startSession(root, T0, A);
    setPhase(root, "autonomous", A);
    startSession(root, T1, B);

    const result = endSession(root, B);

    assert.equal(existsSync(activeSessionPath(root, undefined, B)), false);
    assert.ok(existsSync(activeSessionPath(root, undefined, A)), "marker da rodada A (viva) foi apagado");
    assert.equal(readJson(activeSessionPath(root, undefined, A)).phase, "autonomous");
    assert.deepEqual(result.removed, [activeSessionPath(root, undefined, B)]);
  });

  it("REGRESSÃO (compat legado): --end de outra sessão não apaga o marker LEGADO de uma rodada pré-#9347 viva", () => {
    const root = freshRoot();
    // Rodada A iniciada com o código antigo: marker legado por máquina, com session_id A.
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(activeSessionPath(root), JSON.stringify({ started_at: T0, phase: "autonomous", session_id: A }));
    startSession(root, T1, B);

    const result = endSession(root, B);

    assert.ok(existsSync(activeSessionPath(root)), "marker legado da rodada A foi apagado pelo --end de B");
    assert.equal(readJson(activeSessionPath(root)).session_id, A);
    assert.equal(result.keptForeign, activeSessionPath(root));
  });

  it("compat legado: a própria rodada pré-#9347 continua conseguindo --phase e --end no marker legado", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(activeSessionPath(root), JSON.stringify({ started_at: T0, phase: "briefing", session_id: A }));

    assert.equal(setPhase(root, "autonomous", A), true);
    assert.equal(readJson(activeSessionPath(root)).phase, "autonomous");

    endSession(root, A);
    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("compat legado: --start (resume) da MESMA sessão migra o legado pro arquivo por sessão", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(activeSessionPath(root), JSON.stringify({ started_at: T0, phase: "autonomous", session_id: A }));

    startSession(root, T1, A);

    assert.equal(existsSync(activeSessionPath(root)), false);
    assert.equal(readJson(activeSessionPath(root, undefined, A)).session_id, A);
  });

  it("setPhase de uma sessão nunca muda o marker de outra", () => {
    const root = freshRoot();
    startSession(root, T0, A);
    startSession(root, T1, B);

    setPhase(root, "autonomous", B);

    assert.equal(readJson(activeSessionPath(root, undefined, A)).phase, "briefing");
    assert.equal(readJson(activeSessionPath(root, undefined, B)).phase, "autonomous");
  });

  it("setPhase com sessionId sem marker próprio e com legado de OUTRA sessão → false, legado intacto", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(activeSessionPath(root), JSON.stringify({ started_at: T0, phase: "autonomous", session_id: A }));

    assert.equal(setPhase(root, "briefing", B), false);
    assert.equal(readJson(activeSessionPath(root)).phase, "autonomous");
    assert.equal(readJson(activeSessionPath(root)).session_id, A);
  });

  it("endSession sem sessionId não apaga legado que declara dono", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    writeFileSync(activeSessionPath(root), JSON.stringify({ started_at: T0, phase: "autonomous", session_id: A }));

    const result = endSession(root);

    assert.ok(existsSync(activeSessionPath(root)));
    assert.equal(result.keptForeign, activeSessionPath(root));
  });

  it("listActiveSessionMarkerPaths: legado + por-sessão da máquina, ignora outra máquina e arquivos alheios", () => {
    const root = freshRoot();
    const tag = machineTag();
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(activeSessionPath(root, tag), "{}");
    writeFileSync(activeSessionPath(root, tag, A), "{}");
    writeFileSync(activeSessionPath(root, `${tag}-outra`, B), "{}"); // outra máquina com prefixo parecido
    writeFileSync(activeSessionPath(root, `${tag}-outra`), "{}");
    writeFileSync(join(dir, "plan.json"), "{}");

    assert.deepEqual(
      listActiveSessionMarkerPaths(root, tag),
      [activeSessionPath(root, tag), activeSessionPath(root, tag, A)].sort(),
    );
  });

  it("--start poda marker por-sessão STALE (>24h) de rodada crashada, preserva o fresco", () => {
    const root = freshRoot();
    const dead = "dead0000-aaaa-4bbb-8ccc-000000000003";
    startSession(root, "2026-09-29T00:00:00.000Z", dead); // ~51h antes de T1
    startSession(root, T0, A);
    startSession(root, T1, B);

    assert.equal(existsSync(activeSessionPath(root, undefined, dead)), false);
    assert.ok(existsSync(activeSessionPath(root, undefined, A)));
    assert.ok(existsSync(activeSessionPath(root, undefined, B)));
  });

  it("readPhase: por sessão quando sessionId é dado; agregado (briefing vence) sem ele", () => {
    const root = freshRoot();
    const now = Date.parse("2026-10-01T04:00:00.000Z");
    startSession(root, T0, A);
    setPhase(root, "autonomous", A);
    assert.equal(readPhase(root, undefined, undefined, now), "autonomous");

    startSession(root, T1, B);
    assert.equal(readPhase(root, undefined, A, now), "autonomous");
    assert.equal(readPhase(root, undefined, B, now), "briefing");
    assert.equal(readPhase(root, undefined, undefined, now), "briefing");

    endSession(root, B);
    assert.equal(readPhase(root, undefined, undefined, now), "autonomous");
  });
});
