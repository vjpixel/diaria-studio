/**
 * test/session-conflicts-and-merge-grant.test.ts (#6168 Parte C + #6296)
 *
 * Dois mecanismos:
 *
 *   - **`conflicts` (Parte C)** — CONSULTA "quem mais está mexendo nisto?".
 *     Nunca adquire nada, nunca cria arquivo (critério de aceite explícito da
 *     issue: nada além de `.merge-lock.json` aparece em `data/sessions/`).
 *   - **Concessão de janela (#6296)** — protocolo de merge real, medido ao
 *     vivo em 260826: o peer concedeu a janela, o merge lock foi adquirido, e
 *     o `gh pr merge` foi bloqueado assim mesmo porque o guard do #5716 só
 *     olhava `session_id` contra o registro.
 *
 * A Parte F (`MergeAnnouncement`/`decideMergeOrder`/`resolveMergeAdmission`)
 * foi removida no #7123 — anúncio+admissão nunca teve consumidor real (nada
 * no repo escrevia `merge_announcement`); o protocolo de merge que de fato
 * roda é o lock (`merge-lock-*`) + a concessão (`merge_grant`) testada abaixo.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOCK_SKEW_TOLERANCE_MS,
  MERGE_GRANT_TTL_MS,
  MERGE_LOCK_TTL_MS,
  beaconPathsOverlap,
  collapseTouchedPaths,
  consumeMergeGrant,
  findLiveMergeGrant,
  findSessionConflicts,
  grantMergeWindow,
  machineTag,
  isMergeGrantLive,
  isSelfAuthorizedMergeLive,
  listActiveSessions,
  mergeSessionRecords,
  normalizeBeaconPath,
  registerSession,
  selfAuthorizeMerge,
  sessionsDir,
  type ActiveSessionRecord,
} from "../scripts/lib/session-registry.ts";
import {
  CLOCK_SKEW_TOLERANCE_MS as HOOK_CLOCK_SKEW_TOLERANCE_MS,
  MERGE_GRANT_TTL_MS as HOOK_MERGE_GRANT_TTL_MS,
  MERGE_LOCK_TTL_MS as HOOK_MERGE_LOCK_TTL_MS,
  readConsumedGrantFor,
  readLiveMergeGrantFor,
  shouldBlockGhPrMerge,
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import {
  findLiveMergeGrantFile,
  buildConsumedRecord,
  consumeGrantUnderLock,
} from "../.claude/hooks/consume-merge-grant-on-merge.mjs";

const CONSUME_HOOK_PATH = fileURLToPath(
  new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url),
);

/**
 * Tag da maquina REAL, nao um literal.
 *
 * `grantMergeWindow`/`findLiveMergeGrant`/`consumeMergeGrant` resolvem o path
 * do registro por `meta.tag ?? machineTag()`. Um teste que registra com um tag
 * HARDCODED e depois chama essas funcoes sem passar tag so passa numa maquina
 * cujo hostname seja exatamente esse literal — foi o que aconteceu: verde no
 * Windows do editor (hostname `Neo`), vermelho no runner do CI (#6303).
 */
const LOCAL_TAG = machineTag();

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "conflicts-"));
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

// Devolve `ActiveSessionRecord` (com `stale` obrigatorio) e nao `SessionRecord`:
// e o que `findSessionConflicts` exige desde o #6303, justamente pra impedir
// que uma lista CRUA de disco (sem `stale` computado) seja tratada como toda
// viva. O fixture precisa refletir a mesma precondicao do call site real.
function peer(
  over: Partial<ActiveSessionRecord> & Pick<ActiveSessionRecord, "kind" | "sessionId">,
): ActiveSessionRecord {
  return {
    machineTag: "Neo",
    startedAt: isoAgo(60_000),
    lastHeartbeat: isoAgo(60_000),
    stale: false,
    ...over,
  } as ActiveSessionRecord;
}

// ─── Normalização e teto de caminhos ───────────────────────────────────────

describe("#6168 — normalização de caminho é cross-máquina", () => {
  it("separador do Windows casa com o do Linux", () => {
    // `data/` é o MESMO OneDrive no Neo (Windows) e no helios (Linux). Sem
    // isto, a detecção de sobreposição seria cega exatamente no cenário que a
    // issue chama de caso normal.
    assert.equal(normalizeBeaconPath("scripts\\lib\\session-registry.ts"), "scripts/lib/session-registry.ts");
    assert.ok(beaconPathsOverlap("scripts\\lib\\a.ts", "scripts/lib/a.ts"));
  });

  it("prefixo de DIRETÓRIO sobrepõe; prefixo de STRING não", () => {
    assert.ok(beaconPathsOverlap("scripts/lib", "scripts/lib/session-registry.ts"));
    // O caso que o colapso por prefixo poderia estragar: `scripts/lib` não
    // pode casar `scripts/libreria`.
    assert.equal(beaconPathsOverlap("scripts/lib", "scripts/libreria/x.ts"), false);
  });

  it("caminho vazio nunca sobrepõe nada", () => {
    assert.equal(beaconPathsOverlap("", "scripts/a.ts"), false);
    assert.equal(beaconPathsOverlap("scripts/a.ts", ""), false);
  });
});

describe("#6168 — teto de touched_paths colapsa em vez de truncar", () => {
  it("abaixo do teto: preserva tudo, ordenado e sem duplicata", () => {
    const out = collapseTouchedPaths(["b.ts", "a.ts", "a.ts"], 10);
    assert.deepEqual(out, ["a.ts", "b.ts"]);
  });

  it("acima do teto: colapsa pra prefixo de diretório, preservando o sinal de área", () => {
    // Truncar perderia a informação de que a sessão mexeu naquela área —
    // que é justamente o que `findSessionConflicts` consome.
    const many = Array.from({ length: 50 }, (_, i) => `scripts/lib/mod${i}.ts`);
    const out = collapseTouchedPaths(many, 5);
    assert.ok(out.length <= 5);
    assert.ok(
      out.every((p) => "scripts/lib/mod0.ts".startsWith(p) || p.startsWith("scripts")),
      `colapso deveria manter o prefixo da área, veio: ${JSON.stringify(out)}`,
    );
    // E o sinal sobrevive: um caminho concreto daquela área ainda sobrepõe.
    assert.ok(out.some((p) => beaconPathsOverlap("scripts/lib/mod7.ts", p)));
  });

  it("é determinístico — mesma entrada, mesma saída", () => {
    const many = Array.from({ length: 40 }, (_, i) => `a/b/c/f${i}.ts`);
    assert.deepEqual(collapseTouchedPaths(many, 3), collapseTouchedPaths([...many].reverse(), 3));
  });
});

// ─── Parte C: conflicts ────────────────────────────────────────────────────

describe("#6168 Parte C — conflicts é consulta, e nunca cria arquivo", () => {
  it("rodar conflicts não escreve NADA em data/sessions/", () => {
    // Critério de aceite explícito da issue: nada além de `.merge-lock.json`
    // pode aparecer ali. `conflicts` responde, nunca adquire.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "eu", { tag: LOCAL_TAG });
      const antes = readdirSync(join(root, "data", "sessions")).sort();
      findSessionConflicts(listActiveSessions(root, NOW), {
        sessionId: "eu",
        paths: ["scripts/lib/a.ts"],
        branch: "develop/fix-1",
      });
      assert.deepEqual(readdirSync(join(root, "data", "sessions")).sort(), antes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sobreposição de caminho com peer VIVO → conflito", () => {
    const conflicts = findSessionConflicts(
      [peer({ kind: "overnight", sessionId: "outro", touched_paths: ["scripts/lib/session-registry.ts"] })],
      { sessionId: "eu", paths: ["scripts/lib/session-registry.ts"] },
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.kind, "path-overlap");
    assert.equal(conflicts[0]!.peer?.sessionId, "outro");
  });

  it("o MESMO peer, mas STALE → nenhum conflito", () => {
    // Mesma semântica que `isIssueClaimedByOther` já aplica (#5474).
    const conflicts = findSessionConflicts(
      [
        peer({
          kind: "overnight",
          sessionId: "outro",
          touched_paths: ["scripts/lib/session-registry.ts"],
          stale: true,
        }),
      ],
      { sessionId: "eu", paths: ["scripts/lib/session-registry.ts"] },
    );
    assert.deepEqual(conflicts, []);
  });

  it("dirty_paths (não commitado) é reportado como o sinal mais forte", () => {
    // Evidência 2 da issue: um tick terminou deixando 4 arquivos sem commit em
    // master num checkout compartilhado e reportou "concluído". Um beacon que
    // só dissesse `last_action: "commit"` não distinguiria isso.
    const conflicts = findSessionConflicts(
      [peer({ kind: "continuo", sessionId: "tick", dirty_paths: ["scripts/lib/x.ts"] })],
      { sessionId: "eu", paths: ["scripts/lib/x.ts"] },
    );
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]!.detail, /NÃO COMMITADA/);
  });

  it("nunca conflita consigo mesma", () => {
    const conflicts = findSessionConflicts(
      [peer({ kind: "develop", sessionId: "eu", touched_paths: ["a.ts"], branch: "b" })],
      { sessionId: "eu", paths: ["a.ts"], branch: "b" },
    );
    assert.deepEqual(conflicts, []);
  });

  it("branch-drift: a branch registrada não é mais a do checkout", () => {
    // Evidência 5 da issue: entre o `checkout -b` e o `commit`, outra sessão
    // trocou o checkout pra master e deu pull. O commit caiu em master, e
    // `commit`/`push` reportaram SUCESSO — nenhum sinal de erro em lugar
    // nenhum. Esta é a checagem barata de "a branch ainda é minha?".
    const conflicts = findSessionConflicts([], {
      sessionId: "eu",
      branch: "master",
      ownRecord: peer({ kind: "develop", sessionId: "eu", branch: "fix/6193-teste" }),
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.kind, "branch-drift");
    // "branch-drift não tem peer" deixou de ser asserção de runtime e virou
    // garantia de COMPILADOR no #6303: `SessionConflict` é union discriminada,
    // e o branch `branch-drift` sequer declara o campo. Tentar ler
    // `conflicts[0].peer` aqui não compila mais — que é exatamente o ponto.
    assert.ok(!("peer" in conflicts[0]!), "branch-drift é sobre o próprio registro, não sobre peer");
  });

  it("branch-shared só conta na MESMA máquina", () => {
    // Máquinas diferentes têm checkouts diferentes; homônimo de branch ali
    // não colide.
    const mesma = findSessionConflicts([peer({ kind: "develop", sessionId: "o", branch: "x", machineTag: "Neo" })], {
      sessionId: "eu",
      branch: "x",
      machineTag: "Neo",
    });
    assert.equal(mesma.some((c) => c.kind === "branch-shared"), true);

    const outra = findSessionConflicts(
      [peer({ kind: "develop", sessionId: "o", branch: "x", machineTag: "helios" })],
      { sessionId: "eu", branch: "x", machineTag: "Neo" },
    );
    assert.equal(outra.some((c) => c.kind === "branch-shared"), false);
  });

  it("sem caminhos e sem branch → nenhum conflito (consulta vazia é silenciosa)", () => {
    assert.deepEqual(
      findSessionConflicts([peer({ kind: "overnight", sessionId: "o", touched_paths: ["a.ts"] })], {
        sessionId: "eu",
      }),
      [],
    );
  });
});

// ─── #6296: concessão de janela de merge ───────────────────────────────────

describe("#6296 — concessão de janela: só coordenadora, nunca a si mesma", () => {
  it("uma sessão NÃO concede janela a si mesma", () => {
    // É o invariante que preserva a propriedade que o #5716 protege (a
    // coordenadora decide quando entra merge) em vez de contorná-la — sem
    // ele, "conceder a si mesma" seria relabel com outro nome.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "eu", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "develop", "eu", "eu");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "self-grant-refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sessão interativa NÃO concede janela a ninguém", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "interactive", "i1", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "interactive", "i1", "outra");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "not-a-coordinator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coordenadora concede, o beneficiário encontra, e é USO ÚNICO", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6278 }).ok, true);

      const found = findLiveMergeGrant(root, "interativa");
      assert.ok(found, "beneficiário deveria encontrar a janela viva");
      assert.equal(found?.grant.pr, 6278);

      assert.equal(consumeMergeGrant(root, "interativa"), true);
      assert.equal(findLiveMergeGrant(root, "interativa"), null, "consumida não vale mais");
      assert.equal(consumeMergeGrant(root, "interativa"), false, "consumir de novo é no-op honesto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a janela expira pelo TTL", () => {
    const grant = { grantedTo: "x", grantedBy: "coord", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "x", NOW), true);
    assert.equal(isMergeGrantLive(grant, "x", NOW + MERGE_GRANT_TTL_MS + 1), false);
  });

  it("janela emitida pra OUTRA sessão não vale pra mim", () => {
    const grant = { grantedTo: "outra", grantedBy: "coord", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "eu", NOW), false);
  });

  it("auto-concessão gravada À MÃO no arquivo continua sem valer", () => {
    // Defesa em profundidade: o guard de `grantMergeWindow` impede criar,
    // este impede honrar uma que apareça por outro caminho.
    const grant = { grantedTo: "eu", grantedBy: "eu", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "eu", NOW), false);
  });

  it("nenhum ARQUIVO novo aparece em data/sessions/ — a concessão é campo do record", () => {
    // Critério de aceite do #6168 combinado com a proposta do #6296
    // ("arquivo dedicado OU campo no próprio record"): campo satisfaz os dois.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      const antes = readdirSync(join(root, "data", "sessions")).sort();
      grantMergeWindow(root, "develop", "coord", "outra", { pr: 1 });
      assert.deepEqual(readdirSync(join(root, "data", "sessions")).sort(), antes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #7303 — auto-autorização quando a única coordenadora ativa é `continuo`
// (cron, não conversa — grant-merge normal é inalcançável) ─────────────────

describe("#7303 — selfAuthorizeMerge: escopo estreito, nunca abre mão de proteção existente", () => {
  it("recusa sem --reason (não-vazio) — nunca uma auto-autorização silenciosa", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "eu", { tag: LOCAL_TAG });
      assert.equal(selfAuthorizeMerge(root, "eu", { reason: "" }).reason, "reason-required");
      assert.equal(selfAuthorizeMerge(root, "eu", { reason: "   " }).reason, "reason-required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa quando não há coordenadora nenhuma ativa — nada pra contornar", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "interactive", "eu", { tag: LOCAL_TAG });
      const r = selfAuthorizeMerge(root, "eu", { reason: "teste" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "no-active-coordinator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa quando quem chama já É coordenadora registrada — já tem direito próprio", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      registerSession(root, "develop", "eu-coord", { tag: LOCAL_TAG });
      const r = selfAuthorizeMerge(root, "eu-coord", { reason: "teste" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "caller-is-coordinator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa quando há coordenadora QUE CONVERSA ativa (overnight/develop) — o caminho normal grant-merge continua sendo o único", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      registerSession(root, "overnight", "coord-responsivo", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "eu", { tag: LOCAL_TAG });
      const r = selfAuthorizeMerge(root, "eu", { reason: "teste" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "responsive-coordinator-active");
      assert.deepEqual(r.coordinatorKinds, ["overnight"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recusa (session-not-registered) quando quem chama não tem NENHUM registro em data/sessions/", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      // "eu" nunca chamou register/beacon — não existe arquivo pra ela.
      const r = selfAuthorizeMerge(root, "eu-nao-registrada", { reason: "teste" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "session-not-registered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caso feliz: única coordenadora é continuo → autoriza e grava self_authorized_merge no PRÓPRIO record", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "eu", { tag: LOCAL_TAG });
      const r = selfAuthorizeMerge(root, "eu", {
        reason: "única coordenadora ativa é continuo, sem interlocutor",
        pr: 7273,
      });
      assert.equal(r.ok, true);
      assert.equal(r.reason, "authorized");
      assert.equal(r.record?.pr, 7273);

      // Gravado no PRÓPRIO record de "eu" — nunca no de "cron-1".
      const sessions = listActiveSessions(root);
      const mine = sessions.find((s) => s.sessionId === "eu");
      assert.ok(mine?.self_authorized_merge);
      assert.equal(mine!.self_authorized_merge!.pr, 7273);
      assert.equal(mine!.self_authorized_merge!.reason, "única coordenadora ativa é continuo, sem interlocutor");

      const cron = sessions.find((s) => s.sessionId === "cron-1");
      assert.equal(cron?.self_authorized_merge, undefined, "nunca no record da coordenadora");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2 coordenadoras continuo, nenhuma overnight/develop → ainda autoriza", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "continuo", "cron-1", { tag: LOCAL_TAG });
      registerSession(root, "continuo", "cron-2", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "eu", { tag: LOCAL_TAG });
      assert.equal(selfAuthorizeMerge(root, "eu", { reason: "teste" }).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#7303 — isSelfAuthorizedMergeLive (pura)", () => {
  it("dentro do TTL → true", () => {
    const record = { reason: "x", authorizedAt: new Date(NOW).toISOString() };
    assert.equal(isSelfAuthorizedMergeLive(record, NOW), true);
  });

  it("além do TTL → false", () => {
    const record = { reason: "x", authorizedAt: new Date(NOW).toISOString() };
    assert.equal(isSelfAuthorizedMergeLive(record, NOW + MERGE_GRANT_TTL_MS + 1), false);
  });

  it("undefined → false", () => {
    assert.equal(isSelfAuthorizedMergeLive(undefined, NOW), false);
  });

  it("timestamp ilegível → false", () => {
    assert.equal(isSelfAuthorizedMergeLive({ reason: "x", authorizedAt: "não é data" }, NOW), false);
  });
});

// ─── #7043 — merge_grant é campo único: não sobrescrever uma concessão viva
// em silêncio (achado 1, dois caminhos medidos ao vivo) ────────────────────

describe("#7043 achado 1 (1º caminho) — grant-merge não sobrescreve a PRÓPRIA concessão viva em silêncio", () => {
  it("cenário medido ao vivo: conceder PR#6955 e depois PR#6959 à mesma sessão — a 2ª é RECUSADA", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      const r1 = grantMergeWindow(root, "develop", "coord", "beneficiaria", { pr: 6955 });
      assert.equal(r1.ok, true);

      const r2 = grantMergeWindow(root, "develop", "coord", "beneficiaria", { pr: 6959 });
      assert.equal(r2.ok, false, "sem --force, a 2ª concessão de identidade diferente deve ser RECUSADA");
      assert.equal(r2.reason, "live-grant-would-be-overwritten");

      // A 1ª concessão continua viva e utilizável — é exatamente o que o
      // #7043 media como perdido em silêncio (grant-merge respondia "ok" nas
      // duas chamadas, e a beneficiária original nunca sabia que a janela
      // dela tinha sumido).
      const found = findLiveMergeGrant(root, "beneficiaria");
      assert.ok(found, "a concessão original (PR#6955) deveria continuar viva");
      assert.equal(found?.grant.pr, 6955);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconceder a MESMA identidade (renovar grantedAt) não precisa de --force", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "develop", "coord", "beneficiaria", { pr: 1 }).ok, true);
      // Mesmo grantedTo + mesmo pr: não é a classe de sobrescrita perigosa
      // que o #7043 mede — é renovação da mesma janela.
      const r2 = grantMergeWindow(root, "develop", "coord", "beneficiaria", { pr: 1 });
      assert.equal(r2.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--force sobrescreve deliberadamente uma concessão viva de outra identidade", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "develop", "coord", "b1", { pr: 1 }).ok, true);
      const r2 = grantMergeWindow(root, "develop", "coord", "b2", { pr: 2, force: true });
      assert.equal(r2.ok, true, "--force deve permitir a sobrescrita deliberada");
      assert.equal(findLiveMergeGrant(root, "b1"), null, "a concessão antiga foi legitimamente substituída");
      assert.ok(findLiveMergeGrant(root, "b2"), "a nova concessão deve estar viva");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão anterior já EXPIRADA (fora do TTL) não bloqueia a próxima", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      const r1 = grantMergeWindow(root, "develop", "coord", "b1", {
        pr: 1,
        now: isoAgo(MERGE_GRANT_TTL_MS + 5_000),
      });
      assert.equal(r1.ok, true);
      const r2 = grantMergeWindow(root, "develop", "coord", "b2", { pr: 2, now: new Date(NOW).toISOString() });
      assert.equal(r2.ok, true, "concessão expirada não é 'viva' — não bloqueia a próxima");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão anterior já CONSUMIDA não bloqueia a próxima", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "develop", "coord", "b1", { pr: 1 }).ok, true);
      assert.equal(consumeMergeGrant(root, "b1"), true);
      const r2 = grantMergeWindow(root, "develop", "coord", "b2", { pr: 2 });
      assert.equal(r2.ok, true, "concessão já consumida não é 'viva' — não bloqueia a próxima");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#7043 achado 1 (2º caminho) — duas coordenadoras não concedem o MESMO PR sem se enxergar", () => {
  it("cenário medido ao vivo: duas coordenadoras concedem o mesmo PR, 20s de diferença — a 2ª é RECUSADA", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });

      const r1 = grantMergeWindow(root, "overnight", "coord-a", "beneficiaria-a", { pr: 6988 });
      assert.equal(r1.ok, true);

      const r2 = grantMergeWindow(root, "develop", "coord-b", "beneficiaria-b", { pr: 6988 });
      assert.equal(r2.ok, false, "sem --force, uma 2ª coordenadora não pode conceder o mesmo PR já concedido");
      assert.equal(r2.reason, "pr-already-granted-elsewhere");

      // A concessão da coord-a continua viva — nenhuma das duas foi apagada
      // em silêncio pela outra.
      const found = findLiveMergeGrant(root, "beneficiaria-a");
      assert.ok(found, "a concessão da coord-a deveria continuar viva");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--force permite conceder o mesmo PR mesmo com outra concessão viva", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      assert.equal(grantMergeWindow(root, "overnight", "coord-a", "beneficiaria-a", { pr: 1 }).ok, true);
      const r2 = grantMergeWindow(root, "develop", "coord-b", "beneficiaria-b", { pr: 1, force: true });
      assert.equal(r2.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessões pra PRs DIFERENTES nunca colidem entre coordenadoras", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      assert.equal(grantMergeWindow(root, "overnight", "coord-a", "beneficiaria-a", { pr: 1 }).ok, true);
      assert.equal(grantMergeWindow(root, "develop", "coord-b", "beneficiaria-b", { pr: 2 }).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão SEM --pr (genérica) nunca colide por PR — não tem identidade de PR pra comparar", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG, startedAt: isoAgo(60_000) });
      assert.equal(grantMergeWindow(root, "overnight", "coord-a", "beneficiaria-a").ok, true);
      assert.equal(grantMergeWindow(root, "develop", "coord-b", "beneficiaria-b").ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #6296: o guard passa a compor com lock e concessão ────────────────────

describe("#6296 — o guard de merge compõe com o lock e com a concessão", () => {
  const coords = new Set(["coord-a"]);

  it("sem coordenadora ativa → nunca bloqueia (comportamento pré-#6296)", () => {
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", {}), false);
  });

  it("caller sem session_id → nunca bloqueia (fail-open, inalterado)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "", {}), false);
  });

  it("não-coordenadora SEM concessão → bloqueia (comportamento pré-#6296)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "interativa", { mergeLockHolder: null }), true);
  });

  it("não-coordenadora COM concessão viva → PERMITE — é o caso medido em 260826", () => {
    // O protocolo inteiro da Parte F rodou (peer achado, SendMessage
    // entregue, colisão por arquivo conferida, janela concedida, lock
    // adquirido) e o merge foi bloqueado assim mesmo. Este é o teste que
    // trava a correção.
    assert.equal(shouldBlockGhPrMerge(coords, "interativa", { hasLiveGrant: true, mergeLockHolder: "interativa" }), false);
  });

  it("coordenadora com o lock nas mãos → permite", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: "coord-a" }), false);
  });

  it("coordenadora com o lock de OUTRA sessão → BLOQUEIA (defeito 1 do #6296)", () => {
    // `grep -c 'mergeLock\|merge-lock'` no hook devolvia 0: dois mecanismos
    // governavam a mesma ação sem se compor.
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: "outra-coord" }), true);
  });

  it("lock AUSENTE + ÚNICA coordenadora ativa → permite (rodada solo não quebra)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: null }), false);
  });

  it("lock AUSENTE + DUAS coordenadoras ativas → bloqueia (há contenção real)", () => {
    const duas = new Set(["coord-a", "coord-b"]);
    assert.equal(shouldBlockGhPrMerge(duas, "coord-a", { mergeLockHolder: null }), true);
  });

  it("estado do lock INDETERMINADO → permite, nunca vira bloqueio", () => {
    // `undefined` = não deu pra ler (I/O do OneDrive, JSON corrompido).
    // Nunca transformar falha transitória de leitura em bloqueio de merge
    // legítimo — é a razão de `readMergeLockHolder` distinguir `null` de
    // `undefined`.
    const duas = new Set(["coord-a", "coord-b"]);
    assert.equal(shouldBlockGhPrMerge(duas, "coord-a", { mergeLockHolder: undefined }), false);
  });
});

// ─── as constantes duplicadas no hook não divergem do módulo (#6303 L/M/J) ─

describe("#6303 — as cópias duplicadas em block-gh-pr-merge-subagent.mjs concordam com session-registry.ts", () => {
  // O hook é self-contained (.mjs, sem import de .ts) e mantém cópias
  // PRÓPRIAS de 3 constantes. Duas cópias sem teste que as compare de
  // verdade é a mesma dívida que o fleet review da #6303 (Findings L/M/J)
  // apontou noutros pares deste repo — mudar o valor num lado sozinho
  // deixaria os dois testes (cada um comparando só contra um literal)
  // verdes por coincidência. Aqui os dois módulos são importados lado a
  // lado e comparados de verdade.
  it("CLOCK_SKEW_TOLERANCE_MS", () => {
    assert.equal(HOOK_CLOCK_SKEW_TOLERANCE_MS, CLOCK_SKEW_TOLERANCE_MS);
  });
  it("MERGE_GRANT_TTL_MS", () => {
    assert.equal(HOOK_MERGE_GRANT_TTL_MS, MERGE_GRANT_TTL_MS);
  });
  it("MERGE_LOCK_TTL_MS", () => {
    assert.equal(HOOK_MERGE_LOCK_TTL_MS, MERGE_LOCK_TTL_MS);
  });
});

// ─── #6303 Finding T: consumo automático da concessão pós-merge ───────────

describe("#6303 Finding T — findLiveMergeGrantFile/buildConsumedRecord (funções puras)", () => {
  it("sem concessão nenhuma → null", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      assert.equal(findLiveMergeGrantFile(root, "interativa"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão viva → acha o arquivo, o record e o grant", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      const found = findLiveMergeGrantFile(root, "interativa");
      assert.ok(found);
      assert.equal(found.grant.grantedTo, "interativa");
      assert.equal(found.grant.pr, 6303);
      assert.ok(found.path.includes(`overnight-${LOCAL_TAG}-coord.json`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildConsumedRecord marca consumedAt e preserva o resto do grant/record", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      const found = findLiveMergeGrantFile(root, "interativa");
      const nowIso = new Date(NOW).toISOString();
      const updated = buildConsumedRecord(found, nowIso);
      assert.equal(updated.merge_grant.consumedAt, nowIso);
      assert.equal(updated.merge_grant.grantedTo, "interativa");
      assert.equal(updated.merge_grant.pr, 6303);
      assert.equal(updated.sessionId, "coord", "o resto do record da coordenadora sobrevive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão já consumida não é achada de novo (uso único de fato)", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      assert.equal(consumeMergeGrant(root, "interativa"), true);
      assert.equal(findLiveMergeGrantFile(root, "interativa"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6303 Finding T — CLI end-to-end via stdin real (mesmo padrão do #5161 item 10)", () => {
  function makeGitRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "consume-grant-e2e-"));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  it("session_id com concessão viva → consumedAt é gravado no arquivo da coordenadora", () => {
    const root = makeGitRepo();
    try {
      // Usa o relógio REAL (não o `NOW` fixo de 2026-08-26 usado no resto do
      // arquivo) porque o hook, spawnado como processo separado, resolve
      // `now = Date.now()` de verdade — misturar os dois faria a concessão
      // parecer expirada/no-futuro dependendo de quando a suíte rodar.
      const grantedAt = new Date().toISOString();
      const record = {
        kind: "overnight",
        machineTag: "Neo",
        sessionId: "coord",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
        merge_grant: { grantedTo: "interativa", grantedBy: "coord", grantedAt, pr: 6303 },
      };
      const path = join(root, "data", "sessions", `overnight-${LOCAL_TAG}-coord.json`);
      writeFileSync(path, JSON.stringify(record), "utf8");

      const payload = { session_id: "interativa", tool_name: "Bash", tool_input: { command: "gh pr merge 6303 --squash" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), "", "PostToolUse aqui nunca emite saída — side-effect puro");

      const updated = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(updated.merge_grant.consumedAt, "consumedAt deveria ter sido gravado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_id SEM concessão viva → no-op silencioso, arquivo intocado", () => {
    const root = makeGitRepo();
    try {
      const record = {
        kind: "overnight",
        machineTag: "Neo",
        sessionId: "coord",
        startedAt: isoAgo(60_000),
        lastHeartbeat: isoAgo(1_000),
      };
      const path = join(root, "data", "sessions", `overnight-${LOCAL_TAG}-coord.json`);
      const before = JSON.stringify(record);
      writeFileSync(path, before, "utf8");

      const payload = { session_id: "ninguem-tem-grant", tool_name: "Bash", tool_input: { command: "gh pr merge 1 --squash" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(path, "utf8"), before, "arquivo não deveria ser tocado sem concessão viva");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("payload SEM session_id → nada é escrito, nunca lança", () => {
    const root = makeGitRepo();
    try {
      const payload = { tool_name: "Bash", tool_input: { command: "gh pr merge 1" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(readdirSync(join(root, "data", "sessions")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #7286 — concessão consumida por sessão que NÃO é a beneficiária ──────
//
// Achado ao vivo na rodada 260902b: `merge_grant` concedido pela coordenadora
// overnight para a sessão INTERATIVA da edição (`grantedTo`), mas quem
// mergeou os PRs foi uma OUTRA sessão — `develop-Neo-...` — e `consumedAt`
// apareceu carimbado na concessão da interativa mesmo assim, que nunca
// chegou a mergear nada. A hipótese registrada na issue era que o hook de
// consumo não filtrava por `grantedTo`. Investigação (PR #7312): os 3
// caminhos de consumo (`consumeGrantUnderLock` aqui, `consumeMergeGrant` em
// session-registry.ts, e a leitura em `findLiveMergeGrantFor` do guard) já
// filtravam por identidade ANTES desse PR — a hipótese específica não bate
// com o código lido. Este bloco trava exatamente o cenário sugerido pela
// issue como teste de regressão: concessão viva pra A, sessão B (coordenadora
// registrada, SEM concessão) mergeia — a concessão de A continua viva e
// utilizável.
describe("#7286 — concessão consumida por TERCEIRO (sessão diferente da beneficiária)", () => {
  it("concessão viva pra sessão A; sessão B (coordenadora registrada) roda gh pr merge; a concessão de A NÃO é consumida", () => {
    const root = mkdtempSync(join(tmpdir(), "7286-third-party-consume-"));
    try {
      mkdirSync(join(root, "data", "sessions"), { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: root });

      // Coordenadora "coord-A" concede a janela do PR #7273 pra sessão
      // interativa "sess-A" — cenário idêntico ao medido ao vivo.
      const grantedAt = new Date().toISOString();
      const coordAPath = join(root, "data", "sessions", `overnight-${LOCAL_TAG}-coord-A.json`);
      writeFileSync(
        coordAPath,
        JSON.stringify({
          kind: "overnight",
          machineTag: LOCAL_TAG,
          sessionId: "coord-A",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
          merge_grant: { grantedTo: "sess-A", grantedBy: "coord-A", grantedAt, pr: 7273 },
        }),
        "utf8",
      );

      // Sessão B é uma coordenadora REGISTRADA e ativa por direito PRÓPRIO
      // (kind=develop) — nunca recebeu concessão nenhuma, mergeia por conta
      // do próprio `isCoordinator`, não por causa da concessão de A.
      const sessBPath = join(root, "data", "sessions", `develop-${LOCAL_TAG}-sess-B.json`);
      writeFileSync(
        sessBPath,
        JSON.stringify({
          kind: "develop",
          machineTag: LOCAL_TAG,
          sessionId: "sess-B",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
        }),
        "utf8",
      );

      // Sessão B roda `gh pr merge` — dispara o PostToolUse com
      // session_id="sess-B", nunca "sess-A".
      const payload = {
        session_id: "sess-B",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 7276 --squash" },
      };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");

      // A concessão de A permanece VIVA e UTILIZÁVEL — o terceiro (B) não a
      // consumiu, porque a busca do hook é por `grantedTo === payload.session_id`.
      const afterA = JSON.parse(readFileSync(coordAPath, "utf8"));
      assert.equal(afterA.merge_grant.consumedAt, undefined, "a concessão de A não deveria ter sido tocada por B");
      assert.equal(findLiveMergeGrant(root, "sess-A")?.grant.pr, 7273, "ainda viva e encontrável por sess-A");

      // E direto no nível mais baixo (consumeGrantUnderLock): chamar com o
      // sessionId de B nunca acha/consome a concessão de A.
      assert.equal(
        consumeGrantUnderLock(root, "sess-B"),
        false,
        "consumeGrantUnderLock(root, 'sess-B') não deveria achar nada pra consumir — a concessão é de A, não de B",
      );
      const afterDirect = JSON.parse(readFileSync(coordAPath, "utf8"));
      assert.equal(afterDirect.merge_grant.consumedAt, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #6303 review cruzado: dois bypasses P1 ────────────────────────────────

describe("#6303 P1·a — a concessão destrava IDENTIDADE, nunca TEMPO", () => {
  const coords = new Set(["coord-a"]);

  it("concessão NÃO pula o merge lock de outra sessão", () => {
    // Era o bypass: o ramo da concessão dava `return false` ANTES da checagem
    // de lock. Somado a `grantMergeWindow` não validar o kind de `grantedTo`,
    // uma coordenadora podia receber concessão de outra e pular a
    // serialização — reabrindo a corrida de merge duplo que o §DEFEITO 1
    // desta mesma unidade fecha.
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", {
        hasLiveGrant: true,
        mergeLockHolder: "outra-sessao",
      }),
      true,
    );
  });

  it("concessão + lock nas mãos da própria beneficiada → permite", () => {
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", {
        hasLiveGrant: true,
        mergeLockHolder: "beneficiada",
      }),
      false,
    );
  });

  it("concessão + lock AUSENTE + 1 coordenadora → bloqueia: há 2 sessões, logo contenção", () => {
    // A beneficiada não é a coordenadora, então existem duas sessões em jogo.
    // Ela também precisa passar pelo lock — corolário de "identidade, não tempo".
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", { hasLiveGrant: true, mergeLockHolder: null }),
      true,
    );
  });

  it("coordenadora sozinha, lock ausente → segue permitindo (rodada solo não quebrou)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: null }), false);
  });

  it("grantMergeWindow RECUSA conceder a outra coordenadora ATIVA", () => {
    // Defesa em profundidade: esta recusa responde "quem pode RECEBER"; a
    // reordenação no guard responde "quando pode USAR". Fechar só uma
    // deixaria a outra metade aberta a um merge_grant gravado por outro
    // caminho.
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "overnight", "coord-a", "coord-b", { pr: 1 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "grantee-is-coordinator-refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grantMergeWindow CONCEDE normalmente a sessão não-coordenadora", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "interativa", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "overnight", "coord-a", "interativa", { pr: 1 }).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6303 P1·b — varredura degradada a ZERO coordenadoras não permite", () => {
  it("size 0 + scan DEGRADADO → BLOQUEIA (pior caso de degradação)", () => {
    // O ramo `size === 0` rodava ANTES de `scanDegraded` ser lido em lugar
    // nenhum: `readdirSync` lançando, ou toda entrada falhando no parse,
    // era tratado igual a "não há rodada ativa" — com rodada real ativa e
    // apenas ilegível naquele instante.
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", { scanDegraded: true }), true);
  });

  it("size 0 + scan CONFIÁVEL → permite (sessão interativa comum, #5251)", () => {
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", { scanDegraded: false }), false);
  });

  it("lock INDETERMINADO + scan degradado → bloqueia (os dois sinais moram no mesmo diretório)", () => {
    assert.equal(
      shouldBlockGhPrMerge(new Set(["coord-a"]), "coord-a", {
        mergeLockHolder: undefined,
        scanDegraded: true,
      }),
      true,
    );
  });

  it("lock INDETERMINADO + scan saudável → PERMITE: 'indeterminado nunca bloqueia' segue valendo", () => {
    // O review pediu cruzar `undefined` com `scanDegraded`, não transformar
    // toda leitura falha em bloqueio — isso quebraria o fail-safe declarado
    // desta função desde o #6296.
    assert.equal(
      shouldBlockGhPrMerge(new Set(["coord-a", "coord-b"]), "coord-a", { mergeLockHolder: undefined }),
      false,
    );
  });
});

// ─── #6952 — o consume hook é o TERCEIRO escritor do registro ───────────────
//
// Achado da frota de review da PR #6969: o #6952 serializou
// `session-registry.ts` e `session-beacon.mjs` sobre `{path}.lock`, mas ESTE
// hook ficou de fora — e é ele quem grava `merge_grant.consumedAt` no caminho
// quente (o `consume-merge-grant` do CLI quase nunca roda de fato).
//
// Dois escritores serializados e um terceiro solto não é exclusão mútua. Pior:
// o que este perde é o `consumedAt`, e perdê-lo deixa uma concessão JÁ USADA
// viva pelo resto do TTL — uso duplo, o dano que o #6952 classifica como pior
// que a perda.
describe("#6952 — consume hook escreve sob o lock compartilhado", () => {
  const roots: string[] = [];
  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  function makeRootWithGrant(): { root: string; recordPath: string } {
    const root = mkdtempSync(join(tmpdir(), "consume-lock-6952-"));
    roots.push(root);
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    const recordPath = join(root, "data", "sessions", `overnight-${LOCAL_TAG}-coord-6952.json`);
    writeFileSync(
      recordPath,
      JSON.stringify({
        kind: "overnight",
        machineTag: LOCAL_TAG,
        sessionId: "coord-6952",
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        claimed_issues: [],
        merge_grant: {
          grantedTo: "benef-6952",
          grantedBy: "coord-6952",
          grantedAt: new Date().toISOString(),
          pr: 6952,
        },
      }),
      "utf8",
    );
    return { root, recordPath };
  }

  it("consome de verdade quando o lock está livre", () => {
    const { root, recordPath } = makeRootWithGrant();
    assert.equal(consumeGrantUnderLock(root, "benef-6952", "2026-09-01T12:00:00.000Z"), true);
    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(after.merge_grant.consumedAt, "2026-09-01T12:00:00.000Z");
    // E não deixou lock pra trás.
    assert.deepEqual(
      readdirSync(join(root, "data", "sessions")).filter((f) => f.endsWith(".lock")),
      [],
    );
  });

  it("NÃO escreve enquanto outro escritor segura o lock — e desiste fail-open", () => {
    const { root, recordPath } = makeRootWithGrant();
    const lockPath = `${recordPath}.lock`;
    closeSync(openSync(lockPath, "wx")); // outro escritor está na seção crítica

    const before = readFileSync(recordPath, "utf8");
    // Orçamento curto: prova que espera e desiste, sem gastar os 3×2s de
    // produção (ver os parâmetros em `consumeGrantUnderLock`).
    const ok = consumeGrantUnderLock(root, "benef-6952", "2026-09-01T12:00:00.000Z", 2, 150);

    assert.equal(ok, false, "com o lock retido não há como consumir — desiste em vez de atropelar");
    assert.equal(
      readFileSync(recordPath, "utf8"),
      before,
      "o hook escreveu com o lock retido — é assim que ele apaga a escrita concorrente do beacon",
    );
    unlinkSync(lockPath);
  });

  it("um lock ÓRFÃO (processo morto) não trava o consumo pra sempre", () => {
    const { root, recordPath } = makeRootWithGrant();
    const lockPath = `${recordPath}.lock`;
    closeSync(openSync(lockPath, "wx"));
    // Envelhece o lock além de STALE_LOCK_MS (60s): é o que sobra de um
    // processo morto com SIGKILL/OOM, que nunca rodou o `finally`.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    assert.equal(
      consumeGrantUnderLock(root, "benef-6952", "2026-09-01T12:00:00.000Z"),
      true,
      "lock órfão travou o consumo — um processo morto wedgearia o registro pra sempre",
    );
    assert.equal(
      JSON.parse(readFileSync(recordPath, "utf8")).merge_grant.consumedAt,
      "2026-09-01T12:00:00.000Z",
    );
  });

  it("uso único: consumir de novo é no-op (não regrava consumedAt)", () => {
    const { root, recordPath } = makeRootWithGrant();
    assert.equal(consumeGrantUnderLock(root, "benef-6952", "2026-09-01T12:00:00.000Z"), true);
    assert.equal(
      consumeGrantUnderLock(root, "benef-6952", "2026-09-01T12:30:00.000Z"),
      false,
      "a 2ª consumação não pode suceder — a concessão já não está viva",
    );
    assert.equal(
      JSON.parse(readFileSync(recordPath, "utf8")).merge_grant.consumedAt,
      "2026-09-01T12:00:00.000Z",
      "o consumedAt original foi sobrescrito pela 2ª chamada",
    );
  });
});

// ─── #7462 — consumedAt só conta quando está no ARQUIVO REAL ──────────────
//
// O #6952 fez `mergeSessionRecords` UNIR o `merge_grant` entre o arquivo real
// e as cópias `-safeBackup-*` do OneDrive, e a 2ª metade propagou
// `consumedAt` de QUALQUER cópia. Resultado: uma concessão que nunca foi
// consumida (nenhum `gh pr merge` succeed, nenhum `consume-merge-grant`)
// parecia já usada porque um backup carregava um `consumedAt` que o real
// nunca teve — `check-merge-grant` dizia `granted: true` e o gate de merge
// bloqueava de qualquer jeito, reproduzido 2× na sessão develop do Neo.
//
// O `consumedAt` é um carimbo de FATO (deixado pelo merge bem-sucedido), não
// um voto de maioria: só conta quando está no registro que o merge escreve.
// O gate (`block-gh-pr-merge-subagent.mjs`) lê SÓ arquivos reais (pula
// `-safeBackup-`), então o read-path precisa concordar com ele.
describe("#7462 — consumedAt é testemunha do real, nunca de backup", () => {
  const BENEF = "benef-7462";
  const coord = "coord-7462";
  const grantedAt = isoAgo(60_000);

  function grantRecord(consumedAt?: string) {
    return {
      kind: "overnight" as const,
      machineTag: "Neo",
      sessionId: coord,
      startedAt: isoAgo(60_000),
      lastHeartbeat: isoAgo(60_000),
      merge_grant: { grantedTo: BENEF, grantedBy: coord, grantedAt, pr: 7462, ...(consumedAt ? { consumedAt } : {}) },
    };
  }

  it("real VIVO + backup CONSUMIDO → concessão continua viva (o backup é detrito)", () => {
    const root = makeTempRepo();
    try {
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}.json`), JSON.stringify(grantRecord()), "utf8");
      writeFileSync(
        join(sessionsDir(root), `overnight-Neo-${coord}-safeBackup-0001.json`),
        JSON.stringify(grantRecord(isoAgo(30_000))),
        "utf8",
      );
      const found = findLiveMergeGrant(root, BENEF, NOW);
      assert.ok(found, "concessão viva no real não pode ser matada por um backup consumido");
      assert.equal(found?.source, "real");
      // O gate lê só o real — e o real está vivo.
      assert.ok(readLiveMergeGrantFor(root, BENEF, NOW), "o gate honra a concessão");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CONSUMIDO + backup VIVO → concessão morta (o real é quem testemunha)", () => {
    const root = makeTempRepo();
    try {
      writeFileSync(
        join(sessionsDir(root), `overnight-Neo-${coord}.json`),
        JSON.stringify(grantRecord(isoAgo(30_000))),
        "utf8",
      );
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}-safeBackup-0001.json`), JSON.stringify(grantRecord()), "utf8");
      assert.equal(findLiveMergeGrant(root, BENEF, NOW), null, "real consumido mata a concessão, mesmo com backup vivo");
      assert.equal(readConsumedGrantFor(root, BENEF, NOW)?.pr, 7462, "o gate vê o consumo no real");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("órfão (só backup) com consumedAt → concessão continua viva (#6972: sem real, não há testemunha)", () => {
    const root = makeTempRepo();
    try {
      writeFileSync(
        join(sessionsDir(root), `overnight-Neo-${coord}-safeBackup-0001.json`),
        JSON.stringify(grantRecord(isoAgo(30_000))),
        "utf8",
      );
      const found = findLiveMergeGrant(root, BENEF, NOW);
      assert.ok(found, "grupo órfão sem real: o grant é considerado vivo, como o #6972 decide pro merge_grant inteiro");
      assert.equal(found?.source, "backup");
      assert.equal(readLiveMergeGrantFor(root, BENEF, NOW), null, "o gate não honra grant que só vive em detrito — pedir reconcessão");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real e backup ambos vivos → vivo, fonte real", () => {
    const root = makeTempRepo();
    try {
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}.json`), JSON.stringify(grantRecord()), "utf8");
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}-safeBackup-0001.json`), JSON.stringify(grantRecord()), "utf8");
      const found = findLiveMergeGrant(root, BENEF, NOW);
      assert.ok(found);
      assert.equal(found?.source, "real");
      assert.ok(readLiveMergeGrantFor(root, BENEF, NOW), "o gate honra");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real e backup ambos consumidos → morta", () => {
    const root = makeTempRepo();
    try {
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}.json`), JSON.stringify(grantRecord(isoAgo(30_000))), "utf8");
      writeFileSync(join(sessionsDir(root), `overnight-Neo-${coord}-safeBackup-0001.json`), JSON.stringify(grantRecord(isoAgo(30_000))), "utf8");
      assert.equal(findLiveMergeGrant(root, BENEF, NOW), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puramente unitário: mergeSessionRecords não propaga consumedAt de backup", () => {
    const real = grantRecord();
    const backup = grantRecord(isoAgo(30_000));
    const merged = mergeSessionRecords([real, backup]);
    assert.equal(merged.merge_grant?.consumedAt, undefined, "o real não tem consumedAt → o mesclado não pode ter");
    const mergedReversed = mergeSessionRecords([backup, real], 1);
    assert.equal(mergedReversed.merge_grant?.consumedAt, undefined, "realIndex=1 salta o backup e lê o real");
    const mergedOrphan = mergeSessionRecords([backup], -1);
    assert.equal(mergedOrphan.merge_grant?.consumedAt, undefined, "órfão (realIndex=-1): vivo, nunca consumido");
  });

  // #7462 (correção do próprio test): o VENCEDOR da união é um backup com um
  // `consumedAt` que o real nunca teve — mesma concessão em duas cópias
  // (mesma tripla de identidade), mas só o backup carrega o carimbo.
  // `{ ...winner }` espalha o `consumedAt` do próprio winner, então sem a
  // correção este caso saía consumido de qualquer jeito — e é este caso que
  // a issue relata com `realIndex=1` (real na posição 1) e `realIndex=-1`
  // (grupo órfão, só backups).
  it("winner é um backup com consumedAt falso → o mesclado NÃO herda esse carimbo", () => {
    const real = grantRecord(); // vivo, sem consumedAt
    const consumedBackup = grantRecord(isoAgo(30_000)); // mesma concessão, mas com um consumedAt que o real nunca teve
    // O backup é o winner (grants[0]) e o real está na posição 1.
    const merged = mergeSessionRecords([consumedBackup, real], 1);
    assert.equal(
      merged.merge_grant?.consumedAt,
      undefined,
      "o winner é um backup com consumedAt falso: o real (vivo) é quem testemunha, então o mesclado sai vivo",
    );
  });
});
