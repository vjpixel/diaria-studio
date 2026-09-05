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
import { rescueOrphanedWork, pushRescueBranch, defaultSpawn, type RescueOutcome } from "./lib/continuo-tick-closure.ts";
import { isMainModule } from "./lib/cli-args.ts";
import type { GitSpawnFn as SpawnFn, SpawnResult } from "./lib/spawn-types.ts";

/** Adapta `execFileSync` (usado só aqui, `gh pr create`) pro formato
 * `SpawnResult` injetável — mesmo padrão de `defaultSpawn` (git) em
 * `scripts/lib/continuo-tick-closure.ts`/`git-sync.ts`, permite testar
 * `tryOpenPr` sem spawnar `gh` de verdade (#7484). */
function execFileSpawn(cmd: string, args: string[], timeoutMs = 60_000): SpawnResult {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const asNodeError = err as { status?: number; stdout?: unknown; message?: string };
    return {
      status: typeof asNodeError?.status === "number" ? asNodeError.status : 1,
      stdout: typeof asNodeError?.stdout === "string" ? asNodeError.stdout : "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseArgs(argv: string[]): { push: boolean } {
  return { push: argv.includes("--push") };
}

/** Decide o exit code para `outcome === "rescued"` — extraída de `main()` para
 * ser testável sem spawnar `git`/`gh` (#7340: bug era `checkoutBackFailed`
 * nunca ser lido por nenhum consumidor, então todo "rescued" saía 0). */
export function resolveRescuedExitCode(
  result: Extract<RescueOutcome, { outcome: "rescued" }>,
): { exitCode: 0 | 1; stderr?: string } {
  if (result.checkoutBackFailed) {
    return {
      exitCode: 1,
      stderr:
        `\n⚠ CHECKOUT DE VOLTA PRA MASTER FALHOU — o checkout compartilhado ainda está na branch de rescue ` +
        `(${result.branch}). Trocar manualmente antes de qualquer outra sessão continuar (#7340).\n`,
    };
  }
  return { exitCode: 0 };
}

export interface OpenPrSummary {
  number: number;
  headRefName: string;
}

/** Pura (#7446 item 5): escolhe a PR de rescue ABERTA mais recente (maior
 * `number`) entre as candidatas — usada para decidir se já existe uma PR
 * `continuo/rescue-*` aberta antes de abrir outra. `null` quando não há
 * nenhuma. Medido ao vivo (04-05/09/2026): 3 PRs de rescue abertas
 * simultaneamente (#7404, #7444, #7445) sem nenhuma consolidação — cada
 * tick com árvore suja abria uma PR nova, empilhando a fila em vez de
 * apontar pra que já existia. */
export function selectExistingOpenRescuePr(openPrs: OpenPrSummary[]): OpenPrSummary | null {
  const rescuePrs = openPrs.filter((pr) => pr.headRefName.startsWith("continuo/rescue-"));
  if (rescuePrs.length === 0) return null;
  return rescuePrs.reduce((latest, pr) => (pr.number > latest.number ? pr : latest));
}

/** I/O: lista PRs `continuo/rescue-*` abertas via `gh pr list`. `null` = `gh`
 * falhou (rede, auth) — o chamador trata como "não sei" e segue abrindo a PR
 * normalmente (mesmo espírito fail-open de `tryOpenPr`: a pior consequência
 * de um falso negativo aqui é 1 PR a mais na fila, nunca perda de dado). */
function listOpenRescuePrs(): OpenPrSummary[] | null {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,headRefName",
        "--jq",
        '[.[] | select(.headRefName | startswith("continuo/rescue-"))]',
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    return JSON.parse(out) as OpenPrSummary[];
  } catch {
    return null;
  }
}

/** Label aplicada à PR de rescue para bloquear o auto-merge da regra "review
 * limpo + CI verde mergeia sozinho" (#5251/#6299) — `bloqueio-execucao` já é
 * lida por `classifyExecTrack` (roteia pra Bloqueada), então reusar em vez de
 * inventar uma label dedicada (#7484: confirmado via `gh label list` antes de
 * escolher — nenhuma label "não mergear" existia no repo). */
export const RESCUE_PR_BLOCK_LABEL = "bloqueio-execucao";

/** Pura (#7484): monta o argv de `gh pr create` para a PR de rescue.
 * `withLabel=false` (usado só pelo retry de `tryOpenPr` abaixo, quando o
 * primeiro `gh pr create --label ...` falha) omite `--label`/`--body` de
 * bloqueio — usado quando a label não pôde ser aplicada (sumiu/renomeada) e
 * pelo menos o `--draft` precisa sair. Extraída de `tryOpenPr` para ser
 * testável sem spawnar `gh` de verdade. A PR sai SEMPRE como `--draft`
 * (draft não é auto-mergeável por construção) — sem isso, o corpo dizendo
 * "triagem manual necessária" era só prosa: nada impedia a regra de
 * auto-merge (#5251/#6299) de mergear a PR sozinha assim que review+CI
 * saíssem limpos (foi o que aconteceu com a #7438, que levou
 * `.review-i1.md` pra `master`). */
export function buildRescuePrArgs(branch: string, withLabel = true): string[] {
  const labelNote = withLabel
    ? `PR aberta como draft + label \`${RESCUE_PR_BLOCK_LABEL}\` (#7484) para não ser auto-mergeada ` +
      "pela regra de review limpo + CI verde antes dessa triagem acontecer."
    : "PR aberta como draft (SEM a label de bloqueio — `gh pr create --label` falhou, ver mensagem de retry) " +
      "para não ser auto-mergeada pela regra de review limpo + CI verde antes da triagem acontecer.";
  const args = [
    "pr",
    "create",
    "--head",
    branch,
    "--base",
    "master",
    "--draft",
    ...(withLabel ? ["--label", RESCUE_PR_BLOCK_LABEL] : []),
    "--title",
    `chore(#7130): trabalho órfão recuperado de tick do contínuo — ${branch}`,
    "--body",
    "REFS #7130, NÃO CLOSES (achado de recuperação automática, não implementação da issue)\n\n" +
      "Commit automático de `rescue-continuo-orphaned-work.ts`. A origem exata (qual issue, qual tick) " +
      "é desconhecida por construção — triagem manual necessária antes de mergear ou descartar. " +
      labelNote +
      "\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ];

  // Assert leve (#7484, type-design-analyzer): a garantia "toda PR de rescue
  // sai draft, e com a label quando pedida" não fica só implícita no array
  // literal acima nem só nos testes — falha alto AQUI, na construção, se
  // algum refactor futuro remover `--draft` ou o par `--label`/valor por
  // engano, em vez de deixar a PR sair silenciosamente sem a proteção.
  if (!args.includes("--draft")) {
    throw new Error("buildRescuePrArgs: invariante quebrado — PR de rescue sem --draft");
  }
  if (withLabel) {
    const labelIdx = args.indexOf("--label");
    if (labelIdx === -1 || args[labelIdx + 1] !== RESCUE_PR_BLOCK_LABEL) {
      throw new Error("buildRescuePrArgs: invariante quebrado — --label ausente ou com valor errado");
    }
  }

  return args;
}

/** Best-effort `gh pr create` — mas com retry (#7484): `--label
 * bloqueio-execucao` faz o comando INTEIRO falhar se a label não existir
 * (deletada/renomeada/typo), e essa falha cairia no mesmo catch genérico que
 * trata "gh ausente/sem auth" como benigno — exatamente a classe de
 * regressão que esta issue existe pra fechar, uma camada acima: a PR de
 * rescue simplesmente não seria criada, sem PR/draft/label/proteção nenhuma,
 * soando como um caso trivial de "gh indisponível" no log. Se o 1º `gh pr
 * create` (com label) falhar, tenta de novo SEM `--label` — o `--draft`
 * sozinho já é bloqueio mecânico real (GitHub recusa merge de PR draft), e o
 * retry bem-sucedido sinaliza CLARAMENTE (via `labelApplied: false` +
 * mensagem) que a label não pôde ser aplicada, para investigação — nunca
 * silenciosamente "não bloqueia, branch preservada" como uma falha real de
 * `gh` faria. Só depois que os DOIS falharem é que cai na falha benigna
 * (gh não instalado/não autenticado).
 *
 * `spawn` injetável (default `execFileSpawn`, wrapper de `execFileSync`) —
 * mesmo padrão de `defaultSpawn` em `continuo-tick-closure.ts`/`git-sync.ts`
 * — permite testar as duas tentativas sem spawnar `gh` de verdade. */
export function tryOpenPr(
  branch: string,
  spawn: SpawnFn = execFileSpawn,
): { ok: boolean; message: string; labelApplied?: boolean } {
  const withLabel = spawn("gh", buildRescuePrArgs(branch, true));
  if (withLabel.status === 0) {
    return { ok: true, message: withLabel.stdout.trim(), labelApplied: true };
  }

  const withoutLabel = spawn("gh", buildRescuePrArgs(branch, false));
  if (withoutLabel.status === 0) {
    return {
      ok: true,
      labelApplied: false,
      message:
        `PR criada em draft MAS SEM a label \`${RESCUE_PR_BLOCK_LABEL}\` de bloqueio — investigar se a label ` +
        `ainda existe no repo (\`gh label list\`). \`gh pr create --label\` falhou com: ${withLabel.stderr}\n` +
        `PR (sem label): ${withoutLabel.stdout.trim()}`,
    };
  }

  return {
    ok: false,
    message: `gh pr create falhou (não bloqueia — branch já preservada): ${withoutLabel.stderr}`,
  };
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

  const rescuedExit = resolveRescuedExitCode(result);
  if (rescuedExit.exitCode === 1) {
    if (rescuedExit.stderr) process.stderr.write(rescuedExit.stderr);
    process.exitCode = 1;
    return;
  }

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

  // #7446 item 5: teto de 1 PR de rescue aberta por vez. Antes de abrir
  // outra, checa se já existe uma `continuo/rescue-*` aberta — se sim, a
  // branch nova fica publicada (push já rodou acima, trabalho preservado)
  // mas SEM PR nova: evita empilhar a fila (medido: 3 PRs simultâneas,
  // #7404/#7444/#7445, sem nenhuma consolidação). `gh` indisponível (`null`)
  // segue o comportamento pré-existente (abre a PR normalmente) — fail-open
  // em direção a preservar visibilidade, não a suprimir.
  const openRescuePrs = listOpenRescuePrs();
  const existingRescuePr = openRescuePrs === null ? null : selectExistingOpenRescuePr(openRescuePrs);
  if (existingRescuePr !== null) {
    const message =
      `PR de rescue já aberta (#${existingRescuePr.number}, ${existingRescuePr.headRefName}) — não abrindo outra ` +
      `(#7446 item 5, teto de 1). Branch ${result.branch} publicada em origin, sem PR própria; triagem manual pode ` +
      `mergear/rebasear o conteúdo dela na PR existente se fizer sentido consolidar.`;
    console.log(JSON.stringify({ pr: { ok: true, skipped: true, message } }, null, 2));
    process.exitCode = 0;
    return;
  }

  const prResult = tryOpenPr(result.branch);
  console.log(JSON.stringify({ pr: prResult }, null, 2));
  // `gh pr create` falhando não vira exit 1 — o push já publicou o trabalho
  // no remoto, que é a garantia real; o PR é conveniência de triagem.
  process.exitCode = 0;
}

// Guard (#7340, achado ao vivo durante a implementação desta própria issue):
// sem isto, qualquer `import` deste módulo — inclusive de um teste que só
// quer `resolveRescuedExitCode` — executava `main()` de verdade contra o
// checkout compartilhado (git real via `defaultSpawn`), podendo commitar/
// mover a branch corrente sem que o importador tivesse pedido isso.
if (isMainModule(import.meta.url)) {
  main();
}
