/**
 * test/run-merge-train.test.ts (#6300, regressão #633)
 *
 * Cobre o ENTRYPOINT de scripts/run-merge-train.ts como PROCESSO — mesmo
 * padrão de test/plan-merge-train.test.ts e
 * test/check-develop-label-cleared-cli.test.ts (a lacuna que o repo já
 * pagou por deixar destampada num script irmão: "os 40 testes da época
 * seguiram verdes" porque nenhum exercitava o CLI decidindo sobre
 * argumento inválido de verdade).
 *
 * A orquestração de MERGE em si (runMergeTrain e as funções de
 * scripts/lib/merge-train-live.ts) já tem cobertura completa com runner
 * fake em test/merge-train-live.test.ts — aqui só o contrato de
 * argumento/exit-code do CLI, sem precisar de gh/rede real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-merge-train.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Roda o CLI como processo, `PATH` esvaziado — todos os casos abaixo
 * falham na validação de argumento, ANTES de qualquer chamada a `gh`. */
function runCli(args: string[]): RunResult {
  const env = { ...process.env, PATH: "" };
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("run-merge-train CLI — contrato de exit code", () => {
  it("sem --session-id: exit 2, sem tentar chamar gh", () => {
    const r = runCli(["--kind", "develop", "--prs", "1"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--session-id é obrigatório/);
  });

  it("sem --kind: exit 2", () => {
    const r = runCli(["--session-id", "abc-123", "--prs", "1"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--kind/);
  });

  it("--kind inválido (fora de overnight|develop|continuo): exit 2", () => {
    const r = runCli(["--session-id", "abc-123", "--kind", "cronjob", "--prs", "1"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--kind/);
  });

  it("sem --prs nem --open: exit 2", () => {
    const r = runCli(["--session-id", "abc-123", "--kind", "develop"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /passe --prs.*ou --open/);
  });

  it("--prs com token inválido: exit 2, nomeando o token", () => {
    const r = runCli(["--session-id", "abc-123", "--kind", "develop", "--prs", "6340,634l"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"634l"/);
  });

  it("--max-batch-size não-numérico: exit 2 — mesma defesa de plan-merge-train.ts", () => {
    const r = runCli(["--session-id", "abc-123", "--kind", "develop", "--prs", "1", "--max-batch-size", "abc"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /max-batch-size/);
  });

  it("gh ausente do PATH com argumentos válidos: exit 1, nunca stack trace cru", () => {
    const r = runCli(["--session-id", "abc-123", "--kind", "develop", "--prs", "1"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /TypeError|at Object\.<anonymous>/);
  });
});
