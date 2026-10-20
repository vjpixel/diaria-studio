/**
 * test/run-edition-stages-auth-preflight-10597.test.ts (#10597)
 *
 * Edição 261020: o Stage 1 spawnado falhou em 5s com `Failed to authenticate:
 * OAuth session expired` (`terminal_reason=api_error`), e o resumo mostrou o
 * AVISO de erro intencional como se fosse a causa. Cobre:
 * (1) preflight de auth antes de spawnar o Stage 1;
 * (2) AVISO de erro intencional suprimido quando o laço parou no Stage 1/2,
 *     e mantido quando o Stage 2 concluiu;
 * (3) dica acionável quando o stage falhou por auth (token expirado que o
 *     `auth status` ainda reporta como logado).
 * Nunca spawna `claude` real: `execFn` é sempre injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, claudeAuthPreflight, authFailureHint } from "../scripts/run-edition-stages.ts";

type Exec = typeof import("node:child_process").execFileSync;
const asExec = (f: (...a: unknown[]) => unknown) => f as unknown as Exec;
const BIN = "/home/u/.local/bin/claude";

/** Envelope `--output-format json` do incidente real de 261020. */
const OAUTH_EXPIRED_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  terminal_reason: "api_error",
  num_turns: 1,
});

describe("#10597 claudeAuthPreflight", () => {
  it("loggedIn:false → erro acionável com claude /login e o path do CLI", () => {
    const r = claudeAuthPreflight(asExec(() => JSON.stringify({ loggedIn: false })), BIN, {});
    assert.match(r.error ?? "", /claude \/login/);
    assert.ok(r.error?.includes(BIN));
  });

  it("auth status sai != 0 → erro", () => {
    const r = claudeAuthPreflight(asExec(() => { throw Object.assign(new Error("x"), { status: 1 }); }), BIN, {});
    assert.match(r.error ?? "", /claude \/login/);
  });

  it("saída real da assinatura (capturada 20/10/2026) → ok, sem aviso", () => {
    const real = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    assert.deepEqual(claudeAuthPreflight(asExec(() => real), BIN, {}), { error: null, warning: null });
  });

  it("authMethod inesperado → aviso #5608, nunca bloqueio, nunca sugere API key", () => {
    const r = claudeAuthPreflight(asExec(() => JSON.stringify({ loggedIn: true, authMethod: "api_key" })), BIN, {});
    assert.equal(r.error, null);
    assert.match(r.warning ?? "", /5608/);
    assert.doesNotMatch(r.warning ?? "", /ANTHROPIC_API_KEY/);
  });

  it("binário ausente / saída não-JSON → aviso, não bloqueia (fail-soft visível)", () => {
    const enoent = claudeAuthPreflight(asExec(() => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); }), BIN, {});
    assert.equal(enoent.error, null);
    assert.match(enoent.warning ?? "", /ENOENT/);
    const text = claudeAuthPreflight(asExec(() => "Logged in as x"), BIN, {});
    assert.equal(text.error, null);
    assert.match(text.warning ?? "", /JSON/);
  });
});

describe("#10597 authFailureHint", () => {
  it("failureTail com OAuth expirado → dica; falha de conteúdo → null", () => {
    const tail = "terminal_reason=api_error, num_turns=1 | Failed to authenticate: OAuth session expired and could not be refreshed";
    assert.match(authFailureHint([{ status: "failed", failureTail: tail }], BIN) ?? "", /claude \/login/);
    assert.equal(authFailureHint([{ status: "failed", failureTail: "stage saiu 6: lint falhou" }], BIN), null);
    assert.equal(authFailureHint([{ status: "ok" }], BIN), null);
  });
});

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "diaria-auth-10597-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#10597 main", () => {
  it("deslogado → exit 1, nenhum stage spawnado", () =>
    withRoot((root) => {
      const calls: unknown[][] = [];
      const err: string[] = [];
      const code = main(["--edition", "261020", "--through", "2"], {
        execFn: asExec((...a) => { calls.push(a); return JSON.stringify({ loggedIn: false }); }),
        resolveClaudeBinFn: () => BIN,
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.equal(code, 1);
      assert.equal(calls.length, 1, "só o `auth status` pode ter rodado");
      assert.deepEqual((calls[0][1] as string[]).slice(0, 2), ["auth", "status"]);
      assert.ok(err.some((l) => /claude \/login/.test(l)));
    }));

  it("binário do claude não encontrado → exit 1 com mensagem, nunca exceção", () =>
    withRoot((root) => {
      const err: string[] = [];
      const code = main(["--edition", "261020", "--through", "1"], {
        execFn: asExec(() => { throw new Error("não deveria spawnar"); }),
        resolveClaudeBinFn: () => { throw new Error("claude não encontrado em nenhum candidato"); },
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.equal(code, 1);
      assert.ok(err.some((l) => /não encontrado/.test(l)));
    }));

  it("cenário real: preflight passa, Stage 1 falha com OAuth expirado → sem AVISO de erro intencional, com dica de login", () =>
    withRoot((root) => {
      const err: string[] = [];
      const code = main(["--edition", "261020", "--through", "3"], {
        execFn: asExec((_bin, args) => {
          if ((args as string[])[0] === "auth") return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
          throw Object.assign(new Error("Command failed"), { status: 1, stdout: OAUTH_EXPIRED_STDOUT, stderr: "" });
        }),
        resolveClaudeBinFn: () => BIN,
        assertSentinelFn: () => ({ ok: false, reason: "sentinel_missing" }) as never,
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.equal(code, 1);
      assert.ok(!err.some((l) => /sem erro intencional/.test(l)), `AVISO indevido: ${JSON.stringify(err)}`);
      assert.ok(err.some((l) => /autenticação do CLI/.test(l) && l.includes("claude /login")), JSON.stringify(err));
    }));

  it("Stage 2 concluiu e falha veio depois → AVISO de erro intencional continua aparecendo", () =>
    withRoot((root) => {
      const err: string[] = [];
      let sentinelCalls = 0;
      main(["--edition", "261020", "--through", "3"], {
        execFn: asExec((_bin, args) => {
          const a = args as string[];
          if (a[0] === "auth") return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
          if (a.some((x) => x.includes("diaria-3-imagens"))) throw Object.assign(new Error("boom"), { status: 3 });
          return JSON.stringify({ result: "ok", total_cost_usd: 0, usage: {} });
        }),
        resolveClaudeBinFn: () => BIN,
        // pré-spawn → ausente (deixa spawnar); pós-spawn → ok.
        assertSentinelFn: (() => (++sentinelCalls % 2 === 1 ? { ok: false, reason: "sentinel_missing" } : { ok: true })) as never,
        env: {},
        stdout: () => {},
        stderr: (l) => err.push(l),
        repoRootAbs: root,
      });
      assert.ok(err.some((l) => /sem erro intencional declarado/.test(l)), JSON.stringify(err));
    }));
});
