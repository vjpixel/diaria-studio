/**
 * orchestrator-snapshot.test.ts (#9709)
 *
 * Regressão do snapshot agregado do orchestrator: com um hash único, toda PR
 * que mexia em qualquer playbook reescrevia a mesma linha do .snap.json e PRs
 * concorrentes em playbooks DIFERENTES conflitavam (2× na PR #9684). Aqui:
 *   - a entrada de um playbook depende só do conteúdo dele;
 *   - duas branches que mudam playbooks diferentes fazem merge LIMPO do
 *     arquivo serializado (`git merge-file`, o mesmo merge de 3 vias do git);
 *   - a mensagem de falha cita o comando exato de regeneração.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT_UPDATE_COMMAND,
  buildSnapshot,
  computeFileEntry,
  diffSnapshot,
  formatSnapshotFailure,
  isCleanDiff,
  parseSnapshot,
  serializeSnapshot,
} from "../scripts/lib/orchestrator-snapshot.ts";

const FILES = ["orchestrator.md", "orchestrator-stage-a.md", "orchestrator-stage-b.md", "orchestrator-stage-c.md"];
const BASE: Record<string, string> = {
  "orchestrator.md": "# raiz\nlinha\n",
  "orchestrator-stage-a.md": "# A\nconteúdo A\n",
  "orchestrator-stage-b.md": "# B\nconteúdo B\n",
  "orchestrator-stage-c.md": "# C\nconteúdo C\n",
};

describe("orchestrator snapshot por playbook (#9709)", () => {
  it("mudar o playbook A não altera a entrada do playbook B", () => {
    const before = buildSnapshot(FILES, BASE);
    const after = buildSnapshot(FILES, { ...BASE, "orchestrator-stage-a.md": "# A\nconteúdo A editado\nmais uma\n" });
    assert.notDeepEqual(after["orchestrator-stage-a.md"], before["orchestrator-stage-a.md"]);
    assert.deepEqual(after["orchestrator-stage-b.md"], before["orchestrator-stage-b.md"]);
    assert.deepEqual(after["orchestrator-stage-c.md"], before["orchestrator-stage-c.md"]);
    assert.deepEqual(after["orchestrator.md"], before["orchestrator.md"]);

    const diff = diffSnapshot(FILES, before, after);
    assert.deepEqual(diff.changed.map((c) => c.file), ["orchestrator-stage-a.md"]);
  });

  it("serializar → parsear devolve o mesmo snapshot (e é JSON válido)", () => {
    const snap = buildSnapshot(FILES, BASE);
    const text = serializeSnapshot(FILES, snap);
    assert.doesNotThrow(() => JSON.parse(text));
    assert.deepEqual(parseSnapshot(text), snap);
    assert.ok(isCleanDiff(diffSnapshot(FILES, parseSnapshot(text), snap)));
  });

  it("CRLF e LF produzem a mesma entrada", () => {
    assert.deepEqual(computeFileEntry("a\r\nb\r\n"), computeFileEntry("a\nb\n"));
  });

  it("duas branches mudando playbooks diferentes fazem merge limpo do .snap.json (inclusive o último)", () => {
    const base = serializeSnapshot(FILES, buildSnapshot(FILES, BASE));
    const ours = serializeSnapshot(FILES, buildSnapshot(FILES, { ...BASE, "orchestrator-stage-b.md": "# B\nnovo B\n" }));
    // stage-c é a ÚLTIMA entrada e stage-b a vizinha: o par mais propenso a conflito.
    const theirs = serializeSnapshot(FILES, buildSnapshot(FILES, { ...BASE, "orchestrator-stage-c.md": "# C\nnovo C\n" }));

    const dir = mkdtempSync(join(tmpdir(), "orch-snap-9709-"));
    try {
      writeFileSync(join(dir, "base"), base);
      writeFileSync(join(dir, "ours"), ours);
      writeFileSync(join(dir, "theirs"), theirs);
      const r = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf8" });
      assert.equal(r.status, 0, `git merge-file conflitou:\n${r.stdout}`);
      const merged = parseSnapshot(r.stdout);
      const expected = buildSnapshot(FILES, {
        ...BASE,
        "orchestrator-stage-b.md": "# B\nnovo B\n",
        "orchestrator-stage-c.md": "# C\nnovo C\n",
      });
      assert.deepEqual(merged, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("controle: a mesma mudança concorrente no MESMO playbook ainda conflita", () => {
    const base = serializeSnapshot(FILES, buildSnapshot(FILES, BASE));
    const ours = serializeSnapshot(FILES, buildSnapshot(FILES, { ...BASE, "orchestrator-stage-b.md": "x\n" }));
    const theirs = serializeSnapshot(FILES, buildSnapshot(FILES, { ...BASE, "orchestrator-stage-b.md": "y\n" }));
    const dir = mkdtempSync(join(tmpdir(), "orch-snap-9709-"));
    try {
      writeFileSync(join(dir, "base"), base);
      writeFileSync(join(dir, "ours"), ours);
      writeFileSync(join(dir, "theirs"), theirs);
      const r = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf8" });
      assert.ok(r.status !== 0, "esperava conflito ao mudar o mesmo playbook nos dois lados");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot legado (hash agregado) vira 'todas as entradas faltando', sem erro de parse", () => {
    const legacy = JSON.stringify({ hash: "6b07ab9962ef68dd", file_sizes: { "orchestrator.md": 165 }, updated_at: "x" });
    const diff = diffSnapshot(FILES, parseSnapshot(legacy), buildSnapshot(FILES, BASE));
    assert.deepEqual(diff.missing, FILES);
    assert.deepEqual(parseSnapshot("não é json"), {});
  });

  it("entrada sem playbook correspondente aparece em extra", () => {
    const snap = { ...buildSnapshot(FILES, BASE), "orchestrator-stage-z.md": { hash: "0", lines: 1 } };
    const diff = diffSnapshot(FILES, snap, buildSnapshot(FILES, BASE));
    assert.deepEqual(diff.extra, ["orchestrator-stage-z.md"]);
    assert.equal(isCleanDiff(diff), false);
  });

  it("mensagem de falha nomeia o playbook e cita o comando exato de regeneração", () => {
    const before = buildSnapshot(FILES, BASE);
    const after = buildSnapshot(FILES, { ...BASE, "orchestrator-stage-a.md": "mudou\n" });
    const msg = formatSnapshotFailure(diffSnapshot(FILES, before, after));
    assert.match(msg, /orchestrator-stage-a\.md: hash mudou/);
    assert.ok(!msg.includes("orchestrator-stage-b.md"));
    assert.ok(msg.includes("NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts"));
    assert.equal(SNAPSHOT_UPDATE_COMMAND, "NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts");
  });

  it("o .snap.json versionado está no formato v2 (uma entrada por playbook)", () => {
    const raw = readFileSync(new URL("./__snapshots__/orchestrator-prompt.snap.json", import.meta.url), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    assert.equal("hash" in data, false, "formato legado de hash agregado ainda versionado");
    assert.ok(Object.keys(parseSnapshot(raw)).length > 0);
  });
});
