/**
 * #10597: preflight de auth do `claude` antes do Stage 1 + aviso de erro
 * intencional suprimido quando o stage falhou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, claudeAuthPreflightError } from "../scripts/run-edition-stages.ts";

type Exec = typeof import("node:child_process").execFileSync;
const asExec = (f: (...a: unknown[]) => unknown) => f as unknown as Exec;

describe("#10597 claudeAuthPreflightError", () => {
  it("loggedIn:false → mensagem acionável com claude /login", () => {
    const e = claudeAuthPreflightError(asExec(() => JSON.stringify({ loggedIn: false })), "claude", {});
    assert.match(e ?? "", /claude \/login/);
  });
  it("authMethod de API → erro citando #5608", () => {
    const e = claudeAuthPreflightError(asExec(() => JSON.stringify({ loggedIn: true, authMethod: "api_key" })), "claude", {});
    assert.match(e ?? "", /5608/);
  });
  it("exec com status != 0 → falha", () => {
    const e = claudeAuthPreflightError(asExec(() => { throw Object.assign(new Error("x"), { status: 1 }); }), "claude", {});
    assert.match(e ?? "", /claude \/login/);
  });
  it("loggedIn:true e saída ilegível → ok (fail-soft)", () => {
    assert.equal(claudeAuthPreflightError(asExec(() => JSON.stringify({ loggedIn: true })), "claude", {}), null);
    assert.equal(claudeAuthPreflightError(asExec(() => "not json"), "claude", {}), null);
  });
});

describe("#10597 main", () => {
  it("deslogado → exit 1, nenhum stage spawnado", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-auth-preflight-"));
    try {
      const calls: unknown[][] = [];
      const err: string[] = [];
      const code = main(["--edition", "261020", "--through", "2"], {
        execFn: asExec((...a) => { calls.push(a); return JSON.stringify({ loggedIn: false }); }),
        resolveClaudeBinFn: () => "claude",
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.equal(code, 1);
      assert.equal(calls.length, 1);
      assert.ok(err.some((l) => /claude \/login/.test(l)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stage falhou → sem AVISO de erro intencional", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-auth-fail-"));
    try {
      const err: string[] = [];
      const code = main(["--edition", "261020", "--through", "2"], {
        execFn: asExec((_bin, args) => {
          if ((args as string[])[0] === "auth") return JSON.stringify({ loggedIn: true });
          throw Object.assign(new Error("Failed to authenticate"), { status: 1 });
        }),
        resolveClaudeBinFn: () => "claude",
        assertSentinelFn: () => ({ ok: false, reason: "sentinel_missing" }) as never,
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.notEqual(code, 0);
      assert.ok(!err.some((l) => /sem erro intencional/.test(l)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
