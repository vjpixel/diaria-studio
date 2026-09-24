/**
 * git-sync.ts (#2686)
 *
 * Helper testável para sincronizar o checkout local com origin/master no início
 * de cada edição (`/diaria-edicao`). Garante que o pipeline rode sempre com a
 * versão mais recente do código (rodadas overnight/develop mergeiam muito).
 *
 * Comportamento:
 *   1. Se não estiver em master → tenta `git checkout master` antes do sync.
 *      Se checkout falhar → warn + retorna sem forçar (fail-soft).
 *   2. `git fetch origin` — fail-soft (offline, credencial, etc.) → warn + retorna.
 *      #5302: usa timeout PRÓPRIO (`GIT_FETCH_TIMEOUT_MS`, maior que
 *      `GIT_TIMEOUT_MS` dos demais comandos) — um fetch trazendo volume grande
 *      de refs novos de uma vez (checkout muito atrasado) pode legitimamente
 *      passar dos 120s dos comandos rápidos (stash/merge/status/checkout) sem
 *      ser um erro real. Diagnóstico também diferencia timeout (`status ===
 *      null`, o `spawnSync` matou o processo) de erro real do git (`status !==
 *      0 && status !== null`, offline/auth/etc.) — outcomes e mensagens
 *      distintos (`fetch_timeout` vs `fetch_failed`), porque um fetch morto
 *      por timeout pode já ter atualizado os refs remotos localmente ANTES do
 *      kill (reproduzido ao vivo: `fetch_failed` com "offline ou erro de rede"
 *      era enganoso quando a causa real era um fetch grande ainda em
 *      andamento).
 *   1b/2b. #6800: ANTES de tentar checkout master (se branch != master) OU
 *      stash (dirty-check do passo 4), checa se há caminho(s) JÁ unmerged
 *      (UU/AA/etc) no índice — sobra de um "stash pop" conflitante de uma
 *      rodada ANTERIOR (git checkout E git stash recusam rodar nesse
 *      estado, então "checkout_failed"/"stash_failed" genéricos repetiriam
 *      pra sempre sem nenhuma execução futura se recuperar sozinha — estado
 *      ABSORVENTE, não transitório). Outcome distinto
 *      "preexisting_unmerged_state" (ERROR, ainda fail-soft) — ver
 *      parseUnmergedPaths()/uso em syncCodeLocked. Checagem em 2 pontos
 *      (review do PR #6918): a do passo 4 reusa o `git status` já obtido
 *      ali (zero spawn extra no caminho comum); a de ANTES do checkout
 *      roda um spawn dedicado, só quando branch != master (ver
 *      MAX_SEQUENTIAL_GIT_SPAWNS).
 *   3. #8719 (decisão do editor, 24/09/2026): se working tree suja, tenta
 *      `merge --ff-only origin/master` DIRETO primeiro, ANTES de qualquer
 *      stash — a maioria das mudanças locais (config solta, WIP não
 *      conflitante) não colide com o que vem de origin/master, então o ff
 *      direto já resolve sem nunca tocar em stash. Só recorre a stash
 *      quando esse ff direto RECUSA (a sujeira local realmente colide com o
 *      merge, ou a árvore está genuinamente divergente demais pro git
 *      decidir sozinho — as duas causas são indistinguíveis a partir do
 *      exit code, então o código trata ambas igual: protege via stash e
 *      tenta de novo). Se o stash em si falhar e nenhum tiver sido criado →
 *      warn + retorna sem tocar o tree ("stash_failed").
 *   3d. #8719: **NUNCA `git stash pop` automático.** Decisão explícita do
 *      editor (briefing 24/09/2026) — o pop automático que este módulo fazia
 *      até aqui já causou um checkout preso ~20h em `UU` numa rodada real
 *      (conflito do pop com um branch `continuo/rescue-master-*` em curso).
 *      Quando um stash É criado (porque o ff direto recusou), o fluxo tenta
 *      o ff-only DE NOVO sob proteção do stash, mas em NENHUM dos dois
 *      desfechos (ff sucede ou falha depois do stash) o stash é despopado
 *      automaticamente — ele fica preservado (mensagem identificável
 *      `GIT_SYNC_STASH_MESSAGE`, `preserved_stash` estruturado no
 *      resultado) e o checkout fica LIMPO em master (working tree igual ao
 *      índice, sem as mudanças do stash reaplicadas). Outcomes:
 *      `"synced_stash_preserved"` (ff sob stash teve sucesso — código
 *      atualizado, mudanças locais preservadas só no stash) e `"ff_failed"`
 *      com `preserved_stash` preenchido (ff sob stash TAMBÉM falhou —
 *      divergência genuína, checkout limpo em master mas defasado, mudanças
 *      locais preservadas no stash). Em ambos os casos o consumidor
 *      (`sync-code.ts`) já renderiza o banner de "stash preservado" — ver
 *      `preserved_stash` no `GitSyncResult`. Este mecanismo substitui o
 *      auto-pop (com o detector de conflito de pop do #6668, ver histórico
 *      abaixo) que existia antes desta decisão.
 *   3a. #3411: `git stash --include-untracked` não é atômico — cria o(s) commit(s)
 *      de stash e SÓ DEPOIS remove os arquivos não-rastreados (clean-equivalente).
 *      Se essa remoção falhar parcialmente (ex: Permission denied), o comando sai
 *      não-zero MESMO com o stash já criado — "working tree não tocada" seria
 *      falso nesse caso. Detectado comparando `refs/stash` antes/depois; se um
 *      stash foi criado apesar do exit não-zero, o stash é preservado
 *      ("stash_partial_failure_unrecovered") — nunca faz `git stash drop`, e
 *      desde #8719 também nunca tenta `git stash pop` automático de
 *      "recuperação" (era o comportamento até esta decisão).
 *   3b. #3423: a detecção do 3a comparando `refs/stash` antes/depois é uma TOCTOU
 *      race quando 2 chamadas de `syncCode()` rodam concorrentemente contra o
 *      MESMO checkout — `refs/stash` é uma ref escalar única por repositório
 *      (inclusive entre worktrees do mesmo repo), então o processo A pode ler
 *      `stashRefAfter` como o stash que o processo B acabou de criar (não o seu
 *      próprio) e popar as mudanças de B. Não dá pra desambiguar isso de forma
 *      confiável só inspecionando `git stash` (nenhum comando devolve um ID
 *      específico da invocação; a mensagem do stash é idêntica entre processos
 *      no mesmo branch/commit). Fix: serializar toda a operação de sync com um
 *      lock de arquivo (`.diaria-sync.lock`, `fs.mkdirSync` atômico) — elimina a
 *      race na origem em vez de tentar resolvê-la depois do fato. Uma segunda
 *      chamada concorrente detecta o lock e retorna "sync_in_progress" (fail-soft)
 *      SEM tocar em stash/merge.
 *   3c. #3430: o próprio lock do 3b tinha 3 gaps confirmados por review
 *      adversarial (4 finders independentes) — endurecido nesta revisão:
 *        (i) `LOCK_STALE_MS` (10min fixo) era matematicamente MENOR que o pior
 *            caso real (8 spawns git sequenciais × até 120s cada = 16min) —
 *            agora derivado de `MAX_SEQUENTIAL_GIT_SPAWNS` × `GIT_TIMEOUT_MS`
 *            com margem documentada (ver `LOCK_STALE_MS` abaixo).
 *        (ii) a reivindicação de lock morto (`rmdirSync`+`mkdirSync`, 2 syscalls
 *            separadas) permitia 2 processos "vencerem" simultaneamente — agora
 *            via `renameSync` atômico + verificação de identidade por mtime
 *            pós-rename (rollback se não bater) + token de propriedade
 *            verificado em `release()`. Ver `createFileLock()`.
 *        (iii) o path do lock era resolvido a partir de `import.meta.url`
 *            (localização FÍSICA do arquivo, que difere por `git worktree`) —
 *            agora resolvido via `git rev-parse --git-common-dir`, o mesmo
 *            `.git` real compartilhado entre TODOS os worktrees do repo. Ver
 *            `resolveSharedLockPath()`.
 *   4. Se working tree limpa → merge --ff-only origin/master direto.
 *      Se ff-only falhar (divergência) → warn + retorna (nunca força merge).
 *   5. Falha de fetch OU ff_failed OU stash_partial_failure (ou sua variante
 *      _unrecovered) OU sync_in_progress NÃO bloqueiam a edição — retornam
 *      status de warn (ou ERROR, no caso de preexisting_unmerged_state) e a
 *      skill continua.
 *
 * Nota: usa `git merge --ff-only origin/master` (não `git pull`) após o fetch
 * explícito do passo 2 — evita um segundo fetch implícito (rede = única
 * superfície de falha) e roda offline-friendly contra o ref já buscado.
 *
 * Idempotente: re-rodar não tem efeito colateral se já atualizado.
 *
 * #8719: `countStaleAutostashes()` (com o campo `stale_autostash_count` no
 * resultado) implementa o alarme de contagem que a docstring de
 * `GIT_SYNC_STASH_MESSAGE` (#7740, acima) já antecipava — a issue flagrou 6
 * autostashes idênticos deste módulo acumulados silenciosamente em
 * `git stash list`, cada um já sinalizado individualmente por um banner de
 * `sync-code.ts` na sua própria rodada, mas sem nenhuma contagem agregada
 * detectando o pileup ao longo do tempo. Escopo desta correção é só tornar o
 * pileup VISÍVEL (banner) — investigar a causa raiz de "Permission denied"
 * no stash, por que arquivos ficam dirty entre sessões, ou decidir o que
 * fazer com stashes já acumulados seguem fora de escopo por decisão
 * explícita da própria issue (#8719: "não implementar sem decisão do
 * editor").
 *
 * @see .claude/skills/diaria-edicao/SKILL.md — invocado no Passo 0.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSpawnFn, SpawnResult } from "./spawn-types.ts";

export type { SpawnResult } from "./spawn-types.ts";

/**
 * Tipo do spawner injetável. Produção usa spawnSync; testes usam mock.
 * Alias local de back-compat — o tipo canônico é `GitSpawnFn` em
 * `scripts/lib/spawn-types.ts` (#2699 — evita colisão com o `SpawnFn` de
 * 3 args de `scripts/check-pr-bugfix.ts`).
 */
export type SpawnFn = GitSpawnFn;

/**
 * Raiz do repo, resolvida a partir da localização deste arquivo (não de
 * `process.cwd()`) — #2699 item 1. Sem isso, `defaultSpawn` roda `git` no
 * CWD do processo; se `/diaria-edicao` for invocado de dentro de um worktree
 * (`.claude/worktrees/agent-*`), o sync miraria o worktree, não o checkout
 * principal. `scripts/lib/git-sync.ts` está 2 níveis abaixo da raiz.
 *
 * IMPORTANTE (#3430): isso continua correto para o CWD usado nos comandos git
 * de `defaultSpawn` (stash/merge/checkout devem rodar no checkout FÍSICO que
 * de fato invocou `syncCode()`, não redirecionar magicamente pra outro
 * worktree). O que mudou em #3430 é só o path do LOCK em si (ver
 * `resolveSharedLockPath()`), que precisa ser compartilhado entre worktrees
 * mesmo que `REPO_ROOT` — corretamente — não seja.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Status da operação de sync. */
export type GitSyncOutcome =
  | "synced"              // pull --ff-only bem-sucedido (tree limpa, OU tree suja mas o ff direto
                           // já resolveu sem precisar de stash — #8719)
  | "synced_stash_preserved" // #8719: tree suja, ff direto recusou, stash criado, ff SOB stash teve
                           // sucesso — código atualizado, mas o stash NUNCA é despopado
                           // automaticamente (decisão do editor, 24/09/2026); mudanças locais ficam
                           // só no stash, recuperação é manual (`preserved_stash` no resultado)
  | "already_up_to_date"  // já na versão mais recente (tree limpa ou suja)
  | "fetch_failed"        // git fetch falhou com erro real (offline / auth / status !== 0 e != null) — warn, segue
  | "fetch_timeout"       // #5302: git fetch origin foi morto pelo timeout do spawnSync (status === null) —
                           // diferente de erro real; refs remotos podem já ter sido atualizados localmente
                           // antes do kill — warn, segue
  | "ff_failed"           // pull --ff-only falhou (divergência) — warn, segue. #8719: quando isto
                           // ocorre DEPOIS de um stash ter sido criado (o ff sob stash também
                           // falhou), `preserved_stash` vem preenchido — mesmo sem pop nenhum ter
                           // sido tentado, o stash criado nunca é descartado
  | "stash_failed"        // stash falhou E nenhum stash foi criado — tree não tocada — warn, segue
  | "stash_partial_failure"             // #3411; LEGADO/inalcançável desde #8719 — stash saiu não-zero MAS criou
                                         // um stash, e este módulo tentava recuperar via pop automático. Mantido
                                         // no union só por compatibilidade de consumidores que já checam por ele;
                                         // syncCodeLocked() nunca mais produz este outcome (ver "..._unrecovered"
                                         // abaixo, que agora cobre TODO stash parcialmente falho, recuperado ou não)
  | "stash_partial_failure_unrecovered" // #3411/#8719: stash saiu não-zero MAS criou um stash — preservado p/
                                         // investigação manual (nunca mais tenta pop automático) — warn, segue
  | "checkout_failed"     // não estava em master e checkout master falhou — warn, segue
  | "sync_in_progress"    // #3423: outro syncCode() já está rodando neste checkout — warn, segue sem tocar git
  | "worktree_refused"    // #7336: REPO_ROOT resolve dentro de um worktree de agente
                           // (`.claude/worktrees/**`) — sync recusado ANTES de qualquer spawn git.
                           // Sync de código só faz sentido no checkout principal; rodar `checkout
                           // master`/merge dentro do worktree isolado de outra sessão pode mover o
                           // HEAD dela por baixo enquanto ela trabalha (incidente #7336: commit
                           // legítimo de uma sessão aterrissou em master local por causa disso).
                           // Ainda fail-soft (proceed: true) — nunca bloqueia quem chamou, só não
                           // toca o git deste worktree.
  | "preexisting_unmerged_state"; // #6800: caminho(s) UU/AA/etc JÁ presentes no índice ANTES de
                           // qualquer tentativa de stash desta chamada — sobra de um "stash pop"
                           // conflitante de uma rodada ANTERIOR (não desta). ESTADO ABSORVENTE:
                           // "git stash" recusa rodar com caminhos unmerged, então nenhuma
                           // chamada futura de syncCode() se recupera sozinha — diferente de
                           // "stash_failed" comum (transitório, workable na próxima rodada).
                           // ERROR, fail-soft (proceed: true), mas o consumidor (sync-code.ts)
                           // deve tratar como mais urgente que qualquer outro warning — ver
                           // #6800.

/**
 * #7740: mensagem identificável usada em TODO `git stash push` que este módulo
 * cria (`git stash push --include-untracked -m GIT_SYNC_STASH_MESSAGE`), no
 * lugar da mensagem default do git (`WIP on <branch>: <sha> <subject>`, o que
 * `git stash --include-untracked` bare gera). Sem isso, um stash órfão (pop
 * conflitante, #6668) fica INDISTINGUÍVEL no `git stash list` de qualquer
 * `git stash` manual de uma sessão interativa — foi exatamente essa
 * ambiguidade que impediu classificar automaticamente os 248 stashes
 * acumulados citados na #7740 (a issue precisou de uma análise manual por
 * árvore/timestamp). Com a mensagem fixa, `git stash list | grep -F
 * "${GIT_SYNC_STASH_MESSAGE}"` isola confiavelmente os autostashes deste
 * módulo — é o critério que uma futura limpeza (ou o alarme de contagem que a
 * issue propõe) pode usar sem heurística. Exportado para reuso em scripts de
 * auditoria/limpeza e nos testes.
 */
export const GIT_SYNC_STASH_MESSAGE = "diaria-git-sync-autostash";

/** Resultado completo do sync. */
export interface GitSyncResult {
  outcome: GitSyncOutcome;
  message: string;
  branch_before: string;
  warnings: string[];
  /** true quando a edição pode continuar normalmente (sempre true — fail-soft). */
  proceed: true;
  /**
   * #6090: HEAD está em dia com origin/{branch}? Medido DEPOIS da tentativa de
   * sync via `git rev-list --count HEAD..origin/master` — não inferido do
   * outcome (o incidente 260825 provou que essa inferência falha:
   * `stash_partial_failure_unrecovered` não é obviamente "não sincronizou").
   * `false` também quando a medição em si falha (-1 em `commits_behind`).
   */
  up_to_date: boolean;
  /**
   * #6090: quantos commits HEAD está atrás de origin/master (0 quando
   * `up_to_date`). `-1` = não foi possível medir (rev-list falhou).
   */
  commits_behind: number;
  /**
   * #7740: preenchido sempre que este `syncCode()` termina com um stash NÃO
   * despopado — desde #8719 (24/09/2026, decisão do editor) isto é TODO
   * stash que este módulo cria: nunca mais chama `git stash pop`
   * automático. Outcomes que preenchem este campo: `synced_stash_preserved`
   * (ff sob stash teve sucesso), `ff_failed` no caso em que ocorre DEPOIS de
   * um stash ter sido criado (ff sob stash também falhou), e
   * `stash_partial_failure_unrecovered` (o próprio `git stash push` saiu
   * não-zero mas criou um stash). O SHA do stash (`refs/stash` no momento em
   * que foi criado, pode ser `null` se o próprio `rev-parse` de captura
   * falhar) e a mensagem identificável usada ficam aqui, para que o
   * CONSUMIDOR (task-runner, sync-code.ts, orchestrator) tenha um dado
   * ESTRUTURADO para reportar/logar em vez de só texto solto dentro de
   * `warnings` — fecha o "reportar" do vazamento da #7740 (o stash em si já
   * fica identificável via `GIT_SYNC_STASH_MESSAGE`, isto aqui é o ponteiro
   * pronto pra esse stash específico). `null` em todo outcome que não
   * preserva stash (inclusive `synced`/`already_up_to_date` quando o ff
   * DIRETO, sem stash algum, já resolveu — #8719).
   */
  preserved_stash: { ref: string | null; message: string } | null;
  /**
   * #8719: quantos autostashes DESTE módulo (`GIT_SYNC_STASH_MESSAGE`) estão
   * parados em `git stash list` no momento em que este `syncCode()` terminou
   * — medido AFTER-the-fact, mesma disciplina de `commits_behind` (#6090).
   * Diferente de `preserved_stash` (que só aponta o stash desta CHAMADA,
   * quando não recuperado), este campo é uma contagem AGREGADA de todos os
   * autostashes acumulados ao longo do tempo — é o que permite ao consumidor
   * (`sync-code.ts`) detectar pileup silencioso (a issue #8719 flagrou 6
   * idênticos, invisíveis porque cada ocorrência só emitia seu próprio
   * warning isolado, nunca uma contagem agregada). `-1` = não foi possível
   * medir (`git stash list` falhou) — mesma convenção de "não medido" que
   * `commits_behind: -1`.
   */
  stale_autostash_count: number;
}

/**
 * #6090: mede o estado real de sincronização AFTER-the-fact, com um único
 * comando barato e local (`git rev-list --count HEAD..origin/master` — não
 * depende de rede; usa o ref já trazido pelo fetch). Nunca lança — fail-soft,
 * igual ao resto do módulo.
 */
export function measureSyncState(spawn: SpawnFn): { up_to_date: boolean; commits_behind: number } {
  const res = spawn("git", ["rev-list", "--count", "HEAD..origin/master"]);
  if (res.status !== 0 || !/^\d+\s*$/.test(res.stdout.trim())) {
    return { up_to_date: false, commits_behind: -1 };
  }
  const count = Number.parseInt(res.stdout.trim(), 10);
  return { up_to_date: count === 0, commits_behind: count };
}

/**
 * #8719: conta quantos autostashes DESTE módulo estão parados em `git stash
 * list` neste exato momento — o alarme de contagem que a docstring de
 * `GIT_SYNC_STASH_MESSAGE` (ver #7740 acima) já antecipava mas nunca foi
 * implementado. A issue #8719 flagrou 6 stashes idênticos acumulados (outcome
 * `stash_partial_failure_unrecovered` recorrendo silenciosamente rodada após
 * rodada, sem que ninguém notasse o pileup) — sem esta contagem, cada
 * ocorrência individual já emitia um banner (#7740), mas nada agregava
 * quantas dessas já tinham se empilhado.
 *
 * Mede com um único comando barato e local (`git stash list` — não toca
 * rede, não modifica nada) e conta as linhas que contêm
 * `GIT_SYNC_STASH_MESSAGE` — a mesma mensagem identificável que TODO `git
 * stash push` deste módulo grava, isolando confiavelmente os autostashes
 * deste módulo de qualquer `git stash` manual de sessão interativa.
 *
 * Fail-soft: exit não-zero (git indisponível, não é um repositório, etc.) →
 * `-1` — mesma convenção de "não foi possível medir" que `measureSyncState()`
 * já usa em `commits_behind`. Nunca lança.
 */
export function countStaleAutostashes(spawn: SpawnFn): number {
  const res = spawn("git", ["stash", "list"]);
  if (res.status !== 0) {
    return -1;
  }
  return res.stdout
    .split("\n")
    .filter((line) => line.includes(GIT_SYNC_STASH_MESSAGE)).length;
}

/**
 * Timeout por comando git (#2686 review — angle H). Sem isso, um git que trava
 * esperando passphrase de SSH ou credencial bloquearia o processo indefinidamente,
 * derrotando o fail-soft. 120s cobre com folga os comandos RÁPIDOS por natureza
 * (checkout/status/stash/merge --ff-only) — não mais usado pro `git fetch
 * origin` do passo 3, ver `GIT_FETCH_TIMEOUT_MS` abaixo (#5302).
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Timeout específico pro `git fetch origin` do passo 3 (#5302). 120s
 * (`GIT_TIMEOUT_MS`) é curto demais para um fetch que precisa trazer volume
 * grande de refs novos de uma vez — reproduzido ao vivo: um checkout local
 * muito atrasado (866 commits, dezenas de branches novas) teve o fetch morto
 * pelo timeout do `spawnSync` (`status: null`) mesmo com os refs remotos já
 * tendo sido efetivamente atualizados no `.git` local antes do kill.
 *
 * 480s (8min), não 600s — review consolidado do #5313 (finding confiança 83)
 * achou o valor original inatingível: o caminho de invocação documentado
 * (`.claude/skills/diaria-edicao/SKILL.md` Passo 0) roda `npx tsx
 * scripts/sync-code.ts` via tool Bash, cujo timeout default é 120000ms e cujo
 * TETO — mesmo com override explícito — é 600000ms. Se `GIT_FETCH_TIMEOUT_MS`
 * também fosse 600000ms, o harness externo mataria o processo `npx tsx`
 * INTEIRO no mesmo instante em que o `spawnSync` interno dispararia seu
 * próprio timeout — sem margem pro overhead de startup/teardown do `npx tsx`
 * em volta do spawn, e sem o diagnóstico `fetch_timeout` chegar a ser
 * impresso (o processo pai já estaria morto). 480000ms deixa ~120000ms (2min)
 * de folga abaixo do teto de 600000ms do tool Bash — suficiente pro
 * `spawnSync` interno terminar, o diagnóstico ser montado e o JSON ser
 * impresso no stdout antes do harness externo intervir, desde que o Passo 0
 * passe um override de `timeout` (>= ~570000ms) explícito na chamada Bash em
 * vez de herdar o default de 120000ms (ver nota no SKILL.md).
 */
export const GIT_FETCH_TIMEOUT_MS = 480_000;

/**
 * Lock de sync (#3423, endurecido em #3430). Interface injetável — produção usa
 * `createFileLock()` (fs real); testes usam um double em memória para não
 * depender do disco nem interferir entre casos de teste sequenciais.
 */
export interface SyncLock {
  /** Path do lock, só para diagnóstico nas mensagens de warning. */
  readonly path: string;
  /**
   * Tenta adquirir o lock. `true` = adquirido (chamador é dono exclusivo até
   * `release()`); `false` = já havia um lock ATIVO de outro processo (ou erro
   * inesperado ao adquirir — tratado como "não consegui", fail-soft).
   */
  acquire(): boolean;
  /** Libera o lock. Idempotente — seguro chamar mesmo sem ter adquirido. */
  release(): void;
}

/**
 * Subconjunto de `node:fs` usado por `createFileLock()` — injetável só para
 * testes (#3430). Produção usa o módulo `fs` real (importado no topo deste
 * arquivo); testes de race usam um double em memória que intercepta
 * `renameSync`/`mkdirSync` pra simular 2 processos disputando a mesma
 * reivindicação de lock morto sem precisar de 2 processos de verdade.
 */
export interface LockFs {
  mkdirSync(path: string): void;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  statSync(path: string): { mtimeMs: number };
  renameSync(oldPath: string, newPath: string): void;
  writeFileSync(path: string, data: string): void;
  readFileSync(path: string, encoding: "utf8"): string;
}

/**
 * Comandos git sequenciais que `syncCodeLocked()` pode rodar numa única
 * chamada, contados explicitamente (não estimados) no caminho MAIS LONGO
 * (dirty tree, branch != master, ff direto recusa e precisa de stash): 1.
 * rev-parse HEAD, 2. status --porcelain (unmerged pré-existente, condicional
 * a branch != master), 3. checkout master (condicional), 4. fetch, 5. status
 * --porcelain (dirty check), 6. merge --ff-only DIRETO (#8719 — tentado
 * ANTES de qualquer stash), 7. rev-parse --verify refs/stash ANTES do stash
 * (#3411), 8. stash --include-untracked, 9. rev-parse refs/stash (captura o
 * ref recém-criado, #7740), 10. merge --ff-only SOB stash (retry), 11.
 * rev-list --count (measureSyncState, #6090), 12. stash list
 * (countStaleAutostashes, #8719) = 12.
 *
 * `LOCK_STALE_MS` abaixo deriva desse número em vez de um valor redondo
 * chutado — #3430 gap 1 encontrou o valor antigo (10min fixo) matematicamente
 * MENOR que o pior caso teórico.
 *
 * #5302: dos 12 spawns, exatamente 1 é o `git fetch origin` do passo 4, que
 * desde #5302 usa `GIT_FETCH_TIMEOUT_MS` (maior que `GIT_TIMEOUT_MS`) em vez
 * do timeout genérico — `LOCK_STALE_MS` abaixo reflete isso (11 ×
 * `GIT_TIMEOUT_MS` + 1 × `GIT_FETCH_TIMEOUT_MS`, não 12 × `GIT_TIMEOUT_MS`
 * uniforme).
 *
 * #8719 (24/09/2026, decisão do editor): a contagem CAIU de 13 para 12 nesta
 * mudança — removeu o `git stash pop` automático e o `git status --porcelain`
 * pós-pop de detecção de conflito (#6668, agora inalcançável — este módulo
 * nunca mais chama `stash pop` sozinho) e adicionou 1 spawn novo: o `merge
 * --ff-only` DIRETO tentado ANTES de qualquer stash (passo 6 acima) — 2
 * removidos, 1 adicionado, líquido -1. Histórico da evolução anterior (8 → 13
 * spawns, #6090/#6668/#6800/#7740) preservado no changelog do PR que
 * introduziu esta mudança; não repetido aqui linha a linha para não inflar
 * este comentário a cada revisão futura do pior caso.
 */
export const MAX_SEQUENTIAL_GIT_SPAWNS = 12;

/**
 * Lock morto (processo dono crashou sem `release()`) é considerado stale após
 * esse intervalo e liberado automaticamente na próxima tentativa de acquire.
 *
 * #3430 gap 1: o valor antigo (10min fixo; o comentário afirmava "bem acima
 * do pior caso realista") não sustentava a aritmética — `MAX_SEQUENTIAL_GIT_SPAWNS`
 * (8) × até `GIT_TIMEOUT_MS` (120s) cada = até 16min no pior caso teórico,
 * ACIMA dos 10min antigos. Um sync legítimo-mas-lento (ex: contenção de I/O
 * do OneDrive documentada no CLAUDE.md pra junctions de `data/` — o próprio
 * checkout do repo pode compartilhar o mesmo disco) podia ter o lock roubado
 * por um processo concorrente antes de terminar, reproduzindo a exata race
 * que o lock foi criado pra eliminar (#3423).
 *
 * Novo valor: 2× o pior caso teórico + 2min de buffer fixo — margem generosa
 * e DERIVADA (não um número redondo chutado de novo), cobrindo jitter de
 * scheduling do SO e a diferença entre "GIT_TIMEOUT_MS é um teto por comando"
 * vs. "8 comandos consecutivos raspando o teto" (pior caso real, não o caso
 * comum).
 *
 * Trade-off aceito conscientemente (documentado no PR #3430): nenhum valor
 * FINITO elimina 100% a janela teórica — só um heartbeat (renovar o mtime do
 * lock periodicamente durante o trabalho) eliminaria por completo, e isso foi
 * avaliado como desproporcional pra este mecanismo (mais um subsistema com
 * seu próprio potencial de bug novo, exatamente o padrão que #3430 pede pra
 * não repetir). Em vez disso, a reivindicação do lock morto agora é
 * estruturalmente segura mesmo se a janela for cruzada — ver `acquire()`
 * abaixo (reivindicação via `renameSync` atômico + verificação de identidade
 * por mtime, gap 2) — então mesmo o cenário residual (staleness bater
 * durante um sync legítimo-mas-lento) resulta, no pior caso, em dois syncs
 * concorrentes (já fail-soft por design) em vez de corrupção do stash.
 *
 * #5302: a fórmula foi atualizada de `MAX_SEQUENTIAL_GIT_SPAWNS × GIT_TIMEOUT_MS`
 * (8 spawns uniformes) para `(MAX_SEQUENTIAL_GIT_SPAWNS - 1) × GIT_TIMEOUT_MS +
 * GIT_FETCH_TIMEOUT_MS` — só 1 dos 8 spawns (o `git fetch origin` do passo 3)
 * agora usa o timeout maior; os outros 7 continuam em `GIT_TIMEOUT_MS`. Sem
 * este ajuste, aumentar só o timeout do fetch sem re-derivar `LOCK_STALE_MS`
 * reintroduziria exatamente o gap 1 original do #3430 (staleness matematicamente
 * menor que o novo pior caso real, permitindo roubo do lock durante um fetch
 * grande ainda legitimamente em andamento).
 *
 * Review consolidado do #5313 (confiança 83) reduziu `GIT_FETCH_TIMEOUT_MS` de
 * 600s pra 480s (ver comentário da constante) pra deixar margem sob o teto do
 * tool Bash — como `LOCK_STALE_MS` é DERIVADO de `GIT_FETCH_TIMEOUT_MS` (não um
 * valor solto redundante), essa mudança já se propaga automaticamente pra
 * fórmula abaixo sem precisar editar o número aqui.
 */
export const LOCK_STALE_MS =
  ((MAX_SEQUENTIAL_GIT_SPAWNS - 1) * GIT_TIMEOUT_MS + GIT_FETCH_TIMEOUT_MS) * 2 + 2 * 60_000;

/** Nome do arquivo interno que guarda o token de propriedade do lock (#3430 gap 2). */
const OWNER_TOKEN_FILE = "owner.json";

function writeOwnerToken(lockDirPath: string, token: string, fsImpl: LockFs): void {
  try {
    fsImpl.writeFileSync(
      resolve(lockDirPath, OWNER_TOKEN_FILE),
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
    );
  } catch {
    // Best-effort (#3430) — falha ao escrever o token NÃO invalida o lock em
    // si (`mkdirSync` já teve sucesso, provando posse ao nível do FS de forma
    // atômica); só significa que a checagem extra de posse em `release()`
    // degrada pro comportamento pré-#3430 (remove incondicionalmente) para
    // ESTA aquisição especificamente.
  }
}

function readOwnerToken(lockDirPath: string, fsImpl: LockFs): string | null {
  try {
    const raw = fsImpl.readFileSync(resolve(lockDirPath, OWNER_TOKEN_FILE), "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve o path do lock compartilhado entre TODOS os worktrees do mesmo
 * repositório físico (#3430 gap 3).
 *
 * `REPO_ROOT` (raiz calculada a partir de `import.meta.url` — a localização
 * FÍSICA deste arquivo) difere por worktree: num `git worktree`, o arquivo
 * `scripts/lib/git-sync.ts` é uma cópia física separada em
 * `.claude/worktrees/agent-XXX/scripts/lib/git-sync.ts`, então 2 invocações de
 * `syncCode()` em worktrees diferentes do MESMO repo resolviam (antes do
 * #3430) o lock pra paths DIFERENTES e não-conflitantes — mesmo competindo
 * pela mesma `refs/stash` (ref única por repositório, compartilhada entre
 * worktrees — motivação original do #3423).
 *
 * `git rev-parse --path-format=absolute --git-common-dir` é o comando git
 * canônico pra isso: resolve pro MESMO diretório `.git` físico
 * independentemente de rodar a partir do checkout principal ou de um
 * worktree vinculado (verificado empiricamente durante esta correção — rodar
 * esse comando tanto da raiz do repo principal quanto de dentro de
 * `.claude/worktrees/agent-*` retorna o EXATO mesmo path absoluto).
 *
 * IMPORTANTE — a sugestão original da issue #3430 era `git rev-parse
 * --show-toplevel`. Isso NÃO resolve o gap: `--show-toplevel` devolve o
 * diretório de trabalho do PRÓPRIO worktree (equivalente ao `REPO_ROOT`
 * atual, físico), reproduzindo exatamente a mesma fragmentação por worktree
 * que este fix precisa fechar — confirmado empiricamente durante esta
 * correção (valores DIFERENTES entre o checkout principal e um worktree
 * vinculado do mesmo repo). `--git-common-dir` é o comando correto porque
 * aponta pro `.git` REAL compartilhado, não pro toplevel de cada working
 * copy — desviamos da sugestão literal da issue por esse motivo.
 *
 * O lock vive DENTRO do `.git` comum retornado por esse comando — sempre um
 * diretório real (nunca o arquivo `.git` de um worktree vinculado, que só
 * existe no toplevel de CADA worktree individual, não no common dir
 * compartilhado) — e nunca aparece em `git status`/`git stash` (tudo sob
 * `.git/` é implicitamente ignorado pelo git, sem depender de `.gitignore`).
 *
 * Fail-soft: se o comando git falhar (não é um repositório, git indisponível,
 * versão de git anterior a 2.31 sem suporte a `--path-format`), cai de volta
 * pro comportamento pré-#3430 (`REPO_ROOT/.diaria-sync.lock`) — ainda correto
 * pro caso comum de um único checkout, só reintroduzindo o gap de
 * worktree-sharing (aceitável dado que a alternativa seria lançar exceção no
 * meio de um mecanismo que é fail-soft por design inteiro).
 */
export function resolveSharedLockPath(spawn: SpawnFn = defaultSpawn): string {
  const res = spawn("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (res.status === 0 && res.stdout.trim()) {
    return resolve(res.stdout.trim(), "diaria-sync.lock");
  }
  return resolve(REPO_ROOT, ".diaria-sync.lock");
}

/**
 * Cache de `resolveSharedLockPath()` por identidade de função `spawn` (#3435
 * finding 1). Antes desta memoização, `resolveSharedLockPath()` rodava
 * `git rev-parse --git-common-dir` — um spawn de processo real — a CADA
 * chamada de `syncCode()` sem lock explícito (o parâmetro default
 * `lock: SyncLock = createFileLock(undefined, spawn)` é reavaliado a cada
 * invocação, já que default parameters em JS são expressões, não valores
 * memoizados pela linguagem). O git-common-dir não muda durante o processo —
 * não há necessidade de repetir esse spawn no caminho quente.
 *
 * `WeakMap<SpawnFn, string>` (chave = a própria função `spawn`, não uma
 * string) foi escolhido em vez de uma variável módulo única porque:
 *   - produção reusa a MESMA referência `defaultSpawn` em toda chamada de
 *     `syncCode()` dentro de um processo — cache efetivo, 1 spawn real por
 *     processo, como pedido no finding;
 *   - cada `it()` deste arquivo de teste injeta seu PRÓPRIO closure `spawn`
 *     (`makeSpawn({...})` cria uma função nova a cada chamada) — chaves
 *     diferentes nunca colidem, então os testes continuam isolados e
 *     determinísticos sem precisar de nenhum hook de reset entre casos.
 *
 * Cacheia tanto sucesso quanto o fallback fail-soft (`REPO_ROOT/.diaria-sync.lock`)
 * — ambos são funções puras do par (spawn, ambiente), e o ambiente (estar ou
 * não num repo git válido) não muda durante o processo.
 */
const sharedLockPathCache = new WeakMap<SpawnFn, string>();

export function resolveSharedLockPathCached(spawn: SpawnFn = defaultSpawn): string {
  const cached = sharedLockPathCache.get(spawn);
  if (cached !== undefined) return cached;
  const resolved = resolveSharedLockPath(spawn);
  sharedLockPathCache.set(spawn, resolved);
  return resolved;
}

/**
 * Lock de arquivo real (#3423, endurecido em #3430). Usa um DIRETÓRIO (não
 * arquivo) como marcador — `fs.mkdirSync` é atômico em POSIX e Windows (falha
 * com EEXIST se já existe), ao contrário de checar-depois-criar com arquivos
 * comuns.
 *
 * @param lockPath Path do diretório-lock. Default (#3430): resolvido via
 *   `resolveSharedLockPath()` — compartilhado entre TODOS os worktrees do
 *   mesmo repositório físico (gap 3), não mais `REPO_ROOT` (que diferia por
 *   worktree).
 * @param spawn Spawner usado SÓ pra resolver o `lockPath` default via git
 *   (ignorado se `lockPath` for passado explicitamente). Injetável para testes.
 *   Resolvido via `resolveSharedLockPathCached()` (#3435 finding 1) — memoizado
 *   por identidade de `spawn`, evita re-spawnar `git rev-parse --git-common-dir`
 *   a cada `createFileLock(undefined, spawn)` no caminho quente de `syncCode()`.
 * @param fsImpl Subconjunto de `node:fs` usado pelas operações do lock.
 *   Injetável para testes de race (#3430) — produção usa o `fs` real.
 */
export function createFileLock(
  lockPath?: string,
  spawn: SpawnFn = defaultSpawn,
  fsImpl: LockFs = fs,
): SyncLock {
  const path = lockPath ?? resolveSharedLockPathCached(spawn);
  // Token da aquisição ATUAL desta instância de SyncLock — `null` até
  // `acquire()` suceder. `release()` só remove o diretório quando o token
  // gravado em disco bate com este (#3430 gap 2) — nunca remove um lock que
  // não foi ele quem criou.
  let heldToken: string | null = null;

  return {
    path,
    acquire(): boolean {
      const myToken = randomUUID();
      try {
        fsImpl.mkdirSync(path);
        writeOwnerToken(path, myToken, fsImpl);
        heldToken = myToken;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // Erro inesperado (permissão, disco cheio, ENOTDIR, etc.) — tratar
          // como "não consegui adquirir" em vez de propagar. O módulo inteiro
          // é fail-soft; uma falha de lock nunca deve virar exceção não-tratada.
          return false;
        }

        // Lock já existe — pode ser (a) outro processo genuinamente em
        // andamento, ou (b) um lock morto de um processo que crashou sem
        // `release()`. Staleness por mtime distingue os dois casos.
        let observedMtimeMs: number;
        try {
          observedMtimeMs = fsImpl.statSync(path).mtimeMs;
        } catch {
          // Lock sumiu entre o EEXIST e o stat (outro processo liberou
          // concorrentemente) — tenta adquirir de novo, uma única vez.
          try {
            fsImpl.mkdirSync(path);
            writeOwnerToken(path, myToken, fsImpl);
            heldToken = myToken;
            return true;
          } catch {
            return false;
          }
        }

        if (Date.now() - observedMtimeMs <= LOCK_STALE_MS) {
          return false; // lock ativo — outro processo genuinamente sincronizando
        }

        // Lock stale — reivindica via RENAME atômico (#3430 gap 2), não mais
        // `rmdirSync`+`mkdirSync` separados. `renameSync` é uma ÚNICA syscall
        // atômica: só quem vence a corrida de renomear o path original
        // consegue — quem perder recebe ENOENT determinístico (o path de
        // origem já não existe mais pra ele), nunca um "sucesso silencioso"
        // que destrua o lock que o vencedor acabou de criar. Isso fecha o
        // bug original do gap 2: `rmdirSync`+`mkdirSync` eram 2 syscalls
        // separadas SEM verificação de identidade entre elas, então o
        // `rmdirSync` de um processo B podia remover o `mkdirSync`
        // recém-criado do processo A sem levantar erro nenhum (ambos "achavam"
        // que tinham reivindicado o MESMO lock morto original).
        const staleClaimPath = `${path}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
        try {
          fsImpl.renameSync(path, staleClaimPath);
        } catch {
          // Perdemos a corrida de reivindicação (outro processo já renomeou
          // este exato lock morto primeiro), ou outro erro inesperado. De
          // qualquer forma, NÃO fomos nós quem reivindicou. Desiste nesta
          // rodada (fail-soft) — próxima chamada de `syncCode()` tenta de novo.
          return false;
        }

        // Verificação de identidade PÓS-rename (fecha a janela residual: e se
        // outro processo já tivesse reivindicado E recriado um lock FRESCO no
        // instante exato entre nosso `statSync` acima e este `renameSync`?
        // `renameSync` move atomicamente o que ESTIVER no path no momento —
        // não distingue "o lock morto original" de "um lock fresco de outro
        // dono" só por endereço. Comparamos o mtime do que de fato movemos
        // contra o mtime que observamos ANTES de decidir reivindicar: se não
        // bater, renomeamos o lock ERRADO — devolve pro lugar e desiste,
        // preservando o lock do dono real).
        let claimedMtimeMs: number;
        try {
          claimedMtimeMs = fsImpl.statSync(staleClaimPath).mtimeMs;
        } catch {
          // Não deveria acontecer (acabamos de renomear pra cá) — fail-soft.
          return false;
        }
        if (claimedMtimeMs !== observedMtimeMs) {
          // #3434: a janela entre o `renameSync` que acabou de roubar o lock
          // FRESCO de outro dono (identidade não bate, estamos aqui) e este
          // ponto pode ter sido cruzada por um 3º processo C, que rodou
          // `mkdirSync(path)` limpo (sem EEXIST) e virou dono legítimo de
          // `path`. Nesse caso, tentar `renameSync(staleClaimPath, path)`
          // pra "devolver" o lock destruiria o lock genuíno de C — e em
          // Windows/NTFS, rename para um diretório já existente (mesmo
          // vazio) falha com EPERM, que o catch original engolia
          // silenciosamente, deixando `staleClaimPath` (dados órfãos de A,
          // que não é dono de nada) permanentemente no disco. Checar
          // explicitamente ANTES de tentar o rename — mesmo tratamento que o
          // caminho feliz já dá pro EEXIST de `mkdirSync`.
          let pathAlreadyClaimedByThirdProcess = false;
          try {
            fsImpl.statSync(path);
            pathAlreadyClaimedByThirdProcess = true;
          } catch {
            pathAlreadyClaimedByThirdProcess = false;
          }

          if (pathAlreadyClaimedByThirdProcess) {
            // `path` já tem um dono legítimo (C) — não tentar rename de
            // volta. `staleClaimPath` só contém dados órfãos de A; descarta
            // (best-effort, mesmo trade-off já documentado acima: se nem o
            // descarte for possível, fica órfão mas inofensivo).
            try {
              fsImpl.rmSync(staleClaimPath, { recursive: true, force: true });
            } catch {
              /* órfão inofensivo, ver comentário acima */
            }
            return false;
          }

          try {
            fsImpl.renameSync(staleClaimPath, path);
          } catch {
            // `path` estava genuinamente ausente (checamos acima) mas o
            // rename ainda assim falhou — erro inesperado do FS. Pior caso:
            // path fica temporariamente ausente até o dono real notar —
            // nunca corrompemos o lock dele (não o descartamos, não criamos
            // um segundo lock concorrente).
          }
          return false;
        }

        // Identidade confirmada — reivindicamos de fato o lock morto
        // ORIGINAL (mtime bate). Descarta (best-effort — se falhar, fica
        // órfão mas inofensivo: não bloqueia ninguém, só ocupa espaço em disco).
        try {
          fsImpl.rmSync(staleClaimPath, { recursive: true, force: true });
        } catch {
          /* órfão inofensivo, ver comentário acima */
        }

        try {
          fsImpl.mkdirSync(path);
          writeOwnerToken(path, myToken, fsImpl);
          heldToken = myToken;
          return true;
        } catch {
          // Um 3º processo (não participante da corrida de reivindicação)
          // criou um lock fresco no instante entre nosso rename vencedor e
          // este `mkdirSync` — colisão normal (idêntica ao EEXIST comum no
          // topo desta função), desiste nesta rodada.
          return false;
        }
      }
    },
    release(): void {
      if (heldToken === null) {
        // Nunca adquirimos nesta instância — idempotente, não faz nada
        // (comportamento pré-#3430 preservado).
        return;
      }

      // #3430 gap 2: só remove se o token em disco bater com o que ESTA
      // instância gravou ao adquirir. `null` (owner.json ilegível — ex:
      // `writeOwnerToken` falhou ao gravar, ou lock criado por código
      // legado/teste sem token) não é evidência POSITIVA de dono diferente —
      // remove mesmo assim (fail-open, preserva o comportamento idempotente
      // pré-#3430). Um token DIFERENTE É evidência clara: outro processo já
      // reivindicou este lock (staleness bateu enquanto ainda trabalhávamos,
      // ver trade-off documentado em `LOCK_STALE_MS`) — nunca remover o lock
      // do dono atual; nosso `release()` vira no-op.
      const onDiskToken = readOwnerToken(path, fsImpl);
      if (onDiskToken !== null && onDiskToken !== heldToken) {
        heldToken = null;
        return;
      }

      try {
        fsImpl.rmSync(path, { recursive: true, force: true });
      } catch {
        // Idempotente — já liberado, nunca adquirido nesta chamada, ou
        // removido externamente. Nunca lança.
      }
      heldToken = null;
    },
  };
}

/**
 * Spawner de produção. `cwd: REPO_ROOT` explícito (#2699 item 1) — nunca
 * confiar em `process.cwd()` como único sinal de onde rodar o `git`.
 *
 * `timeoutMs` (#5302) é injetável pelo chamador — default `GIT_TIMEOUT_MS`
 * (comandos rápidos por natureza); o passo de `git fetch origin` passa
 * `GIT_FETCH_TIMEOUT_MS` explicitamente.
 */
export function defaultSpawn(cmd: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): SpawnResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, cwd: REPO_ROOT });
  return {
    status: r.status,
    stdout: (r.stdout as string | null) ?? "",
    stderr: (r.stderr as string | null) ?? "",
  };
}

/**
 * Códigos do `git status --porcelain` (`git help status`, seção "Unmerged")
 * que sinalizam um caminho com conflito de merge NÃO resolvido. Não é
 * "os 2 caracteres são ambos non-space" (isso também casaria `MM`/`AM`/`RM`,
 * que NÃO são conflito) — é a lista EXPLÍCITA e fechada dos 7 pares que o
 * git reserva pra estado unmerged (`git help status`, seção "Unmerged"):
 * ambos os lados do índice apontam pra um blob de conflito (`UU`), ou o
 * caminho foi tocado por AMBOS os lados de um add/delete divergente
 * (`AA`/`DD`/`AU`/`UA`/`DU`/`UD`). #6668: usado para detectar quando um
 * `git stash pop` deixou marcador de conflito literal
 * (`<<<<<<<`/`=======`/`>>>>>>>`) dentro de um arquivo VERSIONADO — ver
 * `findUnmergedPaths()` abaixo e o item 3d do docstring no topo do arquivo.
 */
const UNMERGED_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Núcleo puro (#6800, extraído de findUnmergedPaths para reuso): dado o
 * stdout literal de `git status --porcelain`, retorna os caminhos marcados
 * como unmerged. Sem spawn, sem I/O — reusado tanto por findUnmergedPaths
 * (chama git status de novo, pós-stash-pop, #6668) quanto pela checagem de
 * estado PRÉ-EXISTENTE em syncCodeLocked (#6800, reusa o git status do
 * passo 4 sem gastar um spawn extra — MAX_SEQUENTIAL_GIT_SPAWNS já
 * documenta o orçamento de spawns por chamada).
 */
export function parseUnmergedPaths(porcelainStdout: string): string[] {
  return porcelainStdout
    .split("\n")
    .filter((line) => line.length > 3 && UNMERGED_STATUS_CODES.has(line.slice(0, 2)))
    .map((line) => line.slice(3).trim());
}

// #8719 (24/09/2026): `findUnmergedPaths()` (a versão com spawn de
// `git status --porcelain` pós-`stash pop`, #6668) foi removida — este
// módulo nunca mais chama `git stash pop` automaticamente, então a checagem
// de conflito PÓS-pop que ela existia para fazer ficou inalcançável. O núcleo
// puro `parseUnmergedPaths()` acima continua em uso pela checagem de estado
// ABSORVENTE PRÉ-EXISTENTE (#6800, ver `syncCodeLocked`), que é anterior a
// qualquer stash/pop desta chamada e não depende de pop nenhum ter
// acontecido.

/**
 * Detecta se `repoRoot` resolve para dentro de um worktree de agente (#7336).
 *
 * `REPO_ROOT` é derivado da localização FÍSICA de `scripts/lib/git-sync.ts`
 * (ver comentário de `REPO_ROOT` acima) — para um `git worktree` criado sob
 * `.claude/worktrees/<nome>` (convenção usada por overnight/develop/continuo,
 * ver `context/overnight-dispatch-rules.md` item 22 e
 * `docs/claude-md-historical-incidents.md`), esse arquivo é uma cópia física
 * separada dentro do worktree — então `REPO_ROOT` resolve pro próprio
 * worktree, não pro checkout principal. Isso é justamente o sinal que
 * distingue "estou rodando dentro do worktree isolado de uma sessão" de
 * "estou rodando no checkout compartilhado" sem depender de `process.cwd()`
 * (que um chamador poderia manipular ou herdar de outro processo).
 *
 * Padrão testado contra `/` E `\` como separador (Windows) — casa qualquer
 * segmento de path `.claude/worktrees/` ou `.claude\worktrees\`, em qualquer
 * posição do path (não só como sufixo), cobrindo tanto
 * `.claude/worktrees/agent-<id>` (dispatch via `isolation: "worktree"`)
 * quanto `.claude/worktrees/<nome>` (worktree criado manualmente, ver item 22
 * de `context/overnight-dispatch-rules.md`).
 */
export function isAgentWorktreeCheckout(repoRoot: string = REPO_ROOT): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(repoRoot);
}

function isAlreadyUpToDate(stdout: string): boolean {
  // git merge/pull imprime "Already up to date." (EN) ou "Já está atualizado." (PT).
  // Espaços literais (não wildcards) — evita falso-positivo em strings inesperadas.
  return /already up to date/i.test(stdout) || /j[aá] est[aá] atualizad/i.test(stdout);
}

/**
 * Sincroniza o checkout local com origin/master.
 *
 * @param spawn   Spawner injetável para testes (default: spawnSync real).
 * @param lock    Lock injetável para testes. `undefined` (default: nenhum
 *                argumento passado, ou explicitamente `undefined`) resolve
 *                para `createFileLock(undefined, spawn)` real — mas essa
 *                resolução acontece DENTRO do corpo da função, depois do
 *                guard de worktree (#7336) abaixo, não como valor default do
 *                parâmetro. Motivo: um valor default (`lock: SyncLock =
 *                createFileLock(undefined, spawn)`) é avaliado pelo motor JS
 *                ANTES do corpo da função rodar, mesmo quando nenhum lock é
 *                passado explicitamente — o que faria `createFileLock` (que
 *                spawna `git rev-parse --git-common-dir` para resolver o path
 *                do lock, ver `resolveSharedLockPathCached`) rodar mesmo nos
 *                casos em que o guard de worktree deveria abortar sem tocar
 *                em nenhum comando git. Resolvido explicitamente como
 *                `lock ?? createFileLock(undefined, spawn)` logo após o
 *                guard, garantindo "zero spawn git" de fato quando recusado.
 *                #3423: serializa toda a chamada — se outro `syncCode()` já
 *                estiver rodando contra este checkout, retorna imediatamente
 *                sem tocar em stash/merge (evita a race TOCTOU no stash-recovery).
 * @param repoRoot Path usado pra checagem de worktree (#7336) — injetável só
 *                para testes; produção sempre usa `REPO_ROOT` (localização
 *                física real deste módulo). Ver `isAgentWorktreeCheckout()`.
 */
export function syncCode(
  spawn: SpawnFn = defaultSpawn,
  lock?: SyncLock,
  repoRoot: string = REPO_ROOT,
): GitSyncResult {
  // #7336: recusa ANTES de qualquer spawn git ou tentativa de lock — sync de
  // código só faz sentido no checkout principal. Rodar dentro do worktree
  // isolado de uma sessão de agente (`.claude/worktrees/**`) pode mover o
  // HEAD dela por baixo enquanto ela ainda trabalha ali (incidente #7336:
  // outra sessão rodou sync-code.ts/git-sync.ts usando o worktree isolado do
  // agente como cwd, e um commit legítimo da sessão aterrissou em master
  // local por estar no meio da troca de HEAD concorrente).
  if (isAgentWorktreeCheckout(repoRoot)) {
    const msg =
      `[git-sync] ABORT: recusando sync — '${repoRoot}' é um worktree de agente ` +
      `(.claude/worktrees/**), não o checkout principal (#7336). Sync de código só faz ` +
      `sentido no checkout compartilhado — rodar checkout/stash/merge dentro do worktree ` +
      `isolado de OUTRA sessão pode mover o HEAD dela por baixo enquanto ela trabalha. ` +
      `Nenhum comando git foi executado. Se você pretendia sincronizar o checkout ` +
      `principal, rode este script de lá (cwd fora de .claude/worktrees/).`;
    return {
      outcome: "worktree_refused",
      message: msg,
      branch_before: "unknown",
      warnings: [msg],
      proceed: true,
      up_to_date: false,
      commits_behind: -1,
      preserved_stash: null,
      stale_autostash_count: -1,
    };
  }

  // Resolvido DEPOIS do guard acima (#7336) — ver docstring de `lock` no
  // parâmetro. `lock ?? ...` (não `lock ||`) trata explicitamente só
  // `undefined`/`null` como "não passado", preservando qualquer double de
  // teste truthy/falsy que os chamadores possam injetar.
  const effectiveLock: SyncLock = lock ?? createFileLock(undefined, spawn);

  if (!effectiveLock.acquire()) {
    const msg =
      `[git-sync] WARN: outro processo já parece estar sincronizando este checkout ` +
      `(lock '${effectiveLock.path}' presente e ainda válido — #3423). Sync ignorado nesta ` +
      `rodada para evitar popar/aplicar o stash de um processo concorrente. ` +
      `Edição continua com o código local atual (pode estar levemente desatualizado ` +
      `se o outro sync ainda não terminou).`;
    // #6090: NESTE caminho NÃO medimos — o invariante do #3423 é que nenhum
    // comando git roda quando o lock está com outro processo (testado). Estado
    // fica desconhecido (-1/false), conservador. #8719: mesma lógica se aplica
    // à contagem de autostashes — nenhum comando git rodou, então -1.
    return { outcome: "sync_in_progress", message: msg, branch_before: "unknown", warnings: [msg], proceed: true, up_to_date: false, commits_behind: -1, preserved_stash: null, stale_autostash_count: -1 };
  }

  try {
    const result = syncCodeLocked(spawn);
    // #6090: estado de sincronização é SEMPRE medido after-the-fact via
    // `git rev-list --count`, em TODOS os outcomes — nunca inferido deles.
    // #8719: mesma disciplina para `stale_autostash_count` via
    // `countStaleAutostashes()`. Anotação explícita `GitSyncResult`: se um
    // campo futuro colidir entre `result` e a medição, o compilador acusa em
    // vez do spread vencer silenciosamente (review independente PR #6094).
    const out: GitSyncResult = {
      ...result,
      ...measureSyncState(spawn),
      stale_autostash_count: countStaleAutostashes(spawn),
    };
    return out;
  } finally {
    effectiveLock.release();
  }
}

/**
 * Corpo real do sync, executado apenas com o lock (#3423) já adquirido pelo
 * chamador (`syncCode`). Extraído para função própria só para manter o
 * `try/finally` do lock enxuto — não é exportado nem chamado diretamente.
 * #6090: os campos `up_to_date`/`commits_behind` são anexados pelo chamador
 * (`syncCode`) via `measureSyncState()` após a tentativa inteira. #8719:
 * mesma coisa para `stale_autostash_count`, anexado via
 * `countStaleAutostashes()`.
 */
function syncCodeLocked(
  spawn: SpawnFn,
): Omit<GitSyncResult, "up_to_date" | "commits_behind" | "stale_autostash_count"> {
  const warnings: string[] = [];

  // ── 1. Branch atual ────────────────────────────────────────────────────────
  const branchRes = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  // #2699 item 3: se o próprio `rev-parse` falhar (não-repo / HEAD órfão / git
  // indisponível), branchBefore cai em "unknown" só por ausência de stdout —
  // registrar isso explicitamente agora, senão o diagnóstico downstream (se o
  // checkout também falhar) aponta pra "branch inesperada" em vez da causa raiz.
  const branchRevParseFailed = branchRes.status !== 0;
  const branchBefore = branchRes.stdout.trim() || "unknown";
  if (branchRevParseFailed) {
    warnings.push(
      `[git-sync] WARN: git rev-parse --abbrev-ref HEAD falhou (exit ${branchRes.status}). ` +
        `Causa raiz provável: não é um repositório git, ou git indisponível no ambiente — não uma ` +
        `branch desconhecida. Stderr: ${branchRes.stderr.trim() || "(vazio)"}`,
    );
  }

  // ── 2. Se não estiver em master → checkout master ─────────────────────────
  if (branchBefore !== "master") {
    // #6800 review (PR #6918, achado P2): "git checkout <branch>" TAMBÉM
    // recusa rodar com o índice em estado unmerged ("you need to resolve
    // your current index first") — verificado ao vivo com git real. Sem
    // esta checagem, o caso combinado (branch != master E unmerged
    // pré-existente) caía em "checkout_failed" genérico em vez do outcome
    // "preexisting_unmerged_state" mais específico que este PR introduz —
    // exatamente o objetivo do fix não sendo cumprido nesse sub-caso. Só
    // roda quando branch != master (não no caminho comum já coberto pelo
    // reuso do `statusRes` no passo 4, mais abaixo) — 1 spawn extra
    // condicional, refletido em MAX_SEQUENTIAL_GIT_SPAWNS.
    const preCheckoutStatusRes = spawn("git", ["status", "--porcelain"]);
    if (preCheckoutStatusRes.status === 0) {
      const preexistingUnmerged = parseUnmergedPaths(preCheckoutStatusRes.stdout);
      if (preexistingUnmerged.length > 0) {
        const msg =
          `[git-sync] ERROR: ${preexistingUnmerged.length} caminho(s) JÁ em estado unmerged (UU/AA/etc) ` +
          `ANTES de qualquer tentativa de sync desta chamada (detectado antes do checkout master, branch ` +
          `atual '${branchBefore}'): ${preexistingUnmerged.join(", ")}. ESTADO ABSORVENTE (#6800) — sobra ` +
          `de um stash pop conflitante de uma rodada ANTERIOR (não desta) OU de um merge/rebase manual em ` +
          `curso nesta checkout compartilhada. git checkout/git stash recusam rodar com caminhos unmerged, ` +
          `então NENHUMA chamada futura de syncCode() se recupera sozinha até intervenção manual. Resolva ` +
          `um destes: (1) git checkout HEAD -- <arquivo> para descartar o lado local em favor do upstream ` +
          `já mergeado; (2) resolva os marcadores de conflito manualmente e git add <arquivo>; em ambos os ` +
          `casos, confira git stash list e git status antes de qualquer ação destrutiva — pode haver ` +
          `conteúdo genuinamente não-mergeado (merge/rebase em progresso) preservado ali.`;
        warnings.push(msg);
        return {
          outcome: "preexisting_unmerged_state",
          message: msg,
          branch_before: branchBefore,
          warnings,
          proceed: true,
          preserved_stash: null,
        };
      }
    }

    const w = `[git-sync] Branch atual: '${branchBefore}'. Tentando checkout master antes do sync.`;
    warnings.push(w);
    const checkoutRes = spawn("git", ["checkout", "master"]);
    if (checkoutRes.status !== 0) {
      const rootCauseNote = branchRevParseFailed
        ? ` Causa raiz provável: git indisponível ou não é um repositório git (git rev-parse já ` +
          `havia falhado acima) — não uma branch inesperada.`
        : "";
      const msg =
        `[git-sync] WARN: checkout master falhou (branch='${branchBefore}').${rootCauseNote} ` +
        `Sync ignorado — edição continua com código local. ` +
        `Stderr: ${checkoutRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "checkout_failed", message: msg, branch_before: branchBefore, warnings, proceed: true, preserved_stash: null };
    }
    warnings.push("[git-sync] Switched to master.");
  }

  // ── 3. git fetch origin ────────────────────────────────────────────────────
  // #5302: timeout PRÓPRIO (GIT_FETCH_TIMEOUT_MS, maior que GIT_TIMEOUT_MS) —
  // um fetch trazendo volume grande de refs novos pode legitimamente passar
  // dos 120s dos comandos rápidos sem ser um erro real.
  const fetchRes = spawn("git", ["fetch", "origin"], GIT_FETCH_TIMEOUT_MS);
  if (fetchRes.status !== 0) {
    // #5302: distinguir kill por timeout (`spawnSync` mata o processo e
    // devolve `status === null`) de erro real do git (`status !== 0 && status
    // !== null` — offline, auth, etc). Um fetch morto por timeout pode já ter
    // atualizado os refs remotos localmente ANTES do kill — "offline ou erro
    // de rede" é uma mensagem enganosa nesse caso (reproduzido ao vivo).
    const isTimeout = fetchRes.status === null;
    const msg = isTimeout
      ? `[git-sync] WARN: git fetch origin foi encerrado por timeout (${GIT_FETCH_TIMEOUT_MS / 1000}s) — ` +
        `NÃO necessariamente offline ou erro de rede. Fetches grandes (muitos refs novos, checkout muito ` +
        `atrasado) podem ser mortos pelo timeout mesmo já tendo atualizado boa parte ou todos os refs ` +
        `remotos no .git local antes do kill (#5302). Rode 'git fetch origin' manualmente para confirmar/` +
        `completar. Edição continua com código local nesta rodada.`
      : `[git-sync] WARN: git fetch origin falhou (exit ${fetchRes.status} — offline, erro de rede, ou ` +
        `credencial). Edição continua com código local. ` +
        `Stderr: ${fetchRes.stderr.trim() || "(vazio)"}`;
    warnings.push(msg);
    return {
      outcome: isTimeout ? "fetch_timeout" : "fetch_failed",
      message: msg,
      branch_before: branchBefore,
      warnings,
      proceed: true,
      preserved_stash: null,
    };
  }

  // ── 4. Dirty check ────────────────────────────────────────────────────────
  // Se o próprio `git status` falhar (índice corrompido, .git/index.lock travado),
  // NÃO assumir tree limpa — isso pularia a proteção do stash e o ff poderia
  // mover o branch sob mudanças não-protegidas. Conservador: tratar como dirty
  // (força o caminho com stash, que protege ou aborta limpo via stash_failed).
  const statusRes = spawn("git", ["status", "--porcelain"]);
  if (statusRes.status !== 0) {
    warnings.push(
      `[git-sync] WARN: git status falhou (exit ${statusRes.status}). ` +
        `Tratando como dirty por segurança. Stderr: ${statusRes.stderr.trim() || "(vazio)"}`,
    );
  }
  const isDirty = statusRes.status !== 0 || statusRes.stdout.trim().length > 0;

  // #6800: detecta ESTADO ABSORVENTE — caminho(s) já unmerged (UU/AA/etc)
  // ANTES de qualquer tentativa de stash desta chamada. Reusa o statusRes já
  // obtido acima (nenhum spawn extra) via parseUnmergedPaths — o mesmo
  // núcleo puro que findUnmergedPaths usa pós-pop (#6668), aqui aplicado
  // ANTES. Isso só pode ser sobra de um "stash pop" conflitante de uma
  // rodada ANTERIOR (#6668 já cobre o conflito NOVO desta própria chamada,
  // mais abaixo) — "git stash" recusa rodar com o índice em estado unmerged,
  // então SEM esta checagem o fluxo cairia no "stash_failed" genérico
  // (transitório por natureza) toda vez, indistinguível de uma falha
  // passageira. Reproduzido ao vivo (documentado no #6800): uma sessão
  // ficou 14 commits atrás de origin/master porque toda execução de
  // syncCode() batia nesse muro desde o primeiro pop conflitante, sem
  // nenhuma delas se recuperar. Checado ANTES do branch isDirty porque um
  // caminho UU também marca a tree como dirty — sem este early-return,
  // cairia no caminho normal de stash e falharia com a mensagem genérica.
  if (statusRes.status === 0) {
    const preexistingUnmerged = parseUnmergedPaths(statusRes.stdout);
    if (preexistingUnmerged.length > 0) {
      const msg =
        `[git-sync] ERROR: ${preexistingUnmerged.length} caminho(s) JÁ em estado unmerged (UU/AA/etc) ` +
        `ANTES de qualquer tentativa de sync desta chamada: ${preexistingUnmerged.join(", ")}. ESTADO ` +
        `ABSORVENTE (#6800) — sobra de um stash pop conflitante de uma rodada ANTERIOR (não desta) OU de ` +
        `um merge/rebase manual em curso nesta checkout compartilhada. git stash recusa rodar com ` +
        `caminhos unmerged, então NENHUMA chamada futura de syncCode() se recupera sozinha até ` +
        `intervenção manual. Resolva um destes: (1) git checkout HEAD -- <arquivo> para descartar o lado ` +
        `local em favor do upstream já mergeado — correto quando o stash for mais velho que o commit ` +
        `atual; (2) resolva os marcadores de conflito manualmente e git add <arquivo>; em ambos os casos, ` +
        `confira git stash list e git status antes de qualquer ação destrutiva — pode haver conteúdo ` +
        `genuinamente não-mergeado (merge/rebase em progresso) preservado ali.`;
      warnings.push(msg);
      return {
        outcome: "preexisting_unmerged_state",
        message: msg,
        branch_before: branchBefore,
        warnings,
        proceed: true,
        preserved_stash: null,
      };
    }
  }

  if (isDirty) {
    // ── 5a. Dirty tree: ff-only DIRETO primeiro, stash só se recusar ───────
    // #8719 (decisão do editor, 24/09/2026): tenta o merge --ff-only ANTES de
    // qualquer stash. A maioria das mudanças locais soltas (config editada,
    // WIP não conflitante) não colide com o que vem de origin/master — nesse
    // caso o ff direto já resolve e NENHUM stash é criado, eliminando a
    // superfície de conflito de pop por completo pro caso comum. Só recorre a
    // stash quando este ff direto recusa (git recusa mover HEAD com mudanças
    // locais que colidiriam, ou divergência genuína — as duas causas não são
    // distinguíveis só pelo exit code, então tratamos ambas igual: protege via
    // stash e tenta de novo).
    const directFfRes = spawn("git", ["merge", "--ff-only", "origin/master"]);
    if (directFfRes.status === 0) {
      const upToDate = isAlreadyUpToDate(directFfRes.stdout);
      return {
        outcome: upToDate ? "already_up_to_date" : "synced",
        message: upToDate
          ? "[git-sync] Código já estava atualizado (tree suja preservada, sem necessidade de stash — #8719)."
          : "[git-sync] Código sincronizado com origin/master (tree suja preservada, sem necessidade de stash — #8719).",
        branch_before: branchBefore,
        warnings,
        proceed: true,
        preserved_stash: null,
      };
    }

    // ff direto recusou — protege via stash e tenta de novo.
    //
    // #3411: captura o estado de `refs/stash` ANTES de rodar o stash. Motivo:
    // `git stash --include-untracked` NÃO é atômico — ele (1) cria o(s) commit(s)
    // de stash (index + working-tree + untracked-files) e SÓ DEPOIS (2) remove os
    // arquivos não-rastreados do working tree (clean-equivalente). Se o passo 2
    // falhar parcialmente (ex: "Permission denied" num diretório com handle aberto
    // por outro processo), o comando INTEIRO sai com exit não-zero mesmo com o
    // stash já criado e parte dos untracked já removida — reportar "working tree
    // não tocada" nesse caso é falso e pode esconder perda real de arquivos
    // (incidente real 260713). Comparar refs/stash antes/depois é a forma robusta
    // de distinguir "nada foi stashado" de "stash foi criado apesar do exit != 0".
    const stashRefBeforeRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
    const stashRefBefore = stashRefBeforeRes.status === 0 ? stashRefBeforeRes.stdout.trim() : null;

    // #7740: `push -m` (não o bare `git stash --include-untracked`, que gera a
    // mensagem default "WIP on <branch>: <sha> <subject>") — dá a TODO
    // autostash deste módulo uma mensagem identificável em `git stash list`,
    // então um pop conflitante (abaixo) nunca fica indistinguível de um
    // `git stash` manual de sessão interativa. Ver docstring de
    // `GIT_SYNC_STASH_MESSAGE`.
    const stashRes = spawn("git", ["stash", "push", "--include-untracked", "-m", GIT_SYNC_STASH_MESSAGE]);
    if (stashRes.status !== 0) {
      const stashRefAfterRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
      const stashRefAfter = stashRefAfterRes.status === 0 ? stashRefAfterRes.stdout.trim() : null;
      // Um novo stash foi criado apesar do exit não-zero se refs/stash mudou
      // (cobre tanto o caso "não existia stash antes" [before=null] quanto
      // "já existia um stash diferente antes").
      const stashWasCreatedDespiteFailure = stashRefAfter !== null && stashRefAfter !== stashRefBefore;

      if (stashWasCreatedDespiteFailure) {
        // O stash existe e é válido (o commit foi criado no passo 1 antes da
        // falha no passo 2) — MAS #8719 (decisão do editor, 24/09/2026): nunca
        // `git stash pop` automático, nem mesmo aqui como "recuperação". O
        // stash fica preservado incondicionalmente; recuperação é manual.
        // Antes deste fix, este ramo tentava um `git stash pop` de
        // "recuperação" e só preservava se ELE TAMBÉM falhasse — outcome
        // único agora, sem sub-caso de pop bem-sucedido.
        const msg =
          `[git-sync] ERROR: git stash --include-untracked saiu com erro (exit ${stashRes.status}) E criou ` +
          `um stash (${stashRefAfter}) apesar disso — possível remoção NÃO-RECUPERÁVEL de arquivos não-` +
          `rastreados (#3411). Stash preservado (NUNCA despopado automaticamente — #8719, decisão do ` +
          `editor de 24/09/2026): 'git stash show -p ${stashRefAfter}' ou 'git stash apply ${stashRefAfter}'. ` +
          `Identificável por mensagem em 'git stash list' (#7740): '${GIT_SYNC_STASH_MESSAGE}'. ` +
          `Stderr stash: ${stashRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        return {
          outcome: "stash_partial_failure_unrecovered",
          message: msg,
          branch_before: branchBefore,
          warnings,
          proceed: true,
          preserved_stash: { ref: stashRefAfter, message: GIT_SYNC_STASH_MESSAGE },
        };
      }

      const msg =
        `[git-sync] WARN: git stash falhou — sync ignorado, working tree não tocada ` +
        `(nenhum stash foi criado — refs/stash não mudou). ` +
        `Stderr: ${stashRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "stash_failed", message: msg, branch_before: branchBefore, warnings, proceed: true, preserved_stash: null };
    }

    // Detecção locale-robusta de "nada foi guardado" (#2686 review — EN + PT-BR).
    // Dentro do branch isDirty, o esperado é que algo tenha sido guardado; só
    // tratamos como "nada stashado" quando o git explicitamente diz que não
    // havia nada (working tree "dirty" só porque `git status` falhou acima —
    // ver comentário do dirty check).
    const stashedNothing =
      /no local changes to save/i.test(stashRes.stdout) ||
      /n(ã|a)o h(á|a) (mudan|altera)/i.test(stashRes.stdout);
    const stashedSomething = !stashedNothing;

    // #7740: captura o SHA do stash recém-criado — vai pro `preserved_stash`
    // do resultado em QUALQUER desfecho abaixo (#8719: nunca há pop, então o
    // stash — quando algo foi de fato guardado — está SEMPRE preservado a
    // partir daqui, nunca só condicionalmente como antes).
    const createdStashRef = stashedSomething
      ? (() => {
          const r = spawn("git", ["rev-parse", "refs/stash"]);
          return r.status === 0 ? r.stdout.trim() : null;
        })()
      : null;

    // ff-only sob proteção do stash, via merge do ref já buscado no passo 3 —
    // evita o re-fetch implícito do `git pull` (#2686 review — angle H/I).
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    // #8719 (decisão do editor, 24/09/2026): NUNCA `git stash pop` automático
    // — nem quando o ff sob stash teve sucesso. O stash fica preservado
    // (mensagem identificável `GIT_SYNC_STASH_MESSAGE`), o checkout fica
    // LIMPO em master (working tree == índice, sem as mudanças do stash
    // reaplicadas) e o consumidor (`sync-code.ts`) já renderiza um banner
    // pedindo recuperação manual sempre que `preserved_stash` não é `null`.
    if (!stashedSomething) {
      // Nada foi de fato guardado (working tree só "dirty" por `git status`
      // ter falhado acima) — não há stash pra preservar, comportamento igual
      // ao de tree limpa a partir daqui.
      if (pullRes.status !== 0) {
        const msg =
          `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência?). ` +
          `Working tree não tocada (nada foi stashado). Edição continua com código local. ` +
          `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true, preserved_stash: null };
      }
      const upToDate = isAlreadyUpToDate(pullRes.stdout);
      return {
        outcome: upToDate ? "already_up_to_date" : "synced",
        message: upToDate
          ? "[git-sync] Código já estava atualizado."
          : "[git-sync] Código sincronizado com origin/master (nada foi stashado — stash não tinha mudanças a guardar).",
        branch_before: branchBefore,
        warnings,
        proceed: true,
        preserved_stash: null,
      };
    }

    if (pullRes.status !== 0) {
      // ff sob stash TAMBÉM falhou — divergência genuína (não era só sujeira
      // local colidindo). Stash preservado mesmo assim; checkout limpo em
      // master, porém defasado.
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou mesmo sob stash (divergência). ` +
        `Stash preservado (NUNCA despopado automaticamente — #8719, decisão do editor de 24/09/2026). ` +
        `Checkout segue LIMPO em master, porém defasado de origin/master. Recupere manualmente: ` +
        `'git stash show -p ${createdStashRef ?? "<ref, ver git stash list>"}' quando decidir como prosseguir. ` +
        `Identificável por mensagem em 'git stash list' (#7740): '${GIT_SYNC_STASH_MESSAGE}'. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return {
        outcome: "ff_failed",
        message: msg,
        branch_before: branchBefore,
        warnings,
        proceed: true,
        preserved_stash: { ref: createdStashRef, message: GIT_SYNC_STASH_MESSAGE },
      };
    }

    // ff sob stash teve sucesso — código sincronizado, stash preservado (não
    // despopado). `upToDate` aqui só ocorreria se origin/master não tivesse
    // avançado desde o fetch (raro neste ramo — chegamos aqui porque o ff
    // DIRETO, antes do stash, já tinha recusado) — tratado por completude.
    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    const msg =
      `[git-sync] WARN: código sincronizado com origin/master, stash preservado (NUNCA despopado ` +
      `automaticamente — #8719, decisão do editor de 24/09/2026). Mudanças locais ficam só no stash; ` +
      `checkout limpo em master. Recupere manualmente quando decidir como prosseguir: ` +
      `'git stash show -p ${createdStashRef ?? "<ref, ver git stash list>"}' / 'git stash pop'. ` +
      `Identificável por mensagem em 'git stash list' (#7740): '${GIT_SYNC_STASH_MESSAGE}'.`;
    warnings.push(msg);
    return {
      outcome: upToDate ? "already_up_to_date" : "synced_stash_preserved",
      message: msg,
      branch_before: branchBefore,
      warnings,
      proceed: true,
      preserved_stash: { ref: createdStashRef, message: GIT_SYNC_STASH_MESSAGE },
    };
  } else {
    // ── 5b. Clean tree: merge --ff-only direto ────────────────────────────
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência ou conflito). ` +
        `Edição continua com código local. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true, preserved_stash: null };
    }

    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    return {
      outcome: upToDate ? "already_up_to_date" : "synced",
      message: upToDate
        ? "[git-sync] Código já estava atualizado."
        : "[git-sync] Código sincronizado com origin/master.",
      branch_before: branchBefore,
      warnings,
      proceed: true,
      preserved_stash: null,
    };
  }
}
