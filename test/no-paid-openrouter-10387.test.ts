/**
 * test/no-paid-openrouter-10387.test.ts (#10387)
 *
 * Decisão do editor (18/10/2026, /diaria-desbloqueia): "não estou mais usando
 * modelos pagos no OpenRouter". Nenhum caminho deste repo pode cair num modelo
 * pago do OpenRouter, nem como fallback de último recurso. Este teste trava o
 * lado que vive NO REPO (os configs em ~/.hermes no `300` ficam fora):
 *
 *   1. `claude-delegate.sh` recusa `--model` pago com exit 2 ANTES de ler chave
 *      ou prompt (AO VIVO, com `claude` falso no PATH — nunca toca a rede).
 *   2. `claude-delegate.sh` recusa uma cadeia default com elo pago
 *      reintroduzido (AO VIVO, numa cópia do script com o array adulterado).
 *   3. `:free` e a sentinela de assinatura continuam passando pelo portão.
 *   4. A lane de piloto do #6930 aborta antes de qualquer efeito.
 *   5. O alarme de preço do #6818/#10278/#10295 saiu do watchdog.
 *
 * As allowlists vazias (`PAID_ALLOWLIST`/`EXPECTED_PAID_MODELS`) são travadas
 * em test/openrouter-billing-leak-model-list-drift-6994.test.ts e
 * hermes/scripts/hermes-model-cost-report.test.py.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(ROOT, "hermes/scripts/claude-delegate.sh");
const DISPATCH = join(ROOT, "scripts/dispatch-glm-lane-unit.sh");
const WATCH = join(ROOT, "hermes/scripts/watch-continuo-health.sh");

let tmp = "";
let fakeBin = "";
let envBase: NodeJS.ProcessEnv = {};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "no-paid-openrouter-10387-"));
  fakeBin = join(tmp, "bin");
  mkdirSync(fakeBin);
  // `claude` falso: responde ao preflight e a qualquer invocação com exit 0 —
  // nenhuma chamada real ao OpenRouter nem à assinatura.
  writeFileSync(
    join(fakeBin, "claude"),
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.0.0 (fake)"; exit 0; fi\necho "resposta fake"\nexit 0\n',
  );
  chmodSync(join(fakeBin, "claude"), 0o755);
  envBase = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    CLAUDE_BINARY_PREFLIGHT_CMD: "claude",
    TMPDIR: tmp,
  };
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function runWrapper(script: string, args: string[]) {
  return spawnSync("bash", [script, ...args], {
    input: "prompt de teste",
    encoding: "utf8",
    env: envBase,
    timeout: 20_000,
  });
}

describe("#10387 — claude-delegate.sh nunca roda modelo pago do OpenRouter", () => {
  for (const paid of ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash", "anthropic/claude-sonnet-5"]) {
    it(`--model ${paid} é recusado com exit 2`, () => {
      const r = runWrapper(WRAPPER, ["--model", paid, "--timeout", "5"]);
      assert.equal(r.status, 2, `esperava exit 2, veio ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stderr, /recusado \(#10387\)/);
    });
  }

  for (const allowed of ["poolside/laguna-s-2.1:free", "sonnet"]) {
    it(`--model ${allowed} passa pelo portão (:free ou elo de assinatura)`, () => {
      const r = runWrapper(WRAPPER, ["--model", allowed, "--timeout", "5"]);
      assert.doesNotMatch(r.stderr, /recusado \(#10387\)/, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /MODELS_DEFAULT contém/);
    });
  }

  it("cadeia default com elo pago reintroduzido é recusada (exit 2), mesmo sem --model", () => {
    const copyDir = join(tmp, "scripts-copy");
    cpSync(dirname(WRAPPER), copyDir, { recursive: true });
    const copy = join(copyDir, "claude-delegate.sh");
    const src = readFileSync(copy, "utf8");
    const adulterated = src.replace(
      /^MODELS_DEFAULT=\((.*)"\$SUBSCRIPTION_LANE_MODEL"\)$/m,
      'MODELS_DEFAULT=($1"deepseek/deepseek-v4-flash" "$SUBSCRIPTION_LANE_MODEL")',
    );
    assert.notEqual(adulterated, src, "regex não achou a linha MODELS_DEFAULT — formato mudou");
    writeFileSync(copy, adulterated);
    const r = runWrapper(copy, ["--timeout", "5"]);
    assert.equal(r.status, 2, `esperava exit 2, veio ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /MODELS_DEFAULT contém 'deepseek\/deepseek-v4-flash'/);
  });
});

describe("#10387 — lane de piloto do #6930 encerrada", () => {
  it("dispatch-glm-lane-unit.sh aborta (exit 3) antes de qualquer efeito", () => {
    const r = spawnSync("bash", [DISPATCH, "99999"], { encoding: "utf8", env: envBase, timeout: 20_000 });
    assert.equal(r.status, 3, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /encerrada no #10387/);
  });

  it("#10431: o script é só lápide — nenhum código de despacho sobra depois do exit 3", () => {
    // Só linhas de CÓDIGO — o docstring do topo cita o harness removido.
    const code = readFileSync(DISPATCH, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
    assert.deepEqual(
      code.map((l) => l.split(/\s+/)[0]),
      ["set", "echo", "exit"],
      `código além de set/echo/exit voltou ao dispatch-glm-lane-unit.sh: ${code.join(" | ")}`,
    );
    for (const marker of ["claude-delegate", "worktree", "is-claimed", "glm-lane-credits"]) {
      assert.ok(!code.join("\n").includes(marker), `marcador de despacho ${marker} voltou ao código`);
    }
  });

  it("#10431: o harness que só a lane consumia foi removido (gate, registro, guard de headRefName)", () => {
    for (const rel of [
      "scripts/check-glm-lane-gate.ts",
      "scripts/lib/glm-lane-gate.ts",
      "scripts/record-glm-lane-unit.ts",
      "scripts/lib/glm-lane-headref-guard.sh",
    ]) {
      assert.equal(existsSync(join(ROOT, rel)), false, `${rel} deveria ter saído no #10431`);
    }
  });
});

describe("#10387 — alarme de preço de modelo pago saiu do watchdog", () => {
  it("watch-continuo-health.sh não invoca mais --price-check nem abre issue de aumento de preço", () => {
    const code = readFileSync(WATCH, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.doesNotMatch(code, /--price-check/);
    assert.doesNotMatch(code, /aumento de preço em modelo pago/);
  });

  it("sintaxe bash do watchdog segue válida (bash -n)", () => {
    const r = spawnSync("bash", ["-n", WATCH], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});
