/**
 * scripts/lib/sessions/claims.ts (#14004)
 *
 * Claims de issue e de worktree: check-and-set, lote (`--issues`), unclaim,
 * auto-registro e as consultas `isIssueClaimedBy*`/`find*SessionsOfKind`.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { withFileLock } from "../file-lock.ts";
import { formatIssueRef, type IssueRef, legacyIssueNumber, normalizeRepoSlug } from "../issue-repos.ts";
import {
  type ActiveSessionRecord,
  hasMergeAuthorityKind,
  type SessionKind,
  type SessionLifecycleEvent,
  type SessionRecord,
} from "./types.ts";
import {
  breakStaleLock,
  machineTag,
  readJsonSafe,
  readMergedRecordForRealFile,
  recoverAnchorFromOrphanBackups,
  sessionFilePath,
  sessionGroupBackupPaths,
  sessionsDir,
  warnAnchorRecoveredFromOrphanBackups,
  writeJsonSafe,
  writeJsonSafeWithCas,
} from "./store.ts";
import { heartbeat, listActiveSessions, registerSession, sessionLifecycleLogPath } from "./registry.ts";

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
  blockedBy?: ActiveSessionRecord;
}

export interface ClaimIssueOptions {
  /**
   * Escape hatch (#6236) — assume a issue mesmo que outra sessão ainda
   * segure o claim segundo `isIssueClaimedByOther` (#7227: isto NÃO é mais
   * o mesmo limiar que `stale`/`SOFT_STALE_MS` — ver `claimReleaseMsForKind`).
   * Existe pro caso legítimo de retomar issue de sessão que morreu sem
   * liberar o registro, mas AINDA dentro da janela de retenção do claim
   * (`claimReleaseMsForKind`, 24h pros 3 kinds coordenadores) — passada essa
   * janela, o claim já destrava sozinho sem `force` (ver `reason: "claimed"`
   * quando o dono anterior já não segura mais), então `force` só entra em
   * jogo contra dono cujo claim ainda vale.
   */
  force?: boolean;
  /** #14213 — espera máxima pelo lock de claims (default `CLAIMS_LOCK_TIMEOUT_MS`). */
  lockTimeoutMs?: number;
}

/**
 * #10618 (fatia 2) — o que um `claim-issue`/`unclaim-issue`/`is-claimed`
 * reivindica: número legado (= `vjpixel/diaria-studio#N`, como sempre) ou uma
 * `IssueRef` qualificada. Ref do repo default é normalizada pro número legado
 * (vai em `claimed_issues`); ref de outro repo vai em `claimed_foreign_issues`
 * como `owner/repo#N` — os dois espaços nunca colidem (`diaria-design#21` ≠
 * `diaria-studio#21`).
 */
export type ClaimIssueTarget = number | IssueRef;

interface ResolvedClaimTarget {
  /** Número a gravar em `claimed_issues` — só quando a issue é do repo default. */
  legacy: number | null;
  /** `owner/repo#N` a gravar em `claimed_foreign_issues` — só quando é de outro repo. */
  foreignKey: string | null;
}

function resolveClaimTarget(issue: ClaimIssueTarget): ResolvedClaimTarget {
  if (typeof issue === "number") return { legacy: issue, foreignKey: null };
  const repo = normalizeRepoSlug(issue.repo);
  if (!repo || !Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error(`claim: identidade de issue inválida (${JSON.stringify(issue)}) (#10618)`);
  }
  const ref = { repo, number: issue.number };
  const legacy = legacyIssueNumber(ref);
  return legacy !== null ? { legacy, foreignKey: null } : { legacy: null, foreignKey: formatIssueRef(ref) };
}

/** #10618 — rótulos (`#N` e `owner/repo#N`) das claims recuperadas de cópias
 * órfãs, pras mensagens do CLI. */
export function recoveredClaimLabels(result: { recoveredClaims?: number[]; recoveredForeignClaims?: string[] }): string[] {
  return [...(result.recoveredClaims ?? []).map((n) => `#${n}`), ...(result.recoveredForeignClaims ?? [])];
}

/** Rótulo pra mensagens: `#N` (legado) ou `owner/repo#N`. */
export function claimTargetLabel(issue: ClaimIssueTarget): string {
  const t = resolveClaimTarget(issue);
  return t.foreignKey ?? `#${t.legacy}`;
}

function recordHoldsClaim(
  record: Pick<SessionRecord, "claimed_issues" | "claimed_foreign_issues"> | null | undefined,
  t: ResolvedClaimTarget,
): boolean {
  if (!record) return false;
  if (t.legacy !== null) return (record.claimed_issues ?? []).includes(t.legacy);
  return (record.claimed_foreign_issues ?? []).includes(t.foreignKey!);
}

function sessionEffectivelyHolds(session: ActiveSessionRecord, t: ResolvedClaimTarget): boolean {
  if (t.legacy !== null) return session.claimed_issues_effective.includes(t.legacy);
  return (session.claimed_foreign_issues_effective ?? []).includes(t.foreignKey!);
}

function withClaimAdded(record: SessionRecord, t: ResolvedClaimTarget, now: string): SessionRecord {
  if (t.legacy !== null) {
    const n = t.legacy;
    const claimed = new Set(record.claimed_issues ?? []);
    claimed.add(n);
    // #6436 — grava o timestamp da PRIMEIRA reivindicação, nunca sobrescreve
    // numa re-reivindicação da mesma issue (`already-own`) — ver docstring de
    // `claimed_issues_at` em `SessionRecord`.
    const claimedAt = { ...(record.claimed_issues_at ?? {}) };
    if (!(String(n) in claimedAt)) claimedAt[String(n)] = now;
    return {
      ...record,
      claimed_issues: [...claimed].sort((a, b) => a - b),
      claimed_issues_at: claimedAt,
      claimed_issues_ever: [...new Set([...(record.claimed_issues_ever ?? []), n])].sort((a, b) => a - b),
    };
  }
  const key = t.foreignKey!;
  const claimed = new Set(record.claimed_foreign_issues ?? []);
  claimed.add(key);
  const claimedAt = { ...(record.claimed_foreign_issues_at ?? {}) };
  if (!(key in claimedAt)) claimedAt[key] = now;
  return {
    ...record,
    claimed_foreign_issues: [...claimed].sort(),
    claimed_foreign_issues_at: claimedAt,
    claimed_foreign_issues_ever: [...new Set([...(record.claimed_foreign_issues_ever ?? []), key])].sort(),
  };
}

function withClaimRemoved(record: SessionRecord, t: ResolvedClaimTarget): SessionRecord {
  if (t.legacy !== null) {
    const n = t.legacy;
    // #6453 — limpa `claimed_issues_at` junto (ver `unclaimIssue`).
    const claimedAt = { ...(record.claimed_issues_at ?? {}) };
    delete claimedAt[String(n)];
    return {
      ...record,
      claimed_issues: (record.claimed_issues ?? []).filter((x) => x !== n),
      claimed_issues_at: claimedAt,
    };
  }
  const key = t.foreignKey!;
  const claimedAt = { ...(record.claimed_foreign_issues_at ?? {}) };
  delete claimedAt[key];
  return {
    ...record,
    claimed_foreign_issues: (record.claimed_foreign_issues ?? []).filter((x) => x !== key),
    claimed_foreign_issues_at: claimedAt,
  };
}

/**
 * #14213 — quanto o claim espera pelo lock de claims antes de desistir com
 * erro. A seção crítica é ler os registros das sessões e gravar uma âncora
 * (milissegundos); 10s é o mesmo teto do `withFileLock` dos registros.
 */
export const CLAIMS_LOCK_TIMEOUT_MS = 10_000;

/**
 * #14213 — lock que serializa o par "checar se outra sessão segura + gravar a
 * claim" entre TODAS as sessões desta máquina. Antes dele, a checagem lia os
 * arquivos das outras sessões sem lock e a escrita travava só o arquivo da
 * própria sessão: duas sessões têm locks diferentes, e num teste com 2
 * processos e 40 issues as duas ganharam as 40.
 *
 * O nome leva o `machineTag()` LOCAL (não o `tag` da sessão): o lock é só
 * intra-máquina, como sempre foi a garantia do claim (entre máquinas a 2ª
 * barreira segue sendo a claim por comentário na issue, `diaria-claim`). Com
 * um nome por máquina, um `.lock` de outra máquina que o sync do `data/`
 * replicar aqui nunca disputa com os claims locais.
 */
export function claimsLockPath(repoRoot: string, host: string = machineTag()): string {
  return join(sessionsDir(repoRoot), `.claims-${host}.lock`);
}

/**
 * #14213 — roda `fn` (checagem + escrita do claim) sob `claimsLockPath`. Usa o
 * mesmo primitivo dos registros (`withFileLock` + `breakStaleLock`, #6952/#9193):
 * criação exclusiva com o dono `{pid, host, ts, token}` gravado, lock de PID
 * morto desta máquina quebrado na hora, lock legado/vazio só depois de
 * `STALE_LOCK_MS`. Liberado em `finally` mesmo se `fn` lançar. Não obter o
 * lock no prazo LANÇA (nunca segue sem ele): o CLI sai com exit 1 e nenhuma
 * claim é gravada.
 */
function withClaimsLock<T>(repoRoot: string, fn: () => T, timeoutMs: number = CLAIMS_LOCK_TIMEOUT_MS): T {
  const lockPath = claimsLockPath(repoRoot);
  mkdirSync(dirname(lockPath), { recursive: true });
  breakStaleLock(lockPath);
  try {
    return withFileLock(lockPath, fn, timeoutMs);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("[file-lock] lock timeout")) {
      throw new Error(
        `claim-issue: lock de claims ocupado há mais de ${timeoutMs}ms (${lockPath}); nenhuma claim gravada. ` +
          "Outra sessão desta máquina está reivindicando agora: rode o claim de novo (#14213)",
        { cause: e },
      );
    }
    throw e;
  }
}

/**
 * Faz check-and-set: adiciona `issueNumber` a `claimed_issues` da sessão
 * (ou, quando é `IssueRef` de outro repo, a `claimed_foreign_issues` como
 * `owner/repo#N` — #10618) SÓ DEPOIS de confirmar que nenhuma OUTRA sessão ativa já a segura (#6236 —
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
 * - Outra sessão ainda segura o claim segundo `isIssueClaimedByOther`
 *   (#7227: dentro de `claimReleaseMsForKind`, não mais só "não-stale") e
 *   `force` não foi passado → recusa, `{ ok: false, reason: "blocked-by-other", blockedBy }`.
 * - Outra sessão ainda segura o claim e `force: true` → toma o claim
 *   mesmo assim, `{ ok: true, reason: "forced-override" }` (chamador deve
 *   avisar alto quem estava segurando, via `blockedBy` do retorno — este
 *   helper não loga por si, é puro).
 * - Ninguém segura (ou só uma sessão cujo claim já passou de
 *   `claimReleaseMsForKind` — `isIssueClaimedByOther` já ignora esse caso,
 *   #5474/#7227) → claim normal, `{ ok: true, reason: "claimed" }`, sem
 *   precisar de `force`.
 *
 * **Não fecha a janela TOCTOU entre MÁQUINAS diferentes** (mesma ressalva do
 * merge lock, #6182): a leitura de `isIssueClaimedByOther` e a escrita deste
 * claim não são atômicas entre si sobre o junction OneDrive — duas máquinas
 * podem, na mesma janela de poucos milissegundos, cada uma ler "ninguém
 * segura" e escrever seu próprio claim, porque `O_CREAT|O_EXCL`/leitura+escrita
 * sobre cópias sincronizadas via OneDrive não é uma transação atômica cross-
 * inode. Dentro da MESMA máquina a janela só fecha por causa do lock de claims
 * (`withClaimsLock`, #14213), que envolve a checagem e a escrita: sem ele, cada
 * sessão travava só o próprio arquivo e as duas da colisão do #6236
 * (`overnight` e `continuo`, na mesma máquina) ainda ganhavam a mesma issue.
 * Falha ao obter o lock lança, sem gravar nada.
 */
export function claimIssueCheckAndSet(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: ClaimIssueTarget,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): ClaimIssueResult {
  const target = resolveClaimTarget(issueNumber);
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!readJsonSafe<SessionRecord>(path)) return { ok: false, reason: "no-op-session-missing" };
  // #14213: checagem e escrita sob o mesmo lock de todas as sessões da máquina.
  return withClaimsLock(
    repoRoot,
    () => claimIssueCheckAndSetLocked(repoRoot, path, sessionId, issueNumber, target, now, options),
    options.lockTimeoutMs,
  );
}

function claimIssueCheckAndSetLocked(
  repoRoot: string,
  path: string,
  sessionId: string,
  issueNumber: ClaimIssueTarget,
  target: ResolvedClaimTarget,
  now: string,
  options: ClaimIssueOptions,
): ClaimIssueResult {
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return { ok: false, reason: "no-op-session-missing" };

  const alreadyOwn = recordHoldsClaim(current, target);
  let reason: ClaimIssueReason = "claimed";
  let overriddenOwner: ActiveSessionRecord | undefined;
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

  // #6952: CAS em vez de read-modify-write solto. O beacon (mesmo arquivo)
  // pode reescrever o record enquanto este claim tenta gravar, e um
  // `...current` congelado apagaria os campos dele (merge_grant,
  // touched_paths, etc.) — exatamente a mesma classe do #6952.
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("claimIssueCheckAndSet: sessão sumiu entre a leitura e a escrita");
      // #10618: `withClaimAdded` grava em `claimed_issues` (repo default) ou
      // `claimed_foreign_issues` (outro repo) — mesma regra #6436 do timestamp.
      return { ...withClaimAdded(current, target, now), lastHeartbeat: now };
    },
    (onDisk) => onDisk?.lastHeartbeat === now && recordHoldsClaim(onDisk, target),
  );
  return overriddenOwner ? { ok: true, reason, blockedBy: overriddenOwner } : { ok: true, reason };
}

/**
 * Resultado de `claimIssueAutoRegistering` — mesmo shape de `ClaimIssueResult`
 * mais o sinal de que a sessão precisou ser auto-registrada antes do claim.
 */
export interface ClaimIssueAutoRegisterResult extends ClaimIssueResult {
  /** `true` quando não havia registro de sessão pra `kind`/`sessionId` e este
   * helper criou um (via `registerSession`) antes de tentar o claim de novo. */
  autoRegistered: boolean;
  /**
   * #7003 — como o registro ausente foi resolvido, quando `autoRegistered`.
   *
   * - `"fresh"`: nenhum vestígio da sessão em disco → registro novo do zero
   *   (o caminho do #6369, sessão que de fato nunca registrou).
   * - `"recovered-from-orphan-backups"`: a âncora sumiu, mas cópias de
   *   conflito VIVAS dela sobreviveram → o registro foi RECONSTRUÍDO a partir
   *   delas (claims, `claimed_issues_at` e `merge_grant` preservados), nunca
   *   recriado zerado. É o modo 3 medido no #7003, e é ruidoso de propósito.
   *
   * Ausente quando `autoRegistered: false`.
   */
  autoRegisterMode?: "fresh" | "recovered-from-orphan-backups";
  /** #7003 — claims que a reconstrução trouxe de volta das cópias órfãs.
   * Presente só em `autoRegisterMode: "recovered-from-orphan-backups"`. */
  recoveredClaims?: number[];
  /** #10618 — claims de OUTRO repo (`owner/repo#N`) que a reconstrução
   * trouxe de volta. Presente só quando há alguma. */
  recoveredForeignClaims?: string[];
  /** #7003 — quantas cópias de conflito alimentaram a reconstrução. */
  recoveredFromFiles?: number;
  /**
   * #13238 — kind do registro onde a claim foi gravada, quando difere do
   * `--kind` pedido. Só aparece no auto-registro `"fresh"` de um kind com
   * autoridade de merge (`overnight`/`develop`): a claim vai para o registro
   * `interactive` da sessão (ver `autoRegisterKindFor`).
   */
  registeredKind?: SessionKind;
}

/**
 * #13238 — kind com que o auto-registro "fresh" (#6369) cria a sessão. Um kind
 * com AUTORIDADE DE MERGE (`overnight`/`develop`) nunca nasce por auto-registro:
 * esse registro é a identidade de coordenadora que o guard do #5716 lê, e o
 * texto do guard já proíbe sessão interativa de rodar `register --kind develop`.
 * O `claim-issue --kind develop` de uma sessão interativa sem registro (16/11/2026,
 * claims da #13217 e da #13235) fazia exatamente isso por um caminho lateral, e
 * passava a bloquear o merge de outras sessões. As rodadas de verdade registram
 * antes do 1º claim (passo 1 do `/diaria-overnight` e do `/diaria-develop`), então
 * não passam por aqui. `continuo` segue como antes: não tem autoridade de merge
 * (#7702) e o cron do Hermes depende desse auto-registro (#6369, consumidor externo).
 * A reconstrução a partir de cópias órfãs (#7003) não usa isto: lá a sessão
 * comprovadamente já existia com aquele kind.
 */
export function autoRegisterKindFor(kind: SessionKind): SessionKind {
  return hasMergeAuthorityKind(kind) ? "interactive" : kind;
}

/** #13238 — aviso do CLI quando a claim foi para o registro de outro kind. */
export function downgradedClaimKindNotice(requested: SessionKind, registered: SessionKind): string {
  return (
    `session-registry: claim-issue — esta sessão não tem registro ${requested}; a claim foi gravada no registro ` +
    `${registered} dela, e nenhum registro ${requested} foi criado (#13238). Auto-registro nunca cria identidade de ` +
    "coordenadora: rodada overnight/develop de verdade registra com `register` antes do 1º claim. Em sessão " +
    "interativa, prefira `--kind interactive`.\n"
  );
}

/**
 * Wrapper de `claimIssueCheckAndSet` que fecha o buraco do #6369: um
 * `no-op-session-missing` (sessão nunca registrada) deixava de ser tratado
 * como falha real por quem chama o CLI e virava um workaround em prosa (ex:
 * o ciclo `continuo` do cron Hermes registrou a reivindicação num `.md` que
 * nenhuma outra sessão lê — achado ao vivo 26/08/2026, quase causou trabalho
 * duplicado entre duas sessões na mesma issue).
 *
 * A issue propôs duas direções equivalentes: "ou o comando aborta o ciclo,
 * ou registra a sessão primeiro". Esta função implementa a 2ª — a única das
 * duas que fecha o buraco inteiramente DENTRO deste repo, sem depender de
 * uma skill externa (`hermes-diaria-continuo`, fora deste checkout — ver
 * CLAUDE.md "A infra do kind `continuo` tem um consumidor EXTERNO") tratar
 * corretamente um `exit 1`. Quando `claimIssueCheckAndSet` devolve
 * `no-op-session-missing`, registra uma sessão mínima (`registerSession`,
 * mesmos `kind`/`sessionId`/`tag` — idempotente, não pisa em registro
 * existente) e tenta o claim de novo. **Nunca finge que não aconteceu nada**:
 * o retorno sinaliza `autoRegistered: true` pra quem chama poder avisar alto
 * (o CLI abaixo imprime isso explicitamente na mensagem de sucesso) — a
 * intervenção fica visível, não é um passe silencioso.
 *
 * `claimIssueCheckAndSet` em si **não muda** — continua podendo devolver
 * `no-op-session-missing` pra quem quiser esse comportamento explícito (é o
 * que os testes existentes de `claimIssueCheckAndSet`/`unclaimIssue`
 * documentam, incluindo o caso "sessão nunca existiu"). Este wrapper é
 * aditivo, usado pelo CLI (`claim-issue`), não substitui a primitiva.
 *
 * **#7003 — "registro ausente" tem duas causas, e tratá-las igual é o bug.**
 * O auto-registro acima assume "sessão nova". A outra causa, medida ao vivo em
 * 01/09/2026, é a âncora SUMIR no meio de uma sessão VIVA (lost-update de
 * escrita sobre o junction OneDrive, #7002): ali o auto-registro converte
 * perda de ARQUIVO em perda SILENCIOSA de ESTADO — recria o registro zerado e
 * segue. A reprodução: 10 `claim-issue` sequenciais, cada um encontrando (ou
 * recriando) uma âncora vazia, terminaram com 3 das 10 claims — e as outras 7
 * sumiram do read-path enquanto a sessão seguia trabalhando nelas.
 *
 * Por isso, antes de registrar do zero, este wrapper procura cópias de
 * conflito ÓRFÃS e VIVAS da própria identidade
 * (`recoverAnchorFromOrphanBackups`) e RECONSTRÓI a âncora a partir delas —
 * claims, `claimed_issues_at` e `merge_grant` preservados. O desfecho fica
 * explícito em `autoRegisterMode` e num aviso alto em stderr: a sessão nunca
 * volta zerada, e a competição de escrita nunca passa silenciosa.
 *
 * **Por que não abortar o claim** (a leitura alternativa de "falhar alto"): um
 * `claim-issue` que aborta deixa uma sessão VIVA sem claim nenhuma — o
 * falso-negativo que a própria #7003 chama de pior que o falso-positivo, e o
 * caminho mais curto pra duas sessões na mesma issue. Ruído + preservação de
 * estado entrega o sinal sem criar o dano.
 */
export function claimIssueAutoRegistering(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: ClaimIssueTarget,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): ClaimIssueAutoRegisterResult {
  const first = claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options);
  if (first.reason !== "no-op-session-missing") {
    return { ...first, autoRegistered: false };
  }
  // #7003: antes de criar um registro NOVO, checar se a âncora sumiu com a
  // sessão viva — ver `recoverAnchorFromOrphanBackups`. Reconstruir preserva
  // as claims anteriores; o auto-registro do #6369, sozinho, as apagava.
  const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
  if (recovered) {
    warnAnchorRecoveredFromOrphanBackups(
      "claim-issue",
      sessionId,
      sessionFilePath(repoRoot, kind, tag, sessionId),
      recovered,
    );
    const retriedAfterRecovery = claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options);
    return {
      ...retriedAfterRecovery,
      autoRegistered: true,
      autoRegisterMode: "recovered-from-orphan-backups",
      recoveredClaims: [...(recovered.record.claimed_issues ?? [])],
      ...((recovered.record.claimed_foreign_issues ?? []).length > 0
        ? { recoveredForeignClaims: [...(recovered.record.claimed_foreign_issues ?? [])] }
        : {}),
      recoveredFromFiles: recovered.files.length,
    };
  }
  // #13238: kind com autoridade de merge não nasce por auto-registro — a claim
  // vai para o registro `interactive` da sessão (o beacon já pode tê-lo criado).
  const regKind = autoRegisterKindFor(kind);
  if (regKind !== kind) {
    const onInteractive = claimIssueCheckAndSet(repoRoot, regKind, sessionId, issueNumber, tag, now, options);
    if (onInteractive.reason !== "no-op-session-missing") {
      return { ...onInteractive, autoRegistered: false, registeredKind: regKind };
    }
  }
  registerSession(repoRoot, regKind, sessionId, { tag, startedAt: now });
  const retried = claimIssueCheckAndSet(repoRoot, regKind, sessionId, issueNumber, tag, now, options);
  return {
    ...retried,
    autoRegistered: true,
    autoRegisterMode: "fresh",
    ...(regKind !== kind ? { registeredKind: regKind } : {}),
  };
}

/** #12010 — desfecho de UMA issue dentro de um claim em lote. */
export interface BatchClaimIssueEntry extends ClaimIssueResult {
  issue: ClaimIssueTarget;
  /** `#N` ou `owner/repo#N` — o mesmo rótulo das mensagens do CLI. */
  label: string;
}

/** #12010 — resultado de `claimIssuesCheckAndSet`. */
export interface BatchClaimIssuesResult {
  /** `true` só quando TODAS as issues do lote terminaram reivindicadas pela sessão. */
  ok: boolean;
  /** Uma entrada por issue distinta, na ordem pedida. */
  entries: BatchClaimIssueEntry[];
  /** Quantas escritas no arquivo-âncora o lote fez: 0 (nada novo a gravar) ou 1. */
  writes: 0 | 1;
}

/**
 * Claim de VÁRIAS issues numa escrita só do arquivo-âncora (#12010).
 *
 * **O problema que isto ataca.** O coordenador reivindica as issues de uma
 * onda antes do fan-out. Feito com N `claim-issue` (em paralelo ou em série),
 * isso dá N read-modify-write do mesmo arquivo em segundos. Dentro da mesma
 * máquina essas escritas já se serializam (`writeJsonSafeWithCas`, lock
 * `{path}.lock`, #6952) e a união do read-path não perde claim — o que a
 * rodada 261103 mediu foi outra coisa: cada escrita é um write-then-rename
 * (inode novo) num diretório sincronizado pelo OneDrive, e a rajada de
 * renames é o que faz o cliente transformar a âncora em cópia de conflito
 * (`-safeBackup-NNNN`), deixando o `claim-issue` seguinte sem âncora e
 * caindo na reconstrução do #7003. Na mesma rodada, até claims em SÉRIE
 * reconstruíram a âncora — então serializar mais não resolve; o que reduz a
 * janela é escrever MENOS vezes. Este lote grava a onda inteira numa escrita.
 *
 * Semântica por issue idêntica a `claimIssueCheckAndSet` (já-minha é no-op de
 * sucesso, de outra sessão ativa é recusa, `force` toma). A recusa de uma
 * issue NÃO impede as outras do lote: é o mesmo resultado de N chamadas
 * independentes, só que numa escrita. Issues repetidas no pedido contam uma
 * vez. A checagem contra outras sessões e a escrita rodam sob o lock de claims
 * da máquina (`withClaimsLock`, #14213), como no claim individual: o lock da
 * âncora (`{path}.lock`) é só do arquivo DESTA sessão e não serializa nada
 * com as outras.
 */
export function claimIssuesCheckAndSet(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issues: readonly ClaimIssueTarget[],
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): BatchClaimIssuesResult {
  const distinct: { issue: ClaimIssueTarget; label: string; target: ResolvedClaimTarget }[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const label = claimTargetLabel(issue);
    if (seen.has(label)) continue;
    seen.add(label);
    distinct.push({ issue, label, target: resolveClaimTarget(issue) });
  }
  if (distinct.length === 0) throw new Error("claimIssuesCheckAndSet: lista de issues vazia (#12010)");

  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const missing = (): BatchClaimIssuesResult => ({
    ok: false,
    writes: 0,
    entries: distinct.map(({ issue, label }) => ({ issue, label, ok: false, reason: "no-op-session-missing" })),
  });
  if (!readJsonSafe<SessionRecord>(path)) return missing();
  // #14213: checagem e escrita do lote inteiro sob o lock de claims da máquina.
  return withClaimsLock(repoRoot, () => {
    const current = readJsonSafe<SessionRecord>(path);
    if (!current) return missing();
    return claimIssuesCheckAndSetLocked(repoRoot, path, sessionId, current, distinct, now, options);
  }, options.lockTimeoutMs);
}

function claimIssuesCheckAndSetLocked(
  repoRoot: string,
  path: string,
  sessionId: string,
  current: SessionRecord,
  distinct: readonly { issue: ClaimIssueTarget; label: string; target: ResolvedClaimTarget }[],
  now: string,
  options: ClaimIssueOptions,
): BatchClaimIssuesResult {
  const nowMs = Date.parse(now);
  const checkMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const entries: BatchClaimIssueEntry[] = [];
  const toAdd: ResolvedClaimTarget[] = [];
  for (const { issue, label, target } of distinct) {
    if (recordHoldsClaim(current, target)) {
      entries.push({ issue, label, ok: true, reason: "already-own" });
      continue;
    }
    const other = isIssueClaimedByOther(repoRoot, issue, sessionId, checkMs);
    if (other && !options.force) {
      entries.push({ issue, label, ok: false, reason: "blocked-by-other", blockedBy: other });
      continue;
    }
    entries.push(
      other
        ? { issue, label, ok: true, reason: "forced-override", blockedBy: other }
        : { issue, label, ok: true, reason: "claimed" },
    );
    toAdd.push(target);
  }

  if (toAdd.length > 0) {
    writeJsonSafeWithCas(
      path,
      (fresh) => {
        if (!fresh) throw new Error("claimIssuesCheckAndSet: sessão sumiu entre a leitura e a escrita");
        let record = fresh;
        for (const target of toAdd) record = withClaimAdded(record, target, now);
        return { ...record, lastHeartbeat: now };
      },
      (onDisk) => onDisk?.lastHeartbeat === now && toAdd.every((t) => recordHoldsClaim(onDisk, t)),
    );
  }
  return { ok: entries.every((e) => e.ok), entries, writes: toAdd.length > 0 ? 1 : 0 };
}

/** #12010 — `claimIssuesCheckAndSet` com o mesmo auto-registro/reconstrução de `claimIssueAutoRegistering`. */
export interface BatchClaimIssuesAutoRegisterResult extends BatchClaimIssuesResult {
  autoRegistered: boolean;
  autoRegisterMode?: "fresh" | "recovered-from-orphan-backups";
  recoveredClaims?: number[];
  recoveredForeignClaims?: string[];
  recoveredFromFiles?: number;
  /** #13238 — ver `ClaimIssueAutoRegisterResult.registeredKind`. */
  registeredKind?: SessionKind;
}

/**
 * Versão em lote de `claimIssueAutoRegistering` (#12010): sessão sem âncora
 * passa pelo mesmo caminho (reconstrução a partir das cópias órfãs vivas,
 * #7003, ou auto-registro do zero, #6369) UMA vez para o lote inteiro, em vez
 * de uma vez por issue.
 */
export function claimIssuesAutoRegistering(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issues: readonly ClaimIssueTarget[],
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): BatchClaimIssuesAutoRegisterResult {
  const first = claimIssuesCheckAndSet(repoRoot, kind, sessionId, issues, tag, now, options);
  if (!first.entries.some((e) => e.reason === "no-op-session-missing")) {
    return { ...first, autoRegistered: false };
  }
  const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
  if (recovered) {
    warnAnchorRecoveredFromOrphanBackups(
      "claim-issue --issues",
      sessionId,
      sessionFilePath(repoRoot, kind, tag, sessionId),
      recovered,
    );
    const retried = claimIssuesCheckAndSet(repoRoot, kind, sessionId, issues, tag, now, options);
    return {
      ...retried,
      autoRegistered: true,
      autoRegisterMode: "recovered-from-orphan-backups",
      recoveredClaims: [...(recovered.record.claimed_issues ?? [])],
      ...((recovered.record.claimed_foreign_issues ?? []).length > 0
        ? { recoveredForeignClaims: [...(recovered.record.claimed_foreign_issues ?? [])] }
        : {}),
      recoveredFromFiles: recovered.files.length,
    };
  }
  // #13238: mesma regra do `claimIssueAutoRegistering` (`autoRegisterKindFor`).
  const regKind = autoRegisterKindFor(kind);
  if (regKind !== kind) {
    const onInteractive = claimIssuesCheckAndSet(repoRoot, regKind, sessionId, issues, tag, now, options);
    if (!onInteractive.entries.some((e) => e.reason === "no-op-session-missing")) {
      return { ...onInteractive, autoRegistered: false, registeredKind: regKind };
    }
  }
  registerSession(repoRoot, regKind, sessionId, { tag, startedAt: now });
  const retried = claimIssuesCheckAndSet(repoRoot, regKind, sessionId, issues, tag, now, options);
  return {
    ...retried,
    autoRegistered: true,
    autoRegisterMode: "fresh",
    ...(regKind !== kind ? { registeredKind: regKind } : {}),
  };
}

/**
 * Resultado de `heartbeatAutoRegistering` — mesmo shape de
 * `ClaimIssueAutoRegisterResult`, mas sem `reason`/`blockedBy` (heartbeat não
 * disputa dono de issue, só confirma vivacidade).
 */
export interface HeartbeatAutoRegisterResult {
  /** `true` quando o heartbeat (a 1ª tentativa, ou o retry pós auto-registro)
   * de fato atualizou `lastHeartbeat`. Só falso quando até o retry pós
   * auto-registro falhou — não deveria acontecer (mesma rede de segurança de
   * `claim-issue`, ver comentário do case "heartbeat" no CLI). */
  ok: boolean;
  autoRegistered: boolean;
  autoRegisterMode?: "fresh" | "recovered-from-orphan-backups";
  recoveredClaims?: number[];
  recoveredFromFiles?: number;
  /** #11059 — `true` quando o heartbeat foi RECUSADO por a sessão já ter
   * chamado `end` (evento `"ended"` no log de lifecycle). `ok` fica `false`,
   * mas é no-op benigno (o CLI sai 0), não falha: reativar a sessão encerrada
   * a deixava aparecendo como "outra sessão ativa" até expirar. */
  alreadyEnded?: boolean;
}

/** #11059 — `true` se o log de lifecycle tem um evento `"ended"` pra esta
 * identidade (kind + tag + sessionId). Best-effort, nunca lança: log ausente
 * (`data/` ausente) ou ilegível => `false` (comportamento pré-#11059). */
export function sessionHasEndedEvent(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  tag: string = machineTag(),
): boolean {
  try {
    const logPath = sessionLifecycleLogPath(repoRoot);
    if (!existsSync(logPath)) return false;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.includes(sessionId)) continue;
      try {
        const ev = JSON.parse(line) as Partial<SessionLifecycleEvent>;
        if (ev.event === "ended" && ev.kind === kind && ev.sessionId === sessionId && ev.machineTag === tag) return true;
      } catch {
        // linha corrompida — ignora.
      }
    }
  } catch {
    // best-effort.
  }
  return false;
}

/**
 * Wrapper de `heartbeat` que fecha o MESMO buraco que `claimIssueAutoRegistering`
 * fechou pra `claim-issue` (#6369/#7003), agora pro `heartbeat` (#8443).
 *
 * **Por que o heartbeat também precisava disto.** O ciclo `continuo` do cron
 * Hermes chama `session-registry.ts register --kind continuo` como um passo em
 * PROSA no início do tick (SKILL.md, "Preparar e sincronizar") — o `claim-issue`
 * já tinha essa mesma dependência de prosa e o #6369 fechou o buraco pra ele.
 * O `heartbeat`, entretanto, é chamado em MUITO mais pontos do loop do que
 * `claim-issue` — inclusive no caminho que **nunca** reivindica issue nova (fila
 * de PRs abertos, conserto de CI, guard de colisão com a edição diária, que
 * instrui `heartbeat --phase pausado-edicao` e vai direto dormir) — então um
 * tick que pula o `register` explícito e não chega a reivindicar nenhuma issue
 * nova continuava, até aqui, SEM NENHUM registro de sessão em `data/sessions/`,
 * mesmo tendo rodado (e mesmo chamando `heartbeat` várias vezes). Medido ao
 * vivo: `scripts/check-continuo-session-registration.ts` (#7890) reportou 11 de
 * 19 ticks recentes sem sessão `continuo` correlacionada (#8443) — o auto-
 * registro do `claim-issue` sozinho não cobre esse caminho porque ele só
 * dispara quando uma issue NOVA é de fato reivindicada.
 *
 * Mesma lógica do `claimIssueAutoRegistering`: tenta o `heartbeat` normal
 * primeiro; se a sessão não existe, procura cópias de conflito órfãs e vivas
 * da própria identidade antes de assumir "sessão nova" (mesma ressalva do
 * #7002/#7003 — a âncora pode ter sumido no meio de uma sessão viva, não
 * nunca ter existido); só cria um registro do zero quando não há nada pra
 * recuperar. `autoRegistered`/`autoRegisterMode` no retorno tornam a
 * intervenção visível pra quem chama (o CLI abaixo avisa alto), nunca um
 * passe silencioso.
 */
export function heartbeatAutoRegistering(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {},
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): HeartbeatAutoRegisterResult {
  const first = heartbeat(repoRoot, kind, sessionId, patch, tag, now);
  if (first) return { ok: true, autoRegistered: false };
  const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
  if (recovered) {
    warnAnchorRecoveredFromOrphanBackups(
      "heartbeat",
      sessionId,
      sessionFilePath(repoRoot, kind, tag, sessionId),
      recovered,
    );
    const retried = heartbeat(repoRoot, kind, sessionId, patch, tag, now);
    return {
      ok: retried,
      autoRegistered: true,
      autoRegisterMode: "recovered-from-orphan-backups",
      recoveredClaims: [...(recovered.record.claimed_issues ?? [])],
      ...((recovered.record.claimed_foreign_issues ?? []).length > 0
        ? { recoveredForeignClaims: [...(recovered.record.claimed_foreign_issues ?? [])] }
        : {}),
      recoveredFromFiles: recovered.files.length,
    };
  }
  // #11059: sessão que já chamou `end` NÃO é "sessão nunca registrada" — um
  // heartbeat de fechamento depois do `end` (Fase 2 do /diaria-develop) a
  // ressuscitava como ativa. Recusa como no-op benigno.
  if (sessionHasEndedEvent(repoRoot, kind, sessionId, tag)) {
    return { ok: false, autoRegistered: false, alreadyEnded: true };
  }
  registerSession(repoRoot, kind, sessionId, { tag, startedAt: now });
  const retried = heartbeat(repoRoot, kind, sessionId, patch, tag, now);
  return { ok: retried, autoRegistered: true, autoRegisterMode: "fresh" };
}

/**
 * Wrapper booleano de `claimIssueCheckAndSet` (#6236) — mantém a assinatura
 * histórica (`true`/`false`) pros chamadores que só precisam saber se o
 * claim colou, sem inspecionar o motivo. Ver `claimIssueCheckAndSet` para o
 * comportamento completo (check-and-set contra outras sessões ativas,
 * idempotência, `force`).
 */

/**
 * Claim de worktree — uma sessão reivindica o CAMINHO de um worktree
 * para impedir adoção por outra sessão (#7722 item 3). Se outro
 * registro vivo já reivindica o mesmo path, recusa.
 *
 * **CORREÇÃO (#7892, 09-10/09/2026) — chave por PATH, não por `sessionId`.**
 * A versão original (#7722/PR #7810) gravava a claim como um campo único
 * (`worktree_claim`) DENTRO do arquivo de sessão indexado por `sessionId`
 * (`sessionFilePath(root, "continuo", tag, sessionId)`) — um record por
 * sessão, um `worktree_claim` por record. Isso pressupõe que `sessionId`
 * identifica univocamente "quem está reivindicando o quê", premissa que o
 * #7712 mediu como FALSA (4 medições independentes, ver docblock de
 * `block-gh-pr-merge-subagent.mjs`): um subagente despachado via ferramenta
 * `Agent` com `isolation: "worktree"` herda LITERALMENTE o `session_id` do
 * coordenador que o despachou — não tem identidade própria. Quando o
 * coordenador despacha N subagentes concorrentes em worktrees DISTINTOS
 * (padrão normal do overnight/develop, até vários simultâneos), todos
 * calculam o MESMO `file` (mesmo `sessionId`) — o último `claimWorktree` a
 * escrever sobrescreve o `worktree_claim` do anterior em silêncio, e a
 * varredura de "outra sessão com mesmo path" (`findActiveSessionFiles`)
 * também nunca via os próprios concorrentes, porque lia
 * `data/sessions/{kind}/` (um SUBDIRETÓRIO que este mecanismo nunca escreve)
 * enquanto `sessionFilePath` grava achatado em `data/sessions/{kind}-{tag}-
 * {sessionId}.json` — os dois caminhos nunca se cruzavam, então a detecção
 * de colisão nunca disparava, independente do problema de identidade.
 *
 * Fix: a claim passa a ser indexada pelo PRÓPRIO worktree — um arquivo por
 * PATH reivindicado (`worktreeClaimFilePath`, hash estável do path
 * normalizado), não um campo dentro do record da sessão. Dois `claimWorktree`
 * com o MESMO `sessionId` (subagentes-irmãos do mesmo coordenador) mas paths
 * DIFERENTES nunca tocam o mesmo arquivo — não colidem, cada um reivindica o
 * seu. Duas chamadas para o MESMO path — a única forma de "colisão real"
 * fazer sentido aqui — continuam detectadas: se o claim vivo no arquivo
 * pertence a OUTRO `sessionId`, recusa (`false`); se é do MESMO `sessionId`
 * (o mesmo subagente reconfirmando, ou o coordenador verificando o que já é
 * seu), é idempotente — renova o TTL, aceita (`true`).
 *
 * `sessionId` continua sendo o discriminador de "é o mesmo dono?" — o que
 * mudou é o que serve de CHAVE de armazenamento (path, não sessionId), o que
 * é exatamente o efeito de uma chave composta (path, sessionId) sem precisar
 * escrever N registros por sessão: o path já distingue os concorrentes, o
 * sessionId dentro do arquivo resolve o resto.
 *
 * O `worktree_claim` era também mirrorado no record da sessão para o hook
 * `.claude/hooks/block-worktree-alien-commit.mjs`; o mirror saiu no #14214
 * (o hook deixou de lê-lo no #7903, abaixo, e a escrita criava um arquivo
 * `continuo-*` que o GC nunca recolhia). A fonte de verdade é sempre o
 * arquivo indexado por path.
 *
 * **CORREÇÃO (#7903, 10/09/2026)** — o hook consumidor lia SÓ o mirror
 * (`data/sessions/*.json`), nunca o arquivo indexado por path descrito
 * acima, então herdava o mesmo problema de last-writer-wins que este
 * refactor (#7892) já tinha corrigido na escrita: sessão B reivindica wt1 e
 * depois wt2 → o mirror de B aponta só pra wt2, e a sessão A commitando em
 * wt1 passava batido mesmo com a claim de B sobre wt1 ainda viva no arquivo
 * autoritativo. O hook foi corrigido pra ler `worktreeClaimFilePath`
 * diretamente (cópia self-contained da mesma lógica de chave). `branch`
 * (parâmetro novo aqui) é o 2º fix do #7903: grava a branch do HEAD no
 * momento do claim pra o hook comparar contra o HEAD atual e detectar troca
 * de branch por baixo — o check anterior (`git worktree list --porcelain`
 * vs. `git rev-parse HEAD`, ambos do MESMO worktree) nunca podia divergir
 * por construção.
 */
function worktreeClaimKey(path: string): string {
  // #7900 Finding 4: sem `.toLowerCase()` de propósito, ao contrário de
  // `isCallerInLinkedWorktree` (`block-gh-pr-merge-subagent.mjs`) — lá o
  // lowercase existe pra tolerar capitalização de drive DIVERGENTE que o
  // próprio `git rev-parse` pode devolver no Windows para o MESMO `.git`.
  // Aqui o `path` é fornecido pelo chamador, não derivado de `git
  // rev-parse` — dois worktrees REAIS e DISTINTOS que só diferem em
  // capitalização são um caso real (Linux é case-sensitive); normalizar
  // caixa aqui trocaria "path controlado" por "colisão falsa" sem nenhum
  // ganho equivalente ao caso do guard de merge.
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function worktreeClaimsDir(root: string): string {
  return join(root, "data", "sessions", ".worktree-claims");
}

function worktreeClaimFilePath(root: string, path: string): string {
  return join(worktreeClaimsDir(root), `${worktreeClaimKey(path)}.json`);
}

/**
 * Validade de uma claim de worktree (#14214). Era 30 min fixos e nada renovava,
 * então o guard do hook vencia no meio da maioria das unidades. Agora são 3h,
 * renovadas a cada `heartbeat` da sessão dona (`renewWorktreeClaimsForSession`)
 * e por `claim-worktree --renew`. A claim de unidade terminada sai por
 * `unclaim-worktree`; a esquecida vence e o `gc` a recolhe.
 */
export const WORKTREE_CLAIM_TTL_MS = 3 * 60 * 60 * 1000;

/** Claim vencida há mais que isto sai no `gc` (`gcExpiredWorktreeClaims`). */
const WORKTREE_CLAIM_GC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface WorktreeClaimRecord {
  path?: string;
  sessionId?: string;
  branch?: string;
  claimed_at?: string;
  expires_at?: number;
}

function listWorktreeClaimFiles(root: string): string[] {
  const dir = worktreeClaimsDir(root);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Renova (`expires_at` = agora + TTL) as claims de worktree VIVAS da sessão,
 * sem tocar em `branch` (#14214). Chamada pelo `heartbeat` do CLI: a sessão
 * que bate heartbeat segue viva, e os worktrees que ela reivindicou seguem
 * protegidos enquanto isso. Claim já vencida não ressuscita — vencer é o sinal
 * de abandono. Devolve quantas renovou.
 */
export function renewWorktreeClaimsForSession(repoRoot: string, sessionId: string, nowMs: number = Date.now()): number {
  let renewed = 0;
  for (const file of listWorktreeClaimFiles(repoRoot)) {
    const peek = readJsonSafe<WorktreeClaimRecord>(file);
    if (!peek || peek.sessionId !== sessionId || (peek.expires_at ?? 0) <= nowMs) continue;
    const lockPath = `${file}.lock`;
    breakStaleLock(lockPath);
    withFileLock(lockPath, () => {
      const current = readJsonSafe<WorktreeClaimRecord>(file);
      if (!current || current.sessionId !== sessionId || (current.expires_at ?? 0) <= nowMs) return;
      writeJsonSafe(file, { ...current, expires_at: nowMs + WORKTREE_CLAIM_TTL_MS });
      renewed += 1;
    });
  }
  return renewed;
}

/** Desfecho de `unclaimWorktree`. */
type UnclaimWorktreeOutcome = "unclaimed" | "no-op-not-claimed" | "blocked-by-other";

/**
 * Solta a claim de worktree, só quando é da própria sessão (#14214): fim da
 * unidade ou cleanup do worktree. Claim de outra sessão nunca sai daqui.
 */
export function unclaimWorktree(path: string, sessionId: string, repoRoot: string): UnclaimWorktreeOutcome {
  const claimFile = worktreeClaimFilePath(repoRoot, resolve(path));
  if (!existsSync(claimFile)) return "no-op-not-claimed";
  const lockPath = `${claimFile}.lock`;
  breakStaleLock(lockPath);
  let outcome: UnclaimWorktreeOutcome = "no-op-not-claimed";
  withFileLock(lockPath, () => {
    const current = readJsonSafe<WorktreeClaimRecord>(claimFile);
    if (!current) return;
    if (current.sessionId !== sessionId) {
      outcome = "blocked-by-other";
      return;
    }
    rmSync(claimFile, { force: true });
    outcome = "unclaimed";
  });
  return outcome;
}

/**
 * Remove as claims de worktree vencidas há mais de `olderThanMs` (#14214).
 * Chamada pelo `gc` do CLI. `dryRun` só lista. Claim ilegível fica (pode ser
 * escrita em curso); vencida há pouco também (o hook já a ignora).
 */
export function gcExpiredWorktreeClaims(
  repoRoot: string,
  opts: { nowMs?: number; olderThanMs?: number; dryRun?: boolean } = {},
): string[] {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - (opts.olderThanMs ?? WORKTREE_CLAIM_GC_AFTER_MS);
  const removed: string[] = [];
  for (const file of listWorktreeClaimFiles(repoRoot)) {
    const record = readJsonSafe<WorktreeClaimRecord>(file);
    const expiresAt = record?.expires_at;
    if (typeof expiresAt !== "number" || expiresAt > cutoff) continue;
    if (!opts.dryRun) rmSync(file, { force: true });
    removed.push(record?.path ?? file);
  }
  return removed;
}

export function claimWorktree(path: string, sessionId: string, repoRoot?: string, branch?: string): boolean {
  // #7900 fleet review Finding 1 (P1/alta): a versão anterior fazia um
  // read→check→write DESTRAVADO no arquivo de claim — TOCTOU clássico. Duas
  // chamadas concorrentes (dois subagentes-irmãos tentando o MESMO path por
  // engano, ou uma sessão intrusa correndo contra a dona no exato incidente
  // que o #7722 existe pra prevenir) podiam ler "livre" ao mesmo tempo e as
  // duas escreverem "ganhei", justamente o bug de colisão que este mecanismo
  // deveria detectar. O arquivo já tem `withFileLock`/`breakStaleLock` pra
  // essa classe exata de bug (mesma raiz do #6952 noutro campo deste
  // registro) — reusado aqui em vez de reinventado.
  const root = repoRoot || process.cwd();
  const claimFile = worktreeClaimFilePath(root, path);
  const lockPath = `${claimFile}.lock`;
  const nowMs = Date.now();
  const ttl = WORKTREE_CLAIM_TTL_MS;

  mkdirSync(dirname(claimFile), { recursive: true });
  breakStaleLock(lockPath); // lock órfão (dono morreu) não pode travar o claim pra sempre

  let claimed = false;
  let claimedAt = new Date().toISOString();
  let resolvedBranch: string | undefined;
  withFileLock(lockPath, () => {
    const currentClaim = readJsonSafe<any>(claimFile);
    const claimLive = currentClaim && (currentClaim.expires_at ?? 0) > nowMs;
    if (claimLive && currentClaim.sessionId !== sessionId) {
      return; // outro dono (sessionId distinto) segura este path vivo — recusa
    }
    claimedAt = claimLive && currentClaim.sessionId === sessionId ? currentClaim.claimed_at : claimedAt;
    // `branch` (#7903): grava a branch do HEAD no momento do claim, pra
    // `block-worktree-alien-commit.mjs` comparar contra o HEAD atual e
    // detectar troca de branch por baixo — sem isso, comparar HEAD com
    // `git worktree list --porcelain` (versão anterior) é sempre igual por
    // construção (as duas derivam do mesmo HEAD), código morto que parecia
    // proteção. `branch` omitido (chamador não informou) preserva o valor
    // já gravado, se houver — nunca apaga um branch conhecido por omissão.
    resolvedBranch = branch ?? (claimLive ? currentClaim.branch : undefined);
    writeJsonSafe(claimFile, { path, sessionId, branch: resolvedBranch, claimed_at: claimedAt, expires_at: nowMs + ttl });
    claimed = true;
  });

  // #14214: o mirror `worktree_claim` no record da sessão saiu. Ele gravava
  // em `sessionFilePath(root, "continuo", machineTag(), sessionId)` — kind
  // fixo e tag da máquina, não os da sessão —, criando um arquivo
  // `continuo-*` sem `sessionId`/`kind` que o GC via como ilegível e nunca
  // recolhia. Desde o #7903 o hook lê só o arquivo indexado por path
  // (`.worktree-claims/`), então o mirror não tinha mais leitor. Espelhos
  // antigos que já estão no disco são recolhidos por `planSessionGc`
  // (`isWorktreeClaimMirror`).
  return claimed;
}

/** Desfecho de `claimWorktreeChecked` (#14214, subcomando `claim-worktree`).
 * Sem `export`: só o próprio retorno usa (knip acusaria export morto). */
type ClaimWorktreeOutcome =
  | { outcome: "claimed"; path: string; branch: string | undefined }
  | { outcome: "blocked-by-other"; path: string; ownerSessionId: string | null }
  | { outcome: "not-a-linked-worktree"; path: string }
  /** `--renew` sem claim viva da própria sessão: não há o que renovar. */
  | { outcome: "nothing-to-renew"; path: string }
  /** Claim viva da própria sessão com OUTRA branch, sem `--rebind`: a
   * divergência é a evidência que `BLOCK_REASON_BRANCH_DIVERGE` existe para
   * mostrar, e regravar a branch em silêncio a apagaria. */
  | { outcome: "branch-mismatch"; path: string; claimedBranch: string; headBranch: string };

/**
 * Modo do `claim-worktree` (#14214, review da PR #14303):
 * - `claim` (default): 1ª claim, grava a branch do HEAD. Recusa
 *   (`branch-mismatch`) se a própria sessão já tem claim viva com outra branch.
 * - `renew`: só estende o TTL da claim viva da própria sessão; a branch gravada
 *   fica (chama `claimWorktree(..., undefined)`).
 * - `rebind`: regrava a branch do HEAD, para quando o PRÓPRIO agente fez o
 *   checkout de outra branch no worktree.
 */
type ClaimWorktreeMode = "claim" | "renew" | "rebind";

/**
 * Entrada do subcomando `claim-worktree` (#14214): até aqui nada em produção
 * chamava `claimWorktree`, e o hook `.claude/hooks/block-worktree-alien-commit.mjs`
 * lia um `.worktree-claims/` que ninguém gravava.
 *
 * Diferenças para `claimWorktree` cru:
 * - `path` passa por `resolve()`, a mesma normalização que o hook aplica ao
 *   `git rev-parse --show-toplevel` antes de calcular a chave: um caminho
 *   relativo daria outro hash e o hook não acharia a claim.
 * - Só reivindica WORKTREE VINCULADO (`.git` é arquivo, não diretório). O hook
 *   ignora o checkout principal, e uma claim nele (o checkout compartilhado
 *   por todas as sessões) barraria o commit das outras sessões ali.
 * - Na recusa, devolve quem segura o path, para a mensagem do CLI.
 */
export function claimWorktreeChecked(
  path: string,
  sessionId: string,
  repoRoot: string,
  branch?: string,
  mode: ClaimWorktreeMode = "claim",
  nowMs: number = Date.now(),
): ClaimWorktreeOutcome {
  const normalized = resolve(path);
  const gitPath = join(normalized, ".git");
  let linked = false;
  try {
    linked = existsSync(gitPath) && !statSync(gitPath).isDirectory();
  } catch {
    linked = false;
  }
  if (!linked) return { outcome: "not-a-linked-worktree", path: normalized };
  const existing = readJsonSafe<WorktreeClaimRecord>(worktreeClaimFilePath(repoRoot, normalized));
  const ownLive = !!existing && existing.sessionId === sessionId && (existing.expires_at ?? 0) > nowMs;
  if (mode === "renew" && !ownLive) return { outcome: "nothing-to-renew", path: normalized };
  if (mode === "claim" && ownLive && existing?.branch && branch && existing.branch !== branch) {
    return { outcome: "branch-mismatch", path: normalized, claimedBranch: existing.branch, headBranch: branch };
  }
  if (claimWorktree(normalized, sessionId, repoRoot, mode === "renew" ? undefined : branch)) {
    const record = readJsonSafe<any>(worktreeClaimFilePath(repoRoot, normalized));
    return { outcome: "claimed", path: normalized, branch: record?.branch ?? branch };
  }
  const owner = readJsonSafe<any>(worktreeClaimFilePath(repoRoot, normalized));
  const ownerSessionId = typeof owner?.sessionId === "string" ? owner.sessionId : null;
  return { outcome: "blocked-by-other", path: normalized, ownerSessionId };
}

export function claimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: ClaimIssueTarget,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): boolean {
  return claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options).ok;
}

/**
 * Loga (stderr, nunca lança) que `unclaimIssue` achou o arquivo da PRÓPRIA
 * sessão em disco mas não conseguiu ler o conteúdo (#6337 fleet review item
 * 2 — mesma classe de bug que `warnUnreadablePromotionSource`/
 * `outcome: "promotion-failed-unreadable"` corrigiram em `registerSession`,
 * #6326). `readJsonSafe` devolve `null` tanto pra "arquivo ausente" quanto
 * pra "JSON malformado" — SEM logar o segundo caso (comentário no próprio
 * `readJsonSafe`: "comportamento pré-existente preservado, silencioso").
 * Colapsar os dois em `no-op-session-missing` faria o chamador (a skill)
 * tratar uma claim que está ATIVA no disco — só momentaneamente ilegível,
 * cenário recorrente de sync do OneDrive, ver #5161/#6130/#6326 — como se a
 * sessão nunca tivesse existido, seguindo em frente sem soltar nada e sem
 * nenhum sinal de que algo está errado.
 */
function warnUnclaimUnreadable(sessionId: string, path: string): void {
  try {
    process.stderr.write(
      `session-registry: aviso — unclaim-issue achou o registro de sessionId="${sessionId}" em "${path}" mas ` +
        "não conseguiu ler o conteúdo (JSON corrompido/parcialmente sincronizado pelo Drive). A claim pode " +
        'estar ATIVA no disco — isto NÃO é "sessão inexistente" (reason: "no-op-unreadable"); investigar antes de ' +
        "assumir que não há nada pra soltar.\n",
    );
  } catch {
    // Nunca deixar um log de warning quebrar o caminho fail-soft principal.
  }
}

/**
 * Motivo do resultado de `unclaimIssue` (#6317) — espelha `ClaimIssueReason`
 * no formato, mas o conjunto é o inverso: nenhum caso carrega `blockedBy`
 * (não existe "outra sessão bloqueando" pra soltar — só a própria sessão
 * pode `unclaim`, ver docstring de `unclaimIssue`). `no-op-unreadable`
 * (#6337 fleet review item 2) é distinto de `no-op-session-missing` de
 * propósito — ver `warnUnclaimUnreadable` acima pro racional.
 */
export type UnclaimIssueReason = "unclaimed" | "no-op-not-claimed" | "no-op-session-missing" | "no-op-unreadable";

export interface UnclaimIssueResult {
  ok: boolean;
  reason: UnclaimIssueReason;
}

/**
 * Inverso de `claimIssueCheckAndSet` (#6317) — remove `issueNumber` de
 * `claimed_issues` da PRÓPRIA sessão (`kind`+`tag`+`sessionId`) e regrava com
 * o mesmo `writeJsonSafe` atômico. Existe porque `claim-issue` não tinha
 * inverso: a única forma de soltar uma issue era `end`, que encerra a sessão
 * inteira e solta TODAS — inviável para uma sessão longa que termina uma
 * issue no meio de outras ainda em voo (#6317, evidência 1 do #6168
 * acontecendo de novo).
 *
 * **Só remove da própria sessão — nunca mexe na claim de outra** (mesma
 * disciplina de `releaseMergeLock`, que recusa liberar lock alheio). Não há
 * parâmetro `force`/`sessionId` alheio nesta função de propósito: não existe
 * caso de uso legítimo de uma sessão soltar a claim de outra — isso é
 * responsabilidade de `end` (a sessão dona morreu) ou de staleness
 * (`SOFT_STALE_MS`) destravando sozinha. **O que de fato garante "só a
 * própria sessão"** não é o TIPO de `sessionId` (é `string` crua, igual
 * `claimIssueCheckAndSet`/`registerSession`/`heartbeat` — deliberadamente não
 * branded aqui pra não criar inconsistência nova só neste ponto do módulo) —
 * é `.claude/hooks/inject-session-id.mjs` injetando o `session_id` REAL do
 * payload do harness antes do comando rodar; um chamador que forjasse
 * `--session-id` manualmente contornaria isso, mas nenhum call site
 * documentado faz isso (mesma confiança que todo o resto do módulo deposita
 * na injeção automática).
 *
 * Quatro desfechos, nenhum deles lança:
 * - Sessão do próprio `sessionId`/`tag` NUNCA existiu (arquivo ausente) →
 *   `{ ok: false, reason: "no-op-session-missing" }`.
 * - Arquivo EXISTE mas não pôde ser lido (JSON corrompido/parcial — comum
 *   durante sync do OneDrive) → `{ ok: false, reason: "no-op-unreadable" }`,
 *   com aviso em stderr (`warnUnclaimUnreadable`) — distinto do caso acima de
 *   propósito (#6337 fleet review item 2): a claim pode estar ATIVA no disco,
 *   só momentaneamente ilegível, e reportar "sessão inexistente" faria o
 *   chamador seguir em frente sem soltar nada e sem nenhum sinal de alerta —
 *   exatamente a classe de bug que `outcome: "promotion-failed-unreadable"`
 *   corrigiu em `registerSession` (#6326).
 * - Issue não estava em `claimed_issues` desta sessão → **no-op honesto**,
 *   `{ ok: false, reason: "no-op-not-claimed" }` — nunca finge sucesso (mesmo
 *   padrão que `endSession` adotou no #5797: distinguir "removeu" de "não
 *   havia o que remover", nunca reportar `ok: true` sem uma mudança real de
 *   estado em disco).
 * - Issue estava reivindicada → remove, regrava, `{ ok: true, reason:
 *   "unclaimed" }`.
 *
 * **Não é compare-and-swap** — herda a mesma limitação de lost-update já
 * documentada em `writeJsonSafe` (o beacon escreve neste MESMO arquivo a
 * cada chamada de ferramenta da sessão): entre a leitura e a escrita deste
 * `unclaimIssue`, um write concorrente do beacon pode perder campos. Mesmo
 * risco residual que o resto do módulo aceita nesse arquivo, não uma
 * regressão nova introduzida aqui.
 *
 * **#6481 — mescla com `-safeBackup-*` ANTES de checar `claimed_issues`,
 * mesma disciplina fail-safe do read-path.** Até aqui esta função lia só o
 * arquivo "real" (`readJsonSafe(path)`) — mas `data/sessions/` é uma junction
 * OneDrive, e um write concorrente (tipicamente o beacon batendo heartbeat no
 * MESMO arquivo entre o `claim-issue` e a tentativa de `unclaim-issue`) pode
 * bifurcar o arquivo em cópias de conflito `-safeBackup-N`, deixando o
 * arquivo "real" com uma versão do `claimed_issues` que NÃO inclui a issue
 * que uma cópia de conflito carrega. Sem merge, `unclaimIssue` devolvia
 * `no-op-not-claimed` — indistinguível de "esta sessão nunca reivindicou essa
 * issue" — mesmo com a issue genuinamente presente em disco (achado ao vivo
 * #6481: `unclaim-issue --issue 6431`/`--issue 6459` falharam assim 2× cada,
 * enquanto `list-active` mostrava as duas em `claimed_issues` da mesma
 * sessão). `readMergedRecordForRealFile` é a MESMA primitiva que
 * `registerSession` (#6326) já usa para não perder claim na promoção de
 * kind — reusada aqui, não reimplementada. Quando não há nenhum backup (caso
 * comum), o merge devolve exatamente o conteúdo do arquivo real — nenhuma
 * mudança de comportamento no caminho feliz.
 *
 * **#6567 — a remoção da issue é aplicada a TODOS os arquivos do grupo (real
 * + cada `-safeBackup-*`), não só ao real.** O merge acima resolve a LEITURA
 * (a issue aparece como reivindicada mesmo se só um backup a carrega), mas
 * sem isto a ESCRITA seguinte (`writeJsonSafe(path, ...)`) tocava só o
 * arquivo real — os backups continuavam em disco com `issueNumber` ainda em
 * `claimed_issues`, e como o read-path (`readMergedSessionGroups`) faz a
 * MESMA união real+backups, `is-claimed`/`list-active` seguiam reportando a
 * issue como reivindicada mesmo depois do `unclaim-issue` responder `{ok:
 * true}` — issue permanentemente inelegível até o GC eventualmente varrer o
 * backup (achado ao vivo #6567). Cada backup é reescrito CIRURGICAMENTE (só
 * `claimed_issues`/`claimed_issues_at` daquele próprio arquivo, preservando
 * o resto do seu conteúdo) — nunca sobrescrito com o registro MESCLADO, que
 * poderia introduzir campos de outra cópia num backup que nunca os teve.
 */
export function unclaimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: ClaimIssueTarget,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): UnclaimIssueResult {
  // #12166: o caminho individual é o lote de 1 — mesma escrita, mesmos
  // desfechos. Uma implementação só evita as duas divergirem (a lição do
  // #6481/#6567, que precisou corrigir o read-path e o write-path em separado).
  const { ok, reason } = unclaimIssues(repoRoot, kind, sessionId, [issueNumber], tag, now).entries[0];
  return { ok, reason };
}

/** #12166 — desfecho de UMA issue dentro de um unclaim em lote. */
export interface BatchUnclaimIssueEntry extends UnclaimIssueResult {
  issue: ClaimIssueTarget;
  /** `#N` ou `owner/repo#N` — o mesmo rótulo das mensagens do CLI. */
  label: string;
}

/** #12166 — resultado de `unclaimIssues`. */
export interface BatchUnclaimIssuesResult {
  /** `true` só quando TODAS as issues do lote saíram liberadas por esta chamada. */
  ok: boolean;
  /** Uma entrada por issue distinta, na ordem pedida. */
  entries: BatchUnclaimIssueEntry[];
  /** Quantas escritas no arquivo-âncora o lote fez: 0 (nada a soltar) ou 1. */
  writes: 0 | 1;
}

/**
 * Unclaim de VÁRIAS issues numa escrita só do arquivo-âncora (#12166) —
 * simétrico a `claimIssuesCheckAndSet` (#12010) e pelo mesmo motivo: soltar
 * as issues de uma onda com N `unclaim-issue` seguidos é uma rajada de N
 * renames na âncora sincronizada pelo OneDrive, o padrão que vira cópia de
 * conflito `-safeBackup-NNNN` (rodada 261104b: 19 issues mergeadas, 19
 * chamadas standalone, e a rodada preferiu deixar as claims caírem no `end`).
 *
 * Semântica por issue idêntica à de `unclaimIssue` (ver a docstring dele):
 * `no-op-not-claimed` por issue não impede as outras do lote; sessão
 * ausente/ilegível vale para o lote inteiro. Issues repetidas contam uma vez.
 * Cada `-safeBackup-*` do grupo que ainda carrega alguma das issues é
 * reescrito uma vez, cirurgicamente (#6567).
 */
export function unclaimIssues(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issues: readonly ClaimIssueTarget[],
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): BatchUnclaimIssuesResult {
  const distinct: { issue: ClaimIssueTarget; label: string; target: ResolvedClaimTarget }[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const label = claimTargetLabel(issue);
    if (seen.has(label)) continue;
    seen.add(label);
    distinct.push({ issue, label, target: resolveClaimTarget(issue) });
  }
  if (distinct.length === 0) throw new Error("unclaimIssues: lista de issues vazia (#12166)");

  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const rawCurrent = readJsonSafe<SessionRecord>(path);
  if (!rawCurrent) {
    let reason: UnclaimIssueReason = "no-op-session-missing";
    if (existsSync(path)) {
      warnUnclaimUnreadable(sessionId, path);
      reason = "no-op-unreadable";
    }
    // #13238: o claim com `--kind overnight|develop` de uma sessão sem esse
    // registro foi gravado no registro `interactive` dela (`autoRegisterKindFor`);
    // o unclaim simétrico solta de lá. Só solta, nunca cria registro.
    const fallbackKind = autoRegisterKindFor(kind);
    if (reason === "no-op-session-missing" && fallbackKind !== kind) {
      return unclaimIssues(repoRoot, fallbackKind, sessionId, issues, tag, now);
    }
    return { ok: false, writes: 0, entries: distinct.map(({ issue, label }) => ({ issue, label, ok: false, reason })) };
  }

  // #6481: mescla com eventuais `-safeBackup-*` do MESMO arquivo real antes de
  // checar `claimed_issues` — ver docstring de `unclaimIssue`.
  // `readMergedRecordForRealFile` nunca devolve `null` aqui porque `rawCurrent`
  // já provou que o arquivo real é legível (ela sempre inclui pelo menos o
  // próprio arquivo real no merge).
  const current = readMergedRecordForRealFile(repoRoot, path) ?? rawCurrent;

  const entries: BatchUnclaimIssueEntry[] = [];
  const toRemove: ResolvedClaimTarget[] = [];
  for (const { issue, label, target } of distinct) {
    if (!recordHoldsClaim(current, target)) {
      entries.push({ issue, label, ok: false, reason: "no-op-not-claimed" });
      continue;
    }
    entries.push({ issue, label, ok: true, reason: "unclaimed" });
    toRemove.push(target);
  }
  if (toRemove.length === 0) return { ok: false, writes: 0, entries };
  const removeAll = (record: SessionRecord): SessionRecord => {
    let out = record;
    for (const target of toRemove) out = withClaimRemoved(out, target);
    return out;
  };
  const holdsAny = (record: SessionRecord | null): boolean =>
    !!record && toRemove.some((t) => recordHoldsClaim(record, t));

  // #6453 — `withClaimRemoved` limpa a entrada correspondente de
  // `claimed_issues_at` (ou `claimed_foreign_issues_at`, #10618) junto com a
  // remoção da claim. Sem isto, uma re-reivindicação futura da MESMA issue
  // herda o timestamp da claim ANTERIOR (`claimIssueCheckAndSet` nunca
  // sobrescreve uma chave já presente, #6436) e nasce artificialmente
  // "envelhecida" para `findAgedClaims`/`check-block-staleness.ts` — o falso
  // positivo exato que o gate de staleness existe para evitar.

  // #6952: CAS em vez de read-modify-write solto — mesmo risco que
  // `claimIssueCheckAndSet`/`grantMergeWindow`.
  writeJsonSafeWithCas(
    path,
    (fresh) => {
      if (!fresh) throw new Error("unclaimIssue: sessão sumiu entre a leitura e a escrita");
      // #6952: a base é o registro MESCLADO do grupo (real + backups), não o
      // arquivo real cru — igual ao `current` calculado fora do lock, e pelo
      // mesmo motivo (#6481: a claim pode existir só num backup).
      //
      // Reler só o arquivo real aqui foi regressão de verdade, pega por
      // `test/session-registry-reconcile-claims.test.ts`: o `unclaimIssue`
      // deixava de trazer as claims que existiam só nos backups, e o registro
      // real saía com MENOS issues do que o grupo tinha antes da operação.
      // "Re-derivar do estado fresco" continua valendo — o que muda é QUAL
      // leitura é a fresca: a do GRUPO, não a de um arquivo do grupo.
      const base = readMergedRecordForRealFile(repoRoot, path) ?? fresh;
      return { ...removeAll(base), lastHeartbeat: now };
    },
    (onDisk) => onDisk?.lastHeartbeat === now && !holdsAny(onDisk),
  );

  // #6567: propaga a remoção a cada `-safeBackup-*` do grupo que ainda carrega
  // a issue — ver docstring acima. Reescrita cirúrgica: só os dois campos de
  // claim daquele backup, nunca o registro mesclado inteiro.
  for (const backupPath of sessionGroupBackupPaths(repoRoot, path)) {
    const backupRecord = readJsonSafe<SessionRecord>(backupPath);
    if (!backupRecord) continue; // backup ilegível/parcialmente sincronizado — GC recolhe depois
    if (!holdsAny(backupRecord)) continue;
    // #6952 (4º review): esta PR promoveu este laço de `writeJsonSafe` (que
    // praticamente nunca lança) pra `writeJsonSafeWithCas` (que PODE exaurir).
    // Sem o try/catch, um backup que exaure interrompe o laço e os SEGUINTES
    // nunca são tentados — assimetria introduzida por esta PR entre dois laços
    // que ela mesma descreve como um modelado no outro (`consumeMergeGrant` já
    // isola cada cópia). A direção de falha é segura (a união favorece "ainda
    // reivindicada" e o retry se autocura), mas parar cedo é gratuito.
    try {
      writeJsonSafeWithCas(
        backupPath,
        (current) => {
          if (!current) throw new Error("unclaimIssue: backup sumiu entre a leitura e a escrita");
          return removeAll(current);
        },
        (onDisk) => !holdsAny(onDisk),
      );
    } catch {
      // Um backup que falhou não impede limpar os outros. A remoção do
      // arquivo REAL (acima) já aconteceu e é a que manda na leitura; um
      // backup que ainda carregue a issue faz a união preferir "reivindicada",
      // que é a direção segura, e a próxima execução retenta.
    }
  }

  return { ok: entries.every((e) => e.ok), writes: 1, entries };
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
  issueNumber: ClaimIssueTarget,
  excludeSessionId: string,
  now: number = Date.now(),
): ActiveSessionRecord | null {
  const target = resolveClaimTarget(issueNumber);
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    // #7227: lê `claimed_issues_effective` (já resolve a janela de retenção
    // de `claimReleaseMsForKind`) em vez de gatear por `session.stale` +
    // `claimed_issues` bruto. Antes do #7227 as duas coisas coincidiam
    // (`claimed_issues_effective` esvaziava exatamente quando `stale` virava
    // `true`) — desde o #7227 uma sessão `stale: true` pode continuar
    // segurando a issue (ainda dentro de `claimReleaseMsForKind`, "provavelmente
    // ociosa" mas não livre), e gatear por `stale` sozinho voltaria a liberar
    // cedo demais o que este helper existe pra proteger (#5751).
    if (sessionEffectivelyHolds(session, target)) return session;
  }
  return null;
}

/**
 * #7297 — variante de `isIssueClaimedByOther` acima, mas gateada pela janela
 * CURTA de staleness (`session.stale`/`SOFT_STALE_MS`, 90min), não pela janela
 * de RETENÇÃO de claim (`claimed_issues_effective`/`claimReleaseMsForKind`,
 * 24h pros 3 kinds coordenadores desde o #7227).
 *
 * Existe porque as duas perguntas são genuinamente diferentes, com custos de
 * erro em direções opostas:
 * - `isIssueClaimedByOther` — "alguém ainda pode reivindicar este trabalho
 *   sem roubar de uma sessão viva?" (usada por `claim-issue`/`is-claimed`
 *   antes de uma sessão NOVA pegar uma issue). Errar cedo demais rouba
 *   trabalho de uma sessão viva presa numa chamada lenta (#7194) — por isso
 *   #7227 alargou a janela pra 24h.
 * - Esta função — "esta issue parece estar sendo trabalhada AGORA, ou o
 *   bloqueio (`pulada`/`claimed-por-outra-sessao`) já caducou e merece
 *   reavaliação?" (consumida só por `check-block-staleness.ts`, #6259, cujo
 *   propósito desde a origem é reabrir RÁPIDO — não deixar a rodada ociosa
 *   esperando uma sessão que já não dá sinal de vida). Errar tarde demais
 *   (esperar 24h) desperdiça a fila inteira por até um dia — o oposto do
 *   erro que #7227 existe para evitar.
 *
 * O #7227 desacoplou as duas sem querer: antes dele `isIssueClaimedByOther`
 * já usava `session.stale` diretamente, então `check-block-staleness.ts`
 * herdava a janela de 90min por tabela. Esta função restaura esse
 * comportamento de propósito, como consumidor dedicado — em vez de
 * reacoplar o gate de 24h a esta pergunta, ou (a alternativa descartada)
 * afrouxar `isIssueClaimedByOther` de volta e reabrir o incidente do #7194.
 *
 * Usa `claimed_issues_effective` (não `claimed_issues` bruto) só porque é o
 * campo já computado — quando `!session.stale`, os dois são idênticos por
 * construção (`SOFT_STALE_MS`, 90min, é sempre menor que
 * `claimReleaseMsForKind`, 24h/15min, então uma sessão não-stale nunca teve
 * o claim liberado).
 */
export function isIssueClaimedByActiveSession(
  repoRoot: string,
  issueNumber: ClaimIssueTarget,
  excludeSessionId: string,
  now: number = Date.now(),
): ActiveSessionRecord | null {
  const target = resolveClaimTarget(issueNumber);
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    if (session.stale) continue;
    if (sessionEffectivelyHolds(session, target)) return session;
  }
  return null;
}

/**
 * Sessões ATIVAS (não-stale) de um `kind` específico — a pergunta "há uma
 * rodada `/diaria-overnight` acontecendo agora?" respondida de forma
 * determinística, sem o consumidor precisar reimplementar o filtro de
 * staleness sobre `listActiveSessions` (#6277 item 3).
 *
 * Motivação: o `hermes-diaria-continuo` roda de hora em hora e drena a MESMA
 * fila que o overnight. O check-and-set do #6236 fecha a corrida de ESCRITA no
 * claim, mas não evita o desperdício de duas sessões analisarem a mesma fila.
 * Caso real em 260826: a #6232 reivindicada às 11:20 pelo overnight, com
 * subagente já implementando, e às 11:27 pelo contínuo — os DOIS claims
 * sucederam, porque `claimIssue` escrevia só no próprio arquivo sem consultar
 * os das outras sessões (foi esse achado que gerou o #6236/#6242). Hoje a 2ª
 * tentativa é recusada, mas a recusa chega DEPOIS de a sessão já ter lido,
 * classificado e planejado a issue — o trabalho de análise se perde igual. A
 * exclusão precisa acontecer ANTES do claim, e é isso que este helper permite:
 * o tick do contínuo consulta antes de reivindicar issue nova e se limita a
 * processar a própria fila de PRs enquanto houver overnight ativo.
 *
 * Usa `session.stale` (`SOFT_STALE_MS`) diretamente — **não** a janela mais
 * longa de `claimReleaseMsForKind` que `isIssueClaimedByOther` passou a usar
 * desde o #7227 (as duas divergem agora, de propósito: a pergunta aqui é
 * "há uma RODADA deste kind acontecendo?", não "esta issue específica ainda
 * está reivindicada?" — um overnight silencioso há 3h já não conta como
 * "rodada ativa" pro contínuo decidir se pode processar issue nova, mesmo que
 * as claims dele ainda protejam trabalho específico por mais tempo). Sessão
 * com heartbeat morto há mais de `SOFT_STALE_MS` NÃO conta como ativa aqui —
 * um overnight que morreu sem chamar `end` não pode bloquear o contínuo para
 * sempre. Sessões stale saem do retorno principal, mas continuam visíveis via
 * `findStaleSessionsOfKind` para o chamador poder reportá-las.
 *
 * `excludeSessionId` permite a uma sessão perguntar "há OUTRA sessão deste
 * kind?" sem se enxergar (o contínuo consultando por `continuo`, por exemplo).
 *
 * Fail-soft por herança: `listActiveSessions` nunca lança (diretório ausente,
 * JSON corrompido → lista vazia), então este helper também não.
 */
export function findActiveSessionsOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): SessionRecord[] {
  return listActiveSessions(repoRoot, now).filter(
    (session) => session.kind === kind && !session.stale && session.sessionId !== excludeSessionId,
  );
}

/**
 * Contraparte de `findActiveSessionsOfKind` — sessões do mesmo `kind` que
 * estão dentro do teto absoluto (`MAX_SESSION_AGE_MS`) mas com heartbeat
 * morto (`stale: true`). Não bloqueiam ninguém; existem para o chamador poder
 * dizer "não há overnight ativo, mas há 1 registro stale de X" em vez de
 * silenciar o registro órfão (mesma disciplina de nunca descartar em silêncio
 * do `warnClockSkew`).
 */
export function findStaleSessionsOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): SessionRecord[] {
  return listActiveSessions(repoRoot, now).filter(
    (session) => session.kind === kind && session.stale === true && session.sessionId !== excludeSessionId,
  );
}

/**
 * Predicado booleano sobre `findActiveSessionsOfKind` — o formato que o
 * caminho de decisão do contínuo consome ("há overnight ativo? então não
 * reivindico issue nova neste tick").
 */
export function hasActiveSessionOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): boolean {
  return findActiveSessionsOfKind(repoRoot, kind, excludeSessionId, now).length > 0;
}
