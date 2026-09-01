#!/usr/bin/env node
/**
 * sync-code.ts (#2686)
 *
 * CLI wrapper para `scripts/lib/git-sync.ts`.
 *
 * Sincroniza o checkout local com origin/master antes de iniciar uma edição
 * diar.ia.br. Invocado pelo Passo 0 de `.claude/skills/diaria-edicao/SKILL.md`.
 *
 * Sempre sai com código 0 (fail-soft) — falhas de sync são warn, nunca
 * bloqueiam a edição. O status é impresso em JSON para o orchestrator logar.
 *
 * Uso:
 *   npx tsx scripts/sync-code.ts
 *
 * Saída (stdout):
 *   JSON com campos outcome, message, branch_before, warnings, proceed,
 *   up_to_date, commits_behind (#6090).
 *
 * #6090: quando `commits_behind > 0`, imprime um BANNER visível no stderr —
 * a edição continua (fail-soft), mas o defasamento deixa de ser uma linha
 * invisível no meio do JSON e vira sinalização explícita pro orchestrator/
 * editor (incidente 260825: pipeline inteiro rodou com código antigo sob 3×
 * "sucesso" porque o warning era prosa ignorable).
 *
 * #6668: quando `outcome === "stash_pop_conflict"`, imprime um 2º BANNER
 * (mais forte — checkout ficou com arquivo(s) VERSIONADO(S) com marcador de
 * conflito literal no disco, mais sério que um `stash_pop_failed` comum).
 * Ainda fail-soft (exit 0) — este script não decide sozinho parar a
 * pipeline (isso é escopo do orchestrator/stage, CLAUDE.md "Sync de código
 * no início de cada edição"), só garante que o sinal não fique perdido no
 * meio do JSON.
 */

import { syncCode } from "./lib/git-sync.ts";

const result = syncCode();

// Sempre imprime JSON do resultado para o orchestrator logar
console.log(JSON.stringify(result, null, 2));

// Warnings humanos no stderr (sem duplicar o JSON)
if (result.warnings.length > 0) {
  for (const w of result.warnings) {
    process.stderr.write(w + "\n");
  }
}

// #6090: banner de código defasado — NÃO bloqueia (fail-soft preservado),
// só para de ser invisível.
if (result.commits_behind > 0) {
  const n = result.commits_behind;
  process.stderr.write(
    `\n⚠  CÓDIGO DEFASADO — ${n} commit${n > 1 ? "s" : ""} atrás de origin/master.\n` +
      `   A edição vai continuar (fail-soft), mas scripts podem rodar\n` +
      `   com comportamento antigo — incluindo os guards que deveriam\n` +
      `   detectar isso (guard defasado concorda com sujeito defasado).\n` +
      `   Para sincronizar: git fetch origin && git merge --ff-only origin/master\n\n`,
  );
}

// #6668: banner mais forte pro caso de stash pop ter deixado arquivo(s)
// VERSIONADO(S) com conflito não-resolvido no disco (mais sério que um
// stash_pop_failed comum — ver docstring de GitSyncOutcome.stash_pop_conflict
// em scripts/lib/git-sync.ts). Ainda fail-soft (exit 0 abaixo, inalterado).
if (result.outcome === "stash_pop_conflict") {
  process.stderr.write(
    `\n🛑 CONFLITO DE STASH POP DEIXADO NO DISCO — arquivo(s) versionado(s) com marcadores\n` +
      `   de conflito literais (<<<<<<</=======/>>>>>>>). O checkout fica sintaticamente\n` +
      `   quebrado e OUTRA SESSÃO pode ler esse arquivo como se estivesse íntegro.\n` +
      `   A edição vai continuar (fail-soft), mas isto NÃO é um "pop falhou" comum —\n` +
      `   resolva manualmente antes que outra sessão leia o arquivo quebrado:\n` +
      `   git status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' ; git diff ; resolva os marcadores ; git add.\n\n`,
  );
}

// #6800: banner mais forte ainda — este outcome é um ESTADO ABSORVENTE, não
// um warning transitório. Sem intervenção manual, TODA chamada futura de
// sync-code.ts bate no mesmo muro (git stash recusa rodar com caminhos
// unmerged) — o checkout fica defasado indefinidamente, silenciosamente,
// até alguém notar (reproduzido ao vivo: 14 commits de atraso, #6800).
if (result.outcome === "preexisting_unmerged_state") {
  process.stderr.write(
    `\n🧟 ESTADO ABSORVENTE — sync vai continuar falhando pra sempre sem intervenção manual.\n` +
      `   Caminho(s) já em UU/AA/etc no índice (sobra de um stash pop conflitante de uma\n` +
      `   rodada ANTERIOR, não desta) — git stash recusa rodar nesse estado, então NENHUMA\n` +
      `   chamada futura deste script se recupera sozinha.\n` +
      `   Resolva: git status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' pra listar,\n` +
      `   depois git checkout HEAD -- <arquivo> (descarta o lado local, fica com upstream)\n` +
      `   ou resolva os marcadores manualmente + git add <arquivo>.\n` +
      `   Confira git stash list antes de qualquer git stash drop — pode haver conteúdo\n` +
      `   genuinamente não-mergeado preservado ali.\n\n`,
  );
}

// Sempre exit 0 — fail-soft (#2686: falha de sync nunca bloqueia a edição)
process.exit(0);
