/**
 * scripts/lib/sessions/presence.ts (#14004)
 *
 * Lado D1 da coordenação: consumo único do grant no D1, presença da
 * coordenadora e a concessão de janela que a consulta
 * (`grantMergeWindowShared`, `findLiveMergeGrantInD1`).
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { logEvent } from "../run-log.ts";
import {
  MERGE_GRANT_CONSUMED_D1_TTL_MS,
  type D1Client,
  type D1CoordinatorPresence,
  type D1LockResult,
  d1AcquireLock,
  d1ClearCoordinatorPresence,
  d1ReadCoordinatorPresence,
  d1ReadLock,
  d1ReadMergeGrant,
  d1WriteCoordinatorPresence,
  d1WriteMergeGrant,
  mergeGrantConsumedD1Name,
  reportD1Failure,
} from "../d1-locks.ts";
import { DEFAULT_ISSUE_REPO } from "../issue-repos.ts";
import {
  type ActiveSessionRecord,
  hasMergeAuthorityKind,
  isCoordinatorKind,
  MAX_SESSION_AGE_MS,
  MERGE_GRANT_TTL_MS,
  type MergeGrant,
  type SessionKind,
  type SessionRecord,
} from "./types.ts";
import { CLOCK_SKEW_TOLERANCE_MS, machineTag } from "./store.ts";
import { listActiveSessions, readMergedSessionGroups, type RegisterSessionResult } from "./registry.ts";
import { type MergeLockBackend, resolveD1ForRepo, type SharedLockOptions, stderrWarn } from "./merge-lock.ts";
import type { SessionGcResult } from "./gc.ts";
import { type GrantMergeResult, grantMergeWindow, grantRepoOf, isMergeGrantLive } from "./merge-grant.ts";
import { readMergeGrantConsumptions, withLedgerConsumption } from "./merge-grant-ledger.ts";

/**
 * Marca no D1 o consumo único de `grant` (#12842). `null` = sem D1 (vale só
 * o registro local). `{ ok: true, value: "claimed" }` = esta chamada marcou;
 * `"already"` = já estava marcada, ou seja CONSUMO DUPLO (consumida antes,
 * talvez em outra máquina) — o chamador alarma. `{ ok: false }` = o D1 não
 * gravou (`error`/`permanent` para o aviso).
 */
export async function markMergeGrantConsumedInD1(
  d1: D1Client | null,
  grant: MergeGrant,
  sessionId: string,
  opts: { now?: number } = {},
): Promise<D1LockResult<"claimed" | "already"> | null> {
  if (!d1) return null;
  const r = await d1AcquireLock(d1, mergeGrantConsumedD1Name(grant), sessionId, MERGE_GRANT_CONSUMED_D1_TTL_MS, opts);
  if (!r.ok) return r;
  return { ok: true, value: r.value.acquired ? "claimed" : "already" };
}

/** `null` = sem D1. `{ ok: true, value }` = o D1 registra (ou não) o consumo; `{ ok: false }` = sem resposta. */
export async function isMergeGrantConsumedInD1(
  d1: D1Client | null,
  grant: MergeGrant,
  opts: { now?: number } = {},
): Promise<D1LockResult<boolean> | null> {
  if (!d1) return null;
  const r = await d1ReadLock(d1, mergeGrantConsumedD1Name(grant), opts);
  if (!r.ok) return r;
  return { ok: true, value: r.value !== null };
}

/** Alarme de consumo duplo de uma concessão (#12842 review): stderr + run-log `error`. */
export function reportMergeGrantDoubleConsumed(repoRoot: string, grant: MergeGrant, sessionId: string): void {
  process.stderr.write(
    "❌ session-registry: a concessão já constava como CONSUMIDA no D1 (#12842) — consumo duplo " +
      `(concedida por ${grant.grantedBy} a ${grant.grantedTo} em ${grant.grantedAt}).\n`,
  );
  logEvent(
    {
      edition: null,
      stage: null,
      agent: "session-registry",
      level: "error",
      message: "merge_grant_double_consumed",
      details: { grantedBy: grant.grantedBy, grantedTo: grant.grantedTo, grantedAt: grant.grantedAt, sessionId },
    },
    repoRoot,
  );
}

// ─── #13242: a concessão de merge também no D1 ─────────────────────────────
//
// Até aqui a CRIAÇÃO da concessão vivia só no registro da concedente em
// `data/sessions/`, que chega à máquina da beneficiária pelo sync do Drive. Na
// madrugada de 16/11/2026 o registro da overnight do `300` ficou parado no Neo
// na versão de 00:47 e a janela de 10 min venceu antes de chegar: interativa no
// Neo + coordenadora no `300` = merge impossível pelo fluxo documentado. A
// concessão passa a ser gravada também no D1 (`merge-grant:{repo}|{beneficiária}`,
// `holder` = concedente, `meta` = o `merge_grant`), e `check-merge-grant`, o
// guard e o consumo a leem de lá quando o arquivo não a tem.
//
// O que NÃO muda (#5716): só `grantMergeWindow` escreve (coordenadora com
// autoridade de merge, nunca para si, nunca para outra coordenadora); quem lê
// exige que a concedente seja coordenadora com autoridade de merge ATIVA,
// TTL de 10 min a partir de `grantedAt`, uso único (marca de consumo no D1 +
// registro da beneficiária), e o merge lock segue valendo.
//
// #13577: "coordenadora ativa" também sai do D1. Até aqui a leitura exigia o
// registro da concedente em `data/sessions/` desta máquina — o mesmo sync do
// Drive que a concessão do D1 existe para contornar. Em 18/11/2026 a linha
// `merge-grant:` estava no D1 com a chave certa e o Neo a descartou: o
// registro da overnight do `300` não estava lá a tempo (o bisync re-sobe o
// arquivo a cada heartbeat e a conferência de hash falha). Agora a
// coordenadora grava a PRÓPRIA presença no D1 (`coordinator:{id}`, kind +
// máquina, TTL = `SOFT_STALE_MS`) no `register` e a cada `grant-merge`, e a
// apaga no `end`. Quem lê aceita a concedente pelo registro local (como
// antes) OU, se o registro local não a mostra ativa, pela presença viva no D1
// com kind de autoridade de merge. Registro local que a mostra com kind SEM
// autoridade (continuo) segue recusando. Nada disso abre caminho de
// autoconcessão: as duas linhas só saem de `grantMergeWindowShared` e
// `registerCoordinatorPresenceShared`, depois das recusas do arquivo.

/** Resultado de `grantMergeWindowShared`: o de `grantMergeWindow` + onde ficou visível. */
export interface SharedGrantMergeResult extends GrantMergeResult {
  /** `d1` = gravada também no D1; `local` = sem D1; `local-fallback` = o D1 não gravou (aviso emitido). */
  backend?: MergeLockBackend;
  /**
   * #13577: a presença da concedente no D1 foi gravada/renovada (`true`) ou
   * não (`false`, aviso emitido). Sem ela, a beneficiária de outra máquina só
   * aceita a concessão do D1 com o registro da concedente já sincronizado lá.
   * Ausente quando o D1 nem foi tentado (`backend` `local`).
   */
  presence?: boolean;
}

/**
 * Grava/renova a presença da coordenadora no D1 (#13577). Só para kind com
 * autoridade de merge; qualquer outro kind é no-op (`null`). Falha do D1 vira
 * aviso, nunca exceção: a presença só amplia quem enxerga a concessão.
 * `false` = o D1 não gravou (aviso emitido); `true` = gravada.
 */
export async function registerCoordinatorPresenceShared(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  meta: { tag?: string } = {},
  opts: SharedLockOptions = {},
): Promise<boolean | null> {
  if (!hasMergeAuthorityKind(kind)) return null;
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return null;
  const warn = opts.warn ?? stderrWarn;
  const presence: D1CoordinatorPresence = { sessionId, kind, machineTag: meta.tag ?? machineTag() };
  const w = await d1WriteCoordinatorPresence(d1, presence, undefined, opts.d1Now !== undefined ? { now: opts.d1Now } : {});
  if (!w.ok) {
    reportD1Failure(repoRoot, "coordinator-presence", w, warn);
    return false;
  }
  if (!w.value.written) {
    warn(
      `⚠️  session-registry (#13577): o D1 tem a linha de presença de ${sessionId} com OUTRO holder — não ` +
        "sobrescrita. Concessões desta coordenadora só valem em outra máquina depois do sync do registro.\n",
    );
    return false;
  }
  return true;
}

/** Apaga a presença da coordenadora no D1 (#13577, `end`). Fail-soft, com aviso. */
export async function clearCoordinatorPresenceShared(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  opts: SharedLockOptions = {},
): Promise<void> {
  if (!hasMergeAuthorityKind(kind)) return;
  await clearPresenceRow(repoRoot, sessionId, "coordinator-presence (end)", opts);
}

/** Apaga a linha `coordinator:{id}` sem olhar kind (#13596). Fail-soft, com aviso. */
async function clearPresenceRow(
  repoRoot: string,
  sessionId: string,
  what: string,
  opts: SharedLockOptions,
): Promise<boolean | null> {
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return null;
  const r = await d1ClearCoordinatorPresence(d1, sessionId);
  if (!r.ok) {
    reportD1Failure(repoRoot, what, r, opts.warn ?? stderrWarn);
    return false;
  }
  return true;
}

/**
 * Presença no D1 depois do `register` (#13596). Kind com autoridade de merge
 * grava/renova (`registerCoordinatorPresenceShared`, como no #13577). Sessão
 * PROMOVIDA de um kind com autoridade para um sem (overnight/develop →
 * continuo/interactive/continuo-review) apaga a linha: sem isso ela seguia
 * atestando a concedente por até 90 min (`COORDINATOR_PRESENCE_D1_TTL_MS`),
 * e numa máquina onde o registro novo ainda não sincronizou a concessão
 * antiga continuaria valendo. Fail-soft: falha do D1 vira aviso (o registro
 * local já valeu). `true` = gravada/apagada; `false` = o D1 falhou; `null` =
 * nada a fazer (sem D1, ou kind sem autoridade que não veio de um com).
 */
export async function reconcileCoordinatorPresenceOnRegister(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  result: Pick<RegisterSessionResult, "previousKind"> & { record: Pick<SessionRecord, "machineTag"> },
  opts: SharedLockOptions = {},
): Promise<boolean | null> {
  if (hasMergeAuthorityKind(kind)) {
    return registerCoordinatorPresenceShared(repoRoot, kind, sessionId, { tag: result.record.machineTag }, opts);
  }
  if (result.previousKind === undefined || !hasMergeAuthorityKind(result.previousKind)) return null;
  return clearPresenceRow(repoRoot, sessionId, "coordinator-presence (rebaixamento de kind)", opts);
}

/**
 * Apaga a presença no D1 das coordenadoras com autoridade de merge cujo
 * registro o GC removeu (#13596). O GC só remove registro parado muito além
 * do TTL da presença, então quase sempre a linha já venceu; esta limpeza
 * cobre a que foi renovada por último perto do fim (ou a de sessão que nunca
 * chamou `end`). Fail-soft por linha: falha do D1 vira aviso e segue. Devolve
 * quantas linhas o D1 confirmou apagar (inclusive as que já não existiam).
 */
export async function clearPresenceForGcRemovals(
  repoRoot: string,
  plan: readonly SessionGcResult[],
  opts: SharedLockOptions & { localTag?: string } = {},
): Promise<number> {
  const localTag = opts.localTag ?? machineTag();
  const ids = new Set<string>();
  for (const entry of plan) {
    if (entry.action !== "removed" || entry.sessionId === undefined || entry.kind === undefined) continue;
    if (!hasMergeAuthorityKind(entry.kind)) continue;
    // #13603: cópia local de coordenadora de OUTRA máquina (o caso do bisync
    // da #13577) não diz nada sobre a sessão: quem renova e limpa a presença
    // dela é a máquina dela (e a linha tem TTL próprio). Registro sem
    // `machineTag` legível também fica de fora: na dúvida, não apaga.
    if (entry.machineTag !== localTag) continue;
    ids.add(entry.sessionId);
  }
  // Sessão que segue viva noutro registro (outro arquivo, outra máquina) não
  // perde a presença por causa de uma cópia velha recolhida. #13603: qualquer
  // registro com autoridade de merge não encerrado na janela de 24h conta,
  // inclusive PARADO (antes, só `!stale`: promovida e parada entre 90 min e
  // 24 h perdia a presença).
  for (const s of listActiveSessions(repoRoot, opts.now)) {
    if (hasMergeAuthorityKind(s.kind)) ids.delete(s.sessionId);
  }
  if (ids.size === 0) return 0;
  // Uma resolução do D1 para todas as linhas (sem D1 configurado: nada a fazer).
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return 0;
  let cleared = 0;
  for (const id of ids) {
    if ((await clearPresenceRow(repoRoot, id, "coordinator-presence (gc)", { ...opts, d1 })) === true) cleared++;
  }
  return cleared;
}

/**
 * `grantMergeWindow` + espelho no D1 (#13242). Todas as recusas são as do
 * arquivo (rodam antes, inalteradas); o D1 só recebe concessão que o arquivo
 * aceitou. Falha do D1 nunca desfaz a concessão local: vira aviso de que ela
 * só chega a outra máquina pelo sync.
 */
export async function grantMergeWindowShared(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  grantedTo: string,
  meta: { pr?: number; repo?: string; tag?: string; now?: string; force?: boolean } = {},
  opts: SharedLockOptions = {},
): Promise<SharedGrantMergeResult> {
  const local = grantMergeWindow(repoRoot, kind, sessionId, grantedTo, meta);
  if (!local.ok || !local.grant) return local;
  const warn = opts.warn ?? stderrWarn;
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return { ...local, backend: "local" };
  const d1Opts = opts.d1Now !== undefined ? { now: opts.d1Now } : {};
  const grant = local.grant;
  // #13577: renova a presença da concedente ANTES da linha da concessão, para
  // a beneficiária nunca ler uma concessão cuja concedente o D1 ainda não
  // atesta. Rodada registrada antes do #13577 ganha a presença aqui.
  const presence = await registerCoordinatorPresenceShared(repoRoot, kind, sessionId, { tag: meta.tag }, { ...opts, d1, warn });
  if (presence === false) {
    warn(
      "⚠️  session-registry (#13577): a presença desta coordenadora não foi gravada no D1 — numa beneficiária de " +
        "OUTRA máquina a concessão do D1 só vale depois que o registro desta sessão sincronizar lá.\n",
    );
  }
  const withPresence = <T extends SharedGrantMergeResult>(r: T): T => (presence === null ? r : { ...r, presence });
  let w = await d1WriteMergeGrant(d1, grant, MERGE_GRANT_TTL_MS, { ...d1Opts, ...(meta.force ? { force: true } : {}) });
  if (w.ok && !w.value.written) {
    // Linha viva de OUTRA concedente. Se ela já foi consumida, não protege
    // nada: substitui. Viva e não consumida: avisa, sem sobrescrever.
    const prior = await d1ReadMergeGrant(d1, grantedTo, grantRepoOf(grant) ?? DEFAULT_ISSUE_REPO, d1Opts);
    const priorConsumed = prior.ok && prior.value ? await isMergeGrantConsumedInD1(d1, prior.value, d1Opts) : null;
    if (priorConsumed?.ok && priorConsumed.value) {
      w = await d1WriteMergeGrant(d1, grant, MERGE_GRANT_TTL_MS, { ...d1Opts, force: true });
    }
  }
  if (!w.ok) {
    reportD1Failure(repoRoot, "grant-merge", w, warn);
    warn(
      "⚠️  session-registry (#13242): a concessão foi gravada só no arquivo de data/sessions/ — numa beneficiária " +
        "de OUTRA máquina ela só aparece quando o sync replicar, e pode vencer antes (TTL de 10 min).\n",
    );
    return withPresence({ ...local, backend: "local-fallback" });
  }
  if (!w.value.written) {
    warn(
      `⚠️  session-registry (#13242): o D1 já tem concessão viva de ${w.value.holder ?? "outra coordenadora"} para ` +
        `${grantedTo}; a sua ficou só no arquivo (visível em outra máquina só depois do sync). Use --force para substituir.\n`,
    );
    return withPresence({ ...local, backend: "local-fallback" });
  }
  return withPresence({ ...local, backend: "d1" });
}

/**
 * #13596: a presença do D1 que se diz DESTA máquina (`machineTag === localTag`)
 * só atesta a concedente com algum registro coordenador da mesma sessão em
 * `sessions` (`listActiveSessions`, janela de 24h, inclusive stale): a
 * coordenadora desta máquina grava o registro no disco local, sem depender de
 * sync, então presença local sem registro é sobra (`end` que não limpou o D1)
 * ou linha escrita sem registro. Presença de outra máquina (ou sem
 * `machineTag`) passa — é o caso que a presença existe para cobrir. Mesma
 * regra de `presenceMachineConsistent` do guard. Pura.
 */
export function presenceMachineConsistent(
  presence: Pick<D1CoordinatorPresence, "sessionId" | "machineTag">,
  sessions: ReadonlyArray<Pick<SessionRecord, "sessionId" | "kind">>,
  localTag: string,
): boolean {
  if (typeof presence.machineTag !== "string" || presence.machineTag !== localTag) return true;
  return sessions.some((s) => s.sessionId === presence.sessionId && isCoordinatorKind(s.kind));
}

/**
 * #13596: aviso de stderr do `check-merge-grant`/`consume-merge-grant` quando a
 * concessão do D1 vale pela PRESENÇA da concedente. A linha `coordinator:` é
 * autodeclarada (quem tem a credencial do D1 grava para qualquer id), então o
 * aceite por ela nunca passa em silêncio. Pura.
 */
export function d1PresenceGrantNotice(grantor: D1PresenceGrantor): string {
  const where = grantor.machineTag !== undefined ? `máquina ${grantor.machineTag}` : "máquina não declarada";
  return (
    `session-registry (#13596): concessão do D1 aceita pela PRESENÇA de ${grantor.sessionId} no D1 ` +
    `(grantorVia: d1-presence, ${grantor.kind}, ${where}) — o registro dela não está ativo nesta máquina. ` +
    "Se essa coordenadora não existe, a linha foi forjada com a credencial do D1.\n"
  );
}

/**
 * Concedente atestada só pelo D1 (#13577): a presença viva dela, sem registro
 * ativo nesta máquina. Mesma forma mínima que o JSON de `check-merge-grant`
 * mostra em `grantedBy`.
 */
export interface D1PresenceGrantor {
  sessionId: string;
  kind: SessionKind;
  machineTag?: string;
  via: "d1-presence";
}

/** #13596: a concedente veio da presença do D1 (e não de um registro desta máquina). */
export function isD1PresenceGrantor(g: ActiveSessionRecord | D1PresenceGrantor): g is D1PresenceGrantor {
  return (g as Partial<D1PresenceGrantor>).via === "d1-presence";
}

/**
 * #13603: algum registro (por arquivo, ANTES da deduplicação de
 * `listActiveSessions`) da sessão `sessionId` é coordenadora SEM autoridade de
 * merge (continuo), não encerrado e com heartbeat na janela de 24h
 * (`MAX_SESSION_AGE_MS`, inclusive parado). Mesma régua de
 * `scan.nonAuthorityIds` no guard (`readActiveCoordinatorScan`). Pura.
 */
export function hasNonAuthorityCoordinatorRecord(
  records: ReadonlyArray<Pick<SessionRecord, "sessionId" | "kind" | "lastHeartbeat" | "startedAt" | "endedAt">>,
  sessionId: string,
  now: number,
): boolean {
  return records.some((r) => {
    if (r.sessionId !== sessionId || !isCoordinatorKind(r.kind) || hasMergeAuthorityKind(r.kind)) return false;
    if (r.endedAt && Number.isFinite(Date.parse(r.endedAt))) return false;
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (!Number.isFinite(hb)) return false;
    const age = now - hb;
    return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= MAX_SESSION_AGE_MS;
  });
}

/** Concessão do D1 que existe mas não vale aqui (#13577): o motivo, para o aviso. */
export interface D1GrantRejection {
  grantedBy: string;
  grantedAt: string;
  /** #13603: `grantor-presence-local-without-record` = a presença no D1 diz
   * ser desta máquina e não há registro coordenador da concedente aqui. */
  reason: "grantor-not-coordinator" | "grantor-unknown" | "grantor-presence-local-without-record";
}

/**
 * Concessão viva para `sessionId` que só o D1 conhece (#13242): a linha
 * `merge-grant:` existe, a concedente é coordenadora com autoridade de merge
 * ATIVA, dentro do TTL de `grantedAt`, sem consumo no registro da beneficiária
 * nem marca de consumo no D1. `null` = nenhuma (ou o D1 não respondeu; `error`
 * diz qual).
 *
 * "Ativa" (#13577): pelo registro desta máquina (`listActiveSessions`, não
 * stale), como antes; ou, quando esse registro não a mostra ativa (ausente ou
 * parado no sync), pela presença viva dela no D1 com kind de autoridade de
 * merge. Registro desta máquina com a concedente como coordenadora SEM
 * autoridade (continuo) recusa mesmo com presença no D1. Concessão que existe
 * no D1 e não vale por causa da concedente volta como `rejected`, para quem
 * chama dizer isso em vez de responder só `granted: false`.
 */
export async function findLiveMergeGrantInD1(
  repoRoot: string,
  sessionId: string,
  repo: string = DEFAULT_ISSUE_REPO,
  opts: SharedLockOptions & { localTag?: string } = {},
): Promise<
  | { grant: MergeGrant; grantedBy: ActiveSessionRecord | D1PresenceGrantor }
  | { error: { error: string; permanent: boolean } }
  | { rejected: D1GrantRejection }
  | null
> {
  const d1 = resolveD1ForRepo(repoRoot, opts);
  if (!d1) return null;
  const d1Opts = opts.d1Now !== undefined ? { now: opts.d1Now } : {};
  const r = await d1ReadMergeGrant(d1, sessionId, repo, d1Opts);
  if (!r.ok) return { error: r };
  const raw = r.value;
  if (!raw) return null;
  const now = opts.now ?? Date.now();
  // TTL e consumo no registro da beneficiária primeiro: concessão vencida ou
  // usada é "nenhuma", nunca "recusada pela concedente".
  const grant = withLedgerConsumption(raw as MergeGrant, readMergeGrantConsumptions(repoRoot));
  if (!isMergeGrantLive(grant, sessionId, now)) return null;
  const sessions = listActiveSessions(repoRoot, now);
  const reject = (reason: D1GrantRejection["reason"]) => ({
    rejected: { grantedBy: raw.grantedBy, grantedAt: raw.grantedAt, reason },
  });
  // Registro local com a concedente como coordenadora sem autoridade de merge:
  // o D1 nunca a promove. #13603: conferido ANTES da deduplicação por
  // `(machineTag, sessionId)` de `listActiveSessions`, registro a registro,
  // como o hook faz (`scan.nonAuthorityIds`): um continuo não encerrado da
  // mesma sessão ao lado de um overnight vivo recusa nos dois lados.
  if (hasNonAuthorityCoordinatorRecord(readMergedSessionGroups(repoRoot, now), raw.grantedBy, now)) {
    return reject("grantor-not-coordinator");
  }
  let grantor: ActiveSessionRecord | D1PresenceGrantor | undefined = sessions.find(
    (s) => s.sessionId === raw.grantedBy && hasMergeAuthorityKind(s.kind) && !s.stale,
  );
  if (!grantor) {
    const p = await d1ReadCoordinatorPresence(d1, raw.grantedBy, d1Opts);
    if (!p.ok) return { error: p };
    if (!p.value) return reject("grantor-unknown");
    if (!hasMergeAuthorityKind(p.value.kind)) return reject("grantor-not-coordinator");
    // #13596: presença que se diz desta máquina sem registro coordenador da
    // concedente aqui é sobra ou linha escrita sem registro — mesma regra do guard.
    if (!presenceMachineConsistent(p.value, sessions, opts.localTag ?? machineTag())) {
      return reject("grantor-presence-local-without-record");
    }
    grantor = {
      sessionId: p.value.sessionId,
      kind: p.value.kind,
      ...(p.value.machineTag !== undefined ? { machineTag: p.value.machineTag } : {}),
      via: "d1-presence",
    };
  }
  const consumed = await isMergeGrantConsumedInD1(d1, grant!, d1Opts);
  if (consumed?.ok && consumed.value) return null;
  if (consumed && !consumed.ok) return { error: consumed };
  return { grant: grant!, grantedBy: grantor };
}

/**
 * Sufixo da linha de sucesso do `grant-merge` (#13577): diz SEMPRE onde a
 * concessão ficou visível. Antes, só o caso bom tinha sufixo, e "não gravou no
 * D1" era a ausência dele, fácil de não notar no stdout. Pura.
 */
export function grantVisibilitySuffix(result: Pick<SharedGrantMergeResult, "backend" | "presence">): string {
  if (result.backend === "d1") {
    return result.presence === false
      ? " (gravada no D1, mas SEM a presença desta coordenadora no D1: em outra máquina só vale depois do sync do registro)"
      : " (gravada também no D1: visível em todas as máquinas)";
  }
  if (result.backend === "local-fallback") {
    return " (SÓ no arquivo de data/sessions/: o D1 NÃO gravou, ver o aviso acima; em outra máquina só depois do sync)";
  }
  return " (SÓ no arquivo de data/sessions/: D1 não configurado nesta máquina; em outra máquina só depois do sync)";
}

/**
 * Aviso de `check-merge-grant`/`consume-merge-grant` quando o D1 TEM a
 * concessão e ela não vale por causa da concedente (#13577). Pura.
 */
export function d1GrantRejectionMessage(r: D1GrantRejection): string {
  if (r.reason === "grantor-presence-local-without-record") {
    // #13603: repetir o grant-merge não resolve (a presença seguiria dizendo
    // ser desta máquina, sem registro aqui).
    return (
      `session-registry (#13603): o D1 tem concessão de ${r.grantedBy} (grantedAt ${r.grantedAt}) para esta sessão, ` +
      "mas ela NÃO vale aqui: a presença da concedente no D1 diz ser DESTA máquina e não há registro coordenador " +
      "dela aqui (sobra de um `end` que não limpou o D1, ou linha gravada sem registro). Repetir o grant-merge não " +
      "resolve: a concedente precisa estar registrada nesta máquina (`session-registry.ts register`), ou a " +
      "concessão tem de vir de uma coordenadora registrada.\n"
    );
  }
  const why =
    r.reason === "grantor-not-coordinator"
      ? "a concedente não tem autoridade de merge (continuo ou kind sem autoridade)"
      : "a concedente não aparece ativa no registro desta máquina nem tem presença viva no D1 " +
        "(rodada registrada antes do #13577 e ainda sem grant-merge novo, ou a presença venceu)";
  return (
    `session-registry (#13577): o D1 tem concessão de ${r.grantedBy} (grantedAt ${r.grantedAt}) para esta sessão, ` +
    `mas ela NÃO vale aqui: ${why}. Peça à concedente para repetir o grant-merge (renova a presença) ou espere o ` +
    "sync do registro dela.\n"
  );
}

/**
 * Atraso do registro de cada coordenadora de OUTRA máquina (#13242): idade do
 * `lastHeartbeat` como esta máquina o vê. Serve ao aviso de `check-merge-grant`
 * quando a resposta é `granted: false` — o registro pode ser a versão de antes
 * da concessão, parado no sync. Pura sobre a lista recebida.
 */
export function staleGrantorRegistrations(
  sessions: ActiveSessionRecord[],
  localTag: string,
  now: number,
  minAgeMs: number = 60_000,
): Array<{ sessionId: string; kind: SessionKind; machineTag: string; ageMinutes: number }> {
  const out: Array<{ sessionId: string; kind: SessionKind; machineTag: string; ageMinutes: number }> = [];
  for (const s of sessions) {
    if (!hasMergeAuthorityKind(s.kind) || s.machineTag === localTag) continue;
    const hb = Date.parse(s.lastHeartbeat ?? "");
    if (!Number.isFinite(hb)) continue;
    const age = now - hb;
    if (age < minAgeMs) continue;
    out.push({ sessionId: s.sessionId, kind: s.kind, machineTag: s.machineTag, ageMinutes: Math.round(age / 60_000) });
  }
  return out;
}
