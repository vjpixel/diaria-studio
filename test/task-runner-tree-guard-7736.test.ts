/**
 * test/task-runner-tree-guard-7736.test.ts (#7736)
 *
 * Guard mecânico de reincidência — não trava um comportamento de
 * `task-runner.ts` em si (isso já é `test/task-runner.test.ts`), trava a
 * PROPRIEDADE de `test/task-runner.test.ts` inteiro: rodar essa suíte NUNCA
 * move o HEAD do repo nem suja a working tree.
 *
 * ## Por que isto existe
 *
 * `runScheduledTask()` (`scripts/lib/task-runner.ts`) aceita `syncCode` como
 * injeção OPCIONAL — sem injetar, o default é o `syncCode()` REAL de
 * `./git-sync.ts`, que roda `checkout master` → `fetch origin` →
 * `merge --ff-only origin/master` (+ `stash`/`stash pop` se a árvore estiver
 * suja) contra `rootDir`. 13 call sites de `test/task-runner.test.ts`
 * passavam `rootDir: ROOT` (a raiz real do repo) sem injetar `syncCode` — a
 * suíte rodava o sync de verdade contra o próprio checkout que o CI estava
 * testando, no MEIO do `npm test`. Efeito medido em CI (#7736, comentário
 * "CULPADO IDENTIFICADO"): o HEAD saía do merge ref do PR e virava `master`
 * nos últimos ~45s de uma run de ~5min — todo teste que lesse arquivo do
 * disco DEPOIS disso via a versão da BASE, não a do PR (arquivo modificado
 * lido na versão antiga; arquivo adicionado pela PR simplesmente
 * "não existia").
 *
 * O fix (injetar `syncCode` nos 13 call sites) fecha a ocorrência atual, mas
 * sozinho apodrece no próximo call site novo que alguém adicionar sem
 * pensar em injeção — exatamente como os 13 originais nasceram um a um. Este
 * teste é a rede: roda a suíte real via subprocesso e falha se o HEAD (ou a
 * working tree) mudar, não importa QUAL call site causou.
 *
 * ## Limitação conhecida — não reproduz o sintoma dentro de um worktree de
 * agente
 *
 * `syncCode()` real recusa IMEDIATAMENTE (`outcome: "worktree_refused"`,
 * antes de qualquer comando git — ver `isAgentWorktreeCheckout` em
 * `git-sync.ts`, #7336) quando `REPO_ROOT` (calculado a partir de
 * `import.meta.url` do próprio módulo, não do `rootDir` passado ao
 * `runScheduledTask`) resolve para dentro de `.claude/worktrees/**`. Rodar
 * este teste a partir de um worktree de agente (como este mesmo, ao validar
 * o PR) NUNCA vai mover o HEAD mesmo que um call site futuro esqueça
 * `syncCode` — o guard do #7336 mascara o sintoma nesse ambiente
 * específico. Isso não invalida este teste: em CI, o `actions/checkout`
 * NÃO é um worktree de agente (é um clone raso normal na raiz do repo),
 * então `isAgentWorktreeCheckout` retorna `false` e o `syncCode()` real
 * roda os comandos destrutivos de verdade — é exatamente o ambiente onde o
 * defeito original foi medido, e onde este guard protege.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitOutput(args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou (exit ${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

describe("#7736 — test/task-runner.test.ts nunca move o HEAD do repo", () => {
  it("git rev-parse HEAD e git status --porcelain são idênticos antes e depois da suíte", () => {
    const headBefore = gitOutput(["rev-parse", "HEAD"]);
    const statusBefore = gitOutput(["status", "--porcelain"]);

    // `node:test` marca o processo atual com `NODE_TEST_CONTEXT`/
    // `NODE_TEST_WORKER_ID` (herdados por padrão em qualquer processo
    // filho) pra detectar chamada RECURSIVA de `run()` dentro de um
    // arquivo de teste — sem limpar essas 2 vars, o node do filho vê que
    // já está "dentro" de um test runner e pula silenciosamente a run
    // inteira (`Warning: node:test run() is being called recursively...
    // skipping running files`), devolvendo `status: 0`/stdout vazio: um
    // falso-verde que nunca exercita `task-runner.test.ts` de verdade.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "test/task-runner.test.ts"],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: childEnv },
    );

    const headAfter = gitOutput(["rev-parse", "HEAD"]);
    const statusAfter = gitOutput(["status", "--porcelain"]);

    // Falha aqui (test/task-runner.test.ts com asserção quebrada) é um
    // problema separado, não o que este guard testa — mas se a suíte nem
    // rodou (falha de spawn), o resultado do diff de árvore abaixo já não
    // significa nada; melhor reportar isso primeiro.
    assert.notEqual(result.status, null, `spawn de task-runner.test.ts falhou: ${result.error?.message}`);

    // Guarda contra o próprio guard mentir "verde" sem ter rodado nada — ver
    // nota acima sobre `NODE_TEST_CONTEXT`. Se isto disparar, o problema é
    // no MECANISMO deste teste (env do subprocesso), não em `task-runner.ts`.
    assert.match(
      result.stdout,
      /ℹ tests \d+/,
      `subprocesso de task-runner.test.ts não produziu saída de test runner (possível skip ` +
        `silencioso por NODE_TEST_CONTEXT vazado) — stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /being called recursively/,
      "subprocesso detectou run() recursivo e pulou a suíte — env do filho não foi limpo corretamente",
    );

    assert.equal(
      headAfter,
      headBefore,
      `HEAD mudou de ${headBefore} para ${headAfter} durante test/task-runner.test.ts — ` +
        `algum call site de runScheduledTask() não injetou 'syncCode' e rodou o sync REAL ` +
        `contra a raiz do repo (#7736). Saída da suíte:\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      statusAfter,
      statusBefore,
      `git status --porcelain mudou durante test/task-runner.test.ts (antes: ${JSON.stringify(statusBefore)}, ` +
        `depois: ${JSON.stringify(statusAfter)}) — mesma causa provável do HEAD acima (#7736).`,
    );
  });
});
