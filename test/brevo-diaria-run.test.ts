/**
 * test/brevo-diaria-run.test.ts (#5192)
 *
 * Cobre `scripts/brevo-diaria-run.ts` — o orquestrador determinístico dos
 * Passos 1-4 de `/diaria-brevo-diaria` (mesmo padrão de
 * `test/clarice-novos-run.test.ts`, #4941). Nenhum spawn real: `exec` é
 * injetado, um fake que registra as chamadas (script + args, na ordem
 * exata) e devolve respostas canned — os testes verificam tanto o
 * RESULTADO (exit code, modo) quanto a SEQUÊNCIA/ARGS exatos passados a
 * cada sub-script, onde vive o risco real que este script existe pra
 * eliminar (ordem errada / passo pulado numa mutação real de contatos).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runBrevoDiaria,
  parseBrevoDiariaRunArgs,
  BrevoDiariaAbort,
  type BrevoDiariaRunDeps,
  type StepResult,
  type ExecFn,
} from "../scripts/brevo-diaria-run.ts";

function makeFakeExec(handlers: Record<string, StepResult | ((args: string[]) => StepResult)>): {
  exec: ExecFn;
  calls: Array<{ script: string; args: string[] }>;
} {
  const calls: Array<{ script: string; args: string[] }> = [];
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const h = handlers[script];
    if (h === undefined) {
      throw new Error(`fakeExec: sem handler para "${script}" (args=${args.join(" ")})`);
    }
    return typeof h === "function" ? h(args) : h;
  };
  return { exec, calls };
}

function ok(stderr = ""): StepResult {
  return { code: 0, stdout: "", stderr };
}

function deps(exec: ExecFn): BrevoDiariaRunDeps {
  return { rootDir: "/fake/root", exec };
}

const PREFLIGHT_SCRIPTS = [
  "scripts/evaluate-brevo-diaria.ts",
  "scripts/refresh-pending-pool.ts",
  "scripts/sync-pending-to-brevo.ts",
];

const APPLY_SCRIPTS = [
  "scripts/evaluate-brevo-diaria.ts",
  "scripts/refresh-pending-pool.ts",
  "scripts/score-pending-origin.ts",
  "scripts/verify-pending-emails-mv.ts",
  "scripts/sync-pending-to-brevo.ts",
];

describe("parseBrevoDiariaRunArgs", () => {
  it("default (nenhuma flag) é preflight", () => {
    const opts = parseBrevoDiariaRunArgs([]);
    assert.equal(opts.mode, "preflight");
  });

  it("--preflight explícito é preflight", () => {
    const opts = parseBrevoDiariaRunArgs(["--preflight"]);
    assert.equal(opts.mode, "preflight");
  });

  it("--apply e --preflight juntos abortam (mutuamente exclusivos)", () => {
    assert.throws(() => parseBrevoDiariaRunArgs(["--apply", "--preflight", "--max-add", "5"]), BrevoDiariaAbort);
  });

  it("#6895: --apply sem --max-add é válido — maxAdd undefined, nunca 0 implícito", () => {
    const opts = parseBrevoDiariaRunArgs(["--apply"]);
    assert.equal(opts.mode, "apply");
    assert.equal(opts.maxAdd, undefined);
  });

  it("--apply --max-add 0 é válido — forma explícita de 'nenhum contato novo'", () => {
    const opts = parseBrevoDiariaRunArgs(["--apply", "--max-add", "0"]);
    assert.equal(opts.mode, "apply");
    assert.equal(opts.maxAdd, 0);
  });

  it("--apply --max-add com valor não-inteiro aborta", () => {
    assert.throws(() => parseBrevoDiariaRunArgs(["--apply", "--max-add", "abc"]), BrevoDiariaAbort);
    assert.throws(() => parseBrevoDiariaRunArgs(["--apply", "--max-add", "3.5"]), BrevoDiariaAbort);
    assert.throws(() => parseBrevoDiariaRunArgs(["--apply", "--max-add", "-1"]), BrevoDiariaAbort);
  });

  it("--confirm-mv é reconhecido em qualquer modo", () => {
    assert.equal(parseBrevoDiariaRunArgs(["--apply", "--max-add", "5", "--confirm-mv"]).confirmMv, true);
    assert.equal(parseBrevoDiariaRunArgs([]).confirmMv, false);
  });

  it("--i-know-this-skips-mv é reconhecido em qualquer modo, default false", () => {
    assert.equal(
      parseBrevoDiariaRunArgs(["--apply", "--max-add", "5", "--i-know-this-skips-mv"]).iKnowThisSkipsMv,
      true,
    );
    assert.equal(parseBrevoDiariaRunArgs([]).iKnowThisSkipsMv, false);
  });
});

describe("runBrevoDiaria — modo preflight", () => {
  it("roda os 3 dry-runs na ordem certa, sem nenhuma flag --push", () => {
    const handlers = Object.fromEntries(PREFLIGHT_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    const result = runBrevoDiaria([], deps(exec));

    assert.equal(result.code, 0);
    assert.equal(result.mode, "preflight");
    assert.deepEqual(
      calls.map((c) => c.script),
      PREFLIGHT_SCRIPTS,
    );
    for (const call of calls) {
      assert.ok(!call.args.includes("--push"), `${call.script} não deveria receber --push em preflight`);
    }
  });

  it("para no 1º passo que falhar e não roda os seguintes", () => {
    const { exec, calls } = makeFakeExec({
      "scripts/evaluate-brevo-diaria.ts": { code: 2, stdout: "", stderr: "ERRO: brevo_diaria não configurado." },
    });
    const result = runBrevoDiaria([], deps(exec));

    assert.equal(result.code, 1);
    assert.equal(result.mode, "preflight");
    assert.equal(calls.length, 1, "não deveria ter chamado refresh-pending-pool/sync-pending-to-brevo após a falha");
    assert.match(result.summary, /evaluate-brevo-diaria.*falhou/);
  });
});

describe("runBrevoDiaria — modo apply", () => {
  it("roda os 5 passos na ORDEM FIXA do Passo 4, com os args certos", () => {
    const handlers = Object.fromEntries(APPLY_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    const result = runBrevoDiaria(["--apply", "--max-add", "10"], deps(exec));

    assert.equal(result.code, 0);
    assert.equal(result.mode, "apply");
    assert.deepEqual(
      calls.map((c) => c.script),
      APPLY_SCRIPTS,
    );
    assert.deepEqual(calls[0].args, ["--push"]);
    assert.deepEqual(calls[1].args, ["--push"]);
    assert.deepEqual(calls[2].args, []);
    assert.deepEqual(calls[3].args, []); // verify-pending-emails-mv sem --confirm-mv
    assert.deepEqual(calls[4].args, ["--push", "--max-add", "10"]);
  });

  it("--max-add 0 é passado literalmente pro sync-pending-to-brevo", () => {
    const handlers = Object.fromEntries(APPLY_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    runBrevoDiaria(["--apply", "--max-add", "0"], deps(exec));
    assert.deepEqual(calls[4].args, ["--push", "--max-add", "0"]);
  });

  it("#6895: --apply SEM --max-add omite a flag pro sync-pending-to-brevo (sem teto, nunca 0 implícito)", () => {
    const handlers = Object.fromEntries(APPLY_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    const result = runBrevoDiaria(["--apply"], deps(exec));
    assert.equal(result.code, 0);
    assert.deepEqual(calls[4].args, ["--push"]);
  });

  it("--confirm-mv repassa --confirm só pro verify-pending-emails-mv, nenhum outro passo", () => {
    const handlers = Object.fromEntries(APPLY_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    runBrevoDiaria(["--apply", "--max-add", "5", "--confirm-mv"], deps(exec));
    assert.deepEqual(calls[3].args, ["--confirm"]);
    assert.deepEqual(calls[0].args, ["--push"]); // evaluate não recebe --confirm
    assert.deepEqual(calls[2].args, []); // score-pending-origin não recebe --confirm
  });

  it("para no 1º passo que falhar (ex: guard de custo MV) sem rodar sync-pending-to-brevo", () => {
    const { exec, calls } = makeFakeExec({
      "scripts/evaluate-brevo-diaria.ts": ok(),
      "scripts/refresh-pending-pool.ts": ok(),
      "scripts/score-pending-origin.ts": ok(),
      "scripts/verify-pending-emails-mv.ts": {
        code: 2,
        stdout: "",
        stderr: "ERRO: 600 e-mail(s) a verificar ≈ US$ 1.14 — acima do teto de 500. Confirme com --confirm.",
      },
    });
    const result = runBrevoDiaria(["--apply", "--max-add", "5"], deps(exec));

    assert.equal(result.code, 1);
    assert.equal(result.mode, "apply", "já mutou (evaluate/refresh --push rodaram) — mode deve refletir isso");
    assert.equal(calls.length, 4, "sync-pending-to-brevo não deveria rodar depois da falha do guard MV");
    assert.match(result.summary, /verify-pending-emails-mv.*falhou/);
  });

  it("--i-know-this-skips-mv repassa a mesma flag só pro sync-pending-to-brevo", () => {
    const handlers = Object.fromEntries(APPLY_SCRIPTS.map((s) => [s, ok()]));
    const { exec, calls } = makeFakeExec(handlers);
    runBrevoDiaria(["--apply", "--max-add", "5", "--i-know-this-skips-mv"], deps(exec));
    assert.deepEqual(calls[4].args, ["--push", "--max-add", "5", "--i-know-this-skips-mv"]);
    assert.deepEqual(calls[3].args, []); // verify-pending-emails-mv não recebe essa flag
  });

  it("erro de spawn (exceção) também aborta com code 1", () => {
    const exec: ExecFn = () => {
      throw new Error("spawn ENOENT");
    };
    const result = runBrevoDiaria(["--apply", "--max-add", "5"], deps(exec));
    assert.equal(result.code, 1);
    assert.match(result.summary, /erro inesperado/);
  });
});
