/**
 * #10457 — continuação do #10453. Dois buracos no orçamento de 15s de
 * `.claude/hooks/pr-create-review.mjs`:
 *
 * 1. `resolveEffort` fazia até 3 chamadas `gh`/`git` com 10s FIXOS cada,
 *    ignorando `hookDeadline(HOOK_STARTED_AT)` — com `gh` lento, o harness
 *    matava o hook antes do `stdout.write` e a instrução de review sumia.
 *    Agora: cada chamada leva `min(10s, restante)`; sem tempo, nenhuma chamada
 *    e fail-safe `max` (`reason: "orcamento_esgotado"`).
 * 2. Prazo esgotado antes/durante a leitura do corpo voltava `reason: "error"`,
 *    que `closeKeywordWarning` tratava como silêncio — "Fecha #N" mergeado sem
 *    fechar a issue. Agora: `reason: "budget-exhausted"` + aviso.
 *
 * Os testes exercitam as funções (relógio e execFn injetados), não o texto
 * do arquivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PER_CALL_TIMEOUT_MS,
  callTimeoutMs,
  closeKeywordWarning,
  ensureCloseKeywords,
  resolveEffort,
  // @ts-expect-error -- hook .mjs sem .d.mts (mesma situação, já na baseline, de pr-create-review-hook.test.ts)
} from "../.claude/hooks/pr-create-review.mjs";

const PR = "https://github.com/o/r/pull/42";
const noActiveRound = () => false;
const activeRound = () => true;

type Call = { cmd: string; args: string[]; timeout: number };

/**
 * execFn fake: responde headRefName / additions,deletions e registra o timeout
 * de cada chamada. `advance` simula o tempo que a chamada consome.
 */
function fakeGh(opts: { branch: string; additions?: number; advance?: number; clock: { t: number } }) {
  const calls: Call[] = [];
  const execFn = (cmd: string, args: string[], o: { timeout: number }) => {
    calls.push({ cmd, args, timeout: o.timeout });
    opts.clock.t += opts.advance ?? 0;
    if (args.includes("headRefName")) return `${opts.branch}\n`;
    if (args.includes("additions,deletions")) return JSON.stringify({ additions: opts.additions ?? 10, deletions: 0 });
    throw new Error(`chamada inesperada: ${cmd} ${args.join(" ")}`);
  };
  return { execFn, calls };
}

describe("callTimeoutMs = min(10s, restante) (#10457)", () => {
  it("limita a 10s com folga, ao restante perto do fim, e 0 sem tempo", () => {
    assert.equal(PER_CALL_TIMEOUT_MS, 10_000);
    assert.equal(callTimeoutMs(Infinity, 0), 10_000);
    assert.equal(callTimeoutMs(13_000, 0), 10_000);
    assert.equal(callTimeoutMs(13_000, 9_000), 4_000);
    assert.equal(callTimeoutMs(13_000, 13_000), 0);
    assert.equal(callTimeoutMs(13_000, 20_000), 0);
  });
});

describe("resolveEffort respeita o prazo do hook (#10457 item 1)", () => {
  it("sem deadlineAt (call sites antigos) → 10s por chamada, comportamento intacto", () => {
    const clock = { t: 0 };
    const { execFn, calls } = fakeGh({ branch: "develop/x", additions: 10, clock });
    const r = resolveEffort(PR, execFn, noActiveRound);
    assert.equal(r.effort, "low");
    assert.equal(r.reason, "diff_pequeno");
    assert.deepEqual(
      calls.map((c) => c.timeout),
      [10_000, 10_000],
    );
  });

  it("cada chamada leva min(10s, restante) — timeouts encolhem com o relógio", () => {
    const clock = { t: 0 };
    // cada chamada consome 6s; prazo em 13s
    const { execFn, calls } = fakeGh({ branch: "develop/x", additions: 10, advance: 6_000, clock });
    const r = resolveEffort(PR, execFn, noActiveRound, undefined, { deadlineAt: 13_000, now: () => clock.t });
    assert.deepEqual(
      calls.map((c) => c.timeout),
      [10_000, 7_000],
    );
    assert.equal(r.effort, "low");
    assert.equal(r.reason, "diff_pequeno");
  });

  it("prazo já vencido → nenhuma chamada externa, max, motivo orcamento_esgotado", () => {
    const clock = { t: 20_000 };
    const { execFn, calls } = fakeGh({ branch: "overnight/fix-1", clock });
    let checked = false;
    const r = resolveEffort(
      PR,
      execFn,
      () => {
        checked = true;
        return false;
      },
      undefined,
      { deadlineAt: 13_000, now: () => clock.t },
    );
    assert.equal(calls.length, 0, "não pode chamar gh sem orçamento");
    assert.equal(checked, false);
    assert.deepEqual(r, { effort: "max", warning: null, reason: "orcamento_esgotado" });
  });

  it("prazo acaba depois do headRefName (branch overnight) → max, não o low do viés overnight", () => {
    const clock = { t: 0 };
    const { execFn, calls } = fakeGh({ branch: "overnight/fix-1", advance: 14_000, clock });
    const r = resolveEffort(PR, execFn, noActiveRound, undefined, { deadlineAt: 13_000, now: () => clock.t });
    assert.equal(calls.length, 1, "só o headRefName; o diff não é medido sem tempo");
    assert.equal(r.effort, "max");
    assert.equal(r.reason, "orcamento_esgotado");
  });

  it("prazo acaba antes do checkRoundActive → não chama o guard, max", () => {
    const clock = { t: 0 };
    const { execFn } = fakeGh({ branch: "develop/x", advance: 14_000, clock });
    let checked = false;
    const r = resolveEffort(
      PR,
      execFn,
      () => {
        checked = true;
        return true;
      },
      undefined,
      { deadlineAt: 13_000, now: () => clock.t },
    );
    assert.equal(checked, false);
    assert.equal(r.reason, "orcamento_esgotado");
    assert.equal(r.effort, "max");
  });

  it("checkRoundActive recebe o timeout do orçamento (git rev-parse limitado)", () => {
    const clock = { t: 0 };
    const { execFn } = fakeGh({ branch: "develop/x", additions: 10, advance: 5_000, clock });
    let seen: { timeoutMs?: number } | undefined;
    resolveEffort(
      PR,
      execFn,
      (_sid: string | undefined, o: { timeoutMs?: number }) => {
        seen = o;
        return false;
      },
      undefined,
      { deadlineAt: 13_000, now: () => clock.t },
    );
    assert.equal(seen?.timeoutMs, 8_000);
  });

  it("diff de sessão overnight ativa estoura o prazo DURANTE a medição → max, não low", () => {
    const clock = { t: 0 };
    const calls: Call[] = [];
    const execFn = (cmd: string, args: string[], o: { timeout: number }) => {
      calls.push({ cmd, args, timeout: o.timeout });
      if (args.includes("headRefName")) {
        clock.t = 5_000;
        return "develop/x\n";
      }
      // a medição do diff consome o resto do orçamento e falha (timeout)
      clock.t = 13_000;
      const e = new Error("spawnSync gh ETIMEDOUT") as Error & { code: string };
      e.code = "ETIMEDOUT";
      throw e;
    };
    const r = resolveEffort(PR, execFn, activeRound, undefined, { deadlineAt: 13_000, now: () => clock.t });
    assert.equal(calls.length, 2);
    assert.equal(r.effort, "max");
    assert.equal(r.reason, "orcamento_esgotado");
  });

  it("diff desconhecido COM tempo sobrando segue o viés overnight (low) — só o prazo vira max", () => {
    const clock = { t: 0 };
    const execFn = (_cmd: string, args: string[]) => {
      if (args.includes("headRefName")) return "overnight/fix-1\n";
      return "não-é-json";
    };
    const r = resolveEffort(PR, execFn, noActiveRound, undefined, { deadlineAt: 13_000, now: () => clock.t });
    assert.equal(r.effort, "low");
    assert.equal(r.reason, "branch_overnight");
  });

  it("headRefName estourando o timeout encurtado → orcamento_esgotado (não estado_indeterminado)", () => {
    const clock = { t: 0 };
    const execFn = () => {
      clock.t = 13_500;
      throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    const r = resolveEffort(PR, execFn, noActiveRound, undefined, { deadlineAt: 13_000, now: () => clock.t });
    assert.equal(r.effort, "max");
    assert.equal(r.reason, "orcamento_esgotado");
  });

  it("erro comum com tempo sobrando continua estado_indeterminado", () => {
    const r = resolveEffort(
      PR,
      () => {
        throw new Error("gh: not found");
      },
      noActiveRound,
      undefined,
      { deadlineAt: 13_000, now: () => 0 },
    );
    assert.equal(r.reason, "estado_indeterminado");
    assert.equal(r.effort, "max");
  });
});

describe("ensureCloseKeywords: budget-exhausted com aviso (#10457 item 2)", () => {
  it("gh pr view cortado pelo timeout encurtado (ETIMEDOUT) → budget-exhausted + aviso", () => {
    const r = ensureCloseKeywords(PR, {
      execFn: () => {
        throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
      writeFn: () => {
        throw new Error("não deveria escrever");
      },
      deadlineAt: 13_000,
      now: () => 9_000,
    });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "budget-exhausted");
    assert.equal(r.pr, 42);
    const w = closeKeywordWarning(r);
    assert.ok(w);
    assert.match(w, /#42/);
    assert.match(w, /gh-pr-safe-edit\.ts --pr 42/);
  });

  it("leitura falha e o prazo já venceu ao voltar → budget-exhausted", () => {
    let t = 0;
    const r = ensureCloseKeywords(PR, {
      execFn: () => {
        t = 14_000;
        throw new Error("killed");
      },
      deadlineAt: 13_000,
      now: () => t,
    });
    assert.equal(r.reason, "budget-exhausted");
  });

  it("erro de leitura comum, com tempo sobrando, continua 'error' silencioso (#6920)", () => {
    const r = ensureCloseKeywords(PR, {
      execFn: () => {
        throw new Error("HTTP 404");
      },
      deadlineAt: 13_000,
      now: () => 0,
    });
    assert.equal(r.reason, "error");
    assert.equal(closeKeywordWarning(r), null);
  });

  it("not-needed e applied seguem sem aviso", () => {
    assert.equal(closeKeywordWarning({ applied: false, reason: "not-needed" }), null);
    assert.equal(closeKeywordWarning({ applied: true, addendum: "Closes #1" }), null);
  });
});
