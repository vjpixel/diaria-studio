/**
 * test/plan-merge-train.test.ts (#6300)
 *
 * Cobre `printPlan` (formatação pura, chamada por import) e o ENTRYPOINT
 * de scripts/plan-merge-train.ts como PROCESSO (achado do fleet review,
 * PR #6361 — mesma lacuna que `test/check-develop-label-cleared-cli.test.ts`
 * documenta pra um script irmão: "os 40 testes da época seguiram verdes"
 * porque testavam só o módulo puro OU o caminho "gh indisponível", nunca o
 * CLI decidindo sobre argumento inválido de verdade). Os casos abaixo
 * cobrem exatamente esse meio-termo — validação de `--max-batch-size`/
 * `--prs` e o contrato de exit code — sem precisar de `gh`/rede real.
 *
 * `discoverOpenPrs`/`isGateOneGreen`/`filesForPr` (que dependem de `gh` de
 * verdade) continuam fora de teste automatizado — mesmo tratamento de
 * qualquer outro script `gh`-dependente do repo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printPlan } from "../scripts/plan-merge-train.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "plan-merge-train.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Roda o CLI como processo. `noGh: true` esvazia o PATH — usado pra
 * exercitar caminhos de validação de argumento que nunca chegam a chamar
 * `gh` (falham antes disso), sem depender de rede/autenticação real. */
function runCli(args: string[], opts: { noGh?: boolean } = {}): RunResult {
  const env = { ...process.env };
  if (opts.noGh) env.PATH = "";
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("printPlan", () => {
  it("PRs sem colisão viram 1 trem só, reportado como não-singleton", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["a.ts"] },
        { pr: 2, files: ["b.ts"] },
      ],
      3,
    );
    assert.match(out, /1 lote\(s\) composto/);
    assert.match(out, /trem de 2.*#1, #2/);
  });

  it("PRs colidentes viram lotes singleton, cada um rotulado 'caminho de hoje'", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["shared.ts"] },
        { pr: 2, files: ["shared.ts"] },
      ],
      3,
    );
    assert.match(out, /2 lote\(s\) composto/);
    assert.match(out, /singleton \(caminho de hoje, sem trem\)/);
  });

  it("reporta contagem de runs de CI hoje vs. com o trem no caminho feliz", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["a.ts"] },
        { pr: 2, files: ["b.ts"] },
        { pr: 3, files: ["c.ts"] },
      ],
      3,
    );
    assert.match(out, /3 hoje \(1 por PR\)/);
    assert.match(out, /1 com o trem/);
  });

  it("reporta o pior caso total (achado do fleet review — linha nunca era asserida)", () => {
    const out = printPlan([{ pr: 1, files: ["a.ts"] }, { pr: 2, files: ["a.ts"] }, { pr: 3, files: ["a.ts"] }], 3);
    // 3 PRs mutuamente colidentes (mesmo arquivo) → 3 lotes singleton →
    // pior caso = worstCaseCiRuns(1)×3 = 3.
    assert.match(out, /pior caso total \(todo lote vermelho até o piso\): 3 runs/);
  });
});

describe("plan-merge-train CLI — contrato de exit code (achado do fleet review, PR #6361)", () => {
  it("sem --prs nem --open: exit 2, sem tentar chamar gh", () => {
    const r = runCli([], { noGh: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /passe --prs.*ou --open/);
  });

  it("--prs vazio (só vírgulas/espaço): exit 2", () => {
    const r = runCli(["--prs", " , ,"], { noGh: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ao menos 1 número válido/);
  });

  it("--prs com token inválido: exit 2, nomeando o token — NUNCA filtra em silêncio", () => {
    // Achado do fleet review: antes, um token inválido era simplesmente
    // dropado (`.filter(Number.isFinite)`) e o PR sumia do plano sem
    // nenhum sinal. Agora precisa nomear o token e falhar.
    const r = runCli(["--prs", "6340,634l,6345"], { noGh: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"634l"/);
  });

  it("--max-batch-size não-numérico: exit 2 — NUNCA desliga o teto em silêncio", () => {
    // Achado do fleet review, o mais sério dos 5: Number('abc') = NaN, e
    // `NaN < 1` é `false` em JS — sem esta validação, o teto K inteiro
    // ficava desligado sem nenhum erro, e todo PR caía no mesmo lote.
    const r = runCli(["--prs", "1", "--max-batch-size", "abc"], { noGh: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /max-batch-size/);
  });

  it("--max-batch-size 0: exit 2 (não crash não-tratado)", () => {
    const r = runCli(["--prs", "1", "--max-batch-size", "0"], { noGh: true });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /TypeError|at Object\.<anonymous>/, "não pode vazar stack trace cru");
  });

  it("--max-batch-size fracionário (2.5): exit 2 — K é contagem de PR, não pode ser fração", () => {
    const r = runCli(["--prs", "1", "--max-batch-size", "2.5"], { noGh: true });
    assert.equal(r.status, 2);
  });

  it("gh ausente do PATH com --prs válido: exit 1, nunca stack trace cru", () => {
    const r = runCli(["--prs", "1,2"], { noGh: true });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /TypeError|at Object\.<anonymous>/);
  });
});
