/**
 * test/session-beacon-blast-radius.test.ts (#6168)
 *
 * O beacon (`.claude/hooks/session-beacon.mjs`) registra AUTOMATICAMENTE toda
 * sessão interativa em `data/sessions/`. Isso fecha o buraco 3 da #6168
 * (sessão interativa invisível — incidente #5751), mas muda o significado de
 * "existe sessão ativa" para três consumidores que assumiam que só as 3
 * skills coordenadoras se registravam.
 *
 * A Parte B da issue enumera os três e diz o que cada um deve fazer. Este
 * arquivo trava os três — sem ele, o beacon é uma regressão silenciosa:
 *
 *   1. `cleanup-merged-worktrees.ts` passaria a pular a varredura SEMPRE
 *      (qualquer sessão ativa → pula, e agora sempre há uma);
 *   2. `COORDINATOR_KINDS` do guard de merge NÃO pode receber o kind novo —
 *      interativa não é coordenadora e não vira uma por relabel;
 *   3. claim de sessão interativa DEVE bloquear overnight/develop — é
 *      literalmente o caso do #5751.
 *
 * Trava também a consequência que quase derrubou a Parte B: se `interactive`
 * usasse a janela de staleness dos coordenadores (90 min), registrar
 * interativas trocaria risco de colisão por risco de CLAIM ÓRFÃ, que é pior
 * porque não se resolve sozinho.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COORDINATOR_SESSION_KINDS,
  GC_INTERACTIVE_MAX_AGE_MS,
  INTERACTIVE_SOFT_STALE_MS,
  SOFT_STALE_MS,
  TOUCHED_PATHS_CAP,
  isCoordinatorKind,
  isIssueClaimedByOther,
  listActiveSessions,
  normalizeBeaconPath,
  collapseTouchedPaths,
  planSessionGc,
  softStaleMsForKind,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";
import { shouldSkipForSharedSession } from "../scripts/cleanup-merged-worktrees.ts";
import { COORDINATOR_KINDS } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import {
  TOUCHED_PATHS_CAP as HOOK_TOUCHED_PATHS_CAP,
  normalizePath as hookNormalizePath,
  collapsePaths as hookCollapsePaths,
} from "../.claude/hooks/session-beacon.mjs";

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "beacon-blast-"));
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

function writeSession(root: string, record: SessionRecord): void {
  writeFileSync(
    join(root, "data", "sessions", `${record.kind}-${record.machineTag}-${record.sessionId}.json`),
    JSON.stringify(record),
    "utf8",
  );
}

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function session(over: Partial<SessionRecord> & Pick<SessionRecord, "kind" | "sessionId">): SessionRecord {
  return {
    machineTag: "Neo",
    startedAt: isoAgo(60_000),
    lastHeartbeat: isoAgo(60_000),
    ...over,
  } as SessionRecord;
}

describe("#6168 blast radius 2 — COORDINATOR_KINDS não recebe o kind novo", () => {
  it('o guard de merge NÃO trata "interactive" como coordenadora', () => {
    // Se este teste falhar, alguém "resolveu" o bloqueio de uma sessão
    // interativa promovendo o kind a coordenador — que é exatamente o
    // contorno que a #6296 existe pra NÃO abrir. O caminho legítimo é a
    // concessão de janela (merge_grant), nunca o relabel.
    assert.equal(COORDINATOR_KINDS.has("interactive"), false);
    assert.equal(COORDINATOR_KINDS.size, 3);
  });

  it("o conjunto do hook e o do módulo TS não divergem", () => {
    // O hook é self-contained (.mjs, sem import de .ts) e mantém a própria
    // cópia. Duas cópias sem teste cruzado é exatamente a dívida que o
    // comment-analyzer apontou noutro par deste repo — travada aqui.
    assert.deepEqual([...COORDINATOR_KINDS].sort(), [...COORDINATOR_SESSION_KINDS].sort());
  });

  it("isCoordinatorKind concorda com o conjunto", () => {
    for (const kind of COORDINATOR_SESSION_KINDS) assert.equal(isCoordinatorKind(kind), true);
    assert.equal(isCoordinatorKind("interactive"), false);
    assert.equal(isCoordinatorKind("qualquer-outra-coisa"), false);
  });
});

describe("#6303 Findings L/M/J — as OUTRAS constantes/funções duplicadas no beacon não divergem do módulo", () => {
  // Achado do fleet review #6303: `test/session-beacon-hook.test.ts` tinha
  // dois testes que PROMETIAM paridade cruzada ("TOUCHED_PATHS_CAP é 200 nos
  // dois lados", "normalizePath do hook concorda com o do módulo") mas só
  // comparavam a função do hook contra um LITERAL — nunca importavam a
  // versão do `.ts`. Mudar o valor num lado só deixaria os dois testes
  // verdes por coincidência (cada um certo por acaso). O modelo correto já
  // existia neste MESMO arquivo, no describe acima ("o conjunto do hook e o
  // do módulo TS não divergem") — aqui ele é aplicado às 3 duplicações que
  // faltavam.
  it("TOUCHED_PATHS_CAP", () => {
    assert.equal(HOOK_TOUCHED_PATHS_CAP, TOUCHED_PATHS_CAP);
  });

  it("normalizePath (hook) === normalizeBeaconPath (módulo), amostra representativa", () => {
    for (const input of ["scripts\\lib\\a.ts", "./a/", "scripts/lib/a.ts", "a/b/c/", ""]) {
      assert.equal(hookNormalizePath(input), normalizeBeaconPath(input), `input: ${JSON.stringify(input)}`);
    }
  });

  it("collapsePaths (hook) === collapseTouchedPaths (módulo), abaixo e acima do teto", () => {
    const poucos = ["b.ts", "a.ts", "a.ts"];
    assert.deepEqual(hookCollapsePaths(poucos, 10), collapseTouchedPaths(poucos, 10));

    const muitos = Array.from({ length: 50 }, (_, i) => `scripts/lib/mod${i}.ts`);
    assert.deepEqual(hookCollapsePaths(muitos, 5), collapseTouchedPaths(muitos, 5));
  });
});

describe("#6168 blast radius 1 — cleanup não passa a pular sempre", () => {
  it("sessão interativa ativa + ZERO coordenadora → NÃO pula a varredura", () => {
    // É o modo de falha exato: sem o filtro por kind, o beacon faria este
    // guard virar um `return true` permanente e a limpeza de worktree nunca
    // mais rodaria — em silêncio.
    const active = [session({ kind: "interactive", sessionId: "i1" })];
    assert.equal(shouldSkipForSharedSession(active, false), false);
  });

  it("3 interativas ativas, nenhuma coordenadora → ainda NÃO pula", () => {
    const active = [
      session({ kind: "interactive", sessionId: "i1" }),
      session({ kind: "interactive", sessionId: "i2" }),
      session({ kind: "interactive", sessionId: "i3" }),
    ];
    assert.equal(shouldSkipForSharedSession(active, false), false);
  });

  it("coordenadora ativa → pula, como antes do #6168", () => {
    const active = [
      session({ kind: "interactive", sessionId: "i1" }),
      session({ kind: "overnight", sessionId: "o1" }),
    ];
    assert.equal(shouldSkipForSharedSession(active, false), true);
  });

  it("--confirm-shared segue destravando", () => {
    const active = [session({ kind: "develop", sessionId: "d1" })];
    assert.equal(shouldSkipForSharedSession(active, true), false);
  });

  it("registro vazio nunca pula (comportamento pré-#5156 preservado)", () => {
    assert.equal(shouldSkipForSharedSession([], false), false);
  });
});

describe("#6168 blast radius 3 — claim de interativa BLOQUEIA coordenadora", () => {
  it("overnight não reivindica issue já reivindicada por sessão interativa viva", () => {
    // Premissa deliberada da issue: é o caso do #5751, em que o helios tinha
    // #5738 em claimed_issues enquanto uma sessão interativa a implementava
    // e mergeava em paralelo.
    const root = makeTempRepo();
    try {
      writeSession(root, session({ kind: "interactive", sessionId: "i1", claimed_issues: [5738] }));
      const owner = isIssueClaimedByOther(root, 5738, "outra-sessao", NOW);
      assert.ok(owner, "claim de sessão interativa viva deveria bloquear");
      assert.equal(owner?.kind, "interactive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claim de interativa STALE (>15min) não bloqueia", () => {
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          claimed_issues: [5738],
          lastHeartbeat: isoAgo(INTERACTIVE_SOFT_STALE_MS + 60_000),
        }),
      );
      assert.equal(isIssueClaimedByOther(root, 5738, "outra-sessao", NOW), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6168 — janela de staleness própria do kind interactive", () => {
  it("interactive usa 15min; os 3 coordenadores mantêm 90min", () => {
    assert.equal(softStaleMsForKind("interactive"), INTERACTIVE_SOFT_STALE_MS);
    assert.equal(INTERACTIVE_SOFT_STALE_MS, 15 * 60 * 1000);
    for (const kind of COORDINATOR_SESSION_KINDS) {
      assert.equal(softStaleMsForKind(kind), SOFT_STALE_MS);
    }
  });

  it("kind desconhecido cai na janela CONSERVADORA (90min), nunca na curta", () => {
    // Nunca marcar stale mais cedo sobre um registro que não se conseguiu
    // classificar — errar pro lado de "ainda viva".
    assert.equal(softStaleMsForKind(""), SOFT_STALE_MS);
    assert.equal(softStaleMsForKind("kind-que-nao-existe"), SOFT_STALE_MS);
  });

  it("boundary exato: heartbeat == INTERACTIVE_SOFT_STALE_MS não é stale (só > é stale, #6303 Finding I)", () => {
    // Mesma disciplina de `test/session-registry.test.ts` ("boundary exato:
    // heartbeat == SOFT_STALE_MS não é stale") aplicada à janela CURTA do
    // kind interactive — só testar a margem (16min/30min) não pegaria uma
    // mutação de `>` pra `>=` no comparador de `listActiveSessions`.
    const root = makeTempRepo();
    try {
      writeSession(root, session({ kind: "interactive", sessionId: "i1", lastHeartbeat: isoAgo(INTERACTIVE_SOFT_STALE_MS) }));
      const active = listActiveSessions(root, NOW);
      assert.equal(active.length, 1);
      assert.equal(active[0]!.stale, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aos 30min: interativa já é stale, overnight ainda não", () => {
    // É a diferença que impede a claim órfã de sessão interativa encerrada
    // de segurar uma issue por 1h30 (evidência 1 da issue).
    const root = makeTempRepo();
    try {
      writeSession(root, session({ kind: "interactive", sessionId: "i1", lastHeartbeat: isoAgo(30 * 60_000) }));
      writeSession(root, session({ kind: "overnight", sessionId: "o1", lastHeartbeat: isoAgo(30 * 60_000) }));
      const active = listActiveSessions(root, NOW);
      assert.equal(active.find((s) => s.sessionId === "i1")?.stale, true);
      assert.equal(active.find((s) => s.sessionId === "o1")?.stale, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6168 — GC alcança registro interativo órfão sem depender de pid", () => {
  it("interativa de OUTRA máquina, 3h stale → removida (janela de 2h)", () => {
    // Sem isto, o beacon encheria data/sessions/ de registros mortos: sessão
    // interativa termina sem chamar `end` (não há skill pra chamar), e a
    // janela conservadora dos coordenadores é de 7 DIAS.
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          machineTag: "OutraMaquina",
          lastHeartbeat: isoAgo(3 * 60 * 60 * 1000),
        }),
      );
      const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo" });
      assert.equal(plan.length, 1);
      assert.equal(plan[0]!.action, "removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coordenadora de OUTRA máquina, 3h stale → MANTIDA (janela de 7 dias intacta)", () => {
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "overnight",
          sessionId: "o1",
          machineTag: "OutraMaquina",
          lastHeartbeat: isoAgo(3 * 60 * 60 * 1000),
        }),
      );
      const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo" });
      assert.equal(plan[0]!.action, "kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interativa 3h stale mas com PID VIVO local → MANTIDA", () => {
    // O branch de processo vivo vence as duas janelas: nunca remover
    // registro de sessão que ainda está rodando (ressalva do #6130).
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          machineTag: "Neo",
          pid: 4242,
          lastHeartbeat: isoAgo(3 * 60 * 60 * 1000),
        }),
      );
      const plan = planSessionGc(root, {
        now: NOW,
        localMachineTag: "Neo",
        isPidAlive: (pid) => pid === 4242,
      });
      assert.equal(plan[0]!.action, "kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interativa 1h stale (dentro das 2h) → MANTIDA", () => {
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          machineTag: "OutraMaquina",
          lastHeartbeat: isoAgo(60 * 60 * 1000),
        }),
      );
      const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo" });
      assert.equal(plan[0]!.action, "kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GC_INTERACTIVE_MAX_AGE_MS é bem menor que a janela conservadora dos coordenadores", () => {
    assert.equal(GC_INTERACTIVE_MAX_AGE_MS, 2 * 60 * 60 * 1000);
    assert.ok(GC_INTERACTIVE_MAX_AGE_MS < 7 * 24 * 60 * 60 * 1000);
  });

  it("boundary exato: heartbeat == GC_INTERACTIVE_MAX_AGE_MS → MANTIDA (só > remove, #6303 Finding I)", () => {
    // Os testes de margem acima (1h mantida, 3h removida) não pegariam uma
    // mutação de `>` pra `>=` no comparador de `decideSessionGc` — só o
    // valor EXATO do limite pega isso.
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          machineTag: "OutraMaquina",
          lastHeartbeat: isoAgo(GC_INTERACTIVE_MAX_AGE_MS),
        }),
      );
      const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo" });
      assert.equal(plan[0]!.action, "kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("boundary exato +1ms: heartbeat == GC_INTERACTIVE_MAX_AGE_MS + 1ms → REMOVIDA", () => {
    const root = makeTempRepo();
    try {
      writeSession(
        root,
        session({
          kind: "interactive",
          sessionId: "i1",
          machineTag: "OutraMaquina",
          lastHeartbeat: isoAgo(GC_INTERACTIVE_MAX_AGE_MS + 1),
        }),
      );
      const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo" });
      assert.equal(plan[0]!.action, "removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6168 — retrocompatibilidade com registro no formato antigo", () => {
  it("registro SEM nenhum campo de beacon continua sendo lido normalmente", () => {
    // Critério de aceite explícito: os campos novos são ADITIVOS. Um
    // plan/registro gravado antes desta issue não pode quebrar nenhum leitor.
    const root = makeTempRepo();
    try {
      writeFileSync(
        join(root, "data", "sessions", "overnight-helios-antiga.json"),
        JSON.stringify({
          kind: "overnight",
          machineTag: "helios",
          sessionId: "antiga",
          startedAt: isoAgo(60_000),
          lastHeartbeat: isoAgo(60_000),
          claimed_issues: [5653],
        }),
        "utf8",
      );
      const active = listActiveSessions(root, NOW);
      assert.equal(active.length, 1);
      assert.equal(active[0]!.stale, false);
      assert.equal(active[0]!.branch, undefined);
      assert.equal(active[0]!.touched_paths, undefined);
      assert.equal(active[0]!.dirty_paths, undefined);
      assert.deepEqual(active[0]!.claimed_issues, [5653]);
      // E continua bloqueando claim normalmente.
      assert.ok(isIssueClaimedByOther(root, 5653, "outra", NOW));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
