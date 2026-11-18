/**
 * #13301 — a coordenadora some da varredura do merge guard enquanto o rclone
 * bisync renomeia o registro dela para `{nome}.json.conflictN`.
 *
 * Rodada 261116b: `merge_guard_decision` às 12:32:22Z com
 * `sessionFoundInCoordinators: false` e `scanDegraded: false`; 12 s depois a
 * mesma sessão aparecia. O bisync rodava na janela, e o disco ficou com
 * `overnight-300-c9b75947….json.conflict1/.conflict2` sem o arquivo real.
 * A varredura só aceitava `name.endsWith(".json")`, então a cópia era
 * invisível e o merge legítimo da coordenadora saiu `not-authorized`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyMergeBlockCause,
  liveRecordFromConflictCopies,
  machineTag,
  rcloneConflictOriginalName as hookOriginalName,
  readActiveCoordinatorScan,
  readLiveInteractiveRegistrationFor,
  readLiveMergeGrantFor,
  sessionsDir,
  // @ts-expect-error TS7016: o hook .mjs não tem .d.mts (mesmo caso da suíte block-gh-pr-merge-subagent-hook).
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import { rcloneConflictOriginalName as tsOriginalName } from "../scripts/lib/sync-conflict-copy.ts";

const NOW = Date.parse("2026-11-16T12:32:22.000Z");
const MIN = 60 * 1000;
const TAG = machineTag();
const SID = "c9b75947-0000-4000-8000-000000000001";
const REAL = `overnight-${TAG}-${SID}.json`;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `merge-guard-13301-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function write(root: string, name: string, content: unknown): void {
  writeFileSync(join(sessionsDir(root), name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

function coordinator(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "overnight",
    sessionId: SID,
    machineTag: TAG,
    startedAt: new Date(NOW - 120 * MIN).toISOString(),
    lastHeartbeat: new Date(NOW - 2 * MIN).toISOString(),
    ...extra,
  };
}

describe("readActiveCoordinatorScan aceita .json.conflictN como liveness (#13301)", () => {
  it("diretório só com a .conflict1 da coordenadora → sessão ativa, varredura limpa", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator());
    const scan = readActiveCoordinatorScan(root, NOW);
    assert.deepEqual(scan.ids, new Set([SID]));
    assert.equal(scan.kinds.get(SID), "overnight");
    assert.equal(scan.degraded, false);
    assert.deepEqual(scan.viaConflictCopy, new Set([SID]));
  });

  it("o cenário da recusa: a coordenadora deixa de sair not-authorized", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator({ lastHeartbeat: new Date(NOW - 5 * MIN).toISOString() }));
    write(root, `${REAL}.conflict2`, coordinator());
    const scan = readActiveCoordinatorScan(root, NOW, { crossMachine: true });
    const cause = classifyMergeBlockCause(scan.ids, SID, {
      mergeLockHolder: SID,
      scanDegraded: scan.degraded,
      callerInLinkedWorktree: false,
    });
    assert.equal(cause, null);
  });

  it("subagente (worktree vinculado) com o mesmo session_id continua vetado", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator());
    const scan = readActiveCoordinatorScan(root, NOW, { crossMachine: true });
    const cause = classifyMergeBlockCause(scan.ids, SID, {
      mergeLockHolder: SID,
      scanDegraded: scan.degraded,
      callerInLinkedWorktree: true,
    });
    assert.equal(cause, "not-authorized");
  });

  it("registro novo NÃO nasce da cópia: conteúdo com identidade diferente do nome é descartado", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator({ sessionId: "intrusa" }));
    write(root, `${REAL}.conflict2`, coordinator({ kind: "develop" }));
    write(root, `${REAL}.conflict3`, coordinator({ machineTag: "outra-maquina" }));
    const scan = readActiveCoordinatorScan(root, NOW, { crossMachine: true });
    assert.deepEqual(scan.ids, new Set());
    assert.equal(scan.degraded, false);
  });

  it("cópia de nome que não é de sessão (sem identidade) não vira coordenadora", () => {
    const root = freshRoot();
    write(root, "qualquer-coisa.json.conflict1", coordinator());
    assert.deepEqual(readActiveCoordinatorScan(root, NOW, { crossMachine: true }).ids, new Set());
  });

  it("com o real presente, o real decide: real parado + cópia fresca → inativa", () => {
    const root = freshRoot();
    write(root, REAL, coordinator({ lastHeartbeat: new Date(NOW - 200 * MIN).toISOString() }));
    write(root, `${REAL}.conflict1`, coordinator());
    const scan = readActiveCoordinatorScan(root, NOW);
    assert.deepEqual(scan.ids, new Set());
    assert.deepEqual(scan.viaConflictCopy, new Set());
  });

  it("real presente e vivo: conta uma vez, sem viaConflictCopy", () => {
    const root = freshRoot();
    write(root, REAL, coordinator());
    write(root, `${REAL}.conflict1`, coordinator({ attended: false }));
    const scan = readActiveCoordinatorScan(root, NOW);
    assert.deepEqual(scan.ids, new Set([SID]));
    assert.deepEqual(scan.viaConflictCopy, new Set());
    assert.equal(scan.attended.has(SID), false); // o real não traz `attended`
  });

  it("cópia com endedAt encerra a sessão (endSession carimba as cópias antes de apagar o real)", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator({ lastHeartbeat: new Date(NOW - 10 * MIN).toISOString() }));
    write(root, `${REAL}.conflict2`, coordinator({ endedAt: new Date(NOW - 3 * MIN).toISOString() }));
    assert.deepEqual(readActiveCoordinatorScan(root, NOW).ids, new Set());
  });

  it("heartbeat posterior ao endedAt volta a contar como vida (#13114)", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator({ endedAt: new Date(NOW - 10 * MIN).toISOString() }));
    write(root, `${REAL}.conflict2`, coordinator({ lastHeartbeat: new Date(NOW - 1 * MIN).toISOString() }));
    assert.deepEqual(readActiveCoordinatorScan(root, NOW).ids, new Set([SID]));
  });

  it("cópia com heartbeat além da janela de liveness não conta", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, coordinator({ lastHeartbeat: new Date(NOW - 200 * MIN).toISOString() }));
    assert.deepEqual(readActiveCoordinatorScan(root, NOW).ids, new Set());
  });

  it("cópia de outra máquina respeita o filtro por máquina (só entra com crossMachine)", () => {
    const root = freshRoot();
    const other = `overnight-neo-${SID}.json`;
    write(root, `${other}.conflict1`, coordinator({ machineTag: "neo" }));
    assert.deepEqual(readActiveCoordinatorScan(root, NOW).ids, new Set());
    assert.deepEqual(readActiveCoordinatorScan(root, NOW, { crossMachine: true }).ids, new Set([SID]));
  });

  it("cópia com JSON malformado é ignorada sem degradar a varredura", () => {
    const root = freshRoot();
    write(root, `${REAL}.conflict1`, "{não é json");
    const scan = readActiveCoordinatorScan(root, NOW);
    assert.deepEqual(scan.ids, new Set());
    assert.equal(scan.degraded, false);
  });

  it("cópia de -safeBackup- com sufixo rclone fica de fora, como o -safeBackup- puro", () => {
    const root = freshRoot();
    write(root, `overnight-${TAG}-${SID}-${TAG}-safeBackup-0001.json.conflict1`, coordinator());
    assert.deepEqual(readActiveCoordinatorScan(root, NOW).ids, new Set());
  });
});

describe("liveRecordFromConflictCopies (#13301)", () => {
  it("escolhe o heartbeat mais recente entre as cópias vivas", () => {
    const older = coordinator({ lastHeartbeat: new Date(NOW - 9 * MIN).toISOString(), attended: true });
    const newer = coordinator({ lastHeartbeat: new Date(NOW - 1 * MIN).toISOString(), attended: false });
    assert.equal(liveRecordFromConflictCopies(REAL, [older, newer]), newer);
  });

  it("endedAt ilegível conta como encerramento", () => {
    assert.equal(liveRecordFromConflictCopies(REAL, [coordinator({ endedAt: "lixo" }), coordinator()]), null);
  });

  it("entrada inválida devolve null", () => {
    assert.equal(liveRecordFromConflictCopies(REAL, []), null);
    assert.equal(liveRecordFromConflictCopies(REAL, [null, 3, "x"] as unknown[]), null);
  });
});

describe("readLiveInteractiveRegistrationFor aceita .json.conflictN (#13301)", () => {
  const ISID = "11111111-2222-4333-8444-555555555555";
  const IREAL = `interactive-${TAG}-${ISID}.json`;
  const interactive = (extra: Record<string, unknown> = {}) => ({
    kind: "interactive",
    sessionId: ISID,
    machineTag: TAG,
    lastHeartbeat: new Date(NOW - 1 * MIN).toISOString(),
    ...extra,
  });

  it("só a cópia, identidade batendo → registro vivo", () => {
    const root = freshRoot();
    write(root, `${IREAL}.conflict2`, interactive());
    assert.equal(readLiveInteractiveRegistrationFor(root, ISID, NOW), true);
  });

  it("cópia de coordenadora com o mesmo id não prova sessão interativa", () => {
    const root = freshRoot();
    write(root, `overnight-${TAG}-${ISID}.json.conflict1`, interactive({ kind: "overnight" }));
    assert.equal(readLiveInteractiveRegistrationFor(root, ISID, NOW), false);
  });

  it("cópia parada ou encerrada não conta", () => {
    const root = freshRoot();
    write(root, `${IREAL}.conflict1`, interactive({ lastHeartbeat: new Date(NOW - 60 * MIN).toISOString() }));
    write(root, `${IREAL}.conflict2`, interactive({ endedAt: new Date(NOW).toISOString() }));
    assert.equal(readLiveInteractiveRegistrationFor(root, ISID, NOW), false);
  });
});

describe("concessão de merge nunca vem de cópia .json.conflictN (#13301)", () => {
  it("cópia com merge_grant vivo e real ausente → sem concessão", () => {
    const root = freshRoot();
    write(
      root,
      `${REAL}.conflict1`,
      coordinator({
        merge_grant: { grantedTo: "beneficiaria", grantedBy: SID, grantedAt: new Date(NOW - 1 * MIN).toISOString() },
      }),
    );
    assert.equal(readLiveMergeGrantFor(root, "beneficiaria", NOW), null);
  });
});

describe("paridade de rcloneConflictOriginalName hook × scripts/lib/sync-conflict-copy.ts (#13301)", () => {
  for (const name of [
    "s.json.conflict1",
    "s.json.conflict12",
    "noext.conflict1",
    "arch.tar.gz.conflict3",
    ".conflict1",
    "s.json",
    "s.json.conflict",
    "s.json.conflictx",
    "s.json.conflict1.bak",
  ]) {
    it(name, () => {
      assert.equal(hookOriginalName(name), tsOriginalName(name));
    });
  }
});
