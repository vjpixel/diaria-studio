/**
 * test/block-pr-create-orchestrator-snapshot-stale-e2e-9714.test.ts (#9714 item 3)
 *
 * Lacuna: os testes do hook `block-pr-create-orchestrator-snapshot-stale.mjs`
 * (#8732) usam um spawn FALSO com o texto antigo da falha ("Orchestrator
 * content changed"), anterior ao formato por playbook do #9709. Nada provava
 * de ponta a ponta que, com o snapshot v2, o hook (a) ainda acha o teste pelo
 * filtro `snapshot.hash`, (b) reprova quando um playbook muda e (c) entrega na
 * mensagem de recusa o playbook divergente, os 2 hashes e o comando de
 * regeneração.
 *
 * Aqui o `runOrchestratorSnapshotCheck` roda DE VERDADE (spawn real de
 * `npx tsx --test`) contra uma cópia mínima do repo num tmpdir — o teste real
 * `test/orchestrator-prompt.test.ts`, os playbooks reais e o `.snap.json` real.
 * Nada é escrito no checkout.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- hook .mjs sem .d.mts (TS7016), mesmo padrão de block-writer-destaque-write-path-hook.test.ts.
import { runOrchestratorSnapshotCheck, buildSnapshotDenyMessage } from "../.claude/hooks/block-pr-create-orchestrator-snapshot-stale.mjs";
import { SNAPSHOT_UPDATE_COMMAND, computeFileEntry } from "../scripts/lib/orchestrator-snapshot.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK = "orchestrator-stage-3.md";

/**
 * O spawn REAL do hook, só sem `NODE_TEST_CONTEXT`: rodando dentro de outro
 * `node --test`, o filho herda essa var, vira subteste do runner pai e sai
 * com 0 mesmo reprovando — o hook em produção nunca roda sob um runner.
 */
const realSpawnOutsideRunner = (cmd: string, args: string[], opts: Record<string, unknown>) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(cmd, args, { ...opts, env });
};

const COPY = [
  ".claude/agents",
  ".claude/skills",
  "test/orchestrator-prompt.test.ts",
  "test/__snapshots__/orchestrator-prompt.snap.json",
  "scripts/lib/orchestrator-files.ts",
  "scripts/lib/orchestrator-snapshot.ts",
  "package.json",
  "tsconfig.json",
];

describe("#9714 item 3 — hook do snapshot, ponta a ponta, com o formato v2 (#9709)", () => {
  let tmp = "";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "snapshot-hook-e2e-9714-"));
    for (const rel of COPY) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      cpSync(join(ROOT, rel), join(tmp, rel), { recursive: true });
    }
    // Só LEITURA de node_modules (resolver o `tsx`); nenhum npm roda aqui.
    symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"), "junction");
  });

  after(() => {
    if (!tmp) return;
    try {
      unlinkSync(join(tmp, "node_modules")); // remove o LINK antes, nunca o alvo
    } catch {
      /* já removido */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("snapshot em dia: o teste real passa e o hook não bloqueia", { timeout: 60_000 }, () => {
    const result = runOrchestratorSnapshotCheck(tmp, realSpawnOutsideRunner as never);
    assert.equal(result.infra, false, result.output);
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /snapshot hash/, "o filtro snapshot.hash ainda acha o teste");
  });

  it("playbook alterado: o hook reprova e a mensagem nomeia playbook, hashes e o comando", { timeout: 60_000 }, () => {
    const path = join(tmp, ".claude/agents", PLAYBOOK);
    const hashAntes = computeFileEntry(readFileSync(path, "utf8")).hash;
    appendFileSync(path, "\nlinha nova não refletida no snapshot (#9714)\n");
    const hashDepois = computeFileEntry(readFileSync(path, "utf8")).hash;

    const result = runOrchestratorSnapshotCheck(tmp, realSpawnOutsideRunner as never);
    assert.equal(result.infra, false, result.output);
    assert.equal(result.ok, false, "snapshot desatualizado tem que reprovar");
    assert.match(result.output, /Snapshot do orchestrator desatualizado/);

    const msg = buildSnapshotDenyMessage(result.output);
    assert.ok(msg.includes(PLAYBOOK), `mensagem cita o playbook divergente:\n${msg}`);
    assert.ok(msg.includes(hashAntes) && msg.includes(hashDepois), `mensagem cita os 2 hashes:\n${msg}`);
    assert.ok(msg.includes(SNAPSHOT_UPDATE_COMMAND), "mensagem cita o comando de regeneração");

    // playbook restaurado: volta a passar
    writeFileSync(path, readFileSync(join(ROOT, ".claude/agents", PLAYBOOK), "utf8"));
    assert.equal(runOrchestratorSnapshotCheck(tmp, realSpawnOutsideRunner as never).ok, true);
  });
});
