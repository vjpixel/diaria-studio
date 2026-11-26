#!/usr/bin/env npx tsx
/**
 * scripts/lib/session-registry.ts (#5156)
 *
 * Registro compartilhado e leve de sessões ATIVAS — `/diaria-overnight`,
 * `/diaria-develop`, `/diaria-continuo`, e (desde #6168) sessões INTERATIVAS
 * comuns via o beacon automático (`.claude/hooks/session-beacon.mjs`).
 * (#6303 Finding Q: o texto anterior aqui listava só overnight/develop —
 * já estava impreciso antes do #6168 adicionar `continuo`, e o #6168 piorou
 * ao acrescentar o 4º kind sem atualizar este parágrafo.) Nasceu pela
 * "Direção sugerida" do #5156, que audita 11 colisões concretas entre as
 * skills coordenadoras rodando em paralelo (mesma máquina ou máquinas
 * diferentes sincronizadas pelo mesmo junction OneDrive `data/`).
 *
 * Um arquivo por sessão viva: `data/sessions/{kind}-{machineTag}-{sessionId}.json`.
 * `sessionId` é o `session_id` que o harness do Claude Code injeta no payload de
 * TODO hook `PreToolUse`/`PostToolUse` (confirmado contra a doc oficial,
 * `code.claude.com/docs/en/hooks`, ao desenhar este PR) — nunca exposto
 * diretamente à sessão rodando (não há env var `CLAUDE_SESSION_ID`, também
 * confirmado contra a doc). Por isso a ESCRITA deste registro nunca é feita
 * pelo coordenador "sabendo" o próprio session_id: o coordenador chama este CLI
 * SEM `--session-id`, e `.claude/hooks/inject-session-id.mjs` (novo, PreToolUse
 * sobre `Bash`) injeta `--session-id {payload.session_id}` no comando ANTES da
 * execução (`updatedInput.command`) — o mesmo mecanismo, aplicado também a
 * `scripts/overnight-session-marker.ts --start`/`--phase` (ver docblock de lá).
 *
 * **Coexistência deliberada com `data/overnight/.active-session-{tag}.json`
 * (item 10 do #5156):** o marker antigo, por-máquina, especializado no guard
 * de `AskUserQuestion` (#4450) e no desconto de effort do `/code-review`
 * (#3322), CONTINUA existindo e sendo escrito/lido exatamente como antes —
 * ver `scripts/overnight-session-marker.ts` e os dois hooks que o consomem.
 * Migrar esses dois mecanismos pra dentro deste registro foi avaliado e
 * descartado: a rodada `/diaria-overnight` que estava genuinamente ativa em
 * OUTRA máquina (`300`) no momento em que este PR foi escrito usa o
 * formato antigo (sem `session_id`) — qualquer migração que exigisse reescrever
 * esse marker quebraria a rodada em voo. Este registro é aditivo: cobre os
 * itens 3/4/6/7/9 do #5156 (claim de issue, merge lock, teto de concorrência,
 * herança de plano em voo, cleanup de worktree), que não têm mecanismo prévio
 * nenhum — não substitui nada que já funcionava.
 *
 * **Staleness:** mesma janela de 24h usada por `isOvernightRoundActive`
 * (`pr-create-review.mjs`) e `shouldBlockAskUserQuestion`
 * (`block-askuserquestion-overnight-autonomous.mjs`) — uma rodada
 * crashada/abandonada não deve aparecer como "ativa" pra sempre.
 * `listActiveSessions` filtra por `lastHeartbeat` (ou `startedAt` se nunca
 * houve heartbeat) dentro de `[0, maxAgeMs]` — mesmo guard de clock-skew dos
 * dois hooks (idade negativa, ex: relógio adiantado gravando no futuro, nunca
 * conta como "ativa").
 *
 * **Merge lock (item 4):** `data/sessions/.merge-lock.json`, TTL curto (2 min —
 * a janela real é só `gh pr merge` + `git pull`, nunca deveria levar mais que
 * isso). Lock mais velho que o TTL é tratado como abandonado e liberado pro
 * próximo `acquireMergeLock` — nunca trava a máquina pra sempre por um
 * coordenador que crashou segurando o lock. **Entre máquinas a exclusão vem
 * do D1 desde o #12842:** `acquireMergeLockShared` (usado pelo CLI
 * `merge-lock-*`) consulta o D1 primeiro e só cai no arquivo, com aviso em
 * stderr, quando o D1 não responde ou não está provisionado (ver
 * `scripts/lib/sessions/merge-lock.ts` e `scripts/lib/d1-locks.ts`). O
 * arquivo sozinho continua valendo só dentro da MESMA máquina (#6182):
 * `O_CREAT|O_EXCL` sobre a pasta sincronizada não exclui entre máquinas,
 * porque cada uma cria o seu arquivo e ambas recebem `true`.
 *
 * **Claim de issue (item 3):** embutido no próprio registro de sessão
 * (`claimed_issues: number[]`) em vez de um arquivo `claims.jsonl` separado —
 * mais simples (a issue #5156 já sugeria essa opção como preferível), e o
 * dado morre junto com a sessão que fez o claim (staleness compartilhada).
 *
 * Uso CLI (chamado pelas skills — sempre SEM `--session-id`, injetado pelo
 * hook, ver acima):
 *   npx tsx scripts/lib/session-registry.ts register --kind overnight|develop|continuo [--pid N] [--unattended]
 *     (`--unattended`, #7546: grava que esta sessão NÃO consegue receber
 *     SendMessage/Remote Control — ex: rodando como task agendada/dispatched
 *     sem interlocutor do outro lado. Sem a flag, o default por `kind` vale
 *     como antes — `continuo` já nasce `attended: false` sozinho, os demais
 *     `true`. Consumido por `selfAuthorizeMerge`: uma coordenadora
 *     `overnight`/`develop` `--unattended` deixa de contar como "responsiva"
 *     no guard do #5716, mesmo tratamento que `continuo` já tinha.)
 *   npx tsx scripts/lib/session-registry.ts heartbeat --kind ... [--phase X] [--active-worktrees N]
 *   npx tsx scripts/lib/session-registry.ts end --kind ... [--tag MAQUINA] [--allow-dirty]
 *     (`--tag` opcional, #5797: default é o machineTag() local; passar o tag de
 *     OUTRA máquina permite encerrar daqui um registro que não é seu — ver
 *     "Defeito 4" do #5797. `end` também distingue "removeu de fato" de "não
 *     havia nada pra remover": esta última reporta `exit 1` e a mensagem
 *     "nothing to end", nunca "ended". #6922: `end` recusa (`exit 1`) só quando
 *     `repoRoot` tem mudanças não commitadas ATRIBUÍVEIS a esta sessão
 *     (interseção com touched_paths/dirty_paths do próprio registro) — ver
 *     `evaluateEndGuard`; sujeira de outra sessão concorrente no mesmo
 *     checkout compartilhado (#6168, a norma) nunca bloqueia, só avisa.
 *     `--allow-dirty` bypassa tudo explicitamente.)
 *   npx tsx scripts/lib/session-registry.ts claim-issue --kind ... --issue N [--force]
 *     (#6236: check-and-set — recusa (`exit 1`) quando outra sessão ATIVA já
 *     segura a issue, imprimindo quem/desde quando. `--force` toma o claim
 *     mesmo assim — escape hatch pra retomar issue de sessão morta sem
 *     esperar a staleness de 24h. Reivindicar o que a própria sessão já tem
 *     é sempre no-op de sucesso, nunca recusa. #6369: sessão sem registro
 *     prévio não vira mais no-op silencioso — o CLI auto-registra uma sessão
 *     mínima e tenta o claim de novo (ver `claimIssueAutoRegistering`),
 *     avisando na própria mensagem de sucesso quando isso acontece. #7003:
 *     quando a âncora sumiu com a sessão VIVA — e cópias de conflito órfãs
 *     dela ainda estão frescas — o registro é RECONSTRUÍDO a partir delas em
 *     vez de recriado zerado, com `[ALERTA: ...]` na mensagem.)
 *   npx tsx scripts/lib/session-registry.ts claim-issue --kind ... --issues A,B,C [--force]
 *     (#12010: a onda inteira numa escrita só da âncora — mesma semântica por
 *     issue do `--issue`, uma linha de resultado por issue, `exit 1` se
 *     alguma não terminou reivindicada. Preferir isto a N `claim-issue`
 *     seguidos: a rajada de renames na âncora sincronizada pelo OneDrive é o
 *     que gera as cópias de conflito, ver `claimIssuesCheckAndSet`.)
 *   npx tsx scripts/lib/session-registry.ts unclaim-issue --kind ... --issues A,B,C
 *     (#12166: o inverso em lote — solta as issues de uma onda numa escrita
 *     só da âncora, uma linha por issue, `exit 1` se alguma não saiu
 *     liberada (`no-op-not-claimed` de uma não impede as outras). Ver
 *     `unclaimIssues`.)
 *   npx tsx scripts/lib/session-registry.ts is-claimed --issue N
 *   npx tsx scripts/lib/session-registry.ts list-active
 *   npx tsx scripts/lib/session-registry.ts merge-lock-acquire --pr N
 *     (#6334: deixou de ser reentrante pra mesma sessão — uma 2ª chamada
 *     antes do `merge-lock-release` correspondente falha, mesmo sendo a
 *     mesma sessão. Ver `merge-lock-renew` pra estender o TTL de um hold
 *     que já é seu. **`--pr` não é opcional na prática (#7169/#7223,
 *     achado ao vivo na rodada no 300, #7217):** o próprio `BLOCK_REASON`
 *     de `.claude/hooks/block-gh-pr-merge-subagent.mjs` já recomenda
 *     `merge-lock-acquire --pr N`/`merge-lock-release --pr N` — seguir o
 *     comando SEM `--pr` deixou `gh pr merge` bloqueado repetidamente pelo
 *     guard #5716 mesmo com lock genuinamente adquirido.)
 *   npx tsx scripts/lib/session-registry.ts merge-lock-release --pr N
 *   (#10618: `merge-lock-*`, `grant-merge` e `self-authorize-merge` aceitam
 *   `--repo owner/name` — o lock é POR REPO. Sem `--repo` = diaria-studio,
 *   o significado de sempre. Ex: merge do vjpixel/diaria-design#23 →
 *   `merge-lock-acquire --pr 23 --repo vjpixel/diaria-design`, que não
 *   espera nem trava o lock do diaria-studio. `claim-issue`/`is-claimed`/
 *   `unclaim-issue` aceitam `--issue owner/repo#N` de qualquer repo da
 *   allowlist `platform.config.json → issue_repos` (fatia 2): a do repo
 *   default vai em `claimed_issues` como número, a de outro repo em
 *   `claimed_foreign_issues` como `owner/repo#N` — sem colisão entre o #21
 *   de um e o #21 do outro. Repo fora da allowlist é recusado alto, ver
 *   `requireClaimIssue`.)
 *   npx tsx scripts/lib/session-registry.ts merge-lock-renew
 *     (#6334 — renova o TTL de um lock que a PRÓPRIA sessão já detém; nunca
 *     concede um hold novo. Ver `renewMergeLock`.)
 *   npx tsx scripts/lib/session-registry.ts conflicts [--paths a.ts,b.ts] [--branch X]
 *     (#6168 Parte C — CONSULTA "quem mais está mexendo nisto?", nunca
 *     adquire nada nem cria arquivo; `exit 1` = sobreposição real com peer
 *     VIVO, `exit 0` = livre.)
 *   npx tsx scripts/lib/session-registry.ts grant-merge --kind ... --granted-to SESSION_ID [--pr N]
 *     (#6296 — só coordenadora concede, nunca a si mesma; TTL curto, uso
 *     único. Ver `grantMergeWindow`.)
 *   npx tsx scripts/lib/session-registry.ts check-merge-grant
 *     (#6296 — confirma se existe concessão viva pra esta sessão; `exit 1`
 *     quando não há. #6972: o JSON traz `source` ("real"/"backup") e
 *     `visible_to_merge_gate`, e um grant que só existe em cópia de conflito
 *     do OneDrive imprime aviso em stderr — o gate de merge NÃO o honra, e
 *     `granted: true` sozinho já mandou duas sessões investigarem a coisa
 *     errada. Ver `findLiveMergeGrant`.)
 *   npx tsx scripts/lib/session-registry.ts consume-merge-grant
 *     (#6296 — marca a concessão viva desta sessão como consumida, uso
 *     único; desde #6303 também disparado automaticamente por
 *     `.claude/hooks/consume-merge-grant-on-merge.mjs` após um `gh pr merge`
 *     bem-sucedido, sem depender de a sessão beneficiada lembrar de chamar
 *     isto à mão. Ver `consumeMergeGrant`. **#7171 — NUNCA rodar isto à mão
 *     ANTES do `gh pr merge`:** `consumedAt` é o carimbo que o MERGE deixa,
 *     não um passo que quem recebe a janela executa antes de usá-la —
 *     chamar isto antes do merge DESTRÓI a autorização que `gh pr merge` ia
 *     consultar (o comando responde `ok` mesmo assim, sem indicar que acabou
 *     de queimar a própria janela) e o merge seguinte é bloqueado pelo guard
 *     do #5716 mesmo com `check-merge-grant` tendo confirmado `granted:
 *     true` segundos antes. O caminho feliz não tem `consume-merge-grant`
 *     nele: `grant-merge` (coordenadora) → `check-merge-grant` →
 *     `merge-lock-acquire` → `gh pr merge` → `merge-lock-release`; o hook
 *     automático cuida do carimbo depois.)
 *   npx tsx scripts/lib/session-registry.ts gc [--max-age-days N] [--dry-run]
 * (`--session-id X` funciona também se passado explicitamente — o hook só
 * injeta quando a flag está AUSENTE, nunca sobrescreve um valor já presente.)
 *
 * **#6130 — conflitos de sync do OneDrive e GC de registros encerrados.**
 * `data/sessions/` vive numa junction OneDrive compartilhada entre máquinas
 * e pode bifurcar um arquivo de sessão em cópias de conflito com sufixo
 * `-safeBackup-NNNN` (ex: `continuo-300-{uuid}-300-safeBackup-0001.json`)
 * — o `#5427` já fazia `listActiveSessions` IGNORAR essas cópias pra não
 * ressuscitar sessão já encerrada (arquivo real removido, só o backup
 * sobrou). O `#6130` fecha o lado oposto: quando o arquivo REAL de uma
 * sessão AINDA VIVA coexiste com backups divergentes (conflito ocorreu
 * enquanto `claimed_issues` estava sendo escrito), um claim podia
 * desaparecer do registro efetivo se só existisse no backup — permitindo
 * duas sessões na mesma issue. `listActiveSessions`/`isIssueClaimedByOther`
 * agora leem a UNIÃO de `claimed_issues` do arquivo real + todo backup cujo
 * nome começa com o stem do real (ver `mergeSessionRecords`) — fail-safe:
 * preferir "está reivindicada" a "não está". Backup ÓRFÃO (sem arquivo real
 * correspondente — sessão já encerrada) continua ignorado, comportamento
 * do #5427 preservado.
 *
 * `gc` (novo, #6130) remove registros de sessão ENCERRADA — mas NUNCA por
 * staleness de heartbeat sozinha: uma sessão pode estar viva e só ter
 * parado de bater heartbeat (achado ao vivo do #6130 — `stale: true` com
 * processo `claude` ainda rodando no `300`). Ver docstring de
 * `planSessionGc` pra árvore de decisão completa (checagem de PID vivo na
 * MESMA máquina, janela conservadora bem maior que qualquer heartbeat
 * esperado quando não há sinal de processo verificável).
 */

import { parseArgs, isMainModule } from "./cli-args.ts";
import { resolveEnvInjectedSessionId } from "./session-id-required-subcommands.ts";
import { reportD1Failure } from "./d1-locks.ts";
import { DEFAULT_ISSUE_REPO, loadIssueRepos } from "./issue-repos.ts";
import {
  type ActiveSessionRecord,
  isCoordinatorKind,
  MERGE_GRANT_TTL_MS,
  type MergeGrant,
  type MergeLockRecord,
  type SessionRecord,
} from "./sessions/types.ts";
import { machineTag, mergeLockPath, readJsonSafe, sessionFilePath } from "./sessions/store.ts";
import {
  annotatePreviousCoordinator,
  checkSessionsScanHealth,
  endSession,
  evaluateEndGuard,
  listActiveSessions,
  readSessionLifecycleEvents,
  registerSession,
} from "./sessions/registry.ts";
import {
  claimIssueAutoRegistering,
  claimIssuesAutoRegistering,
  claimTargetLabel,
  downgradedClaimKindNotice,
  findActiveSessionsOfKind,
  findStaleSessionsOfKind,
  hasActiveSessionOfKind,
  heartbeatAutoRegistering,
  isIssueClaimedByOther,
  recoveredClaimLabels,
  unclaimIssue,
  unclaimIssues,
} from "./sessions/claims.ts";
import {
  acquireMergeLockShared,
  assessCrossMachineSyncFreshness,
  CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS,
  mergeLockAcquireOutcome,
  releaseMergeLockShared,
  renewMergeLockShared,
  resolveD1ForRepo,
  stderrWarn,
} from "./sessions/merge-lock.ts";
import {
  clearCoordinatorPresenceShared,
  clearPresenceForGcRemovals,
  d1GrantRejectionMessage,
  d1PresenceGrantNotice,
  type D1PresenceGrantor,
  findLiveMergeGrantInD1,
  grantMergeWindowShared,
  grantVisibilitySuffix,
  isD1PresenceGrantor,
  isMergeGrantConsumedInD1,
  markMergeGrantConsumedInD1,
  reconcileCoordinatorPresenceOnRegister,
  reportMergeGrantDoubleConsumed,
  staleGrantorRegistrations,
} from "./sessions/presence.ts";
import { garbageCollectSessions, planSessionGc } from "./sessions/gc.ts";
import { findSessionConflicts, type FindSessionConflictsOptions } from "./sessions/conflicts.ts";
import { consumeMergeGrant, findLiveMergeGrant, type MergeGrantSource, selfAuthorizeMerge } from "./sessions/merge-grant.ts";
import { recordMergeGrantConsumption } from "./sessions/merge-grant-ledger.ts";
import {
  requireClaimIssue,
  requireClaimIssueList,
  requireCoordinatorKind,
  requireKind,
  requireRepoFlag,
  requireSessionId,
  resolveRepoRoot,
  warnLockHeldInOtherRepo,
} from "./sessions/cli-support.ts";

// #14004: a implementação vive em `scripts/lib/sessions/`. Este arquivo
// reexporta a API pública inteira (mesmos nomes, mesmo caminho de import) e
// segue sendo a entrada do CLI (`main()` abaixo), cujo caminho os hooks
// (`inject-session-id.mjs`), as skills e o Hermes casam.
export {
  ALL_SESSION_KINDS,
  COORDINATOR_SESSION_KINDS,
  isCoordinatorKind,
  MERGE_AUTHORITY_SESSION_KINDS,
  hasMergeAuthorityKind,
  PREVIOUS_COORDINATOR_WINDOW_MS,
  MAX_SESSION_AGE_MS,
  SOFT_STALE_MS,
  INTERACTIVE_SOFT_STALE_MS,
  softStaleMsForKind,
  CLAIM_RELEASE_MS,
  claimReleaseMsForKind,
  MERGE_LOCK_TTL_MS,
  MERGE_GRANT_TTL_MS,
  TOUCHED_PATHS_CAP,
} from "./sessions/types.ts";
export type {
  SessionKind,
  WorktreeRef,
  SessionLastAction,
  SessionRecord,
  ActiveSessionRecord,
  PreviousCoordinatorNote,
  MergeGrant,
  SelfAuthorizedMerge,
  SessionLifecycleEventType,
  SessionLifecycleEvent,
} from "./sessions/types.ts";
export {
  CLOCK_SKEW_TOLERANCE_MS,
  machineTag,
  sessionsDir,
  sessionFilePath,
  mergeLockPath,
  STALE_LOCK_MS,
  FOREIGN_HOST_STALE_LOCK_MS,
  breakStaleLock,
  parseSessionFileName,
  readEffectiveSessionRecord,
  endedAfterLastHeartbeat,
  mergeSessionRecords,
} from "./sessions/store.ts";
export {
  registerSession,
  heartbeat,
  readSessionLifecycleEvents,
  annotatePreviousCoordinator,
  endSession,
  checkRepoTreeClean,
  extractPorcelainPath,
  evaluateEndGuard,
  checkSessionsScanHealth,
  listActiveSessions,
} from "./sessions/registry.ts";
export type {
  RegisterSessionOutcome,
  RegisterSessionResult,
  PromotionRemoveIo,
  RepoTreeCleanResult,
  EndGuardResult,
  SessionsScanHealth,
} from "./sessions/registry.ts";
export {
  claimTargetLabel,
  claimIssueCheckAndSet,
  autoRegisterKindFor,
  downgradedClaimKindNotice,
  claimIssueAutoRegistering,
  claimIssuesCheckAndSet,
  claimIssuesAutoRegistering,
  sessionHasEndedEvent,
  heartbeatAutoRegistering,
  claimWorktree,
  claimIssue,
  unclaimIssue,
  unclaimIssues,
  isIssueClaimedByOther,
  isIssueClaimedByActiveSession,
  findActiveSessionsOfKind,
  findStaleSessionsOfKind,
  hasActiveSessionOfKind,
} from "./sessions/claims.ts";
export type {
  ClaimIssueReason,
  ClaimIssueResult,
  ClaimIssueOptions,
  ClaimIssueTarget,
  ClaimIssueAutoRegisterResult,
  BatchClaimIssueEntry,
  BatchClaimIssuesResult,
  BatchClaimIssuesAutoRegisterResult,
  HeartbeatAutoRegisterResult,
  UnclaimIssueReason,
  UnclaimIssueResult,
  BatchUnclaimIssueEntry,
  BatchUnclaimIssuesResult,
} from "./sessions/claims.ts";
export {
  CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS,
  assessCrossMachineSyncFreshness,
  acquireMergeLock,
  createLockFileExclusive,
  MERGE_LOCK_CREATE_GRACE_MS,
  mergeLockAcquireOutcome,
  renewMergeLock,
  releaseMergeLock,
  isRegisteredSessionId,
  acquireMergeLockShared,
  releaseMergeLockShared,
  renewMergeLockShared,
} from "./sessions/merge-lock.ts";
export type {
  MergeLockIo,
  MergeLockBackend,
  SharedMergeLockResult,
  SharedLockOptions,
} from "./sessions/merge-lock.ts";
export {
  markMergeGrantConsumedInD1,
  isMergeGrantConsumedInD1,
  registerCoordinatorPresenceShared,
  clearCoordinatorPresenceShared,
  reconcileCoordinatorPresenceOnRegister,
  clearPresenceForGcRemovals,
  grantMergeWindowShared,
  presenceMachineConsistent,
  d1PresenceGrantNotice,
  isD1PresenceGrantor,
  hasNonAuthorityCoordinatorRecord,
  findLiveMergeGrantInD1,
  grantVisibilitySuffix,
  d1GrantRejectionMessage,
  staleGrantorRegistrations,
} from "./sessions/presence.ts";
export type {
  SharedGrantMergeResult,
  D1PresenceGrantor,
  D1GrantRejection,
} from "./sessions/presence.ts";
export {
  GC_CONSERVATIVE_MAX_AGE_MS,
  GC_INTERACTIVE_MAX_AGE_MS,
  GC_ORPHAN_LIVENESS_MARGIN,
  defaultIsPidAlive,
  planSessionGc,
  garbageCollectSessions,
} from "./sessions/gc.ts";
export type {
  TasklistResult,
  TasklistRunner,
  SessionGcOptions,
  SessionGcAction,
  SessionGcResult,
} from "./sessions/gc.ts";
export {
  claimReconciliationHasAdditions,
  decideClaimReconciliation,
  planClaimReconciliation,
  reconcileClaims,
  planSafeBackupCleanup,
  cleanupReconciledSafeBackups,
  SAFE_BACKUP_CAP_DEFAULT,
  planSafeBackupCapPrune,
  applySafeBackupCapPrune,
} from "./sessions/reconcile.ts";
export type {
  ClaimReconciliationAction,
  ClaimReconciliationResult,
  ClaimReconciliationDecision,
  SafeBackupCleanupAction,
  SafeBackupCleanupResult,
  SafeBackupCapPruneEntry,
  SafeBackupCapPruneResult,
} from "./sessions/reconcile.ts";
export {
  normalizeBeaconPath,
  collapseTouchedPaths,
  beaconPathsOverlap,
  findSessionConflicts,
} from "./sessions/conflicts.ts";
export type {
  SessionConflict,
  FindSessionConflictsOptions,
} from "./sessions/conflicts.ts";
export {
  selfAuthorizeMerge,
  grantRepoOf,
  grantMergeWindow,
  isMergeGrantLive,
  isSelfAuthorizedMergeLive,
  findLiveMergeGrant,
  consumeMergeGrant,
} from "./sessions/merge-grant.ts";
export type {
  SelfAuthorizeMergeReason,
  SelfAuthorizeMergeResult,
  GrantMergeReason,
  GrantMergeResult,
  MergeGrantSource,
} from "./sessions/merge-grant.ts";
export {
  MERGE_GRANT_LEDGER_PREFIX,
  MERGE_GRANT_LEDGER_RETENTION_MS,
  mergeGrantIdentityKey,
  mergeGrantLedgerPath,
  readMergeGrantConsumptions,
  withLedgerConsumption,
  recordMergeGrantConsumption,
} from "./sessions/merge-grant-ledger.ts";
export {
  requireKind,
  requireCoordinatorKind,
  mergeLocksHeldBy,
  requireRepoFlag,
  requireLegacyClaimIssue,
  requireClaimIssue,
  requireClaimIssueList,
  resolveRepoRoot,
} from "./sessions/cli-support.ts";


async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, values, flags } = parseArgs(argv);
  const command = positional[0];
  // #10560: equivalente, por env, do `.claude/hooks/inject-session-id.mjs`
  // para o elo `codex exec` do contínuo (nenhum hook do Claude Code roda lá).
  // Só subcomandos de claim/lease; `--session-id` explícito sempre vence.
  const envInjectedSessionId = resolveEnvInjectedSessionId(command, values, process.env);
  if (envInjectedSessionId) values["session-id"] = envInjectedSessionId;

  try {
    const repoRoot = resolveRepoRoot();
    switch (command) {
      case "register": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const pid = values.pid ? Number(values.pid) : undefined;
        // #7546 — `--unattended` grava explicitamente que esta sessão não
        // consegue receber SendMessage/Remote Control (ex: um wrapper de
        // scheduling que spawna sem interlocutor do outro lado). Sem a
        // flag, `registerSession` aplica o default por kind (ver docstring
        // de `attended` em `SessionRecord`) — nenhuma mudança pra quem já
        // chama `register` sem essa flag hoje.
        const attended = flags.has("unattended") ? false : undefined;
        const result = registerSession(repoRoot, kind, sessionId, { pid, attended });
        const path = sessionFilePath(repoRoot, kind, result.record.machineTag, sessionId);
        // #6326 fleet review — o CLI precisa IMPRIMIR o desfecho, não só o
        // código carregar o tipo: os 2 casos de falha parcial
        // ("promoted-orphan-left"/"promotion-failed-unreadable") são
        // exatamente o bug que esta issue existe pra consertar voltando em
        // silêncio se o operador só vir "registered {path}" nos 5 casos.
        let suffix = "";
        if (result.outcome === "promoted") {
          suffix = ` (promoted from ${result.promotedFrom})`;
        } else if (result.outcome === "promoted-orphan-left") {
          suffix =
            ` (ATENÇÃO: promovido de ${result.promotedFrom}, mas não foi possível remover o registro antigo — ` +
            "órfão deixado em disco, será recolhido pelo GC)";
        } else if (result.outcome === "promotion-failed-unreadable") {
          suffix =
            ` (ATENÇÃO: registro de outro kind encontrado em ${result.promotedFrom} mas ILEGÍVEL — promoção ` +
            "não aconteceu, registro novo criado do zero)";
        } else if (result.outcome === "reregistered") {
          suffix = " (reregistered)";
        }
        process.stdout.write(`session-registry: registered ${path}${suffix}\n`);
        // #13577: coordenadora com autoridade de merge publica a presença no
        // D1, para que a concessão dela valha em outra máquina antes do sync
        // do registro. Falha vira aviso no stderr; o registro local já valeu.
        // #13596: sessão rebaixada para kind sem autoridade apaga a presença.
        await reconcileCoordinatorPresenceOnRegister(repoRoot, kind, sessionId, result);
        break;
      }
      case "heartbeat": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {};
        if (values.phase) patch.phase = values.phase;
        if (values["active-worktrees"]) patch.active_worktrees = Number(values["active-worktrees"]);
        // #8443: sessão sem registro prévio (ex: ciclo `continuo` do cron
        // Hermes chamando `heartbeat` sem nunca ter chamado `register` —
        // mesma classe do #6369, mas pro heartbeat, que é chamado em MUITO
        // mais pontos do loop do que `claim-issue`) não vira mais no-op
        // silencioso — `heartbeatAutoRegistering` registra uma sessão mínima
        // (ou recupera de backup órfão, #7003) e tenta de novo.
        const result = heartbeatAutoRegistering(repoRoot, kind, sessionId, patch);
        const autoRegisterSuffix = !result.autoRegistered
          ? ""
          : result.autoRegisterMode === "recovered-from-orphan-backups"
            ? ` [ALERTA: a ÂNCORA desta sessão SUMIU do disco com a sessão VIVA — reconstruída de ` +
              `${result.recoveredFromFiles} cópia(s) de conflito do OneDrive, ` +
              `${recoveredClaimLabels(result).length} claim(s) recuperada(s)` +
              `${recoveredClaimLabels(result).length > 0 ? `: ${recoveredClaimLabels(result).join(", ")}` : ""}` +
              ". Isto é escrita concorrente, não sessão nova — ver #7002/#7003]"
            : " [ATENÇÃO: sessão não tinha registro prévio — auto-registrada agora antes do heartbeat, ver #8443]";
        if (result.alreadyEnded) {
          process.stdout.write(
            "session-registry: heartbeat no-op (sessão já encerrada via end — não reativada, ver #11059)\n",
          );
          break;
        }
        process.stdout.write(
          `session-registry: heartbeat ${result.ok ? "ok" : "no-op (sessão inexistente mesmo após tentativa de auto-registro)"}${autoRegisterSuffix}\n`,
        );
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "end": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        // #5797: `--tag` opcional — default `machineTag()` local (comportamento
        // pré-#5797 preservado) permite encerrar o registro de OUTRA máquina
        // (data/sessions/ é compartilhado via OneDrive) sem exigir rodar o
        // comando fisicamente naquela máquina.
        const tag = values.tag ?? machineTag();
        // #6922 (revisado): recusa encerrar o tick só quando a sujeira é
        // ATRIBUÍVEL à própria sessão (interseção com touched_paths/
        // dirty_paths do próprio registro, lido ANTES de endSession remover
        // o arquivo) — ver docstring de `evaluateEndGuard` acima.
        // `--allow-dirty` bypassa de propósito (mesmo em sujeira própria).
        const ownRecordPath = sessionFilePath(repoRoot, kind, tag, sessionId);
        const ownRecord = readJsonSafe<SessionRecord>(ownRecordPath);
        const ownPaths = [...(ownRecord?.touched_paths ?? []), ...(ownRecord?.dirty_paths ?? [])];
        const endGuard = evaluateEndGuard(repoRoot, flags.has("allow-dirty"), ownPaths);
        if (!endGuard.ok) {
          process.stdout.write(endGuard.message ?? "session-registry: end recusado (árvore suja)\n");
          process.exitCode = 1;
          break;
        }
        if (endGuard.warning) process.stderr.write(endGuard.warning);
        // ORDEM IMPORTANTE, e o motivo não é legibilidade (#6952): o guard
        // acima é LEITURA PURA (`git status` + interseção de paths) e é o
        // único dos dois passos que pode dizer "não prossiga". O `endSession`
        // abaixo começa quebrando `.lock` órfão — AÇÃO DESTRUTIVA sobre
        // estado compartilhado, porque outro processo pode estar prestes a
        // adquirir aquele lock legitimamente.
        //
        // Invertendo (quebrar o lock e só então avaliar o guard), uma recusa
        // deixa o sistema PIOR do que se ninguém tivesse tentado: lock de
        // terceiro quebrado e nada encerrado. Como o guard não tem efeito
        // colateral, adiá-lo não compra nada.
        //
        // A regra geral: **ação destrutiva por último, depois de todas as
        // recusas possíveis.**
        const removed = endSession(repoRoot, kind, sessionId, tag);
        if (removed) {
          process.stdout.write("session-registry: ended\n");
          // #13577: sem a presença no D1, nenhuma concessão desta sessão vale
          // mais em outra máquina pelo caminho do D1.
          await clearCoordinatorPresenceShared(repoRoot, kind, sessionId);
        } else {
          process.stdout.write(
            "session-registry: nothing to end (registro não encontrado — tag/session-id conferem?)\n",
          );
          process.exitCode = 1;
        }
        break;
      }
      case "claim-issue": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        if (values.issues !== undefined || flags.has("issues")) {
          // #12010: a onda inteira numa escrita só da âncora — ver `claimIssuesCheckAndSet`.
          const issues = requireClaimIssueList(values, flags, loadIssueRepos(repoRoot));
          const batch = claimIssuesAutoRegistering(repoRoot, kind, sessionId, issues, undefined, undefined, {
            force: flags.has("force"),
          });
          const recoveredLabels = recoveredClaimLabels(batch);
          if (batch.autoRegistered) {
            process.stdout.write(
              batch.autoRegisterMode === "recovered-from-orphan-backups"
                ? `session-registry: claim-issue --issues [ALERTA: a ÂNCORA desta sessão SUMIU do disco com a sessão VIVA — ` +
                    `reconstruída de ${batch.recoveredFromFiles} cópia(s) de conflito do OneDrive, ` +
                    `${recoveredLabels.length} claim(s) recuperada(s)` +
                    `${recoveredLabels.length > 0 ? `: ${recoveredLabels.join(", ")}` : ""}` +
                    ". Isto é escrita concorrente, não sessão nova — ver #7002/#7003]\n"
                : `session-registry: claim-issue --issues [ATENÇÃO: sessão não tinha registro prévio — auto-registrada agora ` +
                    `como ${batch.registeredKind ?? kind} antes do claim, ver #6369]\n`,
            );
          }
          if (batch.registeredKind && batch.registeredKind !== kind) {
            process.stderr.write(downgradedClaimKindNotice(kind, batch.registeredKind));
          }
          for (const entry of batch.entries) {
            const owner = entry.blockedBy;
            switch (entry.reason) {
              case "claimed":
                process.stdout.write(`session-registry: claim-issue ${entry.label} ok (claimed)\n`);
                break;
              case "already-own":
                process.stdout.write(`session-registry: claim-issue ${entry.label} ok (already-own, no-op)\n`);
                break;
              case "forced-override":
                process.stdout.write(
                  `session-registry: claim-issue ${entry.label} ok (FORCED — tomado de ${owner?.kind}-${owner?.sessionId} ` +
                    `desde ${owner?.startedAt}, heartbeat ${owner?.lastHeartbeat})\n`,
                );
                break;
              case "no-op-session-missing":
                process.stdout.write(
                  `session-registry: claim-issue ${entry.label} no-op (sessão inexistente mesmo após tentativa de auto-registro)\n`,
                );
                break;
              case "blocked-by-other":
                process.stdout.write(
                  `session-registry: claim-issue ${entry.label} RECUSADO — já está reivindicada por ` +
                    `${owner?.kind}-${owner?.machineTag}-${owner?.sessionId} (desde ${owner?.startedAt}, ` +
                    `último heartbeat ${owner?.lastHeartbeat}). Use --force para tomar mesmo assim.\n`,
                );
                break;
            }
          }
          process.stdout.write(
            `session-registry: claim-issue --issues ${batch.entries.filter((e) => e.ok).length}/${batch.entries.length} ok, ` +
              `${batch.writes} escrita(s) na âncora [repoRoot=${repoRoot}]\n`,
          );
          if (!batch.ok) process.exitCode = 1;
          break;
        }
        // #10618: aceita owner/repo#N de qualquer repo da allowlist `issue_repos`.
        const issue = requireClaimIssue(values, flags, loadIssueRepos(repoRoot));
        const issueLabel = claimTargetLabel(issue);
        const force = flags.has("force");
        // #6369: sessão sem registro prévio (ex: ciclo `continuo` do cron
        // Hermes chamando `claim-issue` antes de qualquer `register`) não
        // vira mais no-op silencioso — `claimIssueAutoRegistering` registra
        // uma sessão mínima e tenta de novo, sinalizando isso na mensagem.
        const result = claimIssueAutoRegistering(repoRoot, kind, sessionId, issue, undefined, undefined, { force });
        // #7003: as duas causas de "registro ausente" imprimem mensagens
        // DIFERENTES. A antiga ("não tinha registro prévio") descrevia a
        // sessão nova; usá-la também pro caso da âncora sumindo com a sessão
        // viva foi o que fez a perda de 7 claims passar como rotina.
        const autoRegisterSuffix = !result.autoRegistered
          ? ""
          : result.autoRegisterMode === "recovered-from-orphan-backups"
            ? ` [ALERTA: a ÂNCORA desta sessão SUMIU do disco com a sessão VIVA — reconstruída de ` +
              `${result.recoveredFromFiles} cópia(s) de conflito do OneDrive, ` +
              `${recoveredClaimLabels(result).length} claim(s) recuperada(s)` +
              `${recoveredClaimLabels(result).length > 0 ? `: ${recoveredClaimLabels(result).join(", ")}` : ""}` +
              ". Isto é escrita concorrente, não sessão nova — ver #7002/#7003]"
            : ` [ATENÇÃO: sessão não tinha registro prévio — auto-registrada agora como ${result.registeredKind ?? kind} ` +
              "antes do claim, ver #6369]";
        if (result.registeredKind && result.registeredKind !== kind) {
          process.stderr.write(downgradedClaimKindNotice(kind, result.registeredKind));
        }
        switch (result.reason) {
          case "claimed":
            process.stdout.write(
              `session-registry: claim-issue ok (claimed)${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          case "already-own":
            process.stdout.write(
              `session-registry: claim-issue ok (already-own, no-op)${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          case "forced-override": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue ok (FORCED — tomado de ${owner?.kind}-${owner?.sessionId} ` +
                `desde ${owner?.startedAt}, heartbeat ${owner?.lastHeartbeat})${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          }
          case "no-op-session-missing":
            // Não deveria mais acontecer depois do auto-registro acima — só
            // sobra se o próprio `registerSession` falhar em silêncio (não
            // deveria: `writeJsonSafe` lança em erro de I/O real). Mantido
            // como rede de segurança — nunca finge sucesso.
            process.stdout.write(
              "session-registry: claim-issue no-op (sessão inexistente mesmo após tentativa de auto-registro)\n",
            );
            process.exitCode = 1;
            break;
          case "blocked-by-other": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue RECUSADO — issue ${issueLabel} já está reivindicada por ` +
                `${owner?.kind}-${owner?.machineTag}-${owner?.sessionId} (desde ${owner?.startedAt}, ` +
                `último heartbeat ${owner?.lastHeartbeat}). Use --force para tomar mesmo assim.\n`,
            );
            process.exitCode = 1;
            break;
          }
        }
        break;
      }
      case "unclaim-issue": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        if (values.issues !== undefined || flags.has("issues")) {
          // #12166: a onda inteira numa escrita só da âncora — ver `unclaimIssues`.
          const issues = requireClaimIssueList(values, flags, loadIssueRepos(repoRoot));
          const batch = unclaimIssues(repoRoot, kind, sessionId, issues);
          for (const entry of batch.entries) {
            switch (entry.reason) {
              case "unclaimed":
                process.stdout.write(`session-registry: unclaim-issue ${entry.label} ok (liberada)\n`);
                break;
              case "no-op-not-claimed":
                process.stdout.write(
                  `session-registry: unclaim-issue ${entry.label} no-op (não estava reivindicada por esta sessão)\n`,
                );
                break;
              case "no-op-session-missing":
                process.stdout.write(`session-registry: unclaim-issue ${entry.label} no-op (sessão inexistente)\n`);
                break;
              case "no-op-unreadable":
                process.stdout.write(
                  `session-registry: unclaim-issue ${entry.label} no-op — registro EXISTE mas está ILEGÍVEL agora ` +
                    "(aviso já emitido em stderr); a claim pode estar ATIVA\n",
                );
                break;
            }
          }
          process.stdout.write(
            `session-registry: unclaim-issue --issues ${batch.entries.filter((e) => e.ok).length}/${batch.entries.length} ok, ` +
              `${batch.writes} escrita(s) na âncora [repoRoot=${repoRoot}]\n`,
          );
          if (!batch.ok) process.exitCode = 1;
          break;
        }
        const issue = requireClaimIssue(values, flags, loadIssueRepos(repoRoot)); // #10618
        const issueLabel = claimTargetLabel(issue);
        const result = unclaimIssue(repoRoot, kind, sessionId, issue);
        switch (result.reason) {
          case "unclaimed":
            process.stdout.write(`session-registry: unclaim-issue ok (issue ${issueLabel} liberada)\n`);
            break;
          case "no-op-not-claimed":
            process.stdout.write(
              `session-registry: unclaim-issue no-op (issue ${issueLabel} não estava reivindicada por esta sessão)\n`,
            );
            process.exitCode = 1;
            break;
          case "no-op-session-missing":
            process.stdout.write("session-registry: unclaim-issue no-op (sessão inexistente)\n");
            process.exitCode = 1;
            break;
          case "no-op-unreadable":
            process.stdout.write(
              "session-registry: unclaim-issue no-op — registro EXISTE mas está ILEGÍVEL agora (JSON corrompido/" +
                "parcialmente sincronizado pelo Drive). A claim pode estar ATIVA — isto NÃO é 'sessão " +
                "inexistente'; investigar antes de assumir que não há nada pra soltar (aviso já emitido em " +
                "stderr).\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "is-claimed": {
        const issue = requireClaimIssue(values, flags, loadIssueRepos(repoRoot)); // #10618
        const excludeSessionId = values["session-id"] ?? "";
        const owner = isIssueClaimedByOther(repoRoot, issue, excludeSessionId);
        process.stdout.write(JSON.stringify({ claimed: owner !== null, by: owner }) + "\n");
        break;
      }
      case "list-active": {
        // #11299: `previous_coordinator` explica um `interactive` que até
        // pouco antes era a rodada coordenadora da mesma conversa.
        const sessions = annotatePreviousCoordinator(listActiveSessions(repoRoot), readSessionLifecycleEvents(repoRoot));
        process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
        break;
      }
      case "active-of-kind": {
        // #6277 item 3 — "há uma rodada deste kind acontecendo agora?".
        // Sempre exit 0 (mesmo padrão de `is-claimed`): a resposta é o JSON,
        // não o exit code — "não há overnight ativo" é resposta válida, não erro.
        const kind = requireKind(values.kind);
        const excludeSessionId = values["session-id"];
        // `uncertain` vem ANTES da varredura: se `data/sessions/` existe mas
        // não pôde ser lido, `active: false` significa "não deu pra saber",
        // não "não há sessão". O chamador deve fail-CLOSED nesse caso —
        // tratar como se houvesse overnight rodando (#6277, achado do review).
        const health = checkSessionsScanHealth(repoRoot);
        const sessions = findActiveSessionsOfKind(repoRoot, kind, excludeSessionId);
        const stale = findStaleSessionsOfKind(repoRoot, kind, excludeSessionId);
        process.stdout.write(
          JSON.stringify(
            {
              kind,
              active: hasActiveSessionOfKind(repoRoot, kind, excludeSessionId),
              uncertain: !health.ok,
              ...(health.ok ? {} : { ioError: health.error }),
              sessions,
              stale,
            },
            null,
            2,
          ) + "\n",
        );
        break;
      }
      case "merge-lock-acquire": {
        const sessionId = requireSessionId(values);
        // #10618: lock POR REPO (`--repo owner/name`, default diaria-studio).
        const lockRepo = requireRepoFlag(values, flags);
        // #12842: D1 na frente (exclusão entre máquinas), arquivo como espelho
        // e fallback — ver `acquireMergeLockShared`.
        const shared = await acquireMergeLockShared(repoRoot, sessionId, lockRepo);
        const ok = shared.ok;
        // #11380: na recusa, relê quem segura o lock só pra mensagem — o
        // resultado (`ok`/exit 1) não muda.
        const holder = ok
          ? null
          : typeof shared.d1Holder === "string"
            ? ({ heldBy: shared.d1Holder, acquiredAt: "(D1)" } satisfies MergeLockRecord)
            : readJsonSafe<MergeLockRecord>(mergeLockPath(repoRoot, lockRepo));
        process.stdout.write(
          `session-registry: merge-lock-acquire ${mergeLockAcquireOutcome(ok, sessionId, holder)} ` +
            `[repo=${lockRepo}] [lock=${shared.backend}] [repoRoot=${repoRoot}]\n`,
        );
        const activeSessions = listActiveSessions(repoRoot);
        // #7169 direção (c) — "guard de frescor": nunca muda o resultado do
        // `ok` acima (o lock continua advisory entre máquinas, #6182), só
        // torna VISÍVEL um sinal hoje mudo. Aviso em stderr (nunca stdout,
        // que é lido por script) quando alguma coordenadora de OUTRA máquina
        // parece com o registro sincronizado desatualizado — `ok: true` aqui
        // pode não significar "de fato livre", só "livre segundo dados que
        // podem estar até 1h+ velhos" (incidente de origem: onedrive.service
        // morto por 1h13 sem alarme).
        const freshness = assessCrossMachineSyncFreshness(activeSessions, Date.now());
        if (freshness.stale) {
          const names = freshness.staleSessions
            .map((s) => `${s.kind}-${s.machineTag}-${s.sessionId} (heartbeat de ${s.lastHeartbeat})`)
            .join(", ");
          process.stderr.write(
            `session-registry: ATENÇÃO (#7169) — registro de coordenadora de OUTRA máquina parece DESATUALIZADO ` +
              `(mais de ${Math.round(CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS / 60000)}min sem heartbeat, mas ainda dentro ` +
              `do limiar de 90min que a marcaria stale): ${names}. Isto pode significar sync cross-máquina ` +
              `degradado (data/sessions/ mora na pasta sincronizada pelo Drive) — o resultado acima (${ok ? "ok" : "denied"}) ` +
              "pode não refletir o estado real daquela máquina agora. Mitigação: `git fetch origin master` e " +
              "conferir se o head mudou antes de confiar no merge lock/grant cross-máquina.\n",
          );
        }
        // #7043 achado 2 — o lock É advisory entre máquinas (#6182: cada
        // máquina vê um inode distinto no mesmo junction OneDrive, `O_EXCL`
        // não é exclusão mútua real ali), mas até aqui `acquire` respondia
        // `ok` IDÊNTICO esteja ou não em cenário cross-máquina — quem lê não
        // tinha como saber que a garantia era fraca. Diferente do aviso de
        // frescor acima (que só dispara com heartbeat DESATUALIZADO), este
        // aviso é sobre a garantia em si: dispara sempre que `ok` e existe
        // QUALQUER coordenadora ativa (mesmo fresca) numa máquina diferente
        // — porque mesmo com dado fresco, a exclusão entre máquinas não é
        // atômica.
        const myTag = machineTag();
        // #12842: com o lock tomado no D1 a exclusão entre máquinas é real —
        // o aviso só vale quando a decisão foi do arquivo.
        if (ok && shared.backend !== "d1") {
          const peers = activeSessions.filter(
            (s) => !s.stale && isCoordinatorKind(s.kind) && s.machineTag !== myTag,
          );
          if (peers.length > 0) {
            const names = [...new Set(peers.map((s) => s.machineTag))].join(", ");
            process.stderr.write(
              `session-registry: AVISO (#7043) — lock adquirido, mas há coordenadora ativa em outra(s) máquina(s) ` +
                `(${names}): a exclusão entre máquinas é ADVISORY, não garantida (#6182) — ambas podem ter recebido ` +
                '"ok" pro mesmo lock. Confie no lock sozinho só na mesma máquina; entre máquinas, combine por ' +
                "outro canal (mensagem direta) antes de mergear.\n",
            );
          }
        }
        if (!ok) process.exitCode = 1;
        break;
      }
      case "merge-lock-release": {
        const sessionId = requireSessionId(values);
        // #7043 achado 2 — lê QUEM detém o lock ANTES de tentar liberar, pra
        // poder distinguir (depois de `releaseMergeLock` recusar) "esperado,
        // advisory" de erro de verdade. `releaseMergeLock` já recusa liberar
        // lock alheio (nunca lança) — a leitura aqui é só pra mensagem, sem
        // mudar essa decisão.
        const lockRepo = requireRepoFlag(values, flags);
        const localHeldBy = readJsonSafe<MergeLockRecord>(mergeLockPath(repoRoot, lockRepo))?.heldBy;
        // #12842: solta no D1 e no arquivo — ver `releaseMergeLockShared`.
        const shared = await releaseMergeLockShared(repoRoot, sessionId, lockRepo);
        const ok = shared.ok;
        const heldByBefore = typeof shared.d1Holder === "string" ? shared.d1Holder : localHeldBy;
        if (ok) {
          process.stdout.write(`session-registry: merge-lock-release ok [repo=${lockRepo}] [lock=${shared.backend}]\n`);
          warnLockHeldInOtherRepo(repoRoot, sessionId, lockRepo, heldByBefore, "merge-lock-release");
          break;
        }
        // Achou o dono atual entre as sessões ativas pra saber se é uma
        // corrida cross-máquina (esperada, advisory — #6182) ou algo que não
        // deveria acontecer (mesma máquina, onde `O_EXCL` é exclusão real).
        const holder = heldByBefore ? listActiveSessions(repoRoot).find((s) => s.sessionId === heldByBefore) : undefined;
        // #12842: no D1 não há corrida "esperada" entre máquinas — a recusa é
        // sempre a de lock alheio (o nosso venceu pelo TTL e outro tomou).
        const crossMachine = shared.backend !== "d1" && holder !== undefined && holder.machineTag !== machineTag();
        if (crossMachine) {
          // Erro é o sinal ERRADO pra comportamento documentado e esperado
          // (#6182 já prevê isto) — treina quem opera a ignorar a saída do
          // comando. `exit 0`: não é uma falha desta chamada, é o desfecho
          // correto de uma corrida cross-máquina que o próprio desenho
          // admite como possível.
          process.stdout.write(
            `session-registry: merge-lock-release no-op — lock já pertence a outra sessão de OUTRA máquina ` +
              `(${holder.kind}-${holder.machineTag}-${holder.sessionId}), corrida cross-máquina ESPERADA (advisory, ` +
              "#6182/#7043) — não é erro. Se o merge que este release protegia já saiu, confira `git log` antes de " +
              "reagir.\n",
          );
        } else {
          process.stdout.write(
            "session-registry: merge-lock-release denied (held by another session)" +
              (holder
                ? ` — ${holder.kind}-${holder.machineTag}-${holder.sessionId}`
                : heldByBefore
                  ? ` — ${heldByBefore}`
                  : "") +
              ` [lock=${shared.backend}]\n`,
          );
          process.exitCode = 1;
        }
        break;
      }
      case "merge-lock-renew": {
        // #6334: renova o TTL de um hold que a PRÓPRIA sessão já detém —
        // nunca concede um hold novo (ver docblock de `renewMergeLock`).
        const sessionId = requireSessionId(values);
        const renewRepo = requireRepoFlag(values, flags);
        // #12842: renova no D1 e no arquivo — ver `renewMergeLockShared`.
        const shared = await renewMergeLockShared(repoRoot, sessionId, renewRepo);
        const ok = shared.ok;
        process.stdout.write(
          `session-registry: merge-lock-renew ${ok ? "ok" : "denied (not held by this session)"} [repo=${renewRepo}] ` +
            `[lock=${shared.backend}]\n`,
        );
        if (!ok) warnLockHeldInOtherRepo(repoRoot, sessionId, renewRepo, undefined, "merge-lock-renew");
        if (!ok) process.exitCode = 1;
        break;
      }
      case "conflicts": {
        // #6168 Parte C — CONSULTA, nunca aquisição: não cria arquivo nenhum.
        // exit 1 = sobreposição real com peer VIVO; exit 0 = livre (inclusive
        // quando o único peer sobreposto está stale).
        const sessionId = values["session-id"] ?? "";
        const paths = (values.paths ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "");
        const branch = values.branch;
        const tag = values.tag ?? machineTag();
        const sessions = listActiveSessions(repoRoot);
        const ownRecord = sessions.find((s) => s.sessionId === sessionId) ?? null;
        const opts: FindSessionConflictsOptions = { sessionId, paths, ownRecord, machineTag: tag };
        if (branch) opts.branch = branch;
        const conflicts = findSessionConflicts(sessions, opts);
        process.stdout.write(JSON.stringify({ conflicts, count: conflicts.length }, null, 2) + "\n");
        if (conflicts.length > 0) process.exitCode = 1;
        break;
      }
      case "grant-merge": {
        // #6296 — só coordenadora concede, e nunca a si mesma.
        // #6331: `--kind` é da sessão CONCEDENTE (a própria, coordenadora),
        // nunca da beneficiária em `--granted-to` — mensagem dedicada aqui
        // porque este é o único subcomando com dois sujeitos de sessão, e a
        // leitura errada ("--kind é da beneficiária") sucede em silêncio.
        if (values.kind === undefined) {
          throw new Error(
            '--kind ausente — é o kind da sessão CONCEDENTE (a SUA, a coordenadora que está chamando grant-merge), ' +
              'nunca da beneficiária em --granted-to. Deve ser "overnight", "develop" ou "continuo". ' +
              "Ex: grant-merge --kind develop --granted-to <sessionId-do-beneficiario> [--pr N] [--force].",
          );
        }
        const kind = requireCoordinatorKind(values.kind);
        const sessionId = requireSessionId(values);
        const grantedTo = values["granted-to"];
        if (!grantedTo) throw new Error("--granted-to (sessionId de quem recebe a janela) é obrigatório");
        const pr = values.pr ? Number(values.pr) : undefined;
        const force = flags.has("force");
        const grantRepo = requireRepoFlag(values, flags);
        // #13242: grava também no D1, para a beneficiária de outra máquina ver
        // na hora (o arquivo só chega pelo sync do Drive).
        const result = await grantMergeWindowShared(repoRoot, kind, sessionId, grantedTo, {
          ...(pr !== undefined ? { pr } : {}),
          ...(grantRepo !== DEFAULT_ISSUE_REPO ? { repo: grantRepo } : {}),
          ...(force ? { force } : {}),
        });
        switch (result.reason) {
          case "granted":
            process.stdout.write(
              `session-registry: grant-merge ok — janela concedida a ${grantedTo}` +
                `${pr !== undefined ? ` (PR #${pr})` : ""}, TTL ${Math.round(MERGE_GRANT_TTL_MS / 60000)}min, uso único` +
                `${grantVisibilitySuffix(result)}\n`,
            );
            // #7857: `grantedTo` não bate NENHUMA sessão ativa no registry —
            // aviso, não recusa (a beneficiária pode ainda não ter se
            // registrado). Vai pro stderr, nunca stdout (stdout aqui é
            // mensagem de linha única esperada pelo operador/script que
            // chama grant-merge; ver o mesmo padrão em check-merge-grant
            // abaixo).
            if (result.granteeRecognized === false) {
              process.stderr.write(
                `session-registry: ATENÇÃO — "${grantedTo}" não corresponde ao session_id de NENHUMA sessão ` +
                  "ativa em data/sessions/ agora (achado ao vivo #7857). A janela foi gravada mesmo assim — a " +
                  "beneficiária pode simplesmente ainda não ter se registrado. Mas se este valor veio do nome " +
                  "CURTO exibido pelo ListAgents (ex: \"02d2e8\") em vez do session_id REAL (UUID completo), a " +
                  "concessão nunca vai ficar visível pro gate do #5716: confirme com `list-active` ou peça o " +
                  "session_id de volta à beneficiária antes de assumir que o merge vai destravar.\n",
              );
            }
            break;
          case "self-grant-refused":
            process.stdout.write(
              "session-registry: grant-merge RECUSADO — uma sessão nunca concede janela a si mesma (#6296). " +
                "É isso que preserva a propriedade do #5716 em vez de contorná-la.\n",
            );
            process.exitCode = 1;
            break;
          case "not-a-coordinator":
            process.stdout.write(
              "session-registry: grant-merge RECUSADO — só overnight/develop concedem (#7702: continuo é rodada, mas não decide merge)\n",
            );
            process.exitCode = 1;
            break;
          case "grantee-is-coordinator-refused":
            process.stdout.write(
              `session-registry: grant-merge RECUSADO — ${grantedTo} é uma sessão COORDENADORA ativa (#6303). ` +
                "Coordenadora já tem direito de mergear por si; o que ela precisa respeitar é o merge lock, e " +
                "conceder entre pares seria justamente um jeito de contorná-lo. A concessão existe pra quem NÃO " +
                "tem identidade de coordenadora (tipicamente uma sessão interativa). Se as duas rodadas precisam " +
                "mergear, elas se serializam pelo merge-lock-acquire, não por concessão.\n",
            );
            process.exitCode = 1;
            break;
          case "no-op-session-missing":
            // #6999 (fix 2): `grant-merge` é o único subcomando com DOIS
            // sujeitos de sessão, e "sessão inexistente" mandava o operador
            // conferir a errada — a leitura natural é a beneficiária, que
            // acabou de ser digitada, quando a não-encontrada é sempre a
            // CONCEDENTE (a beneficiária nem precisa estar registrada).
            process.stdout.write(
              "session-registry: grant-merge no-op — a sessão CONCEDENTE (a SUA, não a de --granted-to) não foi " +
                `encontrada em data/sessions/. Procurado: kind="${kind}", sessionId="${sessionId}", arquivo ` +
                `"${sessionFilePath(repoRoot, kind, machineTag(), sessionId)}". A beneficiária ` +
                `"${grantedTo}" NÃO é o problema aqui (ela nem precisa estar registrada). Causas típicas: ` +
                "--session-id de outra sessão, --kind diferente do que foi registrado, ou a âncora sumiu sem " +
                `nenhuma cópia de conflito viva pra reconstruir (#7002). Registre a concedente ("register --kind ${kind}") antes de conceder.\n`,
            );
            process.exitCode = 1;
            break;
          case "live-grant-would-be-overwritten":
            // #7043 achado 1 (1º caminho).
            process.stdout.write(
              "session-registry: grant-merge RECUSADO — você já tem uma concessão VIVA e NÃO-CONSUMIDA pra outra " +
                `identidade (grantedTo="${result.grant?.grantedTo}"${result.grant?.pr !== undefined ? `, PR #${result.grant.pr}` : ""}). ` +
                "`merge_grant` é campo único: conceder esta agora apagaria aquela em silêncio, sem a beneficiária " +
                "original nunca saber que perdeu a janela (#7043). Se a concessão anterior de fato não é mais " +
                "necessária, repita com --force pra sobrescrever deliberadamente.\n",
            );
            process.exitCode = 1;
            break;
          case "pr-already-granted-elsewhere":
            // #7043 achado 1 (2º caminho).
            process.stdout.write(
              `session-registry: grant-merge RECUSADO — o PR #${pr} já tem concessão viva emitida por OUTRA ` +
                `coordenadora (grantedTo="${result.grant?.grantedTo}"). Duas concessões pro mesmo PR não se ` +
                "enxergam entre records — a 2ª sobrescreveria a 1ª em silêncio (#7043). Confirme com a outra " +
                "coordenadora antes de reconceder, ou repita com --force se for deliberado.\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "check-merge-grant": {
        const sessionId = requireSessionId(values);
        const checkRepo = requireRepoFlag(values, flags);
        const foundLocal = findLiveMergeGrant(repoRoot, sessionId);
        // #12842: consumo marcado no D1 (talvez por outra máquina, antes de o
        // registro sincronizar) derruba a janela — o guard faz o mesmo. Sem
        // D1 vale só a leitura local; D1 configurado e sem resposta também,
        // mas com aviso (a janela pode já ter sido usada em outra máquina).
        const consumedRead = foundLocal
          ? await isMergeGrantConsumedInD1(resolveD1ForRepo(repoRoot, {}), foundLocal.grant)
          : null;
        if (consumedRead && !consumedRead.ok) {
          reportD1Failure(repoRoot, "check-merge-grant (consumo da concessão não conferido)", consumedRead, stderrWarn);
        }
        const consumedInD1 = consumedRead?.ok === true && consumedRead.value;
        // #13242: sem janela no arquivo, a concessão pode estar só no D1 (a
        // concedente é de outra máquina e o registro dela ainda não sincronizou).
        let found: {
          grant: MergeGrant;
          grantedBy: ActiveSessionRecord | D1PresenceGrantor;
          source: MergeGrantSource | "d1";
        } | null = consumedInD1 ? null : foundLocal;
        if (!found && !consumedInD1) {
          const inD1 = await findLiveMergeGrantInD1(repoRoot, sessionId, checkRepo);
          if (inD1 && "error" in inD1) {
            reportD1Failure(repoRoot, "check-merge-grant (concessão no D1 não conferida)", inD1.error, stderrWarn);
          } else if (inD1 && "rejected" in inD1) {
            // #13577: a concessão existe no D1 — dizer por que não vale, nunca calar.
            process.stderr.write(d1GrantRejectionMessage(inD1.rejected));
          } else if (inD1) {
            found = { ...inD1, source: "d1" };
            if (isD1PresenceGrantor(inD1.grantedBy)) process.stderr.write(d1PresenceGrantNotice(inD1.grantedBy));
          }
        }
        if (consumedInD1) {
          process.stderr.write(
            "session-registry: a janela local existe, mas o D1 registra o consumo dela (#12842) — tratada como consumida.\n",
          );
        }
        // #6972: `source` e `visible_to_merge_gate` são ADITIVOS — `granted`/
        // `grant`/`grantedBy` seguem com a mesma forma pra quem já consome
        // este JSON.
        //
        // O nome é `visible_`, não `honored_`, de propósito: `false` afirma
        // com certeza que o gate NÃO vai honrar (ele nem enxerga o arquivo),
        // mas `true` só diz que ESTA causa de bloqueio não se aplica — o gate
        // ainda checa escopo de PR (#6322), staleness e identidade. Prometer
        // "será honrado" reintroduziria, invertida, a confusão que a #6972
        // existe pra remover.
        process.stdout.write(
          JSON.stringify({
            granted: found !== null,
            grant: found?.grant ?? null,
            grantedBy: found?.grantedBy ?? null,
            source: found?.source ?? null,
            // #13242: o guard lê a concessão do D1 com as mesmas regras.
            visible_to_merge_gate: found === null ? null : found.source === "real" || found.source === "d1",
          }) + "\n",
        );
        if (!found) {
          // #13242: `granted: false` com a concedente em outra máquina pode ser
          // só o registro dela parado no sync — diz isso em vez de calar.
          for (const s of staleGrantorRegistrations(listActiveSessions(repoRoot), machineTag(), Date.now())) {
            process.stderr.write(
              `session-registry: registro de ${s.kind} ${s.sessionId} (máquina ${s.machineTag}) com ${s.ageMinutes} min ` +
                "de atraso aqui: o sync pode não ter trazido a concessão. Sem D1 configurado nesta máquina, peça à " +
                "concedente para conferir o grant-merge (a saída diz se gravou no D1) ou para reconceder (#13242).\n",
            );
          }
        }
        if (found && found.source === "backup") {
          // Aviso em stderr (nunca no stdout, que é JSON consumido por script):
          // a janela EXISTE na união do #6952 mas o gate do #5716 é cego a
          // cópia de conflito por decisão deliberada e NÃO vai honrá-la.
          process.stderr.write(
            "session-registry: ATENÇÃO — janela encontrada, mas SÓ em cópia de conflito do OneDrive " +
              "(-safeBackup-): o gate de merge NÃO a honra e o `gh pr merge` será bloqueado assim mesmo. " +
              "Isto não é 'a coordenadora não concedeu' nem 'expirou' — peça RECONCESSÃO à coordenadora " +
              `(${found.grantedBy.kind}-${found.grantedBy.sessionId}) pra que o grant volte a existir no ` +
              "arquivo real (#6972).\n",
          );
        }
        // #7857: `--session-id` conferido aqui não corresponde ao sessionId
        // de NENHUMA sessão ativa registrada — mesmo achado do `grant-merge`
        // acima, só que do lado de quem RECONFERE. Não é prova de que o id
        // está errado (a própria sessão pode ainda não ter mandado
        // heartbeat), mas é o mesmo sinal de possível confusão nome-curto
        // (ListAgents) vs session_id real que motivou a issue.
        if (!listActiveSessions(repoRoot).some((s) => s.sessionId === sessionId)) {
          process.stderr.write(
            `session-registry: ATENÇÃO — "${sessionId}" (o --session-id conferido) não corresponde ao ` +
              "session_id de NENHUMA sessão ativa em data/sessions/ agora. Se este valor veio do nome CURTO " +
              'exibido pelo ListAgents (ex: "02d2e8") em vez do session_id REAL (UUID completo), o resultado ' +
              "acima pode estar respondendo pela identidade ERRADA (#7857) — confirme com `list-active` antes " +
              "de agir sobre este resultado.\n",
          );
        }
        if (!found) process.exitCode = 1;
        break;
      }
      case "consume-merge-grant": {
        // #7171: este subcomando SÓ deveria ser chamado pelo hook automático
        // `.claude/hooks/consume-merge-grant-on-merge.mjs`, DEPOIS que
        // `gh pr merge` sucede — nunca à mão, e nunca antes. Rodar isto antes
        // do merge queima a própria janela e o `gh pr merge` seguinte é
        // bloqueado pelo guard do #5716, mesmo com `check-merge-grant` tendo
        // confirmado `granted: true` segundos antes (o "ok" abaixo não
        // distingue os dois casos — por isso o aviso explícito aqui).
        const sessionId = requireSessionId(values);
        let toConsume = findLiveMergeGrant(repoRoot, sessionId)?.grant ?? null;
        let ok = consumeMergeGrant(repoRoot, sessionId);
        // #13242: janela que só o D1 conhece (concedente de outra máquina, sem
        // sync ainda) — o consumo é a marca no D1 + o registro da beneficiária.
        if (!toConsume) {
          const inD1 = await findLiveMergeGrantInD1(repoRoot, sessionId, requireRepoFlag(values, flags));
          if (inD1 && "error" in inD1) {
            reportD1Failure(repoRoot, "consume-merge-grant (concessão no D1 não conferida)", inD1.error, stderrWarn);
          } else if (inD1 && "rejected" in inD1) {
            process.stderr.write(d1GrantRejectionMessage(inD1.rejected));
          } else if (inD1) {
            if (isD1PresenceGrantor(inD1.grantedBy)) process.stderr.write(d1PresenceGrantNotice(inD1.grantedBy));
            toConsume = inD1.grant;
            ok = recordMergeGrantConsumption(repoRoot, inD1.grant, new Date().toISOString());
          }
        }
        // #12842: marca de uso único no D1, visível a toda máquina. Sem D1, só o local.
        if (ok && toConsume) {
          const d1 = resolveD1ForRepo(repoRoot, {});
          const mark = await markMergeGrantConsumedInD1(d1, toConsume, sessionId);
          if (mark && !mark.ok) {
            reportD1Failure(repoRoot, "consume-merge-grant (marca de consumo não gravada)", mark, stderrWarn);
          } else if (mark?.ok && mark.value === "already") {
            reportMergeGrantDoubleConsumed(repoRoot, toConsume, sessionId);
          }
        }
        // #7223 review — o aviso vai pro STDERR, nunca stdout: stdout é lido
        // como payload por script (mesmo padrão de merge-lock-acquire acima),
        // e a linha "ok/no-op" sozinha já é o contrato de saída esperado.
        process.stdout.write(
          `session-registry: consume-merge-grant ${ok ? "ok (janela consumida — uso único)" : "no-op (nenhuma janela viva)"}\n`,
        );
        process.stderr.write(
          "session-registry: ATENÇÃO (#7171) — chamar isto ANTES do `gh pr merge` queima a janela e o merge " +
            "seguinte será bloqueado. O caminho feliz nunca inclui `consume-merge-grant` explícito: " +
            "grant-merge (coordenadora) → check-merge-grant → merge-lock-acquire → gh pr merge → " +
            "merge-lock-release. `consumedAt` é o carimbo que o MERGE bem-sucedido deixa (automaticamente, " +
            "via .claude/hooks/consume-merge-grant-on-merge.mjs) — não um passo prévio.\n",
        );
        if (!ok) process.exitCode = 1;
        break;
      }
      case "self-authorize-merge": {
        // #7303: escape hatch pro caso em que `gh pr merge` está bloqueado
        // pelo guard do #5716 e a ÚNICA coordenadora ativa é `continuo`
        // (cron, não conversa) — pedir `grant-merge` a ela é estruturalmente
        // impossível. Ver docstring de `selfAuthorizeMerge` pro escopo
        // completo (as 4 recusas existem pra nunca abrir mão de proteção
        // nenhuma que já vale pra uma rodada supervisionada normal).
        const sessionId = requireSessionId(values);
        const reasonArg = values.reason;
        if (!reasonArg || reasonArg.trim() === "") {
          throw new Error(
            "--reason (não-vazio) é obrigatório — nunca uma auto-autorização silenciosa (#7303). " +
              'Ex: self-authorize-merge --reason "única coordenadora ativa é continuo, sem interlocutor" [--pr N].',
          );
        }
        const pr = values.pr ? Number(values.pr) : undefined;
        const selfAuthRepo = requireRepoFlag(values, flags);
        const result = selfAuthorizeMerge(repoRoot, sessionId, {
          reason: reasonArg,
          ...(pr !== undefined ? { pr } : {}),
          ...(selfAuthRepo !== DEFAULT_ISSUE_REPO ? { repo: selfAuthRepo } : {}),
        });
        switch (result.reason) {
          case "authorized":
            process.stdout.write(
              `session-registry: self-authorize-merge ok — auto-autorizado${pr !== undefined ? ` (PR #${pr})` : ""}, ` +
                `TTL ${Math.round(MERGE_GRANT_TTL_MS / 60000)}min. Isto NÃO dispensa o merge lock: rode ` +
                "merge-lock-acquire --pr N ANTES do gh pr merge — a auto-autorização destrava identidade, " +
                "nunca tempo, mesmo princípio de grant-merge (#6303 P1·a).\n",
            );
            break;
          case "reason-required":
            process.stdout.write("session-registry: self-authorize-merge RECUSADO — --reason vazio\n");
            process.exitCode = 1;
            break;
          case "no-active-coordinator":
            process.stdout.write(
              "session-registry: self-authorize-merge no-op — nenhuma coordenadora ativa registrada. gh pr merge " +
                "provavelmente já não está bloqueado pelo guard do #5716 (ele só bloqueia havendo rodada ativa) — " +
                "não há nada pra contornar aqui.\n",
            );
            process.exitCode = 1;
            break;
          case "responsive-coordinator-active":
            process.stdout.write(
              `session-registry: self-authorize-merge RECUSADO — há coordenadora(s) ativa(s) que CONVERSA(M): ` +
                `${result.coordinatorKinds?.join(", ")}. O caminho normal continua sendo o único: peça a janela via ` +
                "grant-merge dela. Este comando só existe pro caso em que NENHUMA coordenadora ativa consegue " +
                "responder (só continuo).\n",
            );
            process.exitCode = 1;
            break;
          case "caller-is-coordinator":
            process.stdout.write(
              "session-registry: self-authorize-merge no-op — você já é uma coordenadora REGISTRADA e ativa; já " +
                "tem direito de mergear por si (o guard te reconhece via isCoordinator), sem precisar deste " +
                "comando.\n",
            );
            process.exitCode = 1;
            break;
          case "session-not-registered":
            process.stdout.write(
              "session-registry: self-authorize-merge RECUSADO — esta sessão ainda não tem registro em " +
                "data/sessions/ (o beacon cria um na 1ª chamada de ferramenta). Rode qualquer outro comando " +
                "(ex: git status) e tente de novo.\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "gc": {
        const maxAgeDaysRaw = values["max-age-days"];
        const conservativeMaxAgeMs =
          maxAgeDaysRaw !== undefined ? Number(maxAgeDaysRaw) * 24 * 60 * 60 * 1000 : undefined;
        if (maxAgeDaysRaw !== undefined && (!Number.isFinite(conservativeMaxAgeMs) || conservativeMaxAgeMs! <= 0)) {
          throw new Error(`--max-age-days deve ser um número positivo, recebido "${maxAgeDaysRaw}"`);
        }
        const opts = conservativeMaxAgeMs !== undefined ? { conservativeMaxAgeMs } : {};
        const isDryRun = flags.has("dry-run");
        const plan = isDryRun ? planSessionGc(repoRoot, opts) : garbageCollectSessions(repoRoot, opts);
        for (const entry of plan) {
          const verb = isDryRun && entry.action === "removed" ? "would-remove" : entry.action;
          process.stdout.write(`session-registry: gc ${verb} ${entry.identity} (${entry.files.length} arquivo(s)) — ${entry.reason}\n`);
        }
        // #13596: coordenadora removida pelo GC não deixa a presença no D1 viva.
        if (!isDryRun) await clearPresenceForGcRemovals(repoRoot, plan);
        const removedCount = plan.filter((e) => e.action === "removed").length;
        process.stdout.write(
          `session-registry: gc ${isDryRun ? "--dry-run: " : ""}${removedCount}/${plan.length} identidade(s) ${isDryRun ? "seriam removidas" : "removidas"}\n`,
        );
        break;
      }
      default:
        process.stderr.write(
          "uso: npx tsx scripts/lib/session-registry.ts <register|heartbeat|end|claim-issue|unclaim-issue|is-claimed|" +
            "list-active|active-of-kind|conflicts|grant-merge|check-merge-grant|consume-merge-grant|self-authorize-merge|" +
            "merge-lock-acquire|merge-lock-release|merge-lock-renew|gc> [--kind overnight|develop|continuo|interactive|continuo-review] [--session-id X] [--tag MAQUINA] ...\n" +
            "  unclaim-issue --issue N: inverso de claim-issue (#6317) — remove a issue de claimed_issues da PRÓPRIA " +
            "sessão; nunca mexe na claim de outra. No-op honesto (exit 1) se a issue não estava reivindicada por ela.\n" +
            "  active-of-kind --kind K [--session-id X]: JSON {kind, active, sessions, stale} — há sessão ATIVA " +
            "(não-stale) do kind K? `--session-id` exclui a própria sessão da resposta (#6277).\n" +
            "  --tag (só \"end\"): machineTag() da sessão a encerrar (default: machineTag() local) — necessário " +
            "pra encerrar da máquina local o registro de OUTRA máquina em data/sessions/ (#5797).\n" +
            "  --allow-dirty (só \"end\"): bypassa a recusa (#6922) — a recusa em si já só dispara quando a " +
            "sujeira intersecta touched_paths/dirty_paths da PRÓPRIA sessão; sujeira alheia de outra sessão " +
            "concorrente no mesmo checkout prossegue com aviso, nunca exit 1.\n" +
            "  conflicts [--paths a,b] [--branch X]: CONSULTA (#6168) — quem mais está mexendo nisto agora. " +
            "exit 1 = sobreposição com peer VIVO; exit 0 = livre. Nunca cria arquivo nem adquire nada.\n" +
            "  grant-merge --kind {overnight|develop|continuo} --granted-to X [--pr N] [--force]: concede janela de " +
            "merge a OUTRA sessão (#6296) — --kind é da sessão CONCEDENTE (a sua, obrigatório, #6331), nunca da " +
            "beneficiária em --granted-to; só coordenadora concede, nunca a si mesma; TTL curto, uso único. " +
            "Recusa (#7043) sobrescrever uma concessão VIVA de OUTRA identidade (sua própria ou de outra " +
            "coordenadora pro mesmo PR) — --force força a sobrescrita deliberada. " +
            "check-merge-grant é o lado de quem recebeu, pra CONFIRMAR a concessão antes de mergear. " +
            "consume-merge-grant NÃO é um passo do beneficiário (#7171) — quem carimba consumedAt é o " +
            "gh pr merge bem-sucedido, automaticamente via .claude/hooks/consume-merge-grant-on-merge.mjs; " +
            "chamar consume-merge-grant à mão ANTES do merge queima a janela e o merge seguinte é bloqueado. " +
            "Ordem correta: grant-merge (coordenadora) -> check-merge-grant -> merge-lock-acquire --pr N -> " +
            "gh pr merge N -> merge-lock-release --pr N. --pr nao e opcional na pratica (#7169/#7223) — " +
            "sem ele, gh pr merge foi bloqueado repetidamente pelo guard #5716 mesmo com lock adquirido.\n" +
            "  self-authorize-merge --reason \"...\" [--pr N] (#7303): escape hatch pra quando gh pr merge está " +
            "bloqueado e a ÚNICA coordenadora ativa é continuo (cron, não conversa — grant-merge normal é " +
            "estruturalmente inalcançável). Recusa se houver coordenadora overnight/develop ativa (peça " +
            "grant-merge dela) ou se você já for coordenadora. --reason é obrigatório. Mesma composição com o " +
            "merge lock de grant-merge — ainda precisa de merge-lock-acquire --pr N antes do gh pr merge.\n" +
            "  gc [--max-age-days N] [--dry-run]: remove registro de sessão ENCERRADA — nunca por staleness de " +
            "heartbeat sozinha, ver docstring de decideSessionGc/planSessionGc (#6130).\n",
        );
        process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(`session-registry: erro — ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
