/**
 * diaria-subscribers-identity-resolve.ts (#6464 fatia 5 — #6589)
 *
 * Resolução de identidade CROSS-PLATAFORMA do store unificado
 * (`diaria-subscribers-db.ts`) + relatório de não-casados. Decisão do editor
 * já registrada no épico (28/08/2026, comentário no #6464):
 *
 *   Opção (a): identidades não-casadas ficam como assinantes separados, com
 *   relatório. Sem fusão manual pelo painel.
 *
 * ## A regra — determinística, sem heurística
 *
 * Dois `identity_alias` são a MESMA pessoa quando (e só quando):
 *   - **mesmo e-mail canonicalizado** (`canonicalizeGmail` — ponto/plus do
 *     Gmail), em QUALQUER plataforma, inclusive dentro da mesma plataforma
 *     (ex: Kit não tem `external_id` nativo — duas variantes de grafia do
 *     mesmo Gmail viram 2 `identity_alias` distintos na ingestão, e é este
 *     módulo que os reconcilia);
 *   - **mesmo `external_id` dentro da MESMA plataforma** — já garantido pelo
 *     find-or-create de `ensureSubscriber` (chave natural
 *     `(platform, external_id, email)`); nada a fazer aqui.
 *
 * Nada de nome, domínio ou proximidade temporal. Duas identidades que a
 * regra não casa permanecem dois `subscriber` — **esse é o estado correto
 * do arquivo, não um defeito a corrigir depois** (o store nunca afirma um
 * vínculo que não pode provar). Casos que ficam separados de propósito:
 * voto anônimo do É IA? (`{uuid}@web...`), e-mail trocado entre plataformas,
 * cadastro duplicado com endereços diferentes.
 *
 * ## Mecânica do merge
 *
 * `resolveIdentitiesByEmail` agrupa TODOS os `identity_alias.email`
 * (ignorando aliases sem e-mail) por `canonicalizeGmail`; qualquer grupo que
 * abranja mais de 1 `subscriber_id` é fundido no subscriber de MENOR id
 * (determinístico e estável entre execuções — "quem chegou primeiro" no
 * store, não um critério editorial). Reassinala `identity_alias`,
 * `subscription` e `event` do perdedor pro vencedor e apaga a linha
 * `subscriber` órfã. Idempotente: rodar 2x não gera merge novo (o 1º já
 * deixou 1 `subscriber_id` só por e-mail canonicalizado).
 *
 * `subscription` tem `UNIQUE(subscriber_id, platform)` — se os dois lados
 * já tiverem uma `subscription` na MESMA plataforma (só acontece em
 * variantes de grafia dentro da própria plataforma, já que plataformas
 * diferentes usam valores de `platform` diferentes), o conflito é resolvido
 * mantendo a `subscription` com `updated_at` mais recente — decisão sobre
 * QUAL REGISTRO sobrevive ao merge, não sobre SE duas identidades casam (a
 * decisão de casar já foi tomada pela regra de e-mail acima).
 *
 * ## O entregável é o RELATÓRIO, não a fusão manual
 *
 * `buildUnmatchedReport` conta, por plataforma, quantos `subscriber`
 * continuam com aliases em UMA SÓ plataforma após a resolução — e aponta
 * "sinal fraco" informativo (mesmo local-part do e-mail, domínio/plataforma
 * diferentes) só para DIMENSIONAR o erro, nunca para fundir automaticamente.
 *
 * ## PISO, não número exato (consequência analítica do épico)
 *
 * Toda métrica derivada deste store que cruze plataformas (ex: "quantos
 * sobreviveram Beehiiv → Kit") é PISO — identidade não-casada aparece como
 * churn + cadastro novo. `CROSS_PLATFORM_FLOOR_NOTE` carrega esse aviso no
 * próprio relatório (não só em prosa), pra qualquer consumidor futuro
 * (painel do Studio, fatia 6) reproduzir o aviso sem precisar rederivar.
 *
 * @see scripts/diaria-subscribers-resolve-identity.ts — CLI/bootstrap.
 * @see scripts/lib/diaria-subscribers-db.ts — schema + primitivas.
 * @see https://github.com/vjpixel/diaria-studio/issues/6589
 * @see https://github.com/vjpixel/diaria-studio/issues/6464 (épico)
 */

import type { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { canonicalizeGmail } from "./canonicalize-gmail.ts";
import { PLATFORMS, type Platform } from "./diaria-subscribers-db.ts";

// ---------------------------------------------------------------------------
// Resolução — merge determinístico por e-mail canonicalizado
// ---------------------------------------------------------------------------

export interface IdentityMergeResult {
  canonical_subscriber_id: number;
  merged_subscriber_id: number;
  canonical_email: string;
  aliases_moved: number;
  subscriptions_moved: number;
  /** Conflitos `UNIQUE(subscriber_id, platform)` resolvidos mantendo a
   *  subscription com `updated_at` mais recente — a outra é descartada. */
  subscriptions_dropped: number;
  events_moved: number;
}

export interface IdentityResolutionSummary {
  generated_at: string;
  /** Grupos distintos de e-mail canonicalizado examinados (com ao menos 1 alias). */
  email_groups_examined: number;
  /** Grupos que abrangiam mais de 1 subscriber_id — os que geraram merge. */
  email_groups_merged: number;
  subscribers_merged: number;
  merges: IdentityMergeResult[];
}

/**
 * Funde `loserId` em `canonicalId`: move `identity_alias`/`event` direto
 * (nenhum dos dois tem `UNIQUE` que inclua `subscriber_id` de um jeito que
 * bloqueie a reatribuição), resolve conflito de `subscription` mantendo a
 * mais recente, e apaga a linha `subscriber` do perdedor. Transação própria
 * (mesmo padrão de `ensureSubscriber`) — uma falha no meio nunca deixa o
 * store com metade movido.
 */
function mergeSubscribers(
  db: DatabaseSync,
  canonicalId: number,
  loserId: number,
  canonicalEmail: string,
  now: string,
): IdentityMergeResult {
  db.exec("BEGIN");
  try {
    const aliasResult = db
      .prepare("UPDATE identity_alias SET subscriber_id = ? WHERE subscriber_id = ?")
      .run(canonicalId, loserId);

    const loserSubs = db
      .prepare(
        "SELECT platform, updated_at FROM subscription WHERE subscriber_id = ?",
      )
      .all(loserId) as Array<{ platform: string; updated_at: string }>;

    let subscriptionsMoved = 0;
    let subscriptionsDropped = 0;

    for (const sub of loserSubs) {
      const existing = db
        .prepare(
          "SELECT updated_at FROM subscription WHERE subscriber_id = ? AND platform = ?",
        )
        .get(canonicalId, sub.platform) as { updated_at: string } | undefined;

      if (!existing) {
        db.prepare(
          "UPDATE subscription SET subscriber_id = ? WHERE subscriber_id = ? AND platform = ?",
        ).run(canonicalId, loserId, sub.platform);
        subscriptionsMoved++;
        continue;
      }

      // Conflito: as duas plataformas já tinham subscription — mantém a
      // mais recente por updated_at, descarta a outra. Decisão sobre QUAL
      // REGISTRO sobrevive, não sobre SE as identidades casam.
      subscriptionsDropped++;
      if (sub.updated_at > existing.updated_at) {
        db.prepare(
          "DELETE FROM subscription WHERE subscriber_id = ? AND platform = ?",
        ).run(canonicalId, sub.platform);
        db.prepare(
          "UPDATE subscription SET subscriber_id = ? WHERE subscriber_id = ? AND platform = ?",
        ).run(canonicalId, loserId, sub.platform);
        subscriptionsMoved++;
      } else {
        db.prepare(
          "DELETE FROM subscription WHERE subscriber_id = ? AND platform = ?",
        ).run(loserId, sub.platform);
      }
    }

    const eventResult = db
      .prepare("UPDATE event SET subscriber_id = ? WHERE subscriber_id = ?")
      .run(canonicalId, loserId);

    db.prepare("DELETE FROM subscriber WHERE id = ?").run(loserId);
    db.prepare("UPDATE subscriber SET updated_at = ? WHERE id = ?").run(now, canonicalId);

    db.exec("COMMIT");

    return {
      canonical_subscriber_id: canonicalId,
      merged_subscriber_id: loserId,
      canonical_email: canonicalEmail,
      aliases_moved: Number(aliasResult.changes),
      subscriptions_moved: subscriptionsMoved,
      subscriptions_dropped: subscriptionsDropped,
      events_moved: Number(eventResult.changes),
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Resolve identidade cross-plataforma no store inteiro — agrupa por e-mail
 * canonicalizado, funde qualquer grupo com mais de 1 `subscriber_id` no de
 * menor id. Idempotente: seguro rodar depois de toda ingestão (Kit, Brevo, e
 * futuramente Beehiiv), em qualquer ordem, quantas vezes for preciso.
 */
/**
 * Agrupa `identity_alias.email` (ignorando aliases sem e-mail) por
 * `canonicalizeGmail` — miolo READ-ONLY compartilhado por
 * `resolveIdentitiesByEmail` (que funde de verdade) e `planIdentityMerges`
 * (que só relata o que fundiria, #7205). Nenhuma escrita acontece aqui.
 */
function groupAliasesByCanonicalEmail(db: DatabaseSync): Map<string, Set<number>> {
  const rows = db
    .prepare("SELECT subscriber_id, email FROM identity_alias WHERE email IS NOT NULL AND email != ''")
    .all() as Array<{ subscriber_id: number; email: string }>;

  const groups = new Map<string, Set<number>>();
  for (const r of rows) {
    const canon = canonicalizeGmail(r.email);
    // Defensivo: uma string vazia/sem "@" canonicaliza pra si mesma
    // (`canonicalizeGmail("")` → `""`) — sem este guard, um futuro caller
    // que grave `identity_alias.email = ""` faria TODOS os aliases vazios
    // colidirem num "grupo" só e se fundirem por acidente. Nenhum caller
    // hoje faz isso (Kit/Brevo já filtram e-mail vazio antes de chamar
    // `ensureSubscriber`), mas a regra "só e-mail canonicalizado casa"
    // pressupõe um e-mail de verdade, não a ausência de um.
    if (!canon || !canon.includes("@")) continue;
    let set = groups.get(canon);
    if (!set) {
      set = new Set();
      groups.set(canon, set);
    }
    set.add(r.subscriber_id);
  }
  return groups;
}

export function resolveIdentitiesByEmail(
  db: DatabaseSync,
  now: string = new Date().toISOString(),
): IdentityResolutionSummary {
  const groups = groupAliasesByCanonicalEmail(db);

  const merges: IdentityMergeResult[] = [];
  let emailGroupsMerged = 0;

  for (const [canonEmail, ids] of groups) {
    if (ids.size < 2) continue;
    emailGroupsMerged++;
    const sorted = [...ids].sort((a, b) => a - b);
    const canonicalId = sorted[0];
    for (const loserId of sorted.slice(1)) {
      merges.push(mergeSubscribers(db, canonicalId, loserId, canonEmail, now));
    }
  }

  return {
    generated_at: now,
    email_groups_examined: groups.size,
    email_groups_merged: emailGroupsMerged,
    subscribers_merged: merges.length,
    merges,
  };
}

// ---------------------------------------------------------------------------
// Plano DRY-RUN — o que fundiria, sem escrever nada (#7205)
// ---------------------------------------------------------------------------

export interface IdentityMergePlanItem {
  canonical_subscriber_id: number;
  loser_subscriber_ids: number[];
  canonical_email: string;
}

export interface IdentityMergePlan {
  generated_at: string;
  email_groups_examined: number;
  email_groups_would_merge: number;
  subscribers_would_merge: number;
  merges: IdentityMergePlanItem[];
}

/**
 * Mesma regra de casamento de `resolveIdentitiesByEmail` (mesmo helper de
 * agrupamento, `groupAliasesByCanonicalEmail`), mas NUNCA escreve — é o
 * relatório "o que fundiria" que o CLI (#7205) imprime por padrão, antes de
 * qualquer `--apply`. Os dois nunca podem divergir na REGRA de casamento
 * porque compartilham o mesmo agrupamento; só a AÇÃO (relatar vs. fundir)
 * difere.
 */
export function planIdentityMerges(
  db: DatabaseSync,
  now: string = new Date().toISOString(),
): IdentityMergePlan {
  const groups = groupAliasesByCanonicalEmail(db);

  const merges: IdentityMergePlanItem[] = [];
  let emailGroupsWouldMerge = 0;
  let subscribersWouldMerge = 0;

  for (const [canonEmail, ids] of groups) {
    if (ids.size < 2) continue;
    emailGroupsWouldMerge++;
    const sorted = [...ids].sort((a, b) => a - b);
    const loserIds = sorted.slice(1);
    subscribersWouldMerge += loserIds.length;
    merges.push({
      canonical_subscriber_id: sorted[0],
      loser_subscriber_ids: loserIds,
      canonical_email: canonEmail,
    });
  }

  return {
    generated_at: now,
    email_groups_examined: groups.size,
    email_groups_would_merge: emailGroupsWouldMerge,
    subscribers_would_merge: subscribersWouldMerge,
    merges,
  };
}

// ---------------------------------------------------------------------------
// Guard de conservação (#7205) — fusão move linhas, nunca perde
// ---------------------------------------------------------------------------

export interface ConservationCheck {
  ok: boolean;
  identity_aliases_before: number;
  identity_aliases_after: number;
  events_before: number;
  events_after: number;
}

/**
 * `identity_alias` e `event` são só REATRIBUÍDOS pro subscriber canônico
 * durante um merge (`UPDATE ... SET subscriber_id`), nunca apagados — a
 * soma de cada um tem que bater exatamente antes e depois. `subscription`
 * fica de fora de propósito: um conflito `UNIQUE(subscriber_id, platform)`
 * pode legitimamente DESCARTAR uma linha (mantém a mais recente,
 * `subscriptions_dropped` em `IdentityMergeResult`) — isso é uma decisão
 * documentada sobre qual registro sobrevive, não perda de dado silenciosa.
 */
export function checkMergeConservation(
  before: { identity_aliases: number; events: number },
  after: { identity_aliases: number; events: number },
): ConservationCheck {
  return {
    ok: before.identity_aliases === after.identity_aliases && before.events === after.events,
    identity_aliases_before: before.identity_aliases,
    identity_aliases_after: after.identity_aliases,
    events_before: before.events,
    events_after: after.events,
  };
}

// ---------------------------------------------------------------------------
// Backup consistente antes de qualquer escrita real (#7205)
// ---------------------------------------------------------------------------

/** Timestamp seguro pra nome de arquivo — `:`/`.` não são válidos em nome
 *  de arquivo no Windows, que é onde este store realmente roda em produção. */
function backupFileSuffix(now: string): string {
  return now.replace(/[:.]/g, "-");
}

/**
 * Copia o `.db` pra um arquivo `{dbPath}.backup-{timestamp}` ao lado do
 * original, ANTES de qualquer merge real. Cópia simples (`copyFileSync`) —
 * o original nunca é tocado por este helper, só lido; diferente do reset
 * atômico (#7187, `atomicRebuildTempPath`/`atomicCommitRebuild`), que troca
 * o arquivo definitivo inteiro por um novo — aqui o objetivo é um SNAPSHOT
 * adicional, preservando o original no lugar de origem, pra restaurar à mão
 * se a resolução ao vivo (#7205) precisar ser desfeita (a operação em si
 * não tem undo — ver docstring do módulo).
 *
 * Não copia sidecars `-wal`/`-shm`: o caller do CLI fecha a conexão de
 * leitura antes de chamar isto, então o `.db` principal já reflete o estado
 * consistente sem WAL pendente no momento do backup.
 */
export function backupStoreFile(dbPath: string, now: string = new Date().toISOString()): string {
  if (!existsSync(dbPath)) {
    throw new Error(`backupStoreFile: store não encontrado em ${dbPath} — nada para copiar.`);
  }
  const backupPath = `${dbPath}.backup-${backupFileSuffix(now)}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Relatório de não-casados — o entregável real desta fatia
// ---------------------------------------------------------------------------

export const CROSS_PLATFORM_FLOOR_NOTE =
  "Qualquer número derivado deste store que cruze plataformas é PISO, nunca " +
  "exato (#6464 fatia 5): identidade não-casada aparece como churn + " +
  "cadastro novo, não como continuidade.";

export interface UnmatchedPlatformStat {
  platform: Platform;
  /** Total de subscribers com pelo menos 1 alias nesta plataforma. */
  total_subscribers: number;
  /** Subscribers cuja ÚNICA plataforma (após resolução) é esta. */
  unmatched_subscribers: number;
}

/**
 * Sinal fraco informativo (#6464 "com que sinal fraco de possível vínculo")
 * — subscribers não-casados cujo e-mail compartilha o MESMO local-part
 * (antes do `@`, já canonicalizado) em plataformas DIFERENTES. Nunca usado
 * pra fundir automaticamente (isso seria heurística, fora do escopo) — só
 * pra dimensionar quantos não-casados têm ALGUM indício de vínculo possível
 * vs. quantos não têm indício nenhum.
 */
export interface WeakSignalGroup {
  local_part: string;
  platforms: Platform[];
  subscriber_ids: number[];
}

export interface UnmatchedReport {
  generated_at: string;
  total_subscribers: number;
  /** Subscribers com aliases em 2+ plataformas — casaram de fato. */
  matched_subscribers: number;
  /** Subscribers com aliases em 1 só plataforma — não casaram. */
  unmatched_subscribers: number;
  by_platform: UnmatchedPlatformStat[];
  weak_signals: WeakSignalGroup[];
  note: string;
}

/**
 * Relatório de não-casados — pensado pra rodar DEPOIS de
 * `resolveIdentitiesByEmail` (reflete o estado atual do store; se chamado
 * antes, "não-casado" inclui identidades que a resolução ainda vai fundir).
 * Puro sobre o que já está no DB — nunca persiste nada, sempre recomputado
 * (mesma disciplina de "derivadas nunca persistidas" do resto do store).
 */
export function buildUnmatchedReport(
  db: DatabaseSync,
  now: string = new Date().toISOString(),
): UnmatchedReport {
  const rows = db
    .prepare("SELECT subscriber_id, platform, email FROM identity_alias")
    .all() as Array<{ subscriber_id: number; platform: Platform; email: string | null }>;

  const byId = new Map<number, { platforms: Set<Platform>; emails: Set<string> }>();
  for (const r of rows) {
    let entry = byId.get(r.subscriber_id);
    if (!entry) {
      entry = { platforms: new Set(), emails: new Set() };
      byId.set(r.subscriber_id, entry);
    }
    entry.platforms.add(r.platform);
    if (r.email) entry.emails.add(r.email);
  }

  const platformTotals = new Map<Platform, number>();
  const platformUnmatched = new Map<Platform, number>();
  const unmatchedByLocalPart = new Map<string, WeakSignalGroup>();
  let matched = 0;
  let unmatched = 0;

  for (const [subscriberId, entry] of byId) {
    for (const p of entry.platforms) {
      platformTotals.set(p, (platformTotals.get(p) ?? 0) + 1);
    }

    if (entry.platforms.size > 1) {
      matched++;
      continue;
    }

    unmatched++;
    const onlyPlatform = [...entry.platforms][0];
    platformUnmatched.set(onlyPlatform, (platformUnmatched.get(onlyPlatform) ?? 0) + 1);

    for (const email of entry.emails) {
      const canon = canonicalizeGmail(email);
      const at = canon.lastIndexOf("@");
      const localPart = at === -1 ? canon : canon.slice(0, at);
      let group = unmatchedByLocalPart.get(localPart);
      if (!group) {
        group = { local_part: localPart, platforms: [], subscriber_ids: [] };
        unmatchedByLocalPart.set(localPart, group);
      }
      if (!group.platforms.includes(onlyPlatform)) group.platforms.push(onlyPlatform);
      if (!group.subscriber_ids.includes(subscriberId)) group.subscriber_ids.push(subscriberId);
    }
  }

  const byPlatform: UnmatchedPlatformStat[] = PLATFORMS.map((p) => ({
    platform: p,
    total_subscribers: platformTotals.get(p) ?? 0,
    unmatched_subscribers: platformUnmatched.get(p) ?? 0,
  }));

  // Sinal fraco só interessa quando aponta pra MAIS DE 1 plataforma — mesmo
  // local-part repetido dentro de 1 única plataforma não é indício de nada
  // cross-plataforma.
  const weakSignals = [...unmatchedByLocalPart.values()].filter(
    (g) => g.platforms.length > 1,
  );

  return {
    generated_at: now,
    total_subscribers: byId.size,
    matched_subscribers: matched,
    unmatched_subscribers: unmatched,
    by_platform: byPlatform,
    weak_signals: weakSignals,
    note: CROSS_PLATFORM_FLOOR_NOTE,
  };
}
