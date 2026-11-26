/**
 * scripts/lib/sessions/registry.ts (#14004)
 *
 * Ciclo de vida da sessão: `register`, `heartbeat`, `end` (com o guard de
 * árvore suja), log de ciclo de vida, saúde da varredura e `listActiveSessions`.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { basename, join } from "node:path";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { withFileLock } from "../file-lock.ts";
import { conflictCopyBelongsToStem, isSyncConflictCopyName } from "../sync-conflict-copy.ts";
import {
  type ActiveSessionRecord,
  claimReleaseMsForKind,
  isCoordinatorKind,
  MAX_SESSION_AGE_MS,
  PREVIOUS_COORDINATOR_WINDOW_MS,
  type PreviousCoordinatorNote,
  type SessionKind,
  type SessionLifecycleEvent,
  type SessionLifecycleEventType,
  type SessionRecord,
  softStaleMsForKind,
} from "./types.ts";
import {
  breakStaleLock,
  CLOCK_SKEW_TOLERANCE_MS,
  endedAfterLastHeartbeat,
  findExistingSessionFileAnyKind,
  isOrphanBackupGroupLive,
  listSessionJsonFiles,
  machineTag,
  mergeSessionRecords,
  parseSessionFileName,
  probeSessionsDirWithWarning,
  readJsonSafe,
  readMergedRecordForRealFile,
  readOrphanBackupGroups,
  sessionFilePath,
  sessionGroupBackupPaths,
  sessionsDir,
  warnClockSkew,
  warnIoError,
  writeJsonSafe,
  writeJsonSafeWithCas,
} from "./store.ts";
import { beaconPathsOverlap, normalizeBeaconPath } from "./conflicts.ts";
import { readMergeGrantConsumptions, withLedgerConsumption } from "./merge-grant-ledger.ts";

/**
 * Loga (stderr, nunca lança) um aviso de que `registerSession` encontrou um
 * registro de OUTRO kind pra `sessionId` mas não conseguiu ler nem o arquivo
 * real nem nenhum backup dele (#6326 fleet review item 1) — cenário
 * documentado como NORMAL no OneDrive (sync no meio de um write), e mais
 * provável justamente quando o beacon escreve durante o sync. Complementa
 * (não substitui) o `outcome: "promotion-failed-unreadable"` do retorno de
 * `registerSession` — este aviso é o que fica visível a quem lê stderr
 * direto (ex: log de systemd/Task Scheduler), o `outcome` é o que fica
 * visível ao CÓDIGO que chama `registerSession` programaticamente.
 */
function warnUnreadablePromotionSource(sessionId: string, otherPath: string): void {
  try {
    process.stderr.write(
      `session-registry: aviso — encontrado um registro de OUTRO kind pra sessionId="${sessionId}" em ` +
        `"${otherPath}", mas nem o arquivo real nem nenhum backup dele foi legível (JSON corrompido/ ` +
        "parcialmente sincronizado pelo Drive) — a promoção NÃO pôde ler o conteúdo antigo. Um registro NOVO " +
        `foi criado do zero; "${otherPath}" continua em disco (outcome: "promotion-failed-unreadable").\n`,
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho fail-soft principal.
  }
}

/**
 * Desfecho de `registerSession` (#6326 fleet review item — antes desta
 * mudança, o retorno era `SessionRecord` puro e o CLI (`main()`, case
 * `register`) imprimia a MESMA mensagem nos 4 caminhos genuinamente
 * distintos que a função pode tomar — inclusive `"promoted-orphan-left"`,
 * que é literalmente o bug que a #6326 existe pra consertar voltando em
 * silêncio caso o `rmSync` do arquivo antigo falhe). Mesmo padrão de
 * `ClaimIssueReason`/`claimIssueCheckAndSet` — união discriminada em vez de
 * um booleano ou só prosa no comentário.
 *
 * - `"created"` — nenhum registro existia (nem no path do kind atual, nem
 *   sob outro kind) pra este `sessionId`; registro novo do zero.
 * - `"reregistered"` — já havia registro no path do KIND ATUAL; caminho
 *   idempotente de sempre (#6294/#6303), sem promoção envolvida.
 * - `"promoted"` — encontrou e leu um registro de OUTRO kind, promoveu com
 *   sucesso (novo path gravado, antigo removido). O caso feliz do #6326.
 * - `"promoted-orphan-left"` — encontrou e leu um registro de OUTRO kind, o
 *   novo path foi gravado, mas a remoção do antigo FALHOU (I/O transitório
 *   do OneDrive, ou o arquivo persistiu depois do `rmSync` "bem-sucedido").
 *   O órfão fica em disco — `planSessionGc` recolhe depois, mas só quando
 *   ficar legível/o `pid` gravado nele não estiver mais vivo (ver ressalva
 *   no docblock de `registerSession`).
 * - `"promotion-failed-unreadable"` — encontrou um arquivo de OUTRO kind
 *   pelo NOME, mas nem ele nem nenhum backup dele foi legível — a promoção
 *   não pôde acontecer. Registro novo criado do zero mesmo assim (decisão:
 *   deixar a sessão sem registro nenhum seria pior — ver docblock de
 *   `warnUnreadablePromotionSource`). O arquivo ilegível antigo fica em
 *   disco, órfão.
 */
export type RegisterSessionOutcome =
  | "created"
  | "reregistered"
  | "promoted"
  | "promoted-orphan-left"
  | "promotion-failed-unreadable";

export interface RegisterSessionResult {
  record: SessionRecord;
  outcome: RegisterSessionOutcome;
  /** Path do arquivo de OUTRO kind encontrado pra este `sessionId` — presente
   * em `"promoted"`, `"promoted-orphan-left"` e `"promotion-failed-unreadable"`,
   * ausente em `"created"`/`"reregistered"`. */
  promotedFrom?: string;
  /**
   * #13596: kind do registro de onde a sessão veio na promoção (lido do
   * conteúdo, ou do prefixo do nome `{kind}-{tag}-{id}.json` quando o conteúdo
   * está ilegível). Presente junto de `promotedFrom` quando dá para saber. O
   * `register` CLI usa para apagar a presença no D1 quando a sessão perde a
   * autoridade de merge (overnight/develop rebaixada a continuo/interactive).
   */
  previousKind?: string;
}

/**
 * Primitiva de I/O usada só pela remoção do arquivo ANTIGO na promoção de
 * kind de `registerSession` (#6326 fleet review — teste obrigatório
 * "rmSync falhando"). Injetável pra teste, mesmo padrão de `MergeLockIo`
 * (usado por `acquireMergeLock` mais abaixo neste módulo) — sem isto não dá
 * pra simular uma falha de remoção de forma determinística e PORTÁVEL:
 * monkey-patchar `require("node:fs").rmSync` não intercepta o
 * `import { rmSync } from "node:fs"` que este módulo usa de verdade (são
 * bindings distintos — confirmado experimentalmente), e forçar uma falha
 * REAL de sistema operacional (lock de arquivo aberto, permissão) é frágil
 * entre plataformas — mesma classe de problema que já deixa o teste de
 * `checkSessionsScanHealth` via `chmod` quebrado no Windows (ver nota no
 * teste correspondente). O default (`REAL_PROMOTION_REMOVE_IO`) usa
 * `node:fs` de verdade; testes injetam um `remove` que lança.
 */
export interface PromotionRemoveIo {
  exists: (path: string) => boolean;
  remove: (path: string) => void;
}

const REAL_PROMOTION_REMOVE_IO: PromotionRemoveIo = {
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path),
};

/**
 * Registra uma sessão ativa. Idempotente — chamar de novo com o mesmo
 * kind/tag/sessionId atualiza o registro (mesmo padrão de `startSession` em
 * `overnight-session-marker.ts`).
 *
 * **#6294 — re-registrar NÃO apaga mais `claimed_issues`.** Até aqui esta
 * função montava o record do zero com `claimed_issues: []`, então não existia
 * caminho suportado pra corrigir um campo (`pid`, tipicamente) sem destruir as
 * claims em voo: uma sessão com 12 issues reivindicadas que rodasse `register`
 * de novo — que é literalmente o que `BLOCK_REASON` do #5716 sugere a quem se
 * vê bloqueado por engano — perdia as 12 em silêncio, liberando-as pra outras
 * sessões no meio do trabalho. Agora o re-registro PRESERVA `claimed_issues`,
 * `startedAt` e os campos de beacon do registro anterior, e só sobrescreve o
 * que foi passado explicitamente. Registro novo (nenhum arquivo anterior)
 * continua nascendo com `claimed_issues: []`, comportamento inalterado.
 *
 * **#6326 — PROMOVE um registro pré-existente de OUTRO kind pro kind novo,
 * quando consegue ler o conteúdo antigo.** Se não há arquivo no path do kind
 * sendo registrado, mas existe um registro REAL pra este `sessionId` sob
 * outro kind (tipicamente `interactive`, criado pelo beacon antes desta
 * chamada — ver `findExistingSessionFileAnyKind`), a sessão de fato VIROU
 * `kind` ao rodar `register`: o registro passa a viver no path do kind novo
 * (preservando `startedAt`/`claimed_issues`/campos de beacon já acumulados,
 * inclusive os que só existiam num `-safeBackup-` do registro antigo).
 *
 * **Garantia real (#6326 fleet review item 2 — a versão anterior deste
 * parágrafo prometia "nunca sobra um par", que o código não cumpria):** no
 * caminho feliz (arquivo antigo legível E remoção bem-sucedida — `outcome:
 * "promoted"`), de fato nunca sobra um par `{kind-antigo}-{tag}-{sessionId}.json`
 * + `{kind-novo}-{tag}-{sessionId}.json` simultâneo. Mas a remoção é
 * BEST-EFFORT (`rmSync` num `try/catch` — falha de I/O transitória do
 * OneDrive nunca lança) e a leitura do conteúdo antigo pode falhar (JSON
 * corrompido/parcialmente sincronizado) — os dois desfechos de falha
 * (`"promoted-orphan-left"`, `"promotion-failed-unreadable"`, ver
 * `RegisterSessionOutcome`) DEIXAM um arquivo órfão do kind antigo em disco,
 * com heartbeat congelado a partir de agora. Esse órfão é recolhido depois
 * por `planSessionGc`, mas só quando (a) ficar legível — GC nunca remove
 * estado que não consegue interpretar — E (b) o `pid` gravado nele (herdado
 * do registro antigo — ver #6326 fleet review item 5b) não estiver mais
 * vivo na máquina local, OU a checagem rodar de outra máquina, onde a janela
 * conservadora de 2h (`GC_INTERACTIVE_MAX_AGE_MS`) decide.
 *
 * Promover (e não só ignorar) importa porque é o que
 * `isCoordinatorKind`/`COORDINATOR_SESSION_KINDS` leem (guard do #5716) — o
 * kind precisa refletir que a sessão é coordenadora agora. O desfecho de
 * CADA chamada é observável via `RegisterSessionResult.outcome` — ver ali
 * pros 5 caminhos possíveis.
 */
export function registerSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  meta: { pid?: number; tag?: string; startedAt?: string; attended?: boolean } = {},
  removeIo: PromotionRemoveIo = REAL_PROMOTION_REMOVE_IO,
): RegisterSessionResult {
  const tag = meta.tag ?? machineTag();
  const now = meta.startedAt ?? new Date().toISOString();
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  let previous = readJsonSafe<SessionRecord>(path);
  const hadOwnFile = previous !== null;

  // #6326: sem registro no path do KIND ATUAL, procurar (e promover) um
  // registro pré-existente da MESMA sessão sob OUTRO kind — ver docstring
  // acima. `otherPath !== path` evita o caso degenerado de um arquivo
  // corrompido no PRÓPRIO path (readJsonSafe já devolveu null pra ele
  // acima) ser "promovido" pra si mesmo e depois removido por engano.
  let promotedFrom: string | null = null;
  let unreadablePromotionSource: string | null = null;
  if (!previous) {
    const otherPath = findExistingSessionFileAnyKind(repoRoot, sessionId);
    if (otherPath && otherPath !== path) {
      const merged = readMergedRecordForRealFile(repoRoot, otherPath);
      if (merged) {
        previous = merged;
        promotedFrom = otherPath;
      } else {
        // #6326 fleet review item 1: `otherPath` EXISTE (achado pelo NOME em
        // `findExistingSessionFileAnyKind`), mas nem ele nem nenhum backup
        // foi legível. Decisão (a), não (b): AVISAR alto e seguir criando o
        // registro novo do zero, em vez de recusar e deixar a sessão SEM
        // registro nenhum — (b) trocaria um bug de contagem dupla/órfão
        // (recuperável: o arquivo antigo pode ficar legível numa chamada
        // futura, ou o GC eventualmente o recolhe) por um buraco de
        // visibilidade TOTAL, estritamente pior pros consumidores que
        // dependem de `listActiveSessions` (claim de issue, merge lock,
        // exclusão overnight×contínuo).
        unreadablePromotionSource = otherPath;
        warnUnreadablePromotionSource(sessionId, otherPath);
      }
    }
  }

  // #6952: CAS em vez de read-modify-write solto. O beacon reescreve este
  // arquivo a cada chamada de ferramenta — um `...previous` congelado no
  // momento acima apagaria um `merge_grant`/`claimed_issues` que o beacon
  // gravou entre o read inicial e o write (lost update). Dentro do lock,
  // re-deriva `record` do estado FRESCO em disco (`current`), caindo pro
  // `previous` promovido só quando `current` é nulo (arquivo não existe na
  // janela de lock — caso de promoção).
  let record: SessionRecord = {} as SessionRecord;
  writeJsonSafeWithCas(
    path,
    (current) => {
      const base: Partial<SessionRecord> = current ?? previous ?? {};
      record = {
        ...base,
        kind,
        machineTag: tag,
        sessionId,
        // `startedAt` do registro ORIGINAL é preservado — re-registrar (ou
        // promover de outro kind) não rejuvenesce a sessão (senão um
        // `register` de correção zeraria a idade que
        // `planSessionGc`/`listActiveSessions` usam pra decidir staleness).
        startedAt: base.startedAt ?? now,
        lastHeartbeat: now,
        claimed_issues: base.claimed_issues ?? [],
      };
      if (meta.pid !== undefined) {
        record.pid = meta.pid;
      }
      // #7546 — `attended` sempre recomputado nesta chamada quando o
      // chamador passa `meta.attended` explícito (CLI `register` sempre
      // passa, derivado de `--unattended`/kind); só cai pro valor
      // preservado (`base.attended`, herdado de um registro/promoção
      // anterior) ou pro default por kind quando nenhum dos dois existe —
      // nunca deixa o campo definitivamente ausente pra um kind que precisa
      // dele (`continuo`, ver docstring do campo em `SessionRecord`).
      record.attended = meta.attended ?? base.attended ?? kind !== "continuo";
      // #6326 fleet review item 5b (decisão registrada, não "corrigida" — ambas
      // as opções são defensáveis, esta é a escolhida): quando a promoção
      // sucede e `--pid` NÃO foi passado a ESTA chamada, o `pid` do registro
      // ANTIGO (herdado via `...base` acima, tipicamente `process.ppid`
      // gravado pelo beacon — ver #6160) é PRESERVADO, não limpo.
      // Justificativa: é o pid da MESMA sessão Claude Code (beacon e skill
      // compartilham `process.ppid`/o processo pai), então continua correto —
      // e é exatamente o sinal que o branch 3 de `decideSessionGc` usa pra
      // nunca remover um registro de sessão viva (ver docblock acima). Limpar
      // aqui destruiria esse sinal de liveness sem necessidade.
      return record;
    },
    (onDisk) =>
      onDisk?.sessionId === sessionId &&
      onDisk?.kind === kind &&
      onDisk?.machineTag === tag &&
      onDisk?.lastHeartbeat === now,
  );

  if (unreadablePromotionSource) {
    const parsedKind = parseSessionFileName(basename(unreadablePromotionSource))?.kind;
    return {
      record,
      outcome: "promotion-failed-unreadable",
      promotedFrom: unreadablePromotionSource,
      ...(parsedKind !== undefined ? { previousKind: parsedKind } : {}),
    };
  }
  // #13596: kind de onde a sessão veio, para o `register` CLI reconciliar a presença no D1.
  const previousKind = promotedFrom
    ? (typeof previous?.kind === "string" ? previous.kind : parseSessionFileName(basename(promotedFrom))?.kind)
    : undefined;

  if (promotedFrom) {
    // #7028: carimba `endedAt` no CONTEÚDO do registro antigo ANTES de
    // tentar removê-lo — belt-and-suspenders pro caso (best-effort, como o
    // `rmSync` abaixo) de a remoção falhar e o arquivo permanecer em disco.
    // Sem isto, um órfão `promoted-orphan-left` ficava indistinguível de uma
    // sessão genuinamente viva pros leitores (`dedupeBySessionId`,
    // `listActiveSessions`) até `SOFT_STALE_MS` (90min) expirar — achado ao
    // vivo #7028: uma sessão `overnight` promovida de volta pra `interactive`
    // (o `sessionId` sobrevive à mudança, o harness preserva a conversa)
    // deixou o registro `overnight` antigo congelado no heartbeat da
    // promoção, e ele continuou contando como COORDENADOR ATIVO — o guard do
    // #5716 lê exatamente esse sinal pra bloquear merge cross-máquina.
    // `writeJsonSafe` usa `node:fs` de verdade (não o `removeIo` injetável,
    // que só existe pra simular falha de `rmSync` em teste) — se a stampagem
    // em si falhar (I/O), cai no catch e segue pro rmSync normalmente; nunca
    // lança, nunca aborta a promoção.
    try {
      if (removeIo.exists(promotedFrom)) {
        writeJsonSafe(promotedFrom, { ...previous, endedAt: now });
      }
    } catch (e) {
      warnIoError(promotedFrom, e);
    }
    // Best-effort: o record novo já foi gravado com sucesso acima.
    // `existsSync` antes do `rmSync` (mesmo padrão de
    // `garbageCollectSessions` abaixo) evita um warning espúrio no caso
    // benigno de o arquivo já ter sumido entre a busca e aqui (ex: um `gc`
    // concorrente). Qualquer OUTRA falha de I/O (transitório do OneDrive) é
    // logada, nunca lançada — e o desfecho fica visível via `outcome:
    // "promoted-orphan-left"` (#6326 fleet review — antes disto o retorno
    // não distinguia isso de uma promoção limpa).
    let removed = true;
    try {
      if (removeIo.exists(promotedFrom)) removeIo.remove(promotedFrom);
      if (removeIo.exists(promotedFrom)) removed = false; // remove "teve sucesso" mas o arquivo persiste (raro, ex: lock de outro processo)
    } catch (e) {
      removed = false;
      warnIoError(promotedFrom, e);
    }
    return {
      record,
      outcome: removed ? "promoted" : "promoted-orphan-left",
      promotedFrom,
      ...(previousKind !== undefined ? { previousKind } : {}),
    };
  }

  return { record, outcome: hadOwnFile ? "reregistered" : "created" };
}

/**
 * Atualiza `lastHeartbeat` (+ um patch opcional de `phase`/`active_worktrees`)
 * de uma sessão já registrada. Retorna `false`, nunca lança, quando não há
 * sessão pra atualizar (nunca registrada, já encerrada, ou JSON corrompido).
 *
 * **`overnight`/`develop` nunca chamam esta função diretamente — e isso é
 * esperado, não um buraco (#6327).** `lastHeartbeat` dessas duas sessões
 * coordenadoras é mantido por um mecanismo DIFERENTE: `.claude/hooks/
 * session-beacon.mjs` (`PreToolUse`, #6303) escreve no registro EXISTENTE da
 * sessão (via `findExistingSessionFile`) a cada chamada de ferramenta,
 * atualizando `lastHeartbeat` como efeito colateral — sem que a skill precise
 * chamar `heartbeat` em lugar nenhum. Só `continuo` chama este export direto
 * (2 call sites hoje). A garantia efetiva pras 3: `lastHeartbeat` de QUALQUER
 * sessão viva fica fresco enquanto ela roda QUALQUER ferramenta (Bash, Edit,
 * Write, NotebookEdit — o matcher do hook), automaticamente.
 *
 * **Isto era falso até o #6303, e uma docstring desatualizada (a versão
 * anterior deste comentário, e trechos de `decideSessionGc` acima) continuou
 * descrevendo o estado pré-#6303 depois que o beacon já tinha fechado o
 * buraco — o #6327 é a correção.** Medido ao vivo em 26/08/2026: uma sessão
 * `develop` com 171min de vida tinha heartbeat de 0min; uma `overnight` com
 * 246min tinha heartbeat de 4min — nenhuma das duas jamais chamou
 * `heartbeat` neste módulo.
 *
 * **O acoplamento é implícito e vale a pena nomear (contra-argumento honesto
 * do #6327, não varrido):** um mecanismo de OBSERVABILIDADE (o beacon) virou
 * pré-requisito de um mecanismo de CORREÇÃO (claim válida — `SOFT_STALE_MS`
 * só destrava issue de sessão morta se o heartbeat de fato parar). Isso
 * quebra em SILÊNCIO se o beacon for desligado (`.claude/settings.json`),
 * reduzido em frequência, ou não rodar por algum dos guards dele (worktree
 * vinculado, `data/` ausente) — nesses casos `lastHeartbeat` volta a
 * congelar em `startedAt` e `SOFT_STALE_MS` volta a ser o único sinal, exatamente
 * como era antes do #6303, sem nenhum alarme dedicado pra essa regressão.
 * `test/session-beacon-hook.test.ts` (describe "#6327") trava que o beacon
 * atualiza `lastHeartbeat` de um registro de kind COORDENADOR (não só
 * `interactive`) — é o que impede reduzir/desligar o beacon de virar uma
 * mudança silenciosamente perigosa.
 *
 * **Decisão registrada (#6327 critério de aceite 4) — sessão coordenadora
 * rodando de WORKTREE VINCULADO:** o beacon pula de propósito quando o
 * próprio processo está num worktree vinculado (`isLinkedWorktree`, #6303
 * blast radius 3 — existe pra não registrar SUBAGENTES implementadores, que
 * sempre rodam com `isolation: "worktree"`). Isso também bloquearia o
 * heartbeat de uma coordenadora que, por algum motivo, rodasse a partir de um
 * worktree em vez do checkout principal. **Decisão: aceitável ficar stale
 * nesse caso, sem heartbeat por caminho alternativo.** Três razões: (1) por
 * convenção do repo (`context/overnight-dispatch-rules.md` item 11, "o
 * coordenador precisa ver o diff FINAL... existe fora do worktree do
 * subagente de propósito" — item 3, "Bootstrap do worktree", descreve a
 * mesma premissa em prosa mais indireta), worktree é SEMPRE do subagente
 * implementador — a coordenadora roda no checkout principal; uma
 * coordenadora em worktree vinculado é configuração fora do padrão
 * documentado, não o caso comum a otimizar; (2) o fallback já existe e
 * é seguro: `SOFT_STALE_MS` (90min) volta a valer sozinho, exatamente como
 * antes do #6303 — nenhuma claim fica presa pra sempre, só demora até 90min
 * a mais pra destravar; (3) adicionar um call site de `heartbeat` só pra esse
 * caso reabriria o próprio argumento do #6168 que motivou o beacon existir
 * ("o que depende de skill lembrar, não acontece") — pra um cenário que hoje
 * não tem instância real conhecida.
 */
export function heartbeat(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {},
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!readJsonSafe<SessionRecord>(path)) return false;
  // #6952: CAS em vez de read-modify-write solto — o beacon (mesmo arquivo)
  // pode reescrever o record enquanto este heartbeat tenta gravar, e um
  // `...current` congelado apagaria o `merge_grant`/`claimed_issues` dele.
  writeJsonSafeWithCas(
    path,
    (current) => {
      // Já confirmamos acima que o registro existe. Se ele sumiu entre aquela
      // leitura e o lock (`end` concorrente), LANÇAR é o certo: recriar aqui a
      // partir de um `{}` produziria um registro sem `kind`/`sessionId`, que é
      // pior que a falha visível.
      if (!current) throw new Error("heartbeat: sessão sumiu entre a leitura e a escrita");
      return { ...current, ...patch, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.lastHeartbeat === now,
  );
  return true;
}

/** #10618 — `claimed_foreign_issues` (e o histórico) pro evento de lifecycle;
 * `{}` quando a sessão nunca reivindicou fora do repo default. */
export function snapshotForeignClaims(record: SessionRecord): {
  claimed_foreign_issues?: string[];
  claimed_foreign_issues_ever?: string[];
} {
  const finals = Array.isArray(record.claimed_foreign_issues)
    ? record.claimed_foreign_issues.filter((x): x is string => typeof x === "string")
    : [];
  const ever = Array.isArray(record.claimed_foreign_issues_ever)
    ? record.claimed_foreign_issues_ever.filter((x): x is string => typeof x === "string")
    : [];
  if (finals.length === 0 && ever.length === 0) return {};
  return {
    claimed_foreign_issues: [...new Set(finals)].sort(),
    claimed_foreign_issues_ever: [...new Set([...ever, ...finals])].sort(),
  };
}

/** #8521 — cópia ordenada/deduplicada de `claimed_issues` pro evento de
 * lifecycle; tolera campo ausente ou com lixo (nunca lança). */
export function snapshotClaimedIssues(record: SessionRecord): number[] {
  const raw = Array.isArray(record.claimed_issues) ? record.claimed_issues : [];
  return [...new Set(raw.filter((n): n is number => Number.isInteger(n)))].sort((a, b) => a - b);
}

/** #8521 — histórico de claims (ever ∪ finais). */
export function snapshotClaimedIssuesEver(record: SessionRecord): number[] {
  const ever = Array.isArray(record.claimed_issues_ever) ? record.claimed_issues_ever : [];
  return [...new Set([...ever, ...snapshotClaimedIssues(record)].filter((n): n is number => Number.isInteger(n)))].sort(
    (a, b) => a - b,
  );
}

export function sessionLifecycleLogPath(repoRoot: string): string {
  return join(repoRoot, "data", "session-lifecycle.jsonl");
}

/** Best-effort, nunca lança — instrumentação não pode derrubar o caminho
 * principal de `endSession`/`garbageCollectSessions`. `data/` ausente (sessão
 * cloud/clone fresco) é um no-op silencioso, mesma disciplina fail-soft do
 * resto do módulo. */
export function logSessionLifecycleEvent(repoRoot: string, event: SessionLifecycleEvent): void {
  try {
    const dataDir = join(repoRoot, "data");
    if (!existsSync(dataDir)) return;
    appendFileSync(sessionLifecycleLogPath(repoRoot), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // best-effort — nunca propaga.
  }
}

/**
 * Lê `data/session-lifecycle.jsonl` (#11299). Fail-soft: arquivo ausente ou
 * ilegível vira `[]`, linha corrompida é pulada — a leitura alimenta só a nota
 * diagnóstica de `list-active`, nunca uma decisão.
 */
export function readSessionLifecycleEvents(repoRoot: string): SessionLifecycleEvent[] {
  let raw: string;
  try {
    raw = readFileSync(sessionLifecycleLogPath(repoRoot), "utf8");
  } catch {
    return [];
  }
  const out: SessionLifecycleEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SessionLifecycleEvent;
      if (ev && typeof ev.sessionId === "string" && typeof ev.ts === "string" && typeof ev.kind === "string") {
        out.push(ev);
      }
    } catch {
      // linha corrompida (append concorrente via OneDrive) — pula.
    }
  }
  return out;
}

/**
 * #11299 — anota cada sessão `interactive` cujo `sessionId` teve, nas últimas
 * `windowMs`, um evento de fim de rodada COORDENADORA no log de lifecycle
 * (o mais recente vence). Pura: não lê disco. Só considera eventos com `ts`
 * até `startedAt` do registro interativo + tolerância de clock skew — um
 * `end` posterior ao nascimento do interativo não o explica.
 */
export function annotatePreviousCoordinator<T extends { kind: SessionKind; sessionId: string; startedAt: string }>(
  sessions: T[],
  events: SessionLifecycleEvent[],
  now: number = Date.now(),
  windowMs: number = PREVIOUS_COORDINATOR_WINDOW_MS,
): (T & { previous_coordinator?: PreviousCoordinatorNote })[] {
  return sessions.map((s) => {
    if (s.kind !== "interactive") return s;
    const bornMs = Date.parse(s.startedAt);
    let best: SessionLifecycleEvent | undefined;
    let bestMs = -Infinity;
    for (const ev of events) {
      if (ev.sessionId !== s.sessionId || !isCoordinatorKind(ev.kind)) continue;
      const evMs = Date.parse(ev.ts);
      if (!Number.isFinite(evMs) || now - evMs > windowMs || evMs - now > CLOCK_SKEW_TOLERANCE_MS) continue;
      if (Number.isFinite(bornMs) && evMs - bornMs > CLOCK_SKEW_TOLERANCE_MS) continue;
      if (evMs > bestMs) {
        best = ev;
        bestMs = evMs;
      }
    }
    if (!best) return s;
    const note: PreviousCoordinatorNote = { kind: best.kind, event: best.event, endedAt: best.ts };
    if (best.startedAt !== undefined) note.startedAt = best.startedAt;
    if (Array.isArray(best.claimed_issues_ever)) note.claimed_issues_ever = best.claimed_issues_ever;
    return { ...s, previous_coordinator: note };
  });
}

/**
 * Remove o registro de uma sessão. Idempotente — no-op se já ausente.
 *
 * Retorna `true` quando um registro de fato existia e foi removido, `false`
 * quando não havia nada pra remover (#5797) — distinção que o CLI (`main()`,
 * caso `end`) usa pra nunca reportar sucesso quando nada aconteceu. Antes do
 * #5797 o retorno era `void`: o CLI sempre imprimia "ended" mesmo quando
 * `--tag`/`--session-id` não batiam com nenhum arquivo em disco (ex: tentar
 * encerrar da máquina local o registro de outra máquina sem passar `--tag`
 * explicitamente — `tag` aqui default pra `machineTag()` local, então sem a
 * flag o path procurado nunca é o da outra máquina).
 *
 * #6624: quando `kind` é coordenador (`COORDINATOR_SESSION_KINDS`), registra
 * um evento `"ended"` no log de ciclo de vida — instrumentação, nunca afeta
 * o retorno nem lança. #10020: `opts.lifecycleEvent` troca o evento para
 * `"swept-without-end"` quando quem encerra não é a própria sessão (sweep de
 * ticks órfãos do contínuo).
 *
 * **#6952 (achado do review da PR): a remoção também entra no lock.** Todo
 * ESCRITOR do registro passou a serializar em `{path}.lock`, mas o REMOVEDOR
 * tinha ficado de fora — e remover é escrever. Sem o lock, esta sequência
 * ressuscita um registro encerrado de propósito:
 *
 *   t0  um CAS (heartbeat/claim/beacon) lê `current` DENTRO do lock
 *   t1  endSession apaga o arquivo, sem lock nenhum
 *   t2  o CAS grava — e recria o arquivo que acabou de ser encerrado
 *
 * O gatilho é banal: o beacon da sessão dispara a cada chamada de ferramenta,
 * inclusive na última antes de a sessão terminar, então o heartbeat final e o
 * `end` competem por construção. Um registro ressuscitado é pior que um
 * heartbeat perdido — ele volta a aparecer em `list-active`, segura as claims
 * dele, e só sai no GC seguinte.
 *
 * Um timeout de lock aqui PROPAGA (não vira `false`): "não consegui garantir
 * a remoção" e "não havia nada pra remover" são estados diferentes, e o CLI
 * distingue os dois — o `main()` transforma o throw em erro nomeado com exit
 * 1, em vez de imprimir "nothing to end" pra uma remoção que não aconteceu.
 *
 * **`breakStaleLock` ANTES de adquirir (achado do 4º review).** Pegar o lock
 * sem quebrar o órfão reabre, neste call site, exatamente o modo de falha que
 * `STALE_LOCK_MS` existe pra eliminar: com um `.lock` deixado por um processo
 * que morreu segurando-o, o `end` gasta o timeout inteiro e LANÇA, e o
 * registro da sessão sobrevive pra sempre. Reproduzido: 10s e `exit 1`, com o
 * arquivo intacto.
 *
 * Aqui isso é mais grave que nos outros escritores, e por isso a checagem é
 * obrigatória e não conveniência: `end` é a ÚLTIMA operação sobre este
 * arquivo. Os demais se autocurariam na escrita seguinte — aqui não há
 * escrita seguinte, e `end` é o passo final obrigatório de toda rodada
 * overnight/develop/contínuo. O gatilho também não é hipotético: o binário do
 * Claude Code quebrou 9× num único dia, e morrer segurando o lock é
 * precisamente como o órfão nasce.
 *
 * Sem laço de retry, diferente do `writeJsonSafeWithCas`: uma quebra de órfão
 * basta pro caso órfão, e contenção real com um escritor VIVO deve mesmo
 * esperar os 10s e falhar de forma visível — não há o que reconciliar numa
 * remoção.
 *
 * **Quem chama isto deve ter feito todas as recusas ANTES.** A primeira coisa
 * que esta função faz é quebrar lock órfão, que é destrutivo sobre estado
 * compartilhado; um guard avaliado depois já não tem como desfazer isso. Ver
 * o comentário de ordem no caso `end` do CLI.
 */
export function endSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  tag: string = machineTag(),
  // Só pra teste: o caso "lock VIVO é respeitado" precisa ESPERAR o timeout
  // estourar pra provar que a quebra é por IDADE e nunca incondicional, e
  // esperar os 10s de produção custava 10s de wall-clock na suíte — o
  // suficiente, somado aos outros testes de lock, pra estourar o orçamento de
  // 300s do batch do runner paralelo (medido: o batch de 150 arquivos que
  // contém estes testes passou a dar ETIMEDOUT). Produção nunca passa este
  // argumento.
  lockTimeoutMs: number = 10_000,
  // #10020: qual evento de lifecycle registrar. Default `"ended"` (o fim
  // limpo, chamado pela própria sessão); o sweep de órfãos do contínuo passa
  // `"swept-without-end"` — encerrar em nome de uma sessão morta não é "ela
  // chamou end", e registrar como tal apagava a taxa de falha do relatório.
  opts: { lifecycleEvent?: Extract<SessionLifecycleEventType, "ended" | "swept-without-end"> } = {},
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!existsSync(path)) return false;
  // #7002: os paths das cópias de conflito do grupo são resolvidos ENQUANTO o
  // arquivo real ainda existe — `sessionGroupBackupPaths` casa backup→real por
  // stem REAL EXISTENTE, então depois do `rmSync` abaixo elas viram órfãs e o
  // mesmo cálculo devolveria lista vazia.
  const groupBackupPaths = sessionGroupBackupPaths(repoRoot, path);
  breakStaleLock(`${path}.lock`);
  // #6624 × #6952: a leitura do registro pra instrumentação acontece DENTRO
  // do lock, junto da remoção — lida fora, o `startedAt` poderia vir de um
  // registro que outro escritor já trocou entre a leitura e o `rmSync`. O
  // EVENTO é emitido depois de soltar o lock: é append num arquivo diferente,
  // não precisa da exclusão do registro, e prender o lock por ele alongaria a
  // janela da única operação que não tem escrita seguinte pra se autocurar.
  const outcome = withFileLock<{ removed: boolean; record: SessionRecord | null }>(`${path}.lock`, () => {
    // Re-checa DENTRO do lock: outro `end`/GC concorrente pode ter removido
    // entre o `existsSync` acima e a aquisição.
    if (!existsSync(path)) return { removed: false, record: null };
    const record = isCoordinatorKind(kind) ? readJsonSafe<SessionRecord>(path) : null;
    rmSync(path);
    return { removed: true, record };
  }, lockTimeoutMs);
  if (outcome.removed) {
    // #7002: carimba `endedAt` em cada cópia de conflito do grupo. É o que
    // torna "encerrada limpo" DISTINGUÍVEL de "o arquivo real sumiu com a
    // sessão viva" — as duas produzem a mesma forma em disco (backup sem
    // real), e `readMergedSessionGroups` promove a segunda de volta a sessão
    // ativa. Sem este carimbo, toda sessão que encerra com cópia de conflito
    // no disco ressuscitaria por até `SOFT_STALE_MS` (90min), com as claims
    // dela bloqueando outras sessões — o falso-POSITIVO simétrico ao bug que
    // a promoção conserta.
    //
    // Reescrita cirúrgica de UM campo por cópia (molde do `unclaimIssue`/
    // `consumeMergeGrant`), best-effort e isolada por cópia: uma que falhe
    // nunca impede o carimbo das demais, e o `end` em si já aconteceu.
    const endedAt = new Date().toISOString();
    for (const backupPath of groupBackupPaths) {
      try {
        if (!existsSync(backupPath)) continue;
        writeJsonSafeWithCas(
          backupPath,
          (current) => {
            if (!current) throw new Error("endSession: backup sumiu entre a leitura e a escrita");
            return { ...current, endedAt };
          },
          (onDisk) => Boolean(onDisk?.endedAt),
        );
      } catch {
        // Cópia ilegível/exaurida: o GC recolhe depois (`planSessionGc` já
        // trata backup órfão), e a promoção do #7002 só a ressuscitaria
        // enquanto o heartbeat dela ainda estivesse dentro da janela de
        // liveness — janela curta, dano limitado, nunca motivo pra `end`
        // falhar.
      }
    }
  }
  if (outcome.record) {
    const now = Date.now();
    const startedMs = Date.parse(outcome.record.startedAt ?? "");
    logSessionLifecycleEvent(repoRoot, {
      event: opts.lifecycleEvent ?? "ended",
      kind,
      machineTag: tag,
      sessionId,
      ts: new Date(now).toISOString(),
      ageMs: Number.isFinite(startedMs) ? now - startedMs : undefined,
      startedAt: outcome.record.startedAt ?? null,
      lastHeartbeat: outcome.record.lastHeartbeat ?? null,
      claimed_issues: snapshotClaimedIssues(outcome.record),
      claimed_issues_ever: snapshotClaimedIssuesEver(outcome.record),
      ...snapshotForeignClaims(outcome.record),
    });
  }
  return outcome.removed;
}

/**
 * Resultado de `checkRepoTreeClean` — árvore limpa ou lista de linhas de
 * `git status --porcelain` (uma por caminho sujo).
 */
export interface RepoTreeCleanResult {
  clean: boolean;
  files: string[];
}

/**
 * Roda `git status --porcelain` em `repoRoot` e reporta se a árvore está
 * limpa (#6922). Existe pra dar ao CLI `end` (ver `evaluateEndGuard` abaixo)
 * um jeito MECÂNICO de checar a regra que já estava em prosa no `SKILL.md`
 * de `/diaria-continuo` ("nunca encerrar deixando trabalho não commitado em
 * `master` no checkout compartilhado") — a prosa sozinha não bastou: um tick
 * relatou "concluído" em 26/08 com trabalho solto no checkout, e a mesma
 * classe se repetiu em 01/09 (498 linhas da #6952 nunca commitadas, nunca
 * enviadas, sem PR — ver #6922, comentário de 01/09 21:45 BRT). Nas duas
 * ocorrências o `end` do tick não encontrou nenhum obstáculo — a única
 * defesa era o modelo lembrar de rodar `git status` por conta própria antes
 * de encerrar.
 *
 * Fail-soft: se o comando `git` falhar (não é repo git, git indisponível,
 * timeout) devolve `clean: true` — mesma direção de falha de
 * `resolveRepoRoot` acima (nunca bloquear por causa de uma checagem que não
 * rodou, só por uma que rodou e achou sujeira de verdade).
 */
export function checkRepoTreeClean(repoRoot: string): RepoTreeCleanResult {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true, // #13559: chamado também do waiter destacado, sem console
    });
    if (res.status !== 0) return { clean: true, files: [] };
    const files = (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return { clean: files.length === 0, files };
  } catch {
    return { clean: true, files: [] };
  }
}

/**
 * Resultado de `evaluateEndGuard` — se o `end` pode prosseguir, e a mensagem
 * de recusa (só presente quando `ok: false`) pro CLI imprimir. `warning`
 * carrega um aviso informativo (stderr) quando o `end` PROSSEGUE apesar de
 * sujeira alheia — nunca aborta, só avisa (#6922 reaberto).
 */
export interface EndGuardResult {
  ok: boolean;
  message?: string;
  warning?: string;
}

/**
 * Extrai o caminho de cada linha de `git status --porcelain` (formato
 * `XY caminho` ou `XY orig -> novo` pra renames — usa o lado NOVO). Best-effort:
 * uma linha em formato inesperado é devolvida como está, o pior caso é uma
 * interseção que não casa (fail-direction segura — vira "sujeira alheia" e
 * o `end` avisa em vez de recusar, nunca o contrário).
 */
export function extractPorcelainPath(line: string): string {
  const indexStatus = line[0]; // rename/copy só é sinalizado na coluna X (índice)
  const body = line.slice(3); // remove "XY " (2 chars de status + 1 espaço)
  // " -> " só separa orig/novo em rename (R) ou copy (C) — um arquivo comum
  // (M, ??, etc.) cujo nome real contenha esse literal não deve ser cortado.
  if (indexStatus !== "R" && indexStatus !== "C") return body;
  // lastIndexOf, não indexOf: cobre o caso raro em que o nome ORIGINAL do
  // rename/copy também contém o literal " -> " (ex: `git mv "a -> b.txt" c.txt`
  // vira `R  a -> b.txt -> c.txt`) — o lado novo é sempre o último segmento.
  const arrowIdx = body.lastIndexOf(" -> ");
  return arrowIdx === -1 ? body : body.slice(arrowIdx + 4);
}

/**
 * Guard chamado pelo CLI `end` ANTES de remover o registro da sessão
 * (#6922, revisado — ver comentário de 01/09 sobre a fail-direction
 * invertida). Recusa encerrar o tick **só quando a sujeira do checkout
 * compartilhado é atribuível à PRÓPRIA sessão** (interseção entre
 * `git status --porcelain` e os `touched_paths`/`dirty_paths` que o beacon
 * desta sessão já registrou) — força o commit/push/stash a acontecer (ou o
 * `--allow-dirty` explícito) só nesse caso.
 *
 * Sujeira que NÃO intersecta os caminhos da própria sessão é quase sempre de
 * OUTRA sessão viva no mesmo checkout compartilhado (#6168 é a norma
 * documentada, não a exceção) — recusar por ela agrava exatamente os
 * problemas que #6623/#6624 descrevem (sessões desassistidas sem quem digite
 * `--allow-dirty`, claims presas até a staleness). Nesse caso o `end`
 * PROSSEGUE e devolve `warning` (informativo, pro CLI imprimir em stderr) em
 * vez de abortar.
 *
 * `allowDirty: true` continua bypassando tudo, de propósito — escape
 * residual pro caso em que o operador quer confirmar manualmente que é
 * seguro seguir mesmo com sujeira própria.
 *
 * `ownPaths` — união de `touched_paths` e `dirty_paths` do PRÓPRIO registro
 * (já normalizados/coletados pelo chamador antes de `endSession` remover o
 * arquivo). Vazio/ausente (sessão sem beacon de paths, registros antigos
 * pré-#6168 Parte A) → nenhuma sujeira é atribuível à sessão → sempre avisa,
 * nunca recusa (mesma fail-direction: never bloquear por dado ausente).
 */
export function evaluateEndGuard(
  repoRoot: string,
  allowDirty: boolean,
  ownPaths: readonly string[] = [],
): EndGuardResult {
  if (allowDirty) return { ok: true };
  const { clean, files } = checkRepoTreeClean(repoRoot);
  if (clean) return { ok: true };

  const normalizedOwn = [...new Set(ownPaths.map(normalizeBeaconPath))].filter((p) => p !== "");
  const own: string[] = [];
  const foreign: string[] = [];
  for (const line of files) {
    const path = normalizeBeaconPath(extractPorcelainPath(line));
    const isOwn = path !== "" && normalizedOwn.some((op) => beaconPathsOverlap(op, path));
    (isOwn ? own : foreign).push(line);
  }

  if (own.length === 0) {
    const fileList = foreign.map((f) => `  ${f}`).join("\n");
    return {
      ok: true,
      warning:
        `session-registry: end prossegue com árvore suja em ${repoRoot} (${foreign.length} arquivo(s)) — ` +
        `nenhum casa com touched_paths/dirty_paths desta sessão, tratado como sujeira de OUTRA sessão no ` +
        `checkout compartilhado (#6168):\n${fileList}\n`,
    };
  }

  const ownList = own.map((f) => `  ${f}`).join("\n");
  const foreignSuffix =
    foreign.length > 0 ? ` (mais ${foreign.length} arquivo(s) de sujeira alheia, ignorados nesta checagem)` : "";
  return {
    ok: false,
    message:
      `session-registry: end RECUSADO — árvore suja em ${repoRoot} com ${own.length} arquivo(s) atribuível(is) ` +
      `a esta sessão (touched_paths/dirty_paths)${foreignSuffix}:\n${ownList}\n` +
      "Commitar, dar push, ou mover o trabalho pra fora do repo antes de encerrar o tick — nunca encerrar " +
      "deixando trabalho PRÓPRIO não commitado no checkout compartilhado (#6922). --allow-dirty bypassa " +
      "explicitamente se necessário.\n",
  };
}

/**
 * Resultado de `checkSessionsScanHealth` — se a varredura de `data/sessions/`
 * conseguiu de fato ler o diretório, ou se degradou para "vazio" por falha de
 * I/O. Existe porque o caminho fail-soft (correto para não derrubar a
 * pipeline) é indistinguível, no retorno, de "não há sessão nenhuma" — e para
 * uma decisão de EXCLUSÃO mútua essa ambiguidade é fail-open (#6277).
 */
export interface SessionsScanHealth {
  /** `false` quando o diretório EXISTE mas não pôde ser lido, ou quando `data/`
   * é link/junction cujo alvo sumiu (#12547). */
  ok: boolean;
  /** Código/mensagem do erro de I/O — presente só quando `ok: false`. */
  error?: string;
}

/**
 * Responde se `data/sessions/` está legível AGORA. Diretório ausente conta
 * como `ok: true` (é o estado normal de um clone fresco/sessão cloud — "não
 * há sessão" é resposta honesta, não degradação). Devolvem `ok: false` um
 * erro de leitura sobre diretório existente e, desde o #12547, `data/` (ou
 * `data/sessions`) como link/junction cujo alvo não resolve — com `existsSync`
 * isso parecia "ausente" e virava `ok: true` em silêncio.
 *
 * O consumidor é o CLI `active-of-kind`, que expõe isso como `uncertain` no
 * JSON para o chamador poder fail-CLOSED: com `uncertain: true`, tratar como
 * "pode haver overnight rodando" em vez de confiar no `active: false`.
 */
export function checkSessionsScanHealth(repoRoot: string): SessionsScanHealth {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) {
    // #12547: ausente só é `ok` quando nunca existiu. Junction de `data/`
    // com o alvo fora do ar (Drive for desktop fechado) é `ok: false`, com a
    // mensagem que nomeia a causa e a ação.
    const probe = probeSessionsDirWithWarning(repoRoot);
    return probe.degraded ? { ok: false, error: probe.message } : { ok: true };
  }
  try {
    readdirSync(dir);
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
    return { ok: false, error: String(code) };
  }
}

/**
 * Agrupa os arquivos de `data/sessions/` por identidade de sessão (stem do
 * arquivo REAL, sem sufixo `-safeBackup-`) e retorna 1 `SessionRecord`
 * mesclado (`mergeSessionRecords`) por identidade ANCORADA num arquivo real
 * existente. Backup ÓRFÃO (nenhum arquivo real cujo stem seja prefixo dele)
 * é ignorado aqui — mesmo comportamento do #5427: sessão já encerrada
 * (arquivo real removido por `endSession`) não ressuscita como ativa só
 * porque uma cópia de conflito antiga sobrou no disco. O match de backup →
 * real é por PREFIXO DE STRING (nunca assume formato de `sessionId`, que
 * pode ser um UUID em produção ou um id arbitrário em teste) — mais
 * específico (stem mais longo) vence em caso de ambiguidade.
 *
 * **#7002 — a exceção que o parágrafo acima não previa: o arquivo real pode
 * ter sumido com a sessão VIVA.** "Backup órfão" tem duas causas com a MESMA
 * forma em disco — `endSession` removeu o real de propósito (o caso do #5427,
 * acima), ou o real se perdeu num lost-update de escrita sobre o junction
 * OneDrive enquanto a sessão seguia trabalhando. Medido ao vivo em 01/09/2026:
 * a coordenadora de uma rodada `overnight` perdeu o próprio arquivo, os
 * backups guardaram as 10 claims e um `merge_grant` íntegros, e este read-path
 * os descartou — a sessão passou a aparecer pras outras com
 * `claimed_issues: []`. Falso-negativo de claim (issue reivindicada aparecendo
 * como livre) é exatamente o dano que `claim-issue` existe pra prevenir.
 *
 * Por isso um grupo órfão que ainda parece VIVO (`isOrphanBackupGroupLive`:
 * nenhuma cópia com `endedAt` + heartbeat dentro da janela de liveness do
 * kind) é PROMOVIDO de volta a sessão ativa, pela mesma união
 * (`mergeSessionRecords`) usada nos grupos ancorados. Grupo órfão stale, ou
 * carimbado por `endSession`, continua descartado exatamente como antes — o
 * invariante do #5427 não muda para a causa que ele descrevia.
 *
 * O critério é o MESMO que `decideSessionGc` já aplica ("heartbeat recente …
 * sessão claramente ativa" nunca é removido, mesmo órfão): a assimetria entre
 * um GC que preserva o grupo por considerá-lo vivo e um read-path que o
 * descarta por considerá-lo morto era o bug, não uma escolha.
 */
export function readMergedSessionGroups(repoRoot: string, now: number = Date.now()): SessionRecord[] {
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !isSyncConflictCopyName(n));
  const backupNames = names.filter((n) => isSyncConflictCopyName(n));

  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);
  const backupsByRealStem = new Map<string, string[]>();
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => conflictCopyBelongsToStem(backup, stem, ".json"));
    if (!matchStem) continue; // órfão — ver docstring acima
    const list = backupsByRealStem.get(matchStem) ?? [];
    list.push(backup);
    backupsByRealStem.set(matchStem, list);
  }

  const dir = sessionsDir(repoRoot);
  const merged: SessionRecord[] = [];
  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = backupsByRealStem.get(stem) ?? [];
    // Fleet review (#7467, achado CRÍTICO): checagem do real SEPARADA do
    // `.filter()` dos backups — ver o comentário gêmeo em
    // `readMergedRecordForRealFile` acima. Sem isto, um real ilegível
    // (race ENOENT do #7002, JSON malformado, ou sem `sessionId`/`kind`)
    // some do `.filter()` em silêncio, o primeiro BACKUP sobrevivente
    // reindexa pra posição 0, e `mergeSessionRecords` com `realIndex`
    // default (0) o trata como testemunha REAL de `consumedAt`.
    const rawReal = readJsonSafe<SessionRecord>(join(dir, realName));
    const realRecord = rawReal && rawReal.sessionId && rawReal.kind ? rawReal : null;
    const backupRecords = backupNames
      .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
      .filter((r): r is SessionRecord => r !== null && !!r.sessionId && !!r.kind);
    if (realRecord === null && backupRecords.length === 0) continue;
    if (realRecord === null) {
      process.stderr.write(
        `session-registry: ATENÇÃO — readMergedSessionGroups: o arquivo real "${realName}" está ilegível/ausente/sem ` +
          `sessionId+kind, mas ${backupRecords.length} cópia(s) -safeBackup- sobrevivem — tratando como grupo ÓRFÃO ` +
          "(realIndex=-1, #6972): consumedAt de nenhuma delas é confiado como testemunha.\n",
      );
      merged.push(mergeSessionRecords(backupRecords, -1));
      continue;
    }
    // #13114: real ressuscitado pelo sync depois de um `end` que carimbou as
    // cópias. Sem isto, a cópia carimbada só saía da união (`dedupeBySessionId`
    // filtra `endedAt` registro a registro) e o real velho seguia "vivo".
    if (endedAfterLastHeartbeat([realRecord, ...backupRecords]) !== null) continue;
    merged.push(mergeSessionRecords([realRecord, ...backupRecords]));
  }

  // #7002: grupos ÓRFÃOS que ainda parecem vivos voltam pra leitura. Um grupo
  // cuja identidade coincide com um arquivo real existente (nome de backup que
  // o match por prefixo não alcançou) também entra aqui — `dedupeBySessionId`
  // funde os dois por `(machineTag, sessionId)` logo depois, unindo as claims
  // em vez de duplicar a sessão.
  for (const group of readOrphanBackupGroups(repoRoot)) {
    if (!isOrphanBackupGroupLive(group, now)) continue;
    merged.push(group.record);
  }
  return merged;
}

/**
 * Fecha o gap do READ-path documentado no #6481: `readMergedSessionGroups`
 * agrupa só por STEM de arquivo (arquivo real + suas cópias `-safeBackup-N`)
 * — nunca cruza entre um registro `overnight-*`/`develop-*`/`continuo-*` e um
 * `interactive-*` do MESMO `sessionId`, que são arquivos com STEMS distintos.
 * Essa é a mesma janela de corrida que `registerSession` (#6326) já cobre no
 * WRITE-path: o beacon (`.claude/hooks/session-beacon.mjs`) cria
 * `interactive-{tag}-{sessionId}.json` ANTES de a skill rodar `register
 * --kind overnight`, e a promoção subsequente é BEST-EFFORT — `rmSync` do
 * arquivo antigo pode falhar (I/O transitório do OneDrive), deixando os dois
 * arquivos coexistindo por tempo indeterminado (`outcome:
 * "promoted-orphan-left"`, ver `RegisterSessionOutcome`). Nesse intervalo,
 * `readMergedSessionGroups` devolvia os DOIS registros como sessões
 * distintas — e, pior, sem ordem determinística entre eles, `list-active`/
 * `is-claimed` podiam exibir o registro `interactive` (tipicamente com
 * `claimed_issues: []`, porque o beacon não escreve claims) no lugar do
 * `overnight`/`develop`/`continuo` real, escondendo claims genuínas (achado
 * ao vivo #6481: Triagem do Studio parou de mostrar 7 issues reivindicadas
 * porque o registro efetivamente listado para aquele `sessionId` era o
 * `interactive`).
 *
 * Aplica a MESMA regra que o write-path já usa (#6326, `isCoordinatorKind`):
 * quando mais de um registro do grupo já-mesclado-por-STEM compartilha
 * `sessionId`, o COORDENADOR (`overnight`/`develop`/`continuo`) vence sobre
 * `interactive` como base de campos (kind, phase, branch, etc.) — e, na
 * mesma disciplina fail-safe de `mergeSessionRecords`, `claimed_issues`/
 * `claimed_issues_at` são a UNIÃO de TODOS os registros do grupo (incluindo
 * o `interactive` descartado como base), nunca só os do vencedor — preferir
 * "está reivindicada" a "não está", mesmo princípio de sempre neste módulo.
 * Se por algum motivo dois registros COORDENADORES coexistirem pro mesmo
 * `sessionId` (não deveria acontecer — cada skill só registra 1 kind por
 * vez), o de heartbeat mais recente vence como base (mesmo critério de
 * `mergeSessionRecords`).
 *
 * **#6952: a chave de agrupamento é (`machineTag`, `sessionId`), não
 * `sessionId` sozinho.** O propósito descrito acima é sempre INTRA-máquina —
 * uma sessão promovida de `interactive` pra coordenadora mantém o
 * `sessionId` e troca o `kind`, no MESMO host. Dois registros com o mesmo
 * `sessionId` e `machineTag` DIFERENTE não são a mesma sessão; fundi-los
 * mistura duas sessões num record só.
 *
 * Antes do #6952 isso quase não tinha consequência: só `claimed_issues` era
 * unido e todo o resto vinha do `primary`, então um `merge_grant` só cruzava
 * a fronteira de máquina por coincidência de heartbeat. Com o `merge_grant`
 * entrando na união, o vazamento passaria a ser sistemático — uma concessão
 * gravada no registro de uma máquina apareceria viva no record fundido da
 * outra. `data/sessions/` é compartilhado via OneDrive entre as máquinas, e
 * é essa a fronteira que a chave preserva.
 *
 * Dormente na prática (nada num fluxo normal produz o mesmo `sessionId` sob
 * duas tags), e por isso o conserto é a chave + o teste de regressão, não
 * um mecanismo novo.
 *
 * Pura — opera sobre a lista já lida do disco, não lê nada sozinha.
 */
function dedupeBySessionId(records: readonly SessionRecord[]): SessionRecord[] {
  const bySessionId = new Map<string, SessionRecord[]>();
  for (const record of records) {
    // `\u0000` como separador: não pode aparecer em hostname nem em UUID de
    // sessão, então não há como uma tag terminada em "-" colidir com um
    // sessionId iniciado por outra coisa.
    const key = `${record.machineTag ?? ""}\u0000${record.sessionId}`;
    const group = bySessionId.get(key) ?? [];
    group.push(record);
    bySessionId.set(key, group);
  }

  const out: SessionRecord[] = [];
  for (const group of bySessionId.values()) {
    // #7028: registros com `endedAt` carimbado (promoção de kind cuja
    // remoção do arquivo antigo falhou — ver docblock do campo em
    // `SessionRecord`) não contam como sessão viva. Excluídos ANTES de
    // escolher base/kind — senão o órfão `overnight` (que só tem claims
    // MIGRADAS, já duplicadas no registro novo) continuaria vencendo sobre
    // um `interactive` genuinamente vivo só por `isCoordinatorKind`, o
    // sintoma medido ao vivo na #7028. Grupo inteiro encerrado (raro — só
    // aconteceria se TODAS as cópias tivessem sido carimbadas) não produz
    // nenhuma sessão ativa.
    const liveGroup = group.filter((r) => !r.endedAt);
    if (liveGroup.length === 0) continue;
    if (liveGroup.length === 1) {
      out.push(liveGroup[0]!);
      continue;
    }
    const claimsUnion = mergeSessionRecords(liveGroup);
    const coordinatorGroup = liveGroup.filter((r) => isCoordinatorKind(r.kind));
    const base = coordinatorGroup.length > 0 ? mergeSessionRecords(coordinatorGroup) : claimsUnion;
    out.push({
      ...base,
      claimed_issues: claimsUnion.claimed_issues,
      claimed_issues_at: claimsUnion.claimed_issues_at,
      ...(claimsUnion.claimed_issues_ever ? { claimed_issues_ever: claimsUnion.claimed_issues_ever } : {}),
      ...(claimsUnion.claimed_foreign_issues
        ? {
            claimed_foreign_issues: claimsUnion.claimed_foreign_issues,
            claimed_foreign_issues_at: claimsUnion.claimed_foreign_issues_at,
          }
        : {}),
      ...(claimsUnion.claimed_foreign_issues_ever
        ? { claimed_foreign_issues_ever: claimsUnion.claimed_foreign_issues_ever }
        : {}),
    });
  }
  return out;
}

/**
 * Lista as sessões ativas (não-stale) de `data/sessions/`, já com a UNIÃO
 * de claims de eventuais backups de conflito do OneDrive resolvida (#6130,
 * ver `readMergedSessionGroups`/`mergeSessionRecords`) E com registros de
 * kinds diferentes do MESMO `sessionId` deduplicados a favor do coordenador
 * (#6481, ver `dedupeBySessionId`). Fail-soft: diretório ausente ou erro de
 * leitura → array vazio, nunca lança.
 */
export function listActiveSessions(
  repoRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS,
): ActiveSessionRecord[] {
  const out: ActiveSessionRecord[] = [];
  // #11113: consumo gravado no registro da beneficiária vale como `consumedAt`.
  const ledger = readMergeGrantConsumptions(repoRoot);
  for (const merged of dedupeBySessionId(readMergedSessionGroups(repoRoot, now))) {
    const grant = withLedgerConsumption(merged.merge_grant, ledger);
    const record = grant === merged.merge_grant ? merged : { ...merged, merge_grant: grant };
    const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
    const heartbeatMs = Date.parse(heartbeatIso ?? "");
    if (!Number.isFinite(heartbeatMs)) continue;
    const ageMs = now - heartbeatMs;
    // #5161 item 2: idade "no futuro" além da tolerância de clock skew é
    // excluída (nunca finge que uma sessão stale/corrompida está ativa) MAS
    // fica visível via warning — nunca um descarte silencioso. Idade
    // pequena no futuro (dentro da tolerância) é jitter normal entre
    // máquinas e conta como ativa normalmente, sem log.
    if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
      warnClockSkew("listActiveSessions", `${record.kind}-${record.machineTag}-${record.sessionId}`, ageMs);
      continue;
    }
    if (ageMs > maxAgeMs) continue;
    // #5474: `stale` é só um sinal computado — nunca remove a sessão da lista
    // (isso quebraria consumidores como `overnight-watchdog.ts`/
    // `cleanup-merged-worktrees.ts`, que dependem da lista completa).
    // #6168: a janela é POR KIND — `interactive` usa a sua, bem menor, porque
    // não emite heartbeat depois que a conversa acaba (ver
    // `INTERACTIVE_SOFT_STALE_MS`). Os 3 kinds coordenadores não mudam.
    const stale = ageMs > softStaleMsForKind(record.kind);
    // #7227: `claimed_issues_effective` não segue mais `stale` diretamente —
    // usa a janela dedicada e mais conservadora de `claimReleaseMsForKind`
    // (ver sua docstring pro porquê: `stale` sozinho mede só silêncio de
    // heartbeat, que não é sinal POSITIVO de morte, e liberar um claim
    // autoriza terceiro a mexer em trabalho de sessão possivelmente viva).
    // Entre as duas janelas, a sessão aparece `stale: true` (observável) mas
    // com `claimed_issues_effective` ainda populado — "provavelmente ociosa",
    // não "livre". Mesma regra de validade que `isIssueClaimedByOther`
    // aplica (abaixo), carregada aqui pra quem só lê `list-active`.
    const claimsReleased = ageMs > claimReleaseMsForKind(record.kind);
    out.push({
      ...record,
      stale,
      claimed_issues_effective: claimsReleased ? [] : (record.claimed_issues ?? []),
      claimed_foreign_issues_effective: claimsReleased ? [] : (record.claimed_foreign_issues ?? []),
    });
  }
  return out;
}
