#!/usr/bin/env npx tsx
/**
 * scripts/lib/session-registry.ts (#5156)
 *
 * Registro compartilhado e leve de sessões `/diaria-overnight`/`/diaria-develop`
 * ATIVAS — mecanismo pedido pela "Direção sugerida" do #5156, que audita 11
 * colisões concretas entre as duas skills rodando em paralelo (mesma máquina ou
 * máquinas diferentes sincronizadas pelo mesmo junction OneDrive `data/`).
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
 * OUTRA máquina (`helios`) no momento em que este PR foi escrito usa o
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
 * coordenador que crashou segurando o lock. **Nota (#6182): entre máquinas,
 * `O_CREAT|O_EXCL` sobre o mesmo junction OneDrive NÃO é garantia de exclusão
 * mútua real — o kernel vê inodes diferentes, cada máquina pode criar o arquivo
 * e ambas recebem `true`. O lock é **advisory** nesse cenário, não atômico.**
 *
 * **Claim de issue (item 3):** embutido no próprio registro de sessão
 * (`claimed_issues: number[]`) em vez de um arquivo `claims.jsonl` separado —
 * mais simples (a issue #5156 já sugeria essa opção como preferível), e o
 * dado morre junto com a sessão que fez o claim (staleness compartilhada).
 *
 * Uso CLI (chamado pelas skills — sempre SEM `--session-id`, injetado pelo
 * hook, ver acima):
 *   npx tsx scripts/lib/session-registry.ts register --kind overnight|develop|continuo [--pid N]
 *   npx tsx scripts/lib/session-registry.ts heartbeat --kind ... [--phase X] [--active-worktrees N]
 *   npx tsx scripts/lib/session-registry.ts end --kind ... [--tag MAQUINA]
 *     (`--tag` opcional, #5797: default é o machineTag() local; passar o tag de
 *     OUTRA máquina permite encerrar daqui um registro que não é seu — ver
 *     "Defeito 4" do #5797. `end` também distingue "removeu de fato" de "não
 *     havia nada pra remover": esta última reporta `exit 1` e a mensagem
 *     "nothing to end", nunca "ended".)
 *   npx tsx scripts/lib/session-registry.ts claim-issue --kind ... --issue N [--force]
 *     (#6236: check-and-set — recusa (`exit 1`) quando outra sessão ATIVA já
 *     segura a issue, imprimindo quem/desde quando. `--force` toma o claim
 *     mesmo assim — escape hatch pra retomar issue de sessão morta sem
 *     esperar a staleness de 24h. Reivindicar o que a própria sessão já tem
 *     é sempre no-op de sucesso, nunca recusa.)
 *   npx tsx scripts/lib/session-registry.ts is-claimed --issue N
 *   npx tsx scripts/lib/session-registry.ts list-active
 *   npx tsx scripts/lib/session-registry.ts merge-lock-acquire
 *   npx tsx scripts/lib/session-registry.ts merge-lock-release
 *   npx tsx scripts/lib/session-registry.ts gc [--max-age-days N] [--dry-run]
 * (`--session-id X` funciona também se passado explicitamente — o hook só
 * injeta quando a flag está AUSENTE, nunca sobrescreve um valor já presente.)
 *
 * **#6130 — conflitos de sync do OneDrive e GC de registros encerrados.**
 * `data/sessions/` vive numa junction OneDrive compartilhada entre máquinas
 * e pode bifurcar um arquivo de sessão em cópias de conflito com sufixo
 * `-safeBackup-NNNN` (ex: `continuo-predator-{uuid}-predator-safeBackup-0001.json`)
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
 * processo `claude` ainda rodando no `helios`). Ver docstring de
 * `planSessionGc` pra árvore de decisão completa (checagem de PID vivo na
 * MESMA máquina, janela conservadora bem maior que qualquer heartbeat
 * esperado quando não há sinal de processo verificável).
 */

import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs, isMainModule } from "./cli-args.ts";
import { writeFileAtomic } from "./atomic-write.ts";

export type SessionKind = "overnight" | "develop" | "continuo";

export interface SessionRecord {
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  startedAt: string;
  lastHeartbeat: string;
  phase?: string;
  pid?: number;
  active_worktrees?: number;
  claimed_issues?: number[];
  /**
   * Campo COMPUTADO por `listActiveSessions` (#5474) — nunca persistido em
   * disco. `true` quando `now - lastHeartbeat > SOFT_STALE_MS`, sinalizando
   * que a sessão provavelmente está morta mesmo sem ter cruzado o teto
   * absoluto `MAX_SESSION_AGE_MS`. Ausente em registros lidos diretamente do
   * disco fora de `listActiveSessions`.
   */
  stale?: boolean;
  [key: string]: unknown;
}

interface MergeLockRecord {
  heldBy: string;
  acquiredAt: string;
}

/**
 * Teto ABSOLUTO de segurança contra dado corrompido/clock skew — mesma janela
 * de staleness dos dois hooks irmãos (#3322/#4450). NÃO é um sinal de
 * liveness prático: uma sessão pode estar morta havia horas e ainda cair
 * dentro desta janela de 24h. `SOFT_STALE_MS` abaixo é o sinal de liveness
 * real (#5474) — `MAX_SESSION_AGE_MS` só existe para não deixar uma sessão
 * abandonada aparecer como "ativa" para sempre.
 */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sinal de liveness prático (#5474, sugestão 1/3 da issue) — distinto do teto
 * absoluto `MAX_SESSION_AGE_MS` acima. Investigação ao vivo em 16/08/2026
 * achou 2 sessões com heartbeat visivelmente morto (~3h e ~10h stale) ainda
 * listadas como "ativas" porque o único critério existente era o TTL de 24h.
 * Causas raiz: `/diaria-develop` só chama `session-registry.ts end` na Fase 2
 * (crash antes disso deixa o registro órfão até o TTL); `/diaria-continuo`
 * pausa (não encerra) ao colidir com edição em curso e nada chama `end` nesse
 * estado se o processo morrer pausado.
 *
 * 90 minutos — mesma ordem de grandeza do threshold de stall já usado em
 * outros lugares do repo (#2768/#2896; `OVERNIGHT_STALL_THRESHOLD_MIN`, 60
 * min quando esta constante foi escolhida, 45 desde o #5568), com folga
 * extra para a latência de sync do OneDrive entre máquinas (que o TTL de 24h
 * não precisava considerar por ser tão folgado).
 *
 * `listActiveSessions` continua usando `MAX_SESSION_AGE_MS` como corte
 * absoluto (sessão > 24h simplesmente não aparece na lista) — `SOFT_STALE_MS`
 * NÃO remove a sessão da lista, só marca o campo computado `stale: true` em
 * cada registro retornado, para visibilidade sem quebrar consumidores que
 * dependem da lista completa (`overnight-watchdog.ts`,
 * `cleanup-merged-worktrees.ts`). `isIssueClaimedByOther` (consumida pelo CLI
 * `is-claimed`) é o único lugar que trata `stale: true` como sinal
 * NÃO-bloqueante — uma claim de sessão com heartbeat morto há mais de
 * `SOFT_STALE_MS` não impede outra sessão de reivindicar a mesma issue.
 */
export const SOFT_STALE_MS = 90 * 60 * 1000;

/** TTL do merge lock (item 4) — merge + pull não deveria levar mais que isso. */
export const MERGE_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Tolerância de clock skew entre máquinas (#5161 fleet review item 2).
 * `listActiveSessions` e `acquireMergeLock` comparam timestamps ESCRITOS por
 * uma máquina contra o relógio de QUEM LÊ — se os relógios não estão
 * perfeitamente sincronizados (NTP), um timestamp genuinamente recente pode
 * parecer "no futuro" pra quem lê. Um delta pequeno (≤60s) é tratado como
 * jitter normal, nunca como sinal de corrupção/abandono. Um delta MAIOR que
 * isso ainda é tratado com segurança (nunca finge que um registro que parece
 * "do futuro" está abandonado/roubável), mas gera um warning em stderr — ver
 * `warnClockSkew` — porque não é mais jitter, pode ser skew real entre
 * máquinas que vale a pena investigar.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Loga (stderr, nunca lança) um aviso de possível clock skew — usado sempre
 * que um timestamp "no futuro" (relativo ao relógio de quem lê) influencia
 * uma decisão de staleness/freshness em `listActiveSessions`/
 * `acquireMergeLock`. Nunca silencioso: um relógio adiantado numa máquina
 * pode fazer sessões/locks genuinamente ativos desaparecerem/serem roubados
 * sem aviso nenhum se isto não for logado (#5161 item 2).
 */
function warnClockSkew(context: string, identifier: string, deltaMs: number): void {
  try {
    process.stderr.write(
      `session-registry: aviso de possível clock skew em ${context} — "${identifier}" tem timestamp ` +
        `~${Math.round(-deltaMs / 1000)}s no "futuro" relativo ao relógio de quem lê (delta=${deltaMs}ms). ` +
        "Se as máquinas envolvidas não estão sincronizadas via NTP, isto pode estar mascarando/excluindo " +
        "uma sessão ou lock genuinamente ativo. Ver CLOCK_SKEW_TOLERANCE_MS em scripts/lib/session-registry.ts.\n",
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho fail-soft principal.
  }
}

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, "data", "sessions");
}

export function sessionFilePath(repoRoot: string, kind: SessionKind, tag: string, sessionId: string): string {
  return join(sessionsDir(repoRoot), `${kind}-${tag}-${sessionId}.json`);
}

export function mergeLockPath(repoRoot: string): string {
  return join(sessionsDir(repoRoot), ".merge-lock.json");
}

/**
 * Loga (stderr, nunca lança) uma falha de I/O real lendo `path` — distinta de
 * "arquivo ausente" (ENOENT, silencioso — caso comum e esperado) ou "JSON
 * malformado" (também silencioso — arquivo de outra sessão só parcialmente
 * escrito, não é um sinal de bug). `data/` é uma junction OneDrive: erros
 * como EBUSY/EPERM/EACCES são REALISTAMENTE transitórios (sync em andamento),
 * não "o arquivo nunca existiu" — tratar os dois casos como indistinguíveis
 * (#5161 fleet review item 3) enfraquece tanto `listActiveSessions` quanto
 * `acquireMergeLock`: um lock/sessão de OUTRA sessão que falhou por I/O
 * transitório vira "ausente" e é ignorado/roubado sem aviso nenhum.
 */
function warnIoError(path: string, error: unknown): void {
  try {
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? String(error);
    process.stderr.write(
      `session-registry: falha de I/O lendo "${path}" (${code}) — tratando como ausente por segurança (fail-soft), ` +
        "mas isto pode ser TRANSITÓRIO (ex: OneDrive sincronizando o arquivo agora), não uma ausência real. " +
        "Se isto se repetir para o mesmo path, investigar antes de confiar na leitura.\n",
    );
  } catch {
    // Nunca deixar um log de warning quebrar o caminho fail-soft.
  }
}

function readJsonSafe<T>(path: string): T | null {
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT aqui (arquivo removido entre o existsSync e o readFileSync,
    // corrida benigna) é equivalente a "ausente" — silencioso, igual antes.
    // Qualquer OUTRO código (EBUSY/EPERM/EACCES/etc) é uma falha de I/O real
    // que merece ficar visível, não se disfarçar de "nunca existiu".
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") warnIoError(path, e);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // JSON malformado — comportamento pré-existente preservado (silencioso):
    // não é uma falha de I/O, é conteúdo genuinamente inválido.
    return null;
  }
}

/**
 * #6130 item 4 (reduzir a janela de conflito de escrita): write-then-rename
 * atômico (`writeFileAtomic`, já usado por outros outputs do pipeline) em
 * vez de `writeFileSync` in-place — elimina a classe "leitura vê arquivo
 * PARCIALMENTE escrito" (kill/crash/sync do OneDrive no meio de um write).
 * **Não elimina** a classe "lost update" de duas sessões fazendo
 * leitura→merge→escrita concorrente sobre o MESMO registro (ex: duas
 * chamadas de `claimIssue` pra sessões DIFERENTES nunca colidem — cada uma
 * escreve seu PRÓPRIO arquivo — mas duas chamadas concorrentes pra a MESMA
 * sessão, do tipo que só aconteceria por bug de dispatch, ainda podem
 * perder uma escrita) — isso exigiria locking/CAS por registro, avaliado
 * como refactor grande demais pra esta unidade (ver corpo da issue #6130,
 * item sem checkbox). `mkdirSync` continua incondicional antes do write —
 * `writeFileAtomic` não cria o diretório pai.
 */
function writeJsonSafe(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(value), { fsync: false });
}

/**
 * Registra uma sessão ativa. Idempotente — chamar de novo com o mesmo
 * kind/tag/sessionId sobrescreve o registro (mesmo padrão de `startSession` em
 * `overnight-session-marker.ts`).
 */
export function registerSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  meta: { pid?: number; tag?: string; startedAt?: string } = {},
): SessionRecord {
  const tag = meta.tag ?? machineTag();
  const now = meta.startedAt ?? new Date().toISOString();
  const record: SessionRecord = {
    kind,
    machineTag: tag,
    sessionId,
    startedAt: now,
    lastHeartbeat: now,
    claimed_issues: [],
  };
  if (meta.pid !== undefined) record.pid = meta.pid;
  writeJsonSafe(sessionFilePath(repoRoot, kind, tag, sessionId), record);
  return record;
}

/**
 * Atualiza `lastHeartbeat` (+ um patch opcional de `phase`/`active_worktrees`)
 * de uma sessão já registrada. Retorna `false`, nunca lança, quando não há
 * sessão pra atualizar (nunca registrada, já encerrada, ou JSON corrompido).
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
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return false;
  writeJsonSafe(path, { ...current, ...patch, lastHeartbeat: now });
  return true;
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
 */
export function endSession(repoRoot: string, kind: SessionKind, sessionId: string, tag: string = machineTag()): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Nomes de arquivo `.json` de sessão (real ou backup) em `data/sessions/` —
 * exclui dotfiles (`.merge-lock.json` etc). Fail-soft: diretório ausente ou
 * erro de leitura → array vazio, nunca lança. Ordem não é garantida
 * (`readdirSync` bruto). */
function listSessionJsonFiles(repoRoot: string): string[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Nomes de toda cópia de conflito do OneDrive (`-safeBackup-NNNN`) presente
 * em `data/sessions/` — usado pelo alarme dedicado (#6130,
 * `scripts/session-registry-safebackup-alarm.ts`) pra sinalizar que o sync
 * de `data/` teve um conflito de escrita concorrente, órfão ou não.
 */
export function listSafeBackupFiles(repoRoot: string): string[] {
  return listSessionJsonFiles(repoRoot)
    .filter((n) => n.includes("-safeBackup-"))
    .sort();
}

/**
 * Une um grupo de registros (arquivo real + eventuais cópias de conflito do
 * MESMO sessionId, #6130) num único `SessionRecord` efetivo:
 *   - `claimed_issues`: UNIÃO de todos os arrays do grupo — fail-safe,
 *     preferir "está reivindicada" a "não está" (ver docstring do módulo).
 *   - demais campos (phase, pid, active_worktrees, lastHeartbeat…): copiados
 *     do registro com o `lastHeartbeat` MAIS RECENTE do grupo — se qualquer
 *     cópia mostra atividade recente, o grupo inteiro é tratado como
 *     recente (mesmo princípio fail-safe: preferir "viva" a "stale").
 *
 * Pura — não lê disco. `records` não pode ser vazio.
 */
export function mergeSessionRecords(records: readonly SessionRecord[]): SessionRecord {
  // #6130 (achado do fleet review, P3 alta confiança): o invariante "records
  // não pode ser vazio" só existia em comentário — um `records[0]!` mentia
  // pro type checker. Falha nomeada em vez de um TypeError opaco.
  if (records.length === 0) {
    throw new Error("mergeSessionRecords: records não pode ser vazio");
  }
  let primary = records[0]!;
  let primaryHb = Date.parse(primary.lastHeartbeat ?? primary.startedAt ?? "");
  for (const r of records.slice(1)) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && (!Number.isFinite(primaryHb) || hb > primaryHb)) {
      primary = r;
      primaryHb = hb;
    }
  }
  const claimedUnion = new Set<number>();
  for (const r of records) for (const issue of r.claimed_issues ?? []) claimedUnion.add(issue);
  return { ...primary, claimed_issues: [...claimedUnion].sort((a, b) => a - b) };
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
 */
function readMergedSessionGroups(repoRoot: string): SessionRecord[] {
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-"));
  const backupNames = names.filter((n) => n.includes("-safeBackup-"));

  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);
  const backupsByRealStem = new Map<string, string[]>();
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => backup.startsWith(`${stem}-`));
    if (!matchStem) continue; // órfão — ver docstring acima
    const list = backupsByRealStem.get(matchStem) ?? [];
    list.push(backup);
    backupsByRealStem.set(matchStem, list);
  }

  const dir = sessionsDir(repoRoot);
  const merged: SessionRecord[] = [];
  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const groupNames = [realName, ...(backupsByRealStem.get(stem) ?? [])];
    const records = groupNames
      .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
      .filter((r): r is SessionRecord => r !== null && !!r.sessionId && !!r.kind);
    if (records.length === 0) continue;
    merged.push(mergeSessionRecords(records));
  }
  return merged;
}

/**
 * Lista as sessões ativas (não-stale) de `data/sessions/`, já com a UNIÃO
 * de claims de eventuais backups de conflito do OneDrive resolvida (#6130,
 * ver `readMergedSessionGroups`/`mergeSessionRecords`). Fail-soft: diretório
 * ausente ou erro de leitura → array vazio, nunca lança.
 */
export function listActiveSessions(
  repoRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS,
): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const record of readMergedSessionGroups(repoRoot)) {
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
    out.push({ ...record, stale: ageMs > SOFT_STALE_MS });
  }
  return out;
}

/**
 * Motivo do resultado de `claimIssueCheckAndSet` (#6236). `ok: true` cobre
 * três casos de sucesso (`claimed`, `already-own`, `forced-override`);
 * `ok: false` cobre dois de falha (`no-op-session-missing`,
 * `blocked-by-other`) — `blockedBy` só é populado neste último.
 */
export type ClaimIssueReason =
  | "claimed"
  | "already-own"
  | "no-op-session-missing"
  | "blocked-by-other"
  | "forced-override";

export interface ClaimIssueResult {
  ok: boolean;
  reason: ClaimIssueReason;
  /** Registro da sessão que já segura a issue — presente só em `blocked-by-other`. */
  blockedBy?: SessionRecord;
}

export interface ClaimIssueOptions {
  /**
   * Escape hatch (#6236) — assume a issue mesmo que outra sessão ATIVA (não
   * stale) já a segure. Existe pro caso legítimo de retomar issue de sessão
   * que morreu sem liberar o registro (heartbeat parou, mas ainda dentro da
   * janela `SOFT_STALE_MS`/`MAX_SESSION_AGE_MS`) — staleness sozinha já
   * destrava isso sem `force` (ver `reason: "claimed"` quando o dono
   * anterior está stale), então `force` só entra em jogo contra dono ATIVO.
   */
  force?: boolean;
}

/**
 * Faz check-and-set: adiciona `issueNumber` a `claimed_issues` da sessão SÓ
 * DEPOIS de confirmar que nenhuma OUTRA sessão ativa já a segura (#6236 —
 * antes desta mudança, `claimIssue` escrevia cego no próprio arquivo sem
 * nunca consultar os das outras sessões; a checagem vivia inteiramente no
 * chamador via `is-claimed`, com uma janela TOCTOU clássica entre os dois
 * comandos). Reusa `isIssueClaimedByOther` — a mesma função que o CLI
 * `is-claimed` já usa — em vez de reimplementar a consulta.
 *
 * Casos:
 * - Sessão do próprio `sessionId`/`tag` não existe (nunca registrada,
 *   encerrada, corrompida) → `{ ok: false, reason: "no-op-session-missing" }`.
 * - A PRÓPRIA sessão já segura a issue → no-op idempotente,
 *   `{ ok: true, reason: "already-own" }` (nunca recusa — usado em retomada).
 * - Outra sessão ATIVA (não-stale) já segura a issue e `force` não foi
 *   passado → recusa, `{ ok: false, reason: "blocked-by-other", blockedBy }`.
 * - Outra sessão ATIVA já segura a issue e `force: true` → toma o claim
 *   mesmo assim, `{ ok: true, reason: "forced-override" }` (chamador deve
 *   avisar alto quem estava segurando, via `blockedBy` do retorno — este
 *   helper não loga por si, é puro).
 * - Ninguém segura (ou só uma sessão STALE segura — `isIssueClaimedByOther`
 *   já ignora sessão stale, #5474) → claim normal,
 *   `{ ok: true, reason: "claimed" }`, sem precisar de `force`.
 *
 * **Não fecha a janela TOCTOU entre MÁQUINAS diferentes** (mesma ressalva do
 * merge lock, #6182): a leitura de `isIssueClaimedByOther` e a escrita deste
 * claim não são atômicas entre si sobre o junction OneDrive — duas máquinas
 * podem, na mesma janela de poucos milissegundos, cada uma ler "ninguém
 * segura" e escrever seu próprio claim, porque `O_CREAT|O_EXCL`/leitura+escrita
 * sobre cópias sincronizadas via OneDrive não é uma transação atômica cross-
 * inode. Dentro da MESMA máquina (onde múltiplos processos Node leem/escrevem
 * o mesmo arquivo local, sem lag de sync) a janela fecha de fato — foi
 * exatamente aí que a colisão real do #6236 aconteceu (duas sessões,
 * `overnight` e `continuo`, na mesma máquina).
 */
export function claimIssueCheckAndSet(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): ClaimIssueResult {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return { ok: false, reason: "no-op-session-missing" };

  const alreadyOwn = (current.claimed_issues ?? []).includes(issueNumber);
  let reason: ClaimIssueReason = "claimed";
  let overriddenOwner: SessionRecord | undefined;
  if (alreadyOwn) {
    reason = "already-own";
  } else {
    const nowMs = Date.parse(now);
    const other = isIssueClaimedByOther(repoRoot, issueNumber, sessionId, Number.isFinite(nowMs) ? nowMs : Date.now());
    if (other) {
      if (!options.force) return { ok: false, reason: "blocked-by-other", blockedBy: other };
      reason = "forced-override";
      overriddenOwner = other;
    }
  }

  const claimed = new Set(current.claimed_issues ?? []);
  claimed.add(issueNumber);
  writeJsonSafe(path, {
    ...current,
    claimed_issues: [...claimed].sort((a, b) => a - b),
    lastHeartbeat: now,
  });
  return overriddenOwner ? { ok: true, reason, blockedBy: overriddenOwner } : { ok: true, reason };
}

/**
 * Wrapper booleano de `claimIssueCheckAndSet` (#6236) — mantém a assinatura
 * histórica (`true`/`false`) pros chamadores que só precisam saber se o
 * claim colou, sem inspecionar o motivo. Ver `claimIssueCheckAndSet` para o
 * comportamento completo (check-and-set contra outras sessões ativas,
 * idempotência, `force`).
 */
export function claimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): boolean {
  return claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options).ok;
}

/**
 * Retorna o registro da sessão ATIVA e DIFERENTE de `excludeSessionId` que já
 * reivindicou `issueNumber` — ou `null` se nenhuma outra sessão ativa a
 * reivindicou. Usado pelo coordenador antes de dispatchar um implementador
 * pra uma issue (item 3): "essa issue já está sendo trabalhada por outra
 * sessão ativa agora?".
 */
export function isIssueClaimedByOther(
  repoRoot: string,
  issueNumber: number,
  excludeSessionId: string,
  now: number = Date.now(),
): SessionRecord | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    // #5474: claim de sessão STALE (heartbeat morto ha mais de SOFT_STALE_MS,
    // ainda dentro do teto absoluto MAX_SESSION_AGE_MS) nao bloqueia outra
    // sessao de reivindicar a mesma issue.
    if (session.stale) continue;
    if ((session.claimed_issues ?? []).includes(issueNumber)) return session;
  }
  return null;
}

/**
 * Primitivas de I/O usadas por `acquireMergeLock` — injetáveis pra teste
 * (mesmo padrão de `execFn` em `.claude/hooks/pr-create-review.mjs`). O
 * default (`REAL_MERGE_LOCK_IO`) usa `node:fs` de verdade; testes injetam um
 * "disco" fake em memória pra simular INTERCALAÇÃO real entre duas sessões
 * concorrentes (coisa que chamadas sequenciais dentro de um único processo
 * Node — de propósito single-threaded — não conseguem exercitar sozinhas).
 */
export interface MergeLockIo {
  /**
   * Cria `path` com `data` de forma EXCLUSIVA — só sucede se `path` ainda não
   * existir. Retorna `true` em criação, `false` em `EEXIST` (path já existe).
   * Qualquer outro erro de I/O deve ser relançado (o caller decide).
   */
  tryCreateExclusive: (path: string, data: string) => boolean;
  /** Lê e parseia `path`; `null` em qualquer falha (ausente/corrompido). */
  readCurrent: (path: string) => MergeLockRecord | null;
  /** Sobrescreve `path` com `data`, sem exclusividade. */
  overwrite: (path: string, data: string) => void;
}

const REAL_MERGE_LOCK_IO: MergeLockIo = {
  tryCreateExclusive: (path, data) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw e;
    }
  },
  readCurrent: (path) => readJsonSafe<MergeLockRecord>(path),
  overwrite: (path, data) => writeJsonSafe(path, JSON.parse(data)),
};

/**
 * Adquire o lock global de merge (item 4 do #5156) — serializa `gh pr merge` +
 * `git pull` entre sessões concorrentes (mesma máquina é atômico via
 * `O_EXCL`; entre máquinas via OneDrive o lock é **advisory** — ver o
 * docblock do módulo e o #6182). TTL curto: um lock mais velho que
 * `MERGE_LOCK_TTL_MS` é tratado como abandonado (coordenador crashou
 * segurando o lock) e liberado automaticamente pro próximo adquirente —
 * nunca trava a máquina pra sempre.
 *
 * **#5161 fleet review item 1 (CRÍTICO):** a versão anterior fazia
 * read→check→write sem NENHUMA primitiva atômica — duas sessões podiam ler
 * "sem lock" simultaneamente e ambas escreverem, ambas recebendo `true`,
 * quebrando a exclusão mútua NA MESMA MÁQUINA, que é o mínimo esperado
 * deste mecanismo. (O #5161 descrevia esse bug como sendo "o cenário
 * cross-máquina via `data/` OneDrive que o #5156 existe pra proteger" — o
 * #6182 corrigiu essa parte: o fix abaixo resolve a corrida entre processos
 * do MESMO filesystem; entre máquinas o lock segue advisory, e nenhuma das
 * duas partes muda isso.) Fix em duas partes:
 *   1. **Fast path (mesma máquina — nenhuma concorrência com outro inode):**
 *      criação exclusiva atômica (`writeFileSync(path, data, { flag: "wx" })`,
 *      que mapeia pra `O_CREAT | O_EXCL`). Entre processos DIFERENTES no
 *      MESMO kernel/filesystem, no máximo UMA chamada com o MESMO path
 *      ausente pode suceder. **Entre máquinas via OneDrive, NÃO é atômica:**
 *      cada máquina vê um inode distinto no mesmo junction, ambas podem
 *      criar o arquivo e receber `true`. O lock é advisory nesse caso (#6182).
 *      Nenhuma coordenação em memória deste arquivo entra nessa garantia.
 *   2. **Caso raro — lock existe mas expirou (TTL, coordenador crashou):**
 *      plain `fs` não oferece um "substituir só se o conteúdo não mudou
 *      desde que eu li" (compare-and-swap) sem uma lib de lock externa que
 *      este repo não usa. Mitigação: sobrescrever e então RELER
 *      imediatamente pra verificar se a escrita que está no disco agora é
 *      de fato a NOSSA (`heldBy === sessionId`) — se não for, outra sessão
 *      venceu a corrida, retorna `false`. Isto fecha o caso mais comum do
 *      bug original (nenhuma verificação pós-escrita nenhuma — sempre
 *      retornava `true` incondicionalmente). Continua existindo uma janela
 *      residual estreita (o ciclo inteiro de OUTRA sessão completar entre a
 *      nossa PRÓPRIA leitura de decisão e a nossa PRÓPRIA escrita) — dado
 *      que este é o caminho raro (requer um crash prévio E uma corrida bem
 *      no instante de expiração do TTL), a mitigação abaixo é
 *      deliberadamente proporcional ao risco, não uma prova de CAS perfeito.
 *
 * Retorna `true` quando o lock foi adquirido (ou já era desta mesma sessão —
 * reentrante, idempotente), `false` quando outra sessão o segura e ainda
 * está dentro do TTL (ou quando perdemos a corrida de contestação acima).
 */
export function acquireMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_LOCK_TTL_MS,
  io: MergeLockIo = REAL_MERGE_LOCK_IO,
): boolean {
  const path = mergeLockPath(repoRoot);
  const data = JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);

  // Fast path: nenhum lock existia — criação exclusiva atômica (ver docblock).
  try {
    if (io.tryCreateExclusive(path, data)) return true;
  } catch {
    // Erro de I/O inesperado (não-EEXIST) — nunca assumir que adquirimos o
    // lock sobre um estado que não conseguimos nem determinar.
    return false;
  }

  const current = io.readCurrent(path);
  if (current && current.heldBy === sessionId) {
    io.overwrite(path, data); // reentrante: refresca o próprio lock (estende o TTL)
    return true;
  }
  if (current) {
    const acquiredMs = Date.parse(current.acquiredAt);
    if (Number.isFinite(acquiredMs)) {
      const ageMs = now - acquiredMs;
      // #5161 item 2: idade negativa (lock "no futuro" pro nosso relógio) NUNCA
      // é tratada como "abandonado" — um clock adiantado em OUTRA máquina não
      // pode fazer um lock genuinamente fresco parecer roubável. Só logamos
      // quando o delta passa da tolerância de jitter normal (potencial skew
      // real entre máquinas, vale investigar); dentro da tolerância é
      // silencioso, é só o lock sendo tratado como fresco mesmo.
      if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) warnClockSkew("acquireMergeLock", `lock de ${current.heldBy}`, ageMs);
      if (ageMs <= ttlMs) return false; // ainda dentro do TTL (com folga de tolerância) — outra sessão segura de verdade
    }
    // acquiredAt ilegível (campo corrompido, mas JSON válido) — cai pro
    // tratamento de "stale" abaixo, mesma política de antes.
  }

  // Stale (TTL expirado) ou corrompido/ilegível: contesta. Não-atômico — ver
  // docblock acima pro racional e a janela residual aceita.
  io.overwrite(path, data);
  const verify = io.readCurrent(path);
  return verify?.heldBy === sessionId;
}

/**
 * Libera o lock de merge. Retorna `true` quando já estava livre ou foi
 * liberado por quem o segurava; `false` quando outra sessão é a dona atual
 * (nunca libera lock alheio por engano).
 */
export function releaseMergeLock(repoRoot: string, sessionId: string): boolean {
  const path = mergeLockPath(repoRoot);
  const current = readJsonSafe<MergeLockRecord>(path);
  if (!current) return true;
  if (current.heldBy !== sessionId) return false;
  if (existsSync(path)) rmSync(path);
  return true;
}

// ─── GC de registros encerrados (#6130) ────────────────────────────────────

/**
 * Janela CONSERVADORA usada quando não é possível confirmar liveness de
 * processo (sessão registrada por OUTRA máquina, ou sem `pid` gravado) — bem
 * maior que qualquer heartbeat esperado (`SOFT_STALE_MS` = 90min,
 * `MAX_SESSION_AGE_MS` = 24h), de propósito: sem sinal de processo, GC por
 * tempo sozinho é chute (ver "Ressalva importante" do #6130 — um registro
 * `stale: true` correspondeu a uma sessão VIVA que só parou de bater
 * heartbeat). 7 dias é a mesma ordem de grandeza do achado ao vivo da issue
 * (arquivo mais velho encontrado tinha 10 dias) — folgado o bastante pra
 * nunca remover algo que ainda pode estar em uso, curto o bastante pra
 * `data/sessions/` não crescer pra sempre.
 */
export const GC_CONSERVATIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Checa se `pid` corresponde a um processo vivo — padrão "kill -0"
 * (`process.kill(pid, 0)` nunca envia sinal de verdade, só testa
 * existência; funciona em POSIX e Windows). `ESRCH` (processo não existe)
 * → `false`; `EPERM` (existe, mas sem permissão de sinalizar) → `true`
 * (existe é o que importa aqui, não permissão); qualquer outro erro →
 * `false` por segurança de INTERPRETAÇÃO (nunca finge "vivo" sobre um erro
 * que não sabemos classificar) — mas ver `decideSessionGc`: um resultado
 * `false` por si só só remove o registro se TAMBÉM estiver na mesma máquina
 * E além de `SOFT_STALE_MS`, nunca por PID sozinho.
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface SessionGcOptions {
  now?: number;
  /** Default `GC_CONSERVATIVE_MAX_AGE_MS`. */
  conservativeMaxAgeMs?: number;
  /** Injetável pra teste — default `defaultIsPidAlive`. */
  isPidAlive?: (pid: number) => boolean;
  /** Default `machineTag()` local. */
  localMachineTag?: string;
}

export type SessionGcAction = "removed" | "kept";

export interface SessionGcResult {
  /** Rótulo legível da identidade avaliada — `{kind}-{machineTag}-{sessionId}`
   * pro grupo ancorado num arquivo real, ou `orphan-backup:{arquivo}` pra um
   * backup sem arquivo real correspondente. */
  identity: string;
  /** Paths ABSOLUTOS de todo arquivo pertencente a esta identidade (arquivo
   * real + backups do grupo, ou só o próprio arquivo pra um órfão). */
  files: string[];
  action: SessionGcAction;
  /** Explicação legível da decisão — sempre populada, inclusive pra `"kept"`
   * (auditabilidade: por que este registro NÃO foi removido). */
  reason: string;
}

/**
 * Árvore de decisão pura (sem I/O) usada tanto pro grupo ancorado num
 * arquivo real quanto pra um backup órfão avaliado sozinho — ver docstring
 * de `planSessionGc`.
 *
 * **Nunca remove por staleness de heartbeat sozinha** (ressalva do #6130):
 *   1. Heartbeat mais recente do grupo dentro de `SOFT_STALE_MS` (90min) →
 *      mantém — claramente ativa.
 *   2. Heartbeat "no futuro" (clock skew) → mantém — nunca trata como
 *      abandonado.
 *   3. Além de `SOFT_STALE_MS`: se ALGUM registro do grupo foi escrito pela
 *      MÁQUINA LOCAL e carrega `pid`, a liveness do PROCESSO decide —
 *      `pid` vivo → mantém, INDEPENDENTE de quão velho o heartbeat esteja
 *      (é exatamente o cenário da ressalva: sessão viva que parou de bater
 *      heartbeat); `pid` confirmado morto → remove.
 *   4. Sem sinal de processo verificável (máquina diferente, ou nenhum
 *      registro do grupo tem `pid`) → só remove além da janela conservadora
 *      `conservativeMaxAgeMs` (default 7 dias) — chute deliberadamente caro
 *      de errar pro lado seguro.
 *
 * **Limitação do #6130 fechada pelo #6160:** o branch 3 (PID vivo protege
 * incondicionalmente) era alcançável só pro kind `continuo` — `overnight`/
 * `develop` chamavam `register --kind {overnight|develop}` SEM `--pid` (e
 * nenhum dos dois chama `heartbeat`), colapsando a árvore inteira no branch
 * 4 pra eles. Fechado sem exigir mudança nas skills: `.claude/hooks/
 * inject-session-id.mjs` (o mesmo hook que já injeta `--session-id`
 * automaticamente, #5156) agora também injeta `--pid {process.ppid}` em
 * toda chamada standalone de `register` sem a flag — `process.ppid` do
 * hook É o PID da sessão Claude Code corrente, porque o harness spawna o
 * hook como filho direto dela a cada `PreToolUse`. `overnight`/`develop`
 * ainda nunca chamam `heartbeat` (só `continuo` o faz), então
 * `lastHeartbeat === startedAt` continua verdadeiro a sessão inteira pra
 * eles — mas isso não impede mais o branch 3: a checagem de `pid` roda
 * independente de quão stale o heartbeat esteja.
 */
function decideSessionGc(
  records: readonly SessionRecord[],
  now: number,
  conservativeMaxAgeMs: number,
  isPidAlive: (pid: number) => boolean,
  localTag: string,
): { action: SessionGcAction; reason: string } {
  let maxHeartbeatMs = -Infinity;
  for (const r of records) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && hb > maxHeartbeatMs) maxHeartbeatMs = hb;
  }
  if (!Number.isFinite(maxHeartbeatMs)) {
    return { action: "kept", reason: "timestamp ilegível em todos os arquivos do grupo — GC nunca remove sem sinal de idade confiável" };
  }

  const ageMs = now - maxHeartbeatMs;
  if (ageMs < 0) {
    return { action: "kept", reason: "heartbeat no futuro (possível clock skew) — nunca tratado como abandonado" };
  }
  if (ageMs <= SOFT_STALE_MS) {
    return { action: "kept", reason: `heartbeat recente (${Math.round(ageMs / 60000)}min, dentro da janela de liveness de 90min) — sessão claramente ativa` };
  }

  for (const r of records) {
    if (r.machineTag === localTag && typeof r.pid === "number") {
      if (isPidAlive(r.pid)) {
        return {
          action: "kept",
          reason:
            `heartbeat stale (${Math.round(ageMs / 60000)}min) mas processo pid=${r.pid} confirmado VIVO na máquina ` +
            `local (${localTag}) — nunca remove registro de sessão viva (ressalva #6130)`,
        };
      }
      return {
        action: "removed",
        reason: `heartbeat stale (${Math.round(ageMs / 60000)}min) e processo pid=${r.pid} confirmado MORTO na máquina local (${localTag})`,
      };
    }
  }

  if (ageMs > conservativeMaxAgeMs) {
    return {
      action: "removed",
      reason:
        `heartbeat stale há ${Math.round(ageMs / 86_400_000)} dia(s), sem sinal de processo verificável ` +
        `(máquina diferente ou sem pid registrado) — além da janela conservadora de ${Math.round(conservativeMaxAgeMs / 86_400_000)} dia(s)`,
    };
  }
  return {
    action: "kept",
    reason:
      `heartbeat stale (${Math.round(ageMs / 60000)}min) mas sem sinal de processo verificável e ainda dentro da ` +
      "janela conservadora — GC não arrisca remover sessão que pode estar viva",
  };
}

/**
 * Plano PURO (sem tocar disco) de GC de `data/sessions/` (#6130) — avalia
 * todo grupo ancorado num arquivo real (arquivo real + seus backups, ver
 * `readMergedSessionGroups`) e todo backup ÓRFÃO (sem arquivo real
 * correspondente — o caso canônico de "sessão encerrada, sobrou o
 * straggler") via `decideSessionGc`. Arquivo(s) ilegível(is)/corrompido(s)
 * nunca são removidos (mantém por segurança de interpretação — GC nunca
 * remove estado que não consegue entender).
 */
export function planSessionGc(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const now = opts.now ?? Date.now();
  const conservativeMaxAgeMs = opts.conservativeMaxAgeMs ?? GC_CONSERVATIVE_MAX_AGE_MS;
  // #6130 (achado do fleet review, P2): a validação de positividade existia
  // só no parser da CLI (`main()`, case "gc") — um caller programático
  // passando 0/negativo/NaN derrubava em silêncio a janela conservadora que
  // é a rede de segurança inteira do branch 4 de `decideSessionGc` (sem
  // sinal de processo verificável). Falha alto e cedo em vez de degradar.
  if (!Number.isFinite(conservativeMaxAgeMs) || conservativeMaxAgeMs <= 0) {
    throw new Error(
      `planSessionGc: conservativeMaxAgeMs precisa ser finito e positivo (recebido: ${conservativeMaxAgeMs})`,
    );
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const localTag = opts.localMachineTag ?? machineTag();

  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-"));
  const backupNames = names.filter((n) => n.includes("-safeBackup-"));
  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);

  const backupsByRealStem = new Map<string, string[]>();
  const orphanBackups: string[] = [];
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => backup.startsWith(`${stem}-`));
    if (matchStem) {
      const list = backupsByRealStem.get(matchStem) ?? [];
      list.push(backup);
      backupsByRealStem.set(matchStem, list);
    } else {
      orphanBackups.push(backup);
    }
  }

  const results: SessionGcResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const groupNames = [realName, ...(backupsByRealStem.get(stem) ?? [])];
    const groupPaths = groupNames.map((n) => join(dir, n));
    const records = groupNames
      .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
      .filter((r): r is SessionRecord => r !== null && !!r.sessionId && !!r.kind);
    if (records.length === 0) {
      results.push({
        identity: stem,
        files: groupPaths,
        action: "kept",
        reason: "arquivo(s) ilegível(is)/corrompido(s) — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const decision = decideSessionGc(records, now, conservativeMaxAgeMs, isPidAlive, localTag);
    results.push({
      identity: `${records[0]!.kind}-${records[0]!.machineTag}-${records[0]!.sessionId}`,
      files: groupPaths,
      ...decision,
    });
  }

  for (const backup of orphanBackups) {
    const path = join(dir, backup);
    const record = readJsonSafe<SessionRecord>(path);
    if (!record) {
      results.push({
        identity: `orphan-backup:${backup}`,
        files: [path],
        action: "kept",
        reason: "backup órfão ilegível/corrompido — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const decision = decideSessionGc([record], now, conservativeMaxAgeMs, isPidAlive, localTag);
    results.push({ identity: `orphan-backup:${backup}`, files: [path], ...decision });
  }

  return results;
}

/**
 * Aplica `planSessionGc` — remove (best-effort, `rmSync` por arquivo, nunca
 * lança) todo arquivo de todo grupo com `action: "removed"`. Fail-soft por
 * arquivo: se um `rmSync` individual falhar (ex: I/O transitório do
 * OneDrive), os demais arquivos do plano continuam sendo processados — a
 * próxima execução retenta o que sobrou.
 */
export function garbageCollectSessions(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const plan = planSessionGc(repoRoot, opts);
  for (const entry of plan) {
    if (entry.action !== "removed") continue;
    // #6130 (achado HIGH do fleet review): antes disto, uma falha de rmSync
    // era engolida em silêncio E a entry continuava reportando "removed" —
    // o operador via "removido" no output do CLI mesmo com o arquivo ainda
    // no disco. Agora: loga a falha (mesmo padrão de `warnIoError`) e
    // rebaixa a entry pra "kept" quando pelo menos 1 arquivo do grupo não
    // foi confirmadamente removido — próxima execução do GC retenta.
    let allRemoved = true;
    for (const file of entry.files) {
      try {
        if (existsSync(file)) rmSync(file);
        if (existsSync(file)) allRemoved = false; // rmSync "teve sucesso" mas o arquivo persiste (raro, ex: lock de outro processo)
      } catch (e) {
        allRemoved = false;
        warnIoError(file, e);
      }
    }
    if (!allRemoved) {
      entry.action = "kept";
      entry.reason = `${entry.reason} [remoção falhou parcialmente — reportado como "kept", próxima execução retenta]`;
    }
  }
  return plan;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

/**
 * Exportado só para teste direto (#5293) — o CLI (main(), abaixo) é o único
 * chamador em produção.
 */
export function requireKind(value: string | undefined): SessionKind {
  if (value !== "overnight" && value !== "develop" && value !== "continuo") {
    throw new Error(`--kind deve ser "overnight", "develop" ou "continuo", recebido "${value}"`);
  }
  return value;
}

function requireSessionId(values: Record<string, string>): string {
  const sessionId = values["session-id"];
  if (!sessionId) {
    throw new Error(
      "--session-id ausente — normalmente injetado automaticamente por " +
        ".claude/hooks/inject-session-id.mjs a partir do payload do hook PreToolUse. " +
        "Se você está chamando este script fora do harness do Claude Code, passe --session-id explicitamente.",
    );
  }
  return sessionId;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { positional, values, flags } = parseArgs(argv);
  const command = positional[0];
  const repoRoot = process.cwd();

  try {
    switch (command) {
      case "register": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const pid = values.pid ? Number(values.pid) : undefined;
        const record = registerSession(repoRoot, kind, sessionId, { pid });
        process.stdout.write(`session-registry: registered ${sessionFilePath(repoRoot, kind, record.machineTag, sessionId)}\n`);
        break;
      }
      case "heartbeat": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {};
        if (values.phase) patch.phase = values.phase;
        if (values["active-worktrees"]) patch.active_worktrees = Number(values["active-worktrees"]);
        const ok = heartbeat(repoRoot, kind, sessionId, patch);
        process.stdout.write(`session-registry: heartbeat ${ok ? "ok" : "no-op (sessão inexistente)"}\n`);
        if (!ok) process.exitCode = 1;
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
        const removed = endSession(repoRoot, kind, sessionId, tag);
        if (removed) {
          process.stdout.write("session-registry: ended\n");
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
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const force = flags.has("force");
        const result = claimIssueCheckAndSet(repoRoot, kind, sessionId, issue, undefined, undefined, { force });
        switch (result.reason) {
          case "claimed":
            process.stdout.write("session-registry: claim-issue ok (claimed)\n");
            break;
          case "already-own":
            process.stdout.write("session-registry: claim-issue ok (already-own, no-op)\n");
            break;
          case "forced-override": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue ok (FORCED — tomado de ${owner?.kind}-${owner?.sessionId} ` +
                `desde ${owner?.startedAt}, heartbeat ${owner?.lastHeartbeat})\n`,
            );
            break;
          }
          case "no-op-session-missing":
            process.stdout.write("session-registry: claim-issue no-op (sessão inexistente)\n");
            process.exitCode = 1;
            break;
          case "blocked-by-other": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue RECUSADO — issue #${issue} já está reivindicada por ` +
                `${owner?.kind}-${owner?.machineTag}-${owner?.sessionId} (desde ${owner?.startedAt}, ` +
                `último heartbeat ${owner?.lastHeartbeat}). Use --force para tomar mesmo assim.\n`,
            );
            process.exitCode = 1;
            break;
          }
        }
        break;
      }
      case "is-claimed": {
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const excludeSessionId = values["session-id"] ?? "";
        const owner = isIssueClaimedByOther(repoRoot, issue, excludeSessionId);
        process.stdout.write(JSON.stringify({ claimed: owner !== null, by: owner }) + "\n");
        break;
      }
      case "list-active": {
        const sessions = listActiveSessions(repoRoot);
        process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
        break;
      }
      case "merge-lock-acquire": {
        const sessionId = requireSessionId(values);
        const ok = acquireMergeLock(repoRoot, sessionId);
        process.stdout.write(`session-registry: merge-lock-acquire ${ok ? "ok" : "denied (held by another session)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "merge-lock-release": {
        const sessionId = requireSessionId(values);
        const ok = releaseMergeLock(repoRoot, sessionId);
        process.stdout.write(`session-registry: merge-lock-release ${ok ? "ok" : "denied (held by another session)"}\n`);
        if (!ok) process.exitCode = 1;
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
        const removedCount = plan.filter((e) => e.action === "removed").length;
        process.stdout.write(
          `session-registry: gc ${isDryRun ? "--dry-run: " : ""}${removedCount}/${plan.length} identidade(s) ${isDryRun ? "seriam removidas" : "removidas"}\n`,
        );
        break;
      }
      default:
        process.stderr.write(
          "uso: npx tsx scripts/lib/session-registry.ts <register|heartbeat|end|claim-issue|is-claimed|list-active|merge-lock-acquire|merge-lock-release|gc> [--kind overnight|develop|continuo] [--session-id X] [--tag MAQUINA] ...\n" +
            "  --tag (só \"end\"): machineTag() da sessão a encerrar (default: machineTag() local) — necessário " +
            "pra encerrar da máquina local o registro de OUTRA máquina em data/sessions/ (#5797).\n" +
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
  main();
}
