/**
 * #11380 — `merge-lock-acquire` negado porque o lock é da PRÓPRIA sessão
 * (#6334, não reentrante) dizia "held by another session" e mandava procurar
 * uma sessão que não existia (/diaria-develop 261027f, PR #11375). A mensagem
 * agora diz que o lock é desta sessão; exit 1 e a recusa seguem iguais.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeLockAcquireOutcome } from "../scripts/lib/session-registry.ts";

const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "merge-lock-11380-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  return root;
}

function cli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
}

describe("mergeLockAcquireOutcome (#11380)", () => {
  const at = "2026-10-27T21:00:00.000Z";

  it("ok quando adquiriu", () => {
    assert.equal(mergeLockAcquireOutcome(true, "s1", null), "ok");
  });

  it("lock da própria sessão: diz que é desta sessão, com o acquiredAt e o caminho (renew ou merge)", () => {
    const msg = mergeLockAcquireOutcome(false, "s1", { heldBy: "s1", acquiredAt: at });
    assert.match(msg, /^denied /, "consumidores detectam a recusa por /denied/i");
    assert.match(msg, new RegExp(`lock já detido por esta sessão \\(desde ${at}\\)`));
    assert.match(msg, /use merge-lock-renew para estender ou siga com o merge/);
    assert.doesNotMatch(msg, /another session/);
  });

  it("lock de outra sessão (ou ilegível): mantém 'held by another session'", () => {
    assert.equal(mergeLockAcquireOutcome(false, "s1", { heldBy: "s2", acquiredAt: at }), "denied (held by another session)");
    assert.equal(mergeLockAcquireOutcome(false, "s1", null), "denied (held by another session)");
  });
});

describe("CLI merge-lock-acquire 2× na mesma sessão (#11380, cenário da 261027f)", () => {
  it("a 2ª chamada sai 1 com a mensagem de lock desta sessão", () => {
    const root = freshRoot();
    const first = cli(root, ["merge-lock-acquire", "--session-id", "sess-11380", "--pr", "1"]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /merge-lock-acquire ok/);

    const second = cli(root, ["merge-lock-acquire", "--session-id", "sess-11380", "--pr", "1"]);
    assert.equal(second.status, 1, "semântica não reentrante do #6334 preservada");
    assert.match(second.stdout, /merge-lock-acquire denied \(lock já detido por esta sessão \(desde \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(second.stdout, /another session/);
  });

  it("outra sessão continua vendo 'held by another session'", () => {
    const root = freshRoot();
    assert.equal(cli(root, ["merge-lock-acquire", "--session-id", "sess-a", "--pr", "1"]).status, 0);
    const other = cli(root, ["merge-lock-acquire", "--session-id", "sess-b", "--pr", "2"]);
    assert.equal(other.status, 1);
    assert.match(other.stdout, /merge-lock-acquire denied \(held by another session\)/);
  });
});
