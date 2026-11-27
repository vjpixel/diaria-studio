/**
 * #14276 — edição 261127: o waiter da página do site e o
 * `check-site-page-pr-gate.ts` (5 rodadas de `--wait-ms 540000`) ficaram ~1h20
 * em "CI verde, mas o merge lock seguiu ocupado", enquanto o
 * `session-registry.ts merge-lock-acquire` manual adquiriu de primeira (o D1
 * concedeu; o arquivo local estava ilegível). Os dois montavam o lock por
 * `makeSessionRegistryMergeLock`, que chamava `acquireMergeLock` direto: só o
 * arquivo local, sem a autoridade do D1 (#12842) e sem dizer o motivo.
 *
 * Os testes travam: (1) o waiter passa pelo CLI `merge-lock-acquire` (a mesma
 * porta que funcionou à mão) e não pelo arquivo sozinho; (2) a recusa guarda o
 * texto do CLI e ele entra no desfecho "ocupado"; (3) a recusa por erro de I/O
 * na criação exclusiva do arquivo não sai muda.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeSessionRegistryMergeLock,
  waitAndMergeSitePagePr,
  type GhRunner,
  type LockRunner,
} from "../scripts/publish-edition-site-page.ts";
import { acquireMergeLock, type MergeLockIo } from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function rootWithData(): string {
  const root = mkdtempSync(join(tmpdir(), "site-merge-lock-14276-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
function greenGh(calls: string[][]): GhRunner {
  return (args) => {
    calls.push(args);
    if (args[1] === "view") {
      return JSON.stringify({
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        mergeable: "MERGEABLE",
        state: "OPEN",
        headRefOid: HEAD,
      });
    }
    return "";
  };
}

describe("makeSessionRegistryMergeLock passa pelo CLI merge-lock-acquire (#14276)", () => {
  it("cenário da 261127: arquivo local recusaria, o CLI (D1) concede → o waiter adquire e mergeia", () => {
    const root = rootWithData();
    // Espelho local que o caminho só-arquivo recusa: hold fresco de outro dono
    // (sync defasado). O `acquireMergeLock` direto devolve false aqui.
    writeFileSync(
      join(root, "data", "sessions", ".merge-lock.json"),
      JSON.stringify({ heldBy: "espelho-defasado", acquiredAt: new Date().toISOString() }),
    );
    assert.equal(acquireMergeLock(root, "qualquer"), false, "pré-condição: o arquivo sozinho recusa");

    const cliCalls: string[][] = [];
    const cliD1Concede: LockRunner = (args) => {
      cliCalls.push(args);
      return { ok: true, stdout: "session-registry: merge-lock-acquire ok [lock=d1]", stderr: "" };
    };
    const lock = makeSessionRegistryMergeLock(root, 14274, cliD1Concede, () => {});
    assert.equal(lock.acquire(), true, "antes do fix: false (só o arquivo local, sem o D1)");
    assert.equal(cliCalls[0][0], "merge-lock-acquire");
    assert.match(cliCalls[0][cliCalls[0].indexOf("--session-id") + 1], /^site-page-merge-waiter:pr-14274:pid-\d+$/);

    const ghCalls: string[][] = [];
    const r = waitAndMergeSitePagePr(root, 14274, greenGh(ghCalls), () => {}, 0, 5_000, lock);
    assert.equal(r.merged, true, r.reason);
    assert.equal(ghCalls.filter((a) => a[1] === "merge").length, 1);
    assert.ok(cliCalls.some((a) => a[0] === "merge-lock-release"), "release também pelo CLI (solta o D1)");
  });

  it("recusa: o texto do CLI (quem segura) vai pro log uma vez e entra no desfecho 'ocupado'", () => {
    const root = rootWithData();
    const warns: string[] = [];
    const negado: LockRunner = () => ({
      ok: false,
      stdout:
        "session-registry: merge-lock-acquire denied (held by another session) — holder overnight-abc desde (D1) [lock=d1]\n",
      stderr: "",
    });
    const lock = makeSessionRegistryMergeLock(root, 14274, negado, (m) => warns.push(m));
    assert.equal(lock.acquire(), false);
    assert.equal(lock.acquire(), false);
    assert.equal(warns.length, 1, "mesmo motivo não repete a cada volta do poll");
    assert.match(warns[0], /holder overnight-abc/);
    assert.match(lock.lastDenial?.() ?? "", /^negado: .*holder overnight-abc/);

    const r = waitAndMergeSitePagePr(root, 14274, greenGh([]), () => {}, 0, 5_000, lock);
    assert.equal(r.merged, false);
    assert.equal(r.timedOut, true);
    assert.match(r.reason, /merge lock seguiu ocupado/);
    assert.match(r.reason, /última recusa: negado: .*holder overnight-abc/);
  });

  it("falha do CLI sem 'denied' vira erro de infra, nunca contenção", () => {
    const root = rootWithData();
    const quebrado: LockRunner = () => ({ ok: false, stdout: "", stderr: "Error: Cannot find module tsx" });
    const lock = makeSessionRegistryMergeLock(root, 14274, quebrado, () => {});
    assert.equal(lock.acquire(), false);
    assert.match(lock.lastDenial?.() ?? "", /^erro de infra \(não é contenção\): Error: Cannot find module tsx/);
  });

  it("data/ ausente → não chama o CLI, e o motivo fica registrado", () => {
    const root = mkdtempSync(join(tmpdir(), "site-merge-lock-14276-nodata-"));
    roots.push(root);
    let chamou = false;
    const lock = makeSessionRegistryMergeLock(root, 14274, () => {
      chamou = true;
      return { ok: true, stdout: "ok", stderr: "" };
    }, () => {});
    assert.equal(lock.acquire(), false);
    assert.equal(chamou, false);
    assert.match(lock.lastDenial?.() ?? "", /ausente/);
  });
});

describe("acquireMergeLock: recusa por erro de I/O não sai muda (#14276)", () => {
  it("criação exclusiva lança (não-EEXIST) → false e o código do erro no stderr", () => {
    const io: MergeLockIo = {
      tryCreateExclusive: () => {
        throw Object.assign(new Error("boom"), { code: "EIO" });
      },
      readCurrent: () => null,
      overwrite: () => {
        throw new Error("não deve contestar");
      },
    };
    const orig = process.stderr.write.bind(process.stderr);
    const out: string[] = [];
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      out.push(String(chunk));
      return true;
    };
    let ok: boolean;
    try {
      ok = acquireMergeLock("/repo-inexistente-14276", "s1", Date.now(), undefined, io);
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    assert.equal(ok, false);
    assert.match(out.join(""), /acquireMergeLock: criação exclusiva .* falhou \(EIO\)/);
    assert.match(out.join(""), /não por outra sessão/);
  });
});
