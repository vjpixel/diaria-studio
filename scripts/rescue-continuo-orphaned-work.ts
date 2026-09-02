#!/usr/bin/env node
/**
 * rescue-continuo-orphaned-work.ts (#7130)
 *
 * CLI wrapper para `scripts/lib/continuo-tick-closure.ts`.
 *
 * Recupera trabalho órfão (árvore suja no checkout compartilhado, sobra de
 * um tick do contínuo que produziu diff e não fechou o laço — sem claim,
 * sem commit, sem PR, ver #7130) antes que outra sessão rode `git add -A`
 * e publique esse trabalho alheio na PR errada.
 *
 * Uso:
 *   npx tsx scripts/rescue-continuo-orphaned-work.ts [--push]
 *
 * Chamado no Passo 0 de `.claude/skills/diaria-continuo/SKILL.md` e no §1
 * de `hermes/skills/hermes-diaria-continuo/SKILL.md`, SEMPRE ANTES de
 * `scripts/sync-code.ts` (que também mexe em stash — recuperar primeiro
 * evita que o stash do sync misture árvores de origens diferentes).
 *
 * `--push`: além de commitar numa branch dedicada, tenta `git push` (best
 * effort — falha de push nunca descarta o commit local). Sem a flag, a
 * branch fica só local e o output diz isso explicitamente.
 *
 * Códigos de saída:
 *   0 — outcome "clean" (nada a recuperar) OU "rescued" com sucesso
 *       (push OK quando pedido, ou --push omitido).
 *   1 — outcome "rescue_failed" OU "rescued" com --push que falhou. Este
 *       script FALHA ALTO de propósito nesses casos (#7130, direção 2 da
 *       issue: "um tick que produziu diff e não fez nem uma coisa nem outra
 *       deveria falhar alto, não terminar em silêncio reportando sucesso")
 *       — quem chama este CLI (o Passo 0 do loop do contínuo) deve tratar
 *       exit 1 como bloqueio a investigar manualmente, nunca como warning a
 *       ignorar e seguir em frente.
 *
 * GUARD DE PUBLICAÇÃO: este script só mexe em `git` (branch/commit/push) —
 * nunca toca Beehiiv/LinkedIn/Facebook/Brevo/Kit. `git push`/`gh pr create`
 * não estão na lista de scripts proibidos de `context/overnight-dispatch-rules.md`
 * item 1.
 */

import { execFileSync } from "node:child_process";
import { rescueOrphanedWork, pushRescueBranch, defaultSpawn } from "./lib/continuo-tick-closure.ts";

function parseArgs(argv: string[]): { push: boolean } {
  return { push: argv.includes("--push") };
}

/** Best-effort `gh pr create` — nunca aborta o script se `gh` estiver
 * ausente/sem auth: a branch já publicada (ou local) é o que importa
 * preservar; o PR é conveniência de triagem, não a garantia de dados. */
function tryOpenPr(branch: string): { ok: boolean; message: string } {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch,
        "--base",
        "master",
        "--title",
        `chore(#7130): trabalho órfão recuperado de tick do contínuo — ${branch}`,
        "--body",
        "REFS #7130, NÃO CLOSES (achado de recuperação automática, não implementação da issue)\n\n" +
          "Commit automático de `rescue-continuo-orphaned-work.ts`. A origem exata (qual issue, qual tick) " +
          "é desconhecida por construção — triagem manual necessária antes de mergear ou descartar.\n\n" +
          "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    return { ok: true, message: out.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `gh pr create falhou (não bloqueia — branch já preservada): ${message}` };
  }
}

function main(): void {
  const { push } = parseArgs(process.argv.slice(2));

  const result = rescueOrphanedWork(defaultSpawn);
  console.log(JSON.stringify(result, null, 2));

  if (result.outcome === "clean") {
    process.exitCode = 0;
    return;
  }

  if (result.outcome === "rescue_failed") {
    process.stderr.write(`\n⚠ RESCUE FALHOU — trabalho órfão pode continuar sujo no checkout compartilhado.\n`);
    process.stderr.write(result.message + "\n");
    process.exitCode = 1;
    return;
  }

  // outcome === "rescued"
  process.stderr.write(`\n✔ Trabalho órfão recuperado: branch ${result.branch}\n`);
  process.stderr.write(result.message + "\n");

  if (!push) {
    process.exitCode = 0;
    return;
  }

  const pushResult = pushRescueBranch(defaultSpawn, result.branch);
  console.log(JSON.stringify({ push: pushResult }, null, 2));
  if (!pushResult.ok) {
    process.stderr.write(pushResult.message + "\n");
    process.exitCode = 1;
    return;
  }

  const prResult = tryOpenPr(result.branch);
  console.log(JSON.stringify({ pr: prResult }, null, 2));
  // `gh pr create` falhando não vira exit 1 — o push já publicou o trabalho
  // no remoto, que é a garantia real; o PR é conveniência de triagem.
  process.exitCode = 0;
}

main();
