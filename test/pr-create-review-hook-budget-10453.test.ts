/**
 * #10453 — o harness mata `.claude/hooks/pr-create-review.mjs` aos `timeout`
 * segundos do `.claude/settings.json` (15s). A escrita do `Closes #N`
 * (`writePrBodySafe`, #10442) tinha `timeout: 60_000` próprio e rodava ANTES
 * do `resolveEffort` + emissão: estourando, o hook morria sem emitir nada e o
 * review automatizado (gate do auto-merge #5251) sumia em silêncio.
 *
 * Trava: (1) paridade HOOK_TIMEOUT_MS ↔ settings.json; (2) escrita limitada ao
 * orçamento restante e pulada (com aviso) quando não cabe; (3) no main, o
 * effort é resolvido ANTES da escrita, e a escrita recebe o prazo do hook;
 * (4) a escrita não passa mais por `npx`/shell.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOOK_OUTPUT_RESERVE_MS,
  HOOK_TIMEOUT_MS,
  MIN_WRITE_BUDGET_MS,
  closeKeywordWarning,
  ensureCloseKeywords,
  hookDeadline,
  remainingMs,
  writePrBodySafe,
  // @ts-expect-error -- hook .mjs sem .d.mts (mesma situação, já na baseline, de pr-create-review-hook.test.ts)
} from "../.claude/hooks/pr-create-review.mjs";

const ROOT = join(import.meta.dirname, "..");
const HOOK_SRC = readFileSync(join(ROOT, ".claude/hooks/pr-create-review.mjs"), "utf8");
const SETTINGS = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));

const viewReturning = (body: string) => (_cmd: string, args: string[]) => {
  if (args[1] === "view") return body;
  throw new Error(`execFn não deveria ser chamado para ${args.join(" ")}`);
};

describe("orçamento do hook bate com o timeout do settings.json (#10453)", () => {
  it("HOOK_TIMEOUT_MS == timeout (s) do PostToolUse `gh pr create*`", () => {
    const entries = (SETTINGS.hooks?.PostToolUse ?? []).flatMap((m: { hooks?: unknown[] }) => m.hooks ?? []);
    const hook = entries.find(
      (h: { args?: string[] }) => Array.isArray(h.args) && h.args.some((a) => a.endsWith("/pr-create-review.mjs")),
    ) as { timeout?: number } | undefined;
    assert.ok(hook, "entrada do pr-create-review.mjs no settings.json");
    assert.equal(typeof hook.timeout, "number");
    assert.equal(HOOK_TIMEOUT_MS, hook.timeout! * 1000);
  });

  it("reserva + mínimo de escrita cabem no orçamento", () => {
    assert.ok(HOOK_OUTPUT_RESERVE_MS + MIN_WRITE_BUDGET_MS < HOOK_TIMEOUT_MS);
    assert.equal(hookDeadline(1_000), 1_000 + HOOK_TIMEOUT_MS - HOOK_OUTPUT_RESERVE_MS);
    assert.equal(remainingMs(100, 500), 0);
    assert.equal(remainingMs(500, 100), 400);
  });
});

describe("ensureCloseKeywords respeita o prazo (#10453)", () => {
  it("escrita recebe timeout = orçamento restante, nunca 60s fixos", () => {
    let seen: { timeoutMs?: number } | undefined;
    let viewTimeout: number | undefined;
    const r = ensureCloseKeywords("https://github.com/o/r/pull/10453", {
      execFn: (_c: string, args: string[], opts: { timeout: number }) => {
        viewTimeout = opts.timeout;
        return viewReturning("Fecha #10453\n")(_c, args);
      },
      writeFn: (_n: number, _b: string, opts: { timeoutMs: number }) => {
        seen = opts;
        return { ok: true };
      },
      deadlineAt: 10_000,
      now: () => 2_000,
    });
    assert.equal(r.applied, true);
    assert.equal(viewTimeout, 8_000);
    assert.equal(seen?.timeoutMs, 8_000);
  });

  it("sem orçamento pra escrever → não chama writeFn e devolve write-failed com aviso", () => {
    let t = 0;
    let called = false;
    const r = ensureCloseKeywords("https://github.com/o/r/pull/10453", {
      execFn: viewReturning("Fecha #10453\n"),
      writeFn: () => {
        called = true;
        return { ok: true };
      },
      deadlineAt: 10_000,
      // leitura começa com folga, mas termina com só 1s restante
      now: () => (t++ === 0 ? 0 : 9_000),
    });
    assert.equal(called, false);
    assert.equal(r.reason, "write-failed");
    assert.equal(r.addendum, "Closes #10453");
    assert.match(r.error, /orçamento/);
    assert.ok(closeKeywordWarning(r), "aviso tem que chegar à sessão");
  });

  it("prazo já vencido → nem lê o corpo, e avisa (#10457)", () => {
    const r = ensureCloseKeywords("https://github.com/o/r/pull/1", {
      execFn: () => {
        throw new Error("não deveria ler");
      },
      deadlineAt: 5,
      now: () => 10,
    });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "budget-exhausted");
    assert.ok(closeKeywordWarning(r), "silêncio aqui era o defeito do #10457");
  });
});

describe("writePrBodySafe sem npx/shell e com timeout repassado (#10453)", () => {
  it("spawna process.execPath --import tsx, shell desligado, timeout = timeoutMs", () => {
    let seen: { cmd?: string; args?: string[]; opts?: { timeout?: number; shell?: unknown } } = {};
    writePrBodySafe(1, "x", {
      cwd: ROOT,
      timeoutMs: 4_321,
      spawnFn: (cmd: string, args: string[], opts: { timeout: number; shell?: unknown }) => {
        seen = { cmd, args, opts };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(seen.cmd, process.execPath);
    assert.deepEqual(seen.args?.slice(0, 2), ["--import", "tsx"]);
    assert.equal(seen.opts?.timeout, 4_321);
    assert.ok(!seen.opts?.shell, "sem shell: o timeout mata o processo que escreve");
  });
});

describe("main do hook: effort antes da escrita, escrita com prazo (#10453)", () => {
  const mainStart = HOOK_SRC.indexOf("if (prUrl) {");
  const main = HOOK_SRC.slice(mainStart);

  it("resolveEffort vem antes de ensureCloseKeywords", () => {
    const iEffort = main.indexOf("resolveEffort(prUrl");
    const iClose = main.indexOf("ensureCloseKeywords(prUrl");
    assert.ok(mainStart > 0 && iEffort > 0 && iClose > 0);
    assert.ok(iEffort < iClose, "effort tem que ser resolvido antes da escrita opcional");
  });

  it("ensureCloseKeywords recebe o prazo derivado do início do hook", () => {
    // #10457: o prazo virou uma const compartilhada com resolveEffort.
    assert.match(main, /const deadlineAt = hookDeadline\(HOOK_STARTED_AT\);/);
    assert.match(main, /ensureCloseKeywords\(prUrl,\s*\{\s*deadlineAt\s*\}\)/);
    assert.match(HOOK_SRC, /const HOOK_STARTED_AT = Date\.now\(\);/);
  });
});
