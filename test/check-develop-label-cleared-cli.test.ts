/**
 * test/check-develop-label-cleared-cli.test.ts (#6271, lacuna achada no fleet review #6320)
 *
 * Exercita o ENTRYPOINT de `scripts/check-develop-label-cleared.ts` como
 * processo, não as funções puras.
 *
 * Por que isso não é zelo excessivo: o repo já pagou por essa lacuna exata.
 * `test/state-changed-tracker.test.ts` documenta que, num guard irmão, alguém
 * reverteu a condição de saída do CLI de volta ao bug original **e os 40
 * testes da época seguiram verdes** — porque todos exercitavam ou o módulo
 * puro ou o caminho "gh indisponível", nunca o CLI decidindo sobre dado real.
 *
 * O que só se pega aqui: resolução de `--plan`/`--edition`, os `exit` codes do
 * contrato, o parse do `plan.json` nos DOIS shapes (array e dict — ver
 * `plan-issues-normalize.ts`), e a ressalva de cobertura parcial na linha de
 * veredito. Nada disso precisa de `gh`: os casos abaixo ou não chegam a
 * buscar, ou buscam com o `gh` deliberadamente ausente do `PATH`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-develop-label-cleared.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Roda o CLI como processo. `noGh: true` esvazia o PATH pra forçar o
 * caminho fail-soft sem depender de rede nem de rate limit real. */
function runCli(args: string[], opts: { noGh?: boolean } = {}): RunResult {
  const env = { ...process.env };
  if (opts.noGh) env.PATH = "";
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90_000,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function withPlan(plan: unknown, fn: (planPath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dlc-cli-"));
  try {
    const dir = join(root, "data", "develop", "260826x");
    mkdirSync(dir, { recursive: true });
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, typeof plan === "string" ? plan : JSON.stringify(plan), "utf8");
    fn(planPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#6271 CLI — contrato de exit code", () => {
  it("sem --plan nem --edition → exit 2 com instrução", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--plan|--edition/);
  });

  it("plan.json inexistente → exit 2 (não envolve rede, é sessão malformada)", () => {
    const r = runCli(["--plan", join(tmpdir(), "nao-existe-mesmo-6271", "plan.json")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não encontrado/i);
  });

  it("plan.json ilegível → exit 2, e NUNCA um stack trace cru", () => {
    withPlan("{ isto não é json", (planPath) => {
      const r = runCli(["--plan", planPath]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /ileg[íi]vel/i);
      // O contrato do gate é mensagem formatada; exceção crua significaria que
      // o try/catch de parse deixou de cobrir algum caminho.
      assert.doesNotMatch(r.stderr, /TypeError|SyntaxError:.*\n\s+at /);
    });
  });
});

describe("#6271 CLI — os DOIS shapes de plan.issues", () => {
  // `plan-issues-normalize.ts` (#4817/#4860): o develop foi observado ao vivo
  // gravando `issues` como DICT chaveado pelo número, apesar do SKILL.md dizer
  // que reusa o schema do overnight (array). `for...of` sobre dict lança
  // `TypeError: not iterable` — o crash que o #4817 corrigiu noutro consumidor.
  it("ARRAY sem issue terminada → ok trivial, sem tocar o gh", () => {
    withPlan({ issues: [{ number: 1, status: "pendente" }] }, (planPath) => {
      const r = runCli(["--plan", planPath], { noGh: true });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /ok —/);
    });
  });

  it("DICT chaveado por número não crasha — é o shape real do develop", () => {
    withPlan({ issues: { "6181": { status: "pendente" }, "467": { status: "nao-tentada" } } }, (planPath) => {
      const r = runCli(["--plan", planPath], { noGh: true });
      assert.doesNotMatch(r.stderr, /not iterable/i, "leitura direta de plan.issues teria crashado aqui");
      assert.equal(r.status, 0);
    });
  });

  it("issues ausente → plano vazio, ok trivial", () => {
    withPlan({ goal: {} }, (planPath) => {
      const r = runCli(["--plan", planPath], { noGh: true });
      assert.equal(r.status, 0);
    });
  });
});

describe("#6271 CLI — fail-soft do gh nunca vira aprovação implícita", () => {
  it("gh ausente + issue TERMINADA → exit 0, e diz que o gate NÃO rodou", () => {
    // Este é o caminho que o fleet review #6320 apontou como o mais perigoso:
    // sair 0 sem deixar claro que nada foi verificado.
    withPlan({ issues: [{ number: 6181, status: "mergeada" }] }, (planPath) => {
      const r = runCli(["--plan", planPath], { noGh: true });
      assert.equal(r.status, 0, "fail-soft: nunca trava a rodada por CLI/rede ausente (#738)");
      assert.match(
        r.stderr,
        /NÃO é um veredito/i,
        "sair 0 em silêncio seria indistinguível de 'verificado, tudo limpo'",
      );
      assert.doesNotMatch(r.stdout, /nenhum res[íi]duo/i, "não pode afirmar ausência de resíduo sem ter checado");
    });
  });

  it("issue NÃO terminada com gh ausente nem tenta buscar — não há o que ressalvar", () => {
    // Consequência do filtro `isWorkFinished` ANTES do fetch: o gate só gasta
    // rede com o que de fato avalia.
    withPlan({ issues: [{ number: 6048, status: "nao-tentada" }] }, (planPath) => {
      const r = runCli(["--plan", planPath], { noGh: true });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /NÃO é um veredito/i);
    });
  });
});

describe("#6271 CLI — --edition resolve o caminho padrão", () => {
  it("--edition aponta pra data/develop/{AAMMDD}/plan.json e falha honesto se não existir", () => {
    const r = runCli(["--edition", "999999"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /data[\\/]develop[\\/]999999[\\/]plan\.json/);
  });
});
