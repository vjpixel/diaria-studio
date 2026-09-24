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
 *   npx tsx scripts/sync-code.ts [--edition-dir <dir>]
 *
 * #8690: com `--edition-dir`, grava `_internal/05-sync-code.json` (ver
 * `scripts/lib/sync-code-marker.ts`) — o invariant `sync-code-ran` do Stage 5
 * acusa quando o Passo -3 de /diaria-5-publicacao não rodou.
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
 *
 * #8719: quando `result.stale_autostash_count >= STALE_AUTOSTASH_ALARM_THRESHOLD`,
 * imprime um banner de PILEUP — sinaliza que autostashes deste módulo
 * (`GIT_SYNC_STASH_MESSAGE`) se acumularam em `git stash list` ao longo de
 * várias rodadas, não só nesta. A issue #8719 flagrou 6 acumulados
 * silenciosamente; cada ocorrência individual já tinha seu próprio banner
 * (#7740, ver `preserved_stash` abaixo), mas nada agregava a contagem — este
 * é o alarme de contagem que a docstring de `GIT_SYNC_STASH_MESSAGE` em
 * `scripts/lib/git-sync.ts` já antecipava. Este script só torna o pileup
 * VISÍVEL (fail-soft, exit 0 sempre) — não decide o que fazer com os
 * stashes acumulados nem investiga a causa raiz; ambos ficam fora de
 * escopo por decisão explícita da própria issue #8719.
 */

import { GIT_SYNC_STASH_MESSAGE, syncCode } from "./lib/git-sync.ts";
import { writeSyncCodeMarker } from "./lib/sync-code-marker.ts";

/**
 * #8719: a partir de quantos autostashes acumulados (`GIT_SYNC_STASH_MESSAGE`
 * em `git stash list`) o pileup vira alarme visível. 3, não 1-2 — 1 ou 2
 * stashes preservados podem ser transitórios (uma sessão ainda não voltou pra
 * resolver o pop conflitante de agora há pouco); 3+ é o sinal de que ninguém
 * está limpando, o padrão que a issue #8719 mediu ao vivo (6 acumulados).
 */
const STALE_AUTOSTASH_ALARM_THRESHOLD = 3;

const result = syncCode();

// Sempre imprime JSON do resultado para o orchestrator logar
console.log(JSON.stringify(result, null, 2));

// #8690: marker por edição (fail-soft — falha de escrita só avisa).
const editionDirIdx = process.argv.indexOf("--edition-dir");
const editionDir = editionDirIdx !== -1 ? process.argv[editionDirIdx + 1] : undefined;
if (editionDir) {
  try {
    writeSyncCodeMarker(editionDir, {
      ran_at: new Date().toISOString(),
      outcome: result.outcome,
      commits_behind: result.commits_behind,
      up_to_date: result.up_to_date,
    });
  } catch (e) {
    process.stderr.write(`aviso (#8690): falha ao gravar marker de sync-code em ${editionDir}: ${(e as Error).message}\n`);
  }
}

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
      `   rodada ANTERIOR, não desta — ou um merge/rebase manual em curso nesta checkout\n` +
      `   compartilhada) — git checkout/git stash recusam rodar nesse estado, então NENHUMA\n` +
      `   chamada futura deste script se recupera sozinha.\n` +
      `   Resolva: git status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' pra listar,\n` +
      `   depois git checkout HEAD -- <arquivo> (descarta o lado local, fica com upstream)\n` +
      `   ou resolva os marcadores manualmente + git add <arquivo>.\n` +
      `   Confira git stash list e git status antes de qualquer ação destrutiva — pode haver\n` +
      `   conteúdo genuinamente não-mergeado (merge/rebase em progresso) preservado ali.\n\n`,
  );
}

// #7740: banner — um stash deste sync ficou preservado (pop falhou ou
// conflitou) sem ser recuperado automaticamente. Cobre os outcomes que os
// banners #6668/#6800 acima NÃO cobrem (`stash_pop_failed`, `ff_failed` com
// pop também falho, `stash_partial_failure_unrecovered`) — o vazamento que a
// #7740 descreve era exatamente este: o stash ficava pra trás sem nenhum
// sinal legível apontando de volta pra ele. O stash em si já é identificável
// em `git stash list` pela mensagem (ver `GIT_SYNC_STASH_MESSAGE`, gravada no
// próprio stash desde este fix) — o banner só garante que o operador VEJA
// isso agora, não precise descobrir via análise forense depois (como a #7740
// precisou fazer pros 248 acumulados).
if (result.preserved_stash) {
  process.stderr.write(
    `\n📦 STASH PRESERVADO (não recuperado) — outcome '${result.outcome}'.\n` +
      `   ref: ${result.preserved_stash.ref ?? "(não capturado)"} | mensagem identificável: ` +
      `'${result.preserved_stash.message}'.\n` +
      `   Localizar: git stash list | grep -F '${result.preserved_stash.message}'\n` +
      // #7740: com `ref` capturado, `git stash show -p <sha>` funciona direto.
      // SEM ele, NÃO sugerir `git stash show -p '<mensagem>'`: git resolve
      // revisão, não mensagem, e o comando falha com "is not a valid
      // reference" (verificado ao vivo no review da PR #7791 — a 1ª versão
      // deste banner afirmava o contrário e estava errada). O caminho que
      // funciona é achar o índice pela mensagem e usar o `stash@{N}`.
      `   Resolver: ${
        result.preserved_stash.ref
          ? `git stash show -p ${result.preserved_stash.ref}`
          : `ache o índice com o 'git stash list' acima e rode git stash show -p 'stash@{N}'`
      } ; git status ; git diff — NÃO 'git stash drop' até revisar.\n\n`,
  );
}

// #7336: banner — sync foi recusado por rodar dentro de um worktree de
// agente. Ainda fail-soft (exit 0 abaixo, inalterado) — o chamador que
// invocou este script de dentro de um worktree provavelmente tem um bug de
// cwd (ex: outra sessão usando o worktree isolado de um agente como cwd),
// não este script.
if (result.outcome === "worktree_refused") {
  process.stderr.write(
    `\n🚧 SYNC RECUSADO — rodando dentro de um worktree de agente (.claude/worktrees/**), não o\n` +
      `   checkout principal. Nenhum comando git foi executado (#7336) — sync de código só faz\n` +
      `   sentido no checkout compartilhado. Se isto rodou por engano a partir do worktree de\n` +
      `   OUTRA sessão, é um bug de cwd em quem chamou este script, não deste.\n\n`,
  );
}

// #8719: banner de PILEUP — vários autostashes deste módulo acumulados em
// `git stash list` ao longo de várias rodadas (não só esta). Fail-soft
// (exit 0 abaixo, inalterado) — este script só torna o pileup visível, não
// decide o que fazer com os stashes acumulados nem investiga a causa raiz
// (fora de escopo por decisão explícita da própria issue #8719).
if (result.stale_autostash_count >= STALE_AUTOSTASH_ALARM_THRESHOLD) {
  process.stderr.write(
    `\n📚 PILEUP DE AUTOSTASH — ${result.stale_autostash_count} stashes de sync-code.ts acumulados em ` +
      `'git stash list' (limiar de alarme: ${STALE_AUTOSTASH_ALARM_THRESHOLD}+; incidente que motivou o ` +
      `alarme, #8719, mediu 6).\n` +
      `   A edição vai continuar (fail-soft) — este script só sinaliza o pileup, não decide o que fazer\n` +
      `   com ele. Investigue e limpe manualmente (revise CADA um antes de descartar — pode haver\n` +
      `   trabalho legítimo não-relacionado a este sync ali dentro):\n` +
      `   git stash list | grep -F '${GIT_SYNC_STASH_MESSAGE}'\n\n`,
  );
}

// Sempre exit 0 — fail-soft (#2686: falha de sync nunca bloqueia a edição)
process.exit(0);
