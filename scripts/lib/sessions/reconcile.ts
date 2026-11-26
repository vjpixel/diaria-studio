/**
 * scripts/lib/sessions/reconcile.ts (#14004)
 *
 * Reconciliação de claims entre a âncora e as cópias de conflito, e limpeza
 * das cópias `-safeBackup-` já reconciliadas (inclusive o teto por grupo).
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { join } from "node:path";
import { rmSync, statSync } from "node:fs";
import { isSyncConflictCopyName } from "../sync-conflict-copy.ts";
import type { MergeGrant, SessionRecord } from "./types.ts";
import {
  groupBackupsByRealStem,
  listSessionJsonFiles,
  mergeSessionRecords,
  readJsonSafe,
  sessionsDir,
  writeJsonSafeWithCas,
} from "./store.ts";
import { isMergeGrantLive } from "./merge-grant.ts";

// ─── Reconciliação de claims presos em backup (#6581) ──────────────────────
//
// O #6567 (PR #6571) consertou o WRITE-path de `unclaimIssue`: a remoção de
// uma issue passou a propagar para todos os `-safeBackup-*` do grupo, não só
// o arquivo real. Isso impede o problema de CRESCER dali pra frente, mas não
// tocou o ESTOQUE anterior — um claim que só sobrevive num backup porque o
// arquivo REAL ainda existe mas divergiu (escrita pré-#6567 que só tocou o
// real, deixando um `-safeBackup-*` mais antigo/bifurcado com issues que o
// real nunca chegou a carregar) fica preso: o read-path
// (`readMergedSessionGroups`/`mergeSessionRecords`) continua reportando a
// issue como reivindicada via união fail-safe, mesmo sem nenhuma escrita
// pendente que a resolva. **Isto é distinto do caso "sessão encerrou e o
// arquivo real foi removido"** (`endSession`/GC) — aí o backup fica ÓRFÃO,
// não faz parte de grupo nenhum, e este reconciliador explicitamente não o
// toca (ver "Por que backup órfão... nunca vira arquivo real novo" no CLI).
// `planClaimReconciliation`/`reconcileClaims` fecham o caso do real ainda
// vivo: para cada grupo (arquivo real + seus `-safeBackup-*`), a união de
// `claimed_issues` é calculada e gravada de volta no arquivo REAL. Isso não
// muda quando o GC pode remover os backups — `planSessionGc`/`decideSessionGc`
// decidem por liveness do GRUPO (heartbeat/pid), nunca por `claimed_issues`,
// e removem real+backups sempre juntos, atomicamente; o benefício real desta
// reconciliação é o arquivo real virar a fonte de verdade AUTOSSUFICIENTE da
// claim (não depende mais de nenhum backup sobreviver) — não "destravar" o GC.

export type ClaimReconciliationAction =
  | "reconciled"
  | "no-change"
  | "skipped-unreadable-real"
  | "orphan-backups-only"
  | "write-failed";

export interface ClaimReconciliationResult {
  /** `{kind}-{tag}-{sessionId}` (stem do arquivo real) pro grupo ancorado num
   * real, ou `orphan-backup:{arquivo}` pra um backup sem real correspondente. */
  identity: string;
  /** Path absoluto do arquivo real do grupo — `null` só pra `orphan-backups-only`. */
  realPath: string | null;
  /** Paths absolutos de todo `-safeBackup-*` do grupo (ou o próprio arquivo,
   * pra um órfão). */
  backupPaths: string[];
  /** Issues presentes em algum backup do grupo mas ausentes do real —
   * ADICIONADAS ao real quando `action === "reconciled"`. Nunca uma remoção. */
  addedIssues: number[];
  /** Entradas NOVAS de `claimed_issues_at` a mesclar (só para `addedIssues`) —
   * usado por `reconcileClaims` na escrita; nunca sobrescreve uma entrada já
   * existente no real. Vazio quando `addedIssues` é vazio. */
  addedClaimedIssuesAt: Record<string, string>;
  /** #10618 — análogo de `addedIssues` para `claimed_foreign_issues`
   * (`owner/repo#N`). Ausente (=vazio) em grupos sem claim de outro repo. */
  addedForeignIssues?: string[];
  /** #10618 — análogo de `addedClaimedIssuesAt` para
   * `claimed_foreign_issues_at`. */
  addedForeignClaimedIssuesAt?: Record<string, string>;
  /** Quantos `-safeBackup-*` do grupo estavam ilegíveis/corrompidos e por isso
   * ficaram de fora da união — as claims deles, se houver, ficam
   * irrecuperáveis por esta reconciliação (não é erro nem bloqueia o resto do
   * grupo, mas é informação que o CLI agrega no resumo final). */
  unreadableBackupCount: number;
  action: ClaimReconciliationAction;
  /** Explicação legível — sempre populada, inclusive pra `"no-change"`
   * (auditabilidade, mesmo padrão de `SessionGcResult.reason`). */
  reason: string;
}

export interface ClaimReconciliationDecision {
  /** Issues presentes em algum backup mas ausentes do real — a acrescentar
   * (união fail-safe, nunca remoção — mesma direção do read-path #6130 e do
   * write-path de `unclaimIssue` #6567). Ordenadas. */
  addedIssues: number[];
  /** Entradas NOVAS de `claimed_issues_at` (só para `addedIssues`) — nunca
   * sobrescreve uma entrada já existente no real. */
  addedClaimedIssuesAt: Record<string, string>;
  /** #10618 (fatia 2) — claims de OUTRO repo (`owner/repo#N`) presentes em
   * algum backup e ausentes do real, mesma regra #6698 de `addedIssues`.
   * Ausente quando nenhuma (shape legado intacto). Todo consumidor que decide
   * "o backup ainda carrega claim que o real não tem" usa
   * `claimReconciliationHasAdditions`, nunca só `addedIssues.length` — senão
   * um backup com claim do diaria-design viraria `removable` e a claim
   * sumiria. */
  addedForeignIssues?: string[];
  addedForeignClaimedIssuesAt?: Record<string, string>;
}

/** `true` quando a decisão tem QUALQUER claim a acrescentar ao real — do repo
 * default (`addedIssues`) ou de outro repo (`addedForeignIssues`, #10618). */
export function claimReconciliationHasAdditions(d: {
  addedIssues: readonly number[];
  addedForeignIssues?: readonly string[];
}): boolean {
  return d.addedIssues.length > 0 || (d.addedForeignIssues ?? []).length > 0;
}

/**
 * Decisão PURA (sem I/O) de reconciliação de um único grupo: dado o registro
 * REAL e os registros LEGÍVEIS de seus `-safeBackup-*` (backup ilegível já
 * deve ter sido filtrado pelo chamador — não participa da união, mas também
 * não bloqueia o resto do grupo), calcula o que FALTA no real via a mesma
 * primitiva de união do read-path (`mergeSessionRecords`).
 *
 * **#6698 — nunca ressuscita uma claim já removida por um `unclaimIssue`
 * PRÉ-#6567.** Antes desta mudança, esta função era unidirecional puro: TUDO
 * que sobrava só em backup virava `addedIssues`, sem distinguir dois cenários
 * que produzem exatamente a mesma forma em disco (issue presente no backup,
 * ausente do real):
 *   (a) claim genuinamente viva que só sobreviveu no backup (escrita
 *       concorrente do OneDrive perdeu a issue no real) — ressuscitar é
 *       correto, é o caso que o #6581 existe pra resolver;
 *   (b) claim já removida de propósito por um `unclaimIssue` ANTERIOR ao
 *       #6567 (que só tocava o arquivo real, deixando o backup com um
 *       resíduo da issue) — ressuscitar aqui é um BUG: a #6581 devolve ao
 *       real uma claim que o dono já soltou.
 *
 * Distinção usada (a mesma sugerida na issue): uma issue só é adicionada
 * quando `claimed_issues_at` do BACKUP para aquela issue existe E é
 * POSTERIOR ao `lastHeartbeat` do real — evidência de que o REAL ficou pra
 * trás (não recebeu uma escrita que já aconteceu depois da claim), não de que
 * o backup preserva algo que o real removeu de propósito depois. Sem essa
 * evidência (timestamp ausente — claim anterior ao #6436, quando
 * `claimed_issues_at` passou a existir — ou timestamp mais antigo/igual ao
 * heartbeat do real, sinal de que o real teve chance de refletir a claim e
 * genuinamente não a tem), cai no comportamento ANTERIOR — adiciona mesmo
 * assim — porque não há como comprovar a hipótese (b) sem o timestamp:
 * suprimir a adição sem essa evidência trocaria o bug conhecido do #6698 por
 * outro (claim (a) genuína nunca reconciliada, o próprio motivo do #6581).
 */
export function decideClaimReconciliation(
  realRecord: SessionRecord,
  backupRecords: readonly SessionRecord[],
): ClaimReconciliationDecision {
  if (backupRecords.length === 0) return { addedIssues: [], addedClaimedIssuesAt: {} };
  const merged = mergeSessionRecords([realRecord, ...backupRecords]);
  const foreign = decideForeignClaimReconciliation(realRecord, merged);
  const currentClaimed = new Set(realRecord.claimed_issues ?? []);
  const realHeartbeatMs = Date.parse(realRecord.lastHeartbeat ?? realRecord.startedAt ?? "");
  const candidateIssues = (merged.claimed_issues ?? []).filter((n) => !currentClaimed.has(n)).sort((a, b) => a - b);

  const addedIssues: number[] = [];
  const addedClaimedIssuesAt: Record<string, string> = {};
  for (const issue of candidateIssues) {
    const at = merged.claimed_issues_at?.[String(issue)];
    const atMs = at ? Date.parse(at) : NaN;
    // #6698: com evidência de timestamp disponível (`at` presente e parseável
    // + heartbeat do real parseável), só ressuscita quando o backup é
    // POSTERIOR ao real — nunca quando é anterior/igual (evidência de remoção
    // deliberada pré-#6567). Sem evidência (qualquer um dos dois lados
    // ilegível/ausente), preserva o comportamento anterior: adiciona.
    if (at && Number.isFinite(atMs) && Number.isFinite(realHeartbeatMs) && atMs <= realHeartbeatMs) continue;
    addedIssues.push(issue);
    if (at) addedClaimedIssuesAt[String(issue)] = at;
  }
  return foreign.addedForeignIssues.length > 0
    ? { addedIssues, addedClaimedIssuesAt, ...foreign }
    : { addedIssues, addedClaimedIssuesAt };
}

/** #10618 — a mesma regra (#6698) de `decideClaimReconciliation`, sobre
 * `claimed_foreign_issues`/`claimed_foreign_issues_at`. */
function decideForeignClaimReconciliation(
  realRecord: SessionRecord,
  merged: SessionRecord,
): { addedForeignIssues: string[]; addedForeignClaimedIssuesAt: Record<string, string> } {
  const current = new Set(realRecord.claimed_foreign_issues ?? []);
  const realHeartbeatMs = Date.parse(realRecord.lastHeartbeat ?? realRecord.startedAt ?? "");
  const addedForeignIssues: string[] = [];
  const addedForeignClaimedIssuesAt: Record<string, string> = {};
  for (const key of [...(merged.claimed_foreign_issues ?? [])].filter((k) => !current.has(k)).sort()) {
    const at = merged.claimed_foreign_issues_at?.[key];
    const atMs = at ? Date.parse(at) : NaN;
    if (at && Number.isFinite(atMs) && Number.isFinite(realHeartbeatMs) && atMs <= realHeartbeatMs) continue;
    addedForeignIssues.push(key);
    if (at) addedForeignClaimedIssuesAt[key] = at;
  }
  return { addedForeignIssues, addedForeignClaimedIssuesAt };
}

/**
 * Plano PURO (não escreve nada — só lê) de reconciliação de `data/sessions/`
 * (#6581): agrupa real+backups via `groupBackupsByRealStem` (mesma primitiva
 * do read-path, reusada aqui em vez de reimplementada) e roda
 * `decideClaimReconciliation` por grupo. Backup ÓRFÃO (sem arquivo real
 * correspondente) nunca vira arquivo real novo — só é reportado com action
 * `"orphan-backups-only"`; quem decide o destino dele é o GC, com os
 * critérios de liveness dele (`planSessionGc`), não este reconciliador.
 * Arquivo real ilegível/corrompido nunca é sobrescrito (`"skipped-unreadable-real"`)
 * — fail-soft, mesma disciplina de `planSessionGc` sobre registro ilegível.
 */
export function planClaimReconciliation(repoRoot: string): ClaimReconciliationResult[] {
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !isSyncConflictCopyName(n)).sort();
  const backupsByRealStem = groupBackupsByRealStem(names);
  const claimedBackupNames = new Set<string>();
  const results: ClaimReconciliationResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = (backupsByRealStem.get(stem) ?? []).sort();
    for (const b of backupNames) claimedBackupNames.add(b);
    const realPath = join(dir, realName);
    const backupPaths = backupNames.map((n) => join(dir, n));

    const realRecord = readJsonSafe<SessionRecord>(realPath);
    if (!realRecord) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        addedIssues: [],
        addedClaimedIssuesAt: {},
        unreadableBackupCount: 0,
        action: "skipped-unreadable-real",
        reason: "arquivo real ilegível/corrompido — grupo pulado (fail-soft: nunca escreve por cima do que não conseguiu entender)",
      });
      continue;
    }

    const backupRecords: SessionRecord[] = [];
    let unreadableCount = 0;
    for (const b of backupNames) {
      const r = readJsonSafe<SessionRecord>(join(dir, b));
      if (r) backupRecords.push(r);
      else unreadableCount++;
    }

    const decision = decideClaimReconciliation(realRecord, backupRecords);
    const { addedIssues, addedClaimedIssuesAt } = decision;
    const addedForeign = decision.addedForeignIssues ?? [];
    const hasAdditions = claimReconciliationHasAdditions(decision);
    const unreadableNote = unreadableCount > 0 ? ` (${unreadableCount} backup(s) ilegível(is) do grupo ignorado(s))` : "";
    const addedLabels = [...addedIssues.map(String), ...addedForeign];
    results.push({
      identity: stem,
      realPath,
      backupPaths,
      addedIssues,
      addedClaimedIssuesAt,
      ...(addedForeign.length > 0
        ? { addedForeignIssues: addedForeign, addedForeignClaimedIssuesAt: decision.addedForeignClaimedIssuesAt ?? {} }
        : {}),
      unreadableBackupCount: unreadableCount,
      action: hasAdditions ? "reconciled" : "no-change",
      reason: hasAdditions
        ? `${addedLabels.length} claim(s) presos em backup — issue(s) [${addedLabels.join(", ")}]${unreadableNote}`
        : `nenhum claim exclusivo de backup${unreadableNote}`,
    });
  }

  const orphanBackups = names.filter((n) => isSyncConflictCopyName(n) && !claimedBackupNames.has(n)).sort();
  for (const orphan of orphanBackups) {
    results.push({
      identity: `orphan-backup:${orphan}`,
      realPath: null,
      backupPaths: [join(dir, orphan)],
      addedIssues: [],
      addedClaimedIssuesAt: {},
      unreadableBackupCount: 0,
      action: "orphan-backups-only",
      reason:
        "backup sem arquivo real correspondente — nunca cria arquivo real do zero pra reconciliar (decisão #6581); " +
        "o GC (`planSessionGc`) decide o destino dele com os critérios de liveness dele",
    });
  }

  return results;
}

/**
 * Aplica `planClaimReconciliation` de fato: para cada grupo com
 * `action === "reconciled"`, RELÊ tanto o arquivo real quanto cada backup do
 * grupo (podem ter mudado entre o plano e a escrita — mesma corrida que
 * `writeJsonSafe` já aceita em todo o resto do módulo) e RECOMPUTA
 * `decideClaimReconciliation` contra esse estado FRESCO, em vez de reaplicar
 * o `addedIssues` congelado no plano.
 *
 * **Por que recomputar em vez de reusar o plano (achado do fleet review do
 * #6583, confirmado por 3 revisores independentes):** se `entry.addedIssues`
 * do plano fosse aplicado cegamente sobre o `current` relido, uma issue que
 * foi LEGITIMAMENTE removida via `unclaimIssue` no intervalo entre o plano e
 * esta escrita (unclaim já propaga pra backups desde #6567, mas isso não
 * ajuda aqui — o `addedIssues` já tinha sido calculado ANTES da remoção)
 * seria silenciosamente re-adicionada — o próprio script de limpeza
 * ressuscitando uma claim que acabara de ser corretamente encerrada.
 * Recomputar contra o par (real, backups) lido NESTE instante fecha essa
 * janela: se a issue já não aparece em nenhum backup (ou já está no real),
 * `decideClaimReconciliation` simplesmente não a inclui em `addedIssues` de
 * novo, e o grupo vira `"no-change"` sem nenhuma escrita.
 *
 * Escreve só `claimed_issues`/`claimed_issues_at` sobre o `current` ATUAL —
 * nunca sobrescreve com o registro MESCLADO inteiro (que poderia introduzir
 * campos de um backup que o real nunca teve, mesma disciplina cirúrgica de
 * `unclaimIssue` #6567). Escrita atômica (`writeJsonSafe` → `writeFileAtomic`).
 * Nunca remove nenhum backup — quem remove é o GC. Falha de escrita (I/O
 * transitório do OneDrive) rebaixa a entry pra `"write-failed"` — DISTINTO de
 * `"no-change"` (que significa "nada a fazer", não "tentou e não conseguiu")
 * — com o motivo anexado; mesmo espírito de `garbageCollectSessions`
 * rebaixar pra `"kept"` em falha, mas com uma action própria em vez de
 * reusar o valor do caminho feliz — a próxima execução retenta.
 */
export function reconcileClaims(repoRoot: string): ClaimReconciliationResult[] {
  const plan = planClaimReconciliation(repoRoot);
  for (const entry of plan) {
    if (entry.action !== "reconciled" || !entry.realPath) continue;

    const current = readJsonSafe<SessionRecord>(entry.realPath);
    if (!current) {
      entry.action = "skipped-unreadable-real";
      entry.reason = `${entry.reason} [ficou ilegível entre o plano e a escrita — pulado, próxima execução retenta]`;
      continue;
    }

    const freshBackupRecords: SessionRecord[] = [];
    for (const backupPath of entry.backupPaths) {
      const r = readJsonSafe<SessionRecord>(backupPath);
      if (r) freshBackupRecords.push(r);
    }
    const fresh = decideClaimReconciliation(current, freshBackupRecords);
    entry.addedIssues = fresh.addedIssues;
    entry.addedClaimedIssuesAt = fresh.addedClaimedIssuesAt;
    const freshForeign = fresh.addedForeignIssues ?? [];
    const freshForeignAt = fresh.addedForeignClaimedIssuesAt ?? {};
    if (freshForeign.length > 0) {
      entry.addedForeignIssues = freshForeign;
      entry.addedForeignClaimedIssuesAt = freshForeignAt;
    } else {
      delete entry.addedForeignIssues;
      delete entry.addedForeignClaimedIssuesAt;
    }

    if (!claimReconciliationHasAdditions(fresh)) {
      entry.action = "no-change";
      entry.reason = `${entry.reason} [nada a adicionar contra o estado relido no momento da escrita — provavelmente já reconciliado, ou a claim foi legitimamente removida entre o plano e a escrita]`;
      continue;
    }

    try {
      // #6952: CAS em vez de read-modify-write solto — o beacon pode
      // reescrever o record enquanto este `reconcileClaims` tenta gravar, e um
      // `...current` congelado apagaria os campos dele.
      writeJsonSafeWithCas(
        entry.realPath,
        (current) => {
          if (!current) throw new Error("reconcileClaims: sessão sumiu entre a leitura e a escrita");
          const set = new Set(current.claimed_issues ?? []);
          for (const issue of fresh.addedIssues) set.add(issue);
          const at = { ...(current.claimed_issues_at ?? {}), ...fresh.addedClaimedIssuesAt };
          const next: SessionRecord = {
            ...current,
            claimed_issues: [...set].sort((a, b) => a - b),
            claimed_issues_at: at,
            claimed_issues_ever: [...new Set([...(current.claimed_issues_ever ?? []), ...fresh.addedIssues])].sort((a, b) => a - b),
          };
          // #10618: mesma escrita cirúrgica pras claims de outro repo.
          if (freshForeign.length === 0) return next;
          return {
            ...next,
            claimed_foreign_issues: [...new Set([...(current.claimed_foreign_issues ?? []), ...freshForeign])].sort(),
            claimed_foreign_issues_at: { ...(current.claimed_foreign_issues_at ?? {}), ...freshForeignAt },
            claimed_foreign_issues_ever: [
              ...new Set([...(current.claimed_foreign_issues_ever ?? []), ...freshForeign]),
            ].sort(),
          };
        },
        // `verify` checa PERTINÊNCIA das issues que este reconcile veio
        // adicionar, nunca igualdade do array inteiro contra um snapshot.
        // Comparar com um `expectedClaimed` congelado ANTES do lock seria o
        // mesmo bug que esta PR conserta, do lado do `verify`: um escritor
        // concorrente que adicione OUTRA issue deixa o disco correto (o
        // `merge` acima relê fresco e produz o superconjunto) e mesmo assim a
        // igualdade nunca casaria — as 50 tentativas se esgotariam e o
        // reconcile reportaria `write-failed` para uma escrita que funcionou.
        (onDisk) => {
          const claimedOnDisk = new Set(onDisk?.claimed_issues ?? []);
          const foreignOnDisk = new Set(onDisk?.claimed_foreign_issues ?? []);
          return (
            fresh.addedIssues.every((issue) => claimedOnDisk.has(issue)) &&
            freshForeign.every((key) => foreignOnDisk.has(key))
          );
        },
      );
    } catch (e) {
      entry.action = "write-failed";
      entry.reason = `${entry.reason} [escrita falhou: ${(e as Error)?.message ?? String(e)} — próxima execução retenta]`;
    }
  }
  return plan;
}

// ─── Recolhimento de -safeBackup- já reconciliados (#6970) ─────────────────
//
// `reconcileClaims` (#6581, acima) já funde `claimed_issues` de um grupo no
// arquivo REAL, mas DELIBERADAMENTE nunca remove os `-safeBackup-*` — "quem
// remove é o GC", e `planSessionGc` só recolhe backup ÓRFÃO (sessão já
// ENCERRADA, arquivo real ausente). O caso que fica de fora dos dois
// mecanismos: uma sessão VIVA cujo real já reflete tudo que os backups do
// grupo carregam (reconciliação em dia), mas os backups continuam em disco
// para sempre — o #6970 mediu 15 arquivos `-safeBackup-` em `data/sessions/`
// do 300, um criado no mesmo dia da medição.
//
// **Restrição de `merge_grant`, reavaliada no #6573 pós-#6952.** Até o
// #6952 (PR #6969, mergeada), `mergeSessionRecords` NÃO unia `merge_grant`
// entre os arquivos do grupo — um `merge_grant` que sobrevivesse só num
// backup podia ser descartado em SILÊNCIO na leitura, então este planejador
// bloqueava qualquer grupo com QUALQUER backup carregando `merge_grant`,
// sem distinguir vivo de morto. Essa premissa ficou obsoleta ANTES mesmo de
// ser escrita em prosa aqui: o commit da união (`353f73f1`, #6969) mergeou
// ~2h antes do commit que introduziu esta restrição (`887abfe5`, #7005),
// mesma madrugada — achado do review consolidado da rodada 260901.
//
// Com a união em vigor, `mergeGrantBlocksBackupCleanup` (abaixo) substitui o
// bloqueio incondicional por um mais estreito, que protege só os dois riscos
// que sobram depois que a leitura já une corretamente:
//   1. **Perda** — a concessão AGREGADA (real + backups) ainda está viva
//      (não consumida, dentro do TTL) e o real sozinho não a reproduz.
//      Remover os backups apagaria a única cópia utilizável.
//   2. **Ressurreição** — a concessão agregada já está CONSUMIDA (o carimbo
//      só existe em algum backup), mas o real sozinho, sem esse carimbo,
//      ainda pareceria viva (dentro do TTL). Remover o backup apagaria a
//      PROVA de consumo e a concessão voltaria a parecer usável — o mesmo
//      tipo de dano que a união do #6952 fechou do lado da leitura, agora do
//      lado da remoção física.
// Uma concessão já morta por QUALQUER outro motivo (TTL expirado — nunca
// "desexpira" — ou consumida com o real já refletindo o carimbo) nunca
// bloqueia: nenhuma leitura futura voltaria a tratá-la como usável, união ou
// não, então perder a única cópia física dela não muda nada.
export type SafeBackupCleanupAction =
  | "removable"
  | "pending-reconciliation"
  | "has-merge-grant"
  | "skipped-unreadable-real"
  | "orphan-backups-only";

export interface SafeBackupCleanupResult {
  /** Stem do arquivo real (mesma identidade de `ClaimReconciliationResult`), ou
   * `orphan-backup:{arquivo}` pra um backup sem real correspondente. */
  identity: string;
  /** Path absoluto do arquivo real do grupo — `null` só pra `orphan-backups-only`. */
  realPath: string | null;
  backupPaths: string[];
  action: SafeBackupCleanupAction;
  reason: string;
}

/**
 * Verdadeiro quando remover TODOS os backups de um grupo perderia
 * informação de `merge_grant` que nenhum arquivo remanescente (só o real,
 * depois da remoção) reproduziria — os dois riscos descritos na docstring
 * acima ("Perda"/"Ressurreição"). Pura.
 *
 * `winner` é a concessão da UNIÃO do grupo inteiro (`mergeSessionRecords`,
 * que já sabe escolher o `grantedAt` mais recente e propagar `consumedAt` de
 * qualquer cópia — #6952) — a verdade atual, com os backups ainda no disco.
 * `realGrant` é o que o arquivo REAL carrega SOZINHO — o que sobra depois
 * que os backups são removidos. As duas únicas formas de perder algo que
 * importa:
 *
 *   1. **Perda**: `winner` ainda está viva e o real sozinho não reproduz a
 *      MESMA concessão (identidade `grantedBy`+`grantedTo`+`grantedAt`) —
 *      union só existe enquanto os backups existem; apagá-los apagaria a
 *      única cópia legível de uma concessão ainda utilizável.
 *   2. **Ressurreição**: `winner` já está CONSUMIDA, mas o real sozinho — sem
 *      esse carimbo — ainda estaria dentro do TTL e pareceria viva. Uma
 *      concessão já usada não pode voltar a parecer disponível só porque a
 *      prova de consumo morava só no arquivo que foi removido.
 *
 *   **#7462 corrigiu o que conta como "já está consumida".** Antes, o
 *   `consumedAt` vinha de QUALQUER cópia do grupo (`mergeSessionRecords`
 *   propagava de backups), então o caso 2 se disparava com o carimbo no
 *   backup mesmo com o real vivo — exatamente o cenário que a issue relata:
 *   o backup carregava um `consumedAt` que nunca foi escrito por um merge.
 *   Agora o carimbo conta só quando está no real, e o caso 2 só dispara de
 *   fato quando o real está consumido.
 *
 * Uma concessão sem nenhum dos dois riscos (já morta por TTL de qualquer
 * jeito, ou já integralmente reproduzida no real, carimbo de consumo
 * incluso) nunca bloqueia — é exatamente o volume que este relaxamento (#6573,
 * pós-#6952) existe para liberar: backups antigos carregando concessões de
 * TTL 10min havia muito expiradas.
 */
function mergeGrantBlocksBackupCleanup(
  realRecord: SessionRecord,
  backupRecords: readonly SessionRecord[],
  now: number,
): boolean {
  // #7462: o `consumedAt` é um carimbo de FATO, não um voto de maioria — só
  // testemunha quando está no arquivo REAL. Cópias `-safeBackup-` são detrito
  // de sync do OneDrive: um `consumedAt` nelas é um resíduo, não prova de
  // consumo. Por isso esta função consulta o grant DO REAL (nunca o mesclado
  // pela união, que pode herdar um `consumedAt` de backup e dizer "morto"
  // sem que o real tenha sido consumido).
  const real = realRecord.merge_grant;

  if (!real) {
    // O real nem carrega o grant — a concessão vive só nos backups. A
    // pergunta é se a união (só backups) ainda está VIVA: se sim, remover
    // perde a única cópia legível (#6573); se não (consumida ou TTL
    // expirado), nada se perde em remover.
    //
    // #7462: a união aqui NÃO é usada como testemunha de consumo. Um backup
    // pode carregar um `consumedAt` que o real nunca teve (resíduo de sync
    // do OneDrive) — e o `mergeSessionRecords` mescla esse `consumedAt` no
    // grant vencedor, fazendo `isMergeGrantLive` dizer "morto" sem que
    // NINGUÉM tenha consumido. O grant vivo é aquele SEM `consumedAt`:
    // se a concessão não foi consumida de fato, ela morre sozinha pelo
    // TTL, e até lá remover o backup perderia a única cópia legível.
    const winner = mergeSessionRecords([realRecord, ...backupRecords]).merge_grant;
    if (!winner) return false;
    const liveGrant: MergeGrant = { ...winner, consumedAt: undefined };
    return isMergeGrantLive(liveGrant, liveGrant.grantedTo, now);
  }

  // O real carrega o grant. Se o real já mostra MORTO (consumido ou TTL
  // expirado), o backup não acrescenta informação que mude o desfecho —
  // remover é seguro. O #6573 ("nunca remover while alive") já não se
  // aplica: a morte foi atestada pela única fonte de verdade.
  if (!isMergeGrantLive(real, real.grantedTo, now)) return false;

  // O real tem o grant VIVO. Verifica se algum backup carrega a MESMA
  // concessão:
  for (const backup of backupRecords) {
    const bg = backup.merge_grant;
    if (
      bg &&
      bg.grantedBy === real.grantedBy &&
      bg.grantedTo === real.grantedTo &&
      bg.grantedAt === real.grantedAt
    ) {
      // O backup reproduz a mesma concessão que o real, e o real já está
      // vivo. Se o backup NÃO tem `consumedAt`, ele não acrescenta
      // informação: o real sozinho já mostra o mesmo estado (caso #6952:
      // "já integralmente reproduzido no real") — nada a proteger.
      // Se o backup TEM `consumedAt` que o real não tem, há uma
      // divergência: o backup diz "morto", o real diz "vivo". #7462: o
      // carimbo do backup não testemunha o real, então o real continua
      // vivo — e remover o backup deixaria o real como única cópia com a
      // concessão viva (risco de ressurreição). Preserva o backup até o
      // TTL expirar, quando a janela morre sozinha.
      return bg.consumedAt ? true : false;
    }
  }

  // O real tem um grant VIVO que NENHUM backup carrega como mesma identidade.
  // Nesse caso NÃO há o que preservar: o real, que é a fonte de verdade (#7462),
  // já carrega a concessão viva e continua vivo com ou sem os backups. Os
  // backups não carregam grant algum — não há "única cópia legível" do grant
  // guardada neles, então removê-los não perde nada (o grant mora no real, e
  // o real continua vivo). O #6573 ("nunca remover while alive") já está
  // satisfeito: a concessão viva está no real, que não é tocado por aqui.
  // (#7564: o `return true` anterior era um falso positivo conservador —
  // invertia a monotonicidade: menos informação nos backups bloqueava mais).
  return false;
}

/**
 * Plano PURO (sem I/O) de quais grupos de `-safeBackup-*` já reconciliados
 * podem ser removidos com segurança. Reusa `groupBackupsByRealStem` e
 * `decideClaimReconciliation` — a MESMA primitiva de união que
 * `planClaimReconciliation` já usa, evitando uma 2ª regra de merge que
 * divergiria da 1ª (mesmo princípio citado na issue #6970).
 *
 * Grupo sem nenhum backup nunca aparece no resultado (nada a fazer). Backup
 * ÓRFÃO (sem arquivo real correspondente — sessão já encerrada, GC ainda não
 * passou) é reportado com `action: "orphan-backups-only"` — mesma
 * observabilidade que `planClaimReconciliation` já dá pro caso irmão
 * (#7005 self-review finding 2): este planejador nunca toca esses backups
 * (quem decide o destino deles é `planSessionGc`, pela liveness do grupo),
 * mas omiti-los do output silenciosamente sugeria "nada a revisar" quando na
 * verdade pode haver estado importante ali (achado ao vivo #7002).
 *
 * `opts.now` — injeção pra teste (mesmo padrão de `planSessionGc`); default
 * `Date.now()`. Só importa pra decidir liveness/TTL de `merge_grant`
 * (`mergeGrantBlocksBackupCleanup`) — claims não têm noção de tempo aqui.
 */
export function planSafeBackupCleanup(repoRoot: string, opts: { now?: number } = {}): SafeBackupCleanupResult[] {
  const now = opts.now ?? Date.now();
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !isSyncConflictCopyName(n)).sort();
  const backupsByRealStem = groupBackupsByRealStem(names);
  const claimedBackupNames = new Set<string>();
  const results: SafeBackupCleanupResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = (backupsByRealStem.get(stem) ?? []).sort();
    for (const b of backupNames) claimedBackupNames.add(b);
    if (backupNames.length === 0) continue; // sem backup — nada a recolher

    const realPath = join(dir, realName);
    const backupPaths = backupNames.map((n) => join(dir, n));
    const realRecord = readJsonSafe<SessionRecord>(realPath);
    if (!realRecord) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "skipped-unreadable-real",
        reason: "arquivo real ilegível/corrompido — grupo pulado (fail-soft, mesma disciplina de planClaimReconciliation)",
      });
      continue;
    }

    const backupRecords: SessionRecord[] = [];
    for (const b of backupNames) {
      const r = readJsonSafe<SessionRecord>(join(dir, b));
      if (r) backupRecords.push(r);
    }

    // #10618: claim de OUTRO repo presa num backup também segura o grupo —
    // sem isto o backup virava `removable` e a claim do diaria-design sumia.
    const pending = decideClaimReconciliation(realRecord, backupRecords);
    if (claimReconciliationHasAdditions(pending)) {
      const n = pending.addedIssues.length + (pending.addedForeignIssues ?? []).length;
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "pending-reconciliation",
        reason: `${n} claim(s) do grupo ainda não estão no real — rode reconcileClaims primeiro`,
      });
      continue;
    }

    if (mergeGrantBlocksBackupCleanup(realRecord, backupRecords, now)) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "has-merge-grant",
        reason:
          "claims reconciliadas, mas um backup do grupo carrega merge_grant que a união (#6952) mostra ainda " +
          "utilizável e o real sozinho não reproduz — remover perderia a única cópia legível dele; preservado",
      });
      continue;
    }

    results.push({
      identity: stem,
      realPath,
      backupPaths,
      action: "removable",
      reason: `claims já reconciliadas no real, nenhum backup carrega merge_grant — ${backupPaths.length} backup(s) removível(is)`,
    });
  }

  const orphanBackups = names.filter((n) => isSyncConflictCopyName(n) && !claimedBackupNames.has(n)).sort();
  for (const orphan of orphanBackups) {
    results.push({
      identity: `orphan-backup:${orphan}`,
      realPath: null,
      backupPaths: [join(dir, orphan)],
      action: "orphan-backups-only",
      reason:
        "backup sem arquivo real correspondente — este planejador nunca toca backup órfão; " +
        "o GC (`planSessionGc`) decide o destino dele com os critérios de liveness dele",
    });
  }

  return results;
}

/**
 * Aplica `planSafeBackupCleanup`: para cada grupo `"removable"`, RELÊ o real
 * e os backups no momento da escrita e RECOMPUTA a decisão contra esse
 * estado FRESCO — mesma disciplina de `reconcileClaims` (evita remover um
 * backup que recebeu uma claim ou um merge_grant NOVO entre o plano e a
 * execução; a corrida é real, `data/sessions/` é escrito por sessões
 * concorrentes o tempo todo). Remoção é best-effort (`rmSync`, nunca lança)
 * — mesmo idioma de `garbageCollectSessions`: uma falha rebaixa a entry pra
 * `"kept"` com o motivo anexado, e a próxima execução retenta.
 *
 * Nunca escreve no arquivo real — só remove backups já subsumidos por ele.
 * Idempotente por construção: rodar duas vezes sobre o mesmo estado não
 * remove nada na 2ª vez (os backups já não existem).
 *
 * `opts.now` — mesma injeção de `planSafeBackupCleanup`, propagada tanto pro
 * plano inicial quanto pra RECOMPUTAÇÃO fresca de `mergeGrantBlocksBackupCleanup`
 * logo abaixo (mesmo instante lógico das duas checagens — nunca um relógio
 * congelado do plano contra um "agora" resolvido de novo na escrita).
 */
export function cleanupReconciledSafeBackups(repoRoot: string, opts: { now?: number } = {}): SafeBackupCleanupResult[] {
  const now = opts.now ?? Date.now();
  const plan = planSafeBackupCleanup(repoRoot, { now });
  for (const entry of plan) {
    if (entry.action !== "removable" || !entry.realPath) continue; // "removable" nunca tem realPath null (só "orphan-backups-only" tem)

    const freshReal = readJsonSafe<SessionRecord>(entry.realPath);
    if (!freshReal) {
      entry.action = "skipped-unreadable-real";
      entry.reason = `${entry.reason} [ficou ilegível entre o plano e a remoção — pulado, próxima execução retenta]`;
      continue;
    }
    const freshBackupRecords: SessionRecord[] = [];
    const freshBackupPaths: string[] = [];
    for (const backupPath of entry.backupPaths) {
      const r = readJsonSafe<SessionRecord>(backupPath);
      if (r) {
        freshBackupRecords.push(r);
        freshBackupPaths.push(backupPath);
      }
      // backup que sumiu entre o plano e agora (removido por outra execução
      // concorrente) simplesmente não entra na releitura — nada a remover ali.
    }
    if (freshBackupPaths.length === 0) {
      entry.action = "removable"; // nada restava — já recolhido por outra execução
      entry.reason = `${entry.reason} [já não havia backup(s) no momento da remoção — outra execução chegou primeiro]`;
      continue;
    }

    if (claimReconciliationHasAdditions(decideClaimReconciliation(freshReal, freshBackupRecords))) {
      entry.action = "pending-reconciliation";
      entry.reason = `${entry.reason} [claim nova apareceu num backup entre o plano e a remoção — pulado, retenta depois de reconciliar]`;
      continue;
    }
    if (mergeGrantBlocksBackupCleanup(freshReal, freshBackupRecords, now)) {
      entry.action = "has-merge-grant";
      entry.reason = `${entry.reason} [merge_grant utilizável apareceu/persistiu num backup entre o plano e a remoção — pulado]`;
      continue;
    }

    let allRemoved = true;
    for (const backupPath of freshBackupPaths) {
      try {
        rmSync(backupPath, { force: true });
      } catch {
        allRemoved = false;
      }
    }
    if (!allRemoved) {
      entry.reason = `${entry.reason} [remoção falhou parcialmente — próxima execução retenta o que sobrou]`;
    }
  }
  return plan;
}

// ─── Poda por CONTAGEM de -safeBackup- (#7858) ─────────────────────────────
//
// `cleanupReconciledSafeBackups` (#6970, acima) só remove um backup quando o
// grupo INTEIRO já está seguro pra descartar (claims reconciliadas E nenhum
// merge_grant útil preso só no backup) — nunca poda parcialmente um grupo
// que ainda tem QUALQUER pendência. Isso deixa um buraco: o grupo de uma
// sessão VIVA, escrevendo heartbeat sob conflito de sync do OneDrive,
// acumula backup indefinidamente enquanto alguma pendência (por menor que
// seja) persistir — achado ao vivo do #7858 (22 cópias `-safeBackup-` do
// MESMO grupo, sessão overnight ATIVA no momento da medição).
//
// Esta poda é um BACKSTOP independente, por CONTAGEM: nunca espera o grupo
// inteiro ficar seguro — remove, um a um, do backup MAIS ANTIGO (por mtime)
// pro mais novo, só enquanto sobrar mais que `capPerGroup` backups. Cada
// candidato só é removido se a composição do que SOBRARIA (arquivo real +
// os demais backups do grupo, excluindo o candidato) já reproduz tudo que o
// candidato carrega — mesma disciplina de segurança de
// `decideClaimReconciliation`/`mergeGrantBlocksBackupCleanup`, só aplicada
// par a par dentro do grupo (contra o que SOBRA), não só contra o real
// sozinho. Um candidato com claim ou merge_grant único que NENHUM outro
// arquivo do grupo reproduz nunca é removido, mesmo acima do cap — a poda é
// sempre subordinada à segurança, nunca o contrário. NUNCA remove o arquivo
// REAL, nem toca `decideSessionGc`/reconstrução de âncora (#7002/#7003) —
// só descarta backup comprovadamente redundante.

export const SAFE_BACKUP_CAP_DEFAULT = 3;

export interface SafeBackupCapPruneEntry {
  path: string;
  reason: string;
}

export interface SafeBackupCapPruneResult {
  identity: string;
  realPath: string;
  /** Backups removidos (ou que SERIAM removidos, no plano). */
  removed: SafeBackupCapPruneEntry[];
  /** Backups mantidos — dentro do cap, ou não comprovadamente redundantes. */
  kept: string[];
}

/** `statSync(path).mtimeMs`, ou `null` se ilegível/ausente — nunca lança. */
function statMtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Plano PURO (só leitura) da poda por contagem. Ordena backups do grupo por
 * `mtimeMs` (mais antigo primeiro; mtime indisponível ordena como o mais
 * antigo possível — mesma direção conservadora do resto do módulo: prefere
 * remover o que nem dá pra datar). Testa cada candidato, do mais antigo pro
 * mais novo, PARANDO assim que restarem `capPerGroup` backups — nunca poda
 * abaixo do cap, mesmo que os restantes também fossem redundantes (mantém
 * margem de recuperação manual).
 *
 * Grupo com `backupNames.length <= capPerGroup` nunca aparece no resultado
 * (nada a podar) — mesmo padrão de "nada a fazer" de `planSafeBackupCleanup`.
 */
export function planSafeBackupCapPrune(
  repoRoot: string,
  opts: { now?: number; capPerGroup?: number } = {},
): SafeBackupCapPruneResult[] {
  const now = opts.now ?? Date.now();
  const capPerGroup = opts.capPerGroup ?? SAFE_BACKUP_CAP_DEFAULT;
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !isSyncConflictCopyName(n)).sort();
  const backupsByRealStem = groupBackupsByRealStem(names);
  const results: SafeBackupCapPruneResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = backupsByRealStem.get(stem) ?? [];
    if (backupNames.length <= capPerGroup) continue; // dentro do cap — nada a podar

    const realPath = join(dir, realName);
    const realRecord = readJsonSafe<SessionRecord>(realPath);
    if (!realRecord) continue; // real ilegível — sem base segura pra comparar, mesma disciplina fail-soft de planSafeBackupCleanup

    const withMtime = backupNames
      .map((n) => {
        const path = join(dir, n);
        return { name: n, path, mtimeMs: statMtimeOrNull(path) ?? 0 };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let remaining = withMtime.slice();
    const removed: SafeBackupCapPruneEntry[] = [];

    // Cada candidato é avaliado contra `remaining` no estado ATUAL (já
    // descontando remoções deste mesmo laço, não o grupo original) — é essa
    // ordem sequencial que torna seguro podar 2 backups adjacentes com a
    // MESMA claim única (o 1º ainda vê o 2º presente e é liberado; o 2º já
    // não vê o 1º e é preservado). Paralelizar esta avaliação reintroduziria
    // risco de perda de dado sem nenhum teste que pegasse isso hoje.
    for (const candidate of withMtime) {
      if (remaining.length <= capPerGroup) break; // já dentro do cap

      const others = remaining.filter((r) => r.name !== candidate.name);
      const candidateRecord = readJsonSafe<SessionRecord>(candidate.path);
      if (!candidateRecord) {
        // Backup ilegível não carrega informação recuperável — seguro
        // remover (nada a perder).
        removed.push({ path: candidate.path, reason: "backup ilegível/corrompido — nada a preservar" });
        remaining = others;
        continue;
      }

      const otherRecords = others
        .map((r) => readJsonSafe<SessionRecord>(r.path))
        .filter((r): r is SessionRecord => r !== null);

      // Composição do que SOBRARIA sem este candidato: real + demais
      // backups do grupo. `mergeSessionRecords` agrega claims/merge_grant
      // com a MESMA lógica que o read-path real usa (#6952) — não é uma 2ª
      // regra de merge divergente.
      const composite = mergeSessionRecords([realRecord, ...otherRecords]);

      // #10618: inclui claim de outro repo (`claimed_foreign_issues`).
      if (claimReconciliationHasAdditions(decideClaimReconciliation(composite, [candidateRecord]))) {
        // Candidato carrega claim que nada mais no grupo reproduz — não é
        // seguro remover, mesmo acima do cap.
        continue;
      }

      if (mergeGrantBlocksBackupCleanup(composite, [candidateRecord], now)) {
        // Mesma checagem de merge_grant vivo/consumido que
        // cleanupReconciledSafeBackups já usa contra o real — aqui contra o
        // que SOBRARIA sem este candidato.
        continue;
      }

      removed.push({
        path: candidate.path,
        reason: `grupo acima do cap (${withMtime.length} > ${capPerGroup}) — claims e merge_grant já reproduzidos pelo que sobra no grupo`,
      });
      remaining = others;
    }

    if (removed.length > 0) {
      results.push({ identity: stem, realPath, removed, kept: remaining.map((r) => r.path) });
    }
  }

  return results;
}

/**
 * Aplica `planSafeBackupCapPrune`: o plano em si já lê o estado do disco no
 * momento da chamada (sem cache entre plano e aplicação — as duas etapas
 * rodam na mesma invocação). Remoção best-effort (`rmSync`, nunca lança) —
 * mesmo idioma de `cleanupReconciledSafeBackups`: uma falha de I/O fica pra
 * próxima execução retentar. Nunca escreve no arquivo real.
 */
export function applySafeBackupCapPrune(
  repoRoot: string,
  opts: { now?: number; capPerGroup?: number } = {},
): SafeBackupCapPruneResult[] {
  const plan = planSafeBackupCapPrune(repoRoot, opts);
  for (const entry of plan) {
    for (const item of entry.removed) {
      try {
        rmSync(item.path, { force: true });
      } catch {
        // best-effort — próxima execução retenta
      }
    }
  }
  return plan;
}
