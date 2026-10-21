#!/usr/bin/env node
/**
 * scripts/sync-kit-sem-abertura-to-brevo.ts (#10437)
 *
 * Move pra Brevo (lista `brevo_diaria.list_id`) quem está `active` no Kit e
 * recebeu `min_mature_sends` edições da diária sem abrir nem clicar. Saída do
 * Kit por TAG de exclusão `envio-brevo`, nunca descadastro (decisão do editor,
 * 19/10/2026; armadilha 4 da issue: descadastro no Kit não tem volta, e a
 * promoção de volta travaria). Critério e exclusões:
 * `scripts/lib/kit-sem-abertura.ts`.
 *
 * ## Duas flags (default do código: desligadas; LIGADAS no
 * `platform.config.json` desde 19/10/2026, PR #10532 — #10537)
 *
 * - `brevo_diaria.kit_sem_abertura.enabled` — liga ESTE script. Desligada ⇒
 *   sai 0 sem nenhuma chamada de rede (e `brevo-diaria-run.ts` nem o invoca).
 * - `kit.diaria_exclusion_segment.enabled` — troca o `subscriber_filter` do
 *   broadcast da diária pra o segmento "ativos sem a tag". Este script EXIGE
 *   as duas pra mover alguém: tag sem o segmento no envio é edição em dobro
 *   pra todo movido, todo dia. Com a 1ª ligada e a 2ª não, só faz dry-run. A
 *   config do segmento é lida pelo MESMO parser do publish/schedule
 *   (`parseDiariaExclusionSegment`): `segment_id` inválido não move ninguém.
 *
 * ## Ordem por contato (corpo da issue)
 *
 * 1. Ingere na lista com o atributo `ORIGEM_DIARIA = kit_sem_abertura`
 *    (intro própria na Brevo, decisão do editor de 19/10) e RELÊ: lista E
 *    atributo precisam conferir.
 * 2. Aplica a tag `envio-brevo` no Kit e relê (`listSubscriberTags`, a
 *    direção sem atraso de propagação).
 * 3. Upsert no store com origem própria `kit-sem-abertura:{id}` (armadilha 5:
 *    o Passo 1 de `evaluate-brevo-diaria.ts` tira da Brevo todo `kit:` ativo
 *    no Kit; estes continuam ativos lá de propósito).
 * 4. Uma linha em `data/brevo-diaria/kit-sem-abertura-log.jsonl`.
 *
 * ## O que o código garante (nunca uma pessoa sem canal)
 *
 * - Falha no passo 1 ⇒ nada tocado no Kit; a próxima rodada seleciona de novo.
 * - Falha no passo 2 (a tag pode ou não ter pegado) ⇒ o store é gravado
 *   MESMO ASSIM, com `kit_tag_pending: true`. Sem isso o contato com a tag
 *   aplicada ficaria fora do store: o seletor o exclui por ter a tag, e o guard
 *   #6485 o tira da Brevo por estar `active` no Kit, sem canal pra sempre. Com
 *   o marcador, o guard o isenta, o seletor o pula, e cada rodada retenta a
 *   tag até a releitura confirmar. Até lá ele pode receber em dobro (visível,
 *   reversível).
 * - Falha no passo 3 (escrita do store) ⇒ contada como falha; o contato tem a
 *   tag e não está no store. A rodada seguinte o encontra como ÓRFÃO
 *   ("tem a tag `envio-brevo` e não está no store"), re-ingere (idempotente) e
 *   grava o store — nunca o exclui em silêncio.
 * - O store é gravado a cada contato, então uma queda no meio não perde quem
 *   já foi movido.
 * - Órfão já `emailBlacklisted` na Brevo (#10557) não é re-ingerido: a tag
 *   `envio-brevo` é removida no Kit (com releitura) e ele volta a receber por
 *   lá. O par no `evaluate-brevo-diaria.ts` (Passo 0) desfaz do mesmo jeito a
 *   movimentação de quem entrou no store já bloqueado na Brevo.
 *
 * ## Onda
 *
 * Cadastros novos (até `new_signup_window_days`, default 30) entram antes do
 * backlog, mas só se couberem na cota da CONTA Brevo no dia do ENVIO
 * (`checkNewSignupsFitAccountQuota`): não cabendo, o Passo 3c inteiro aborta
 * sem mover ninguém. O backlog entra limitado pela fila (`daily_send_cap`) e
 * pela mesma cota. Circuit breaker pausado zera a rodada. `--max-add N`
 * limita a rodada inteira deste passo (novos inclusive). Contato do backlog
 * pulado na confirmação (blacklisted na Brevo, apoiador pelo GET singular)
 * cede a vaga ao próximo da fila (#10664) — senão os mais antigos pulados
 * ocupariam as mesmas vagas toda rodada e o backlog pararia.
 *
 * Sem MillionVerifier: são contatos que confirmaram o double opt-in (mesmo
 * raciocínio do #5807).
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts            # dry-run
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts --push     # exige as 2 flags
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts --push --max-add 5
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts --send-day 2026-10-21   # dia UTC do envio (default: amanhã em BRT)
 *
 * Exit: 0 ok/desligado; 1 falha em algum contato (os demais seguem), ou cota
 * da conta sem espaço pros cadastros novos; 2 precondição (config, chave,
 * store ausente, tag `envio-brevo` inexistente, registro de broadcasts
 * ilegível).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getIntArg, getStringArg } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { listSubscribers, KitApiError } from "./lib/kit-client.ts";
import { getSubscriberById } from "./lib/kit-subscribers.ts";
import { findTagIdByName, tagSubscriber, untagSubscriber, listSubscriberTags } from "./lib/kit-broadcasts.ts";
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";
import { readRolloutGuardrailState } from "./lib/brevo-diaria-guardrail.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { computeCurrentActiveCount, assertStoreFileGuard } from "./sync-pending-to-brevo.ts";
import { buildOrigin, ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts";
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts";
import { fetchAccountQuotaSnapshot, resolveAccountDailyLimit } from "./lib/brevo-account-quota.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { createRequestPacer, fetchAudience, kitDiariaPublishedPath, newsletterKitPublishedPath } from "./kit-provider-split.ts";
import { parseDiariaExclusionSegment, KIT_ENVIO_BREVO_TAG_NAME, type DiariaExclusionSegmentConfig } from "./lib/kit-diaria-audience.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./lib/apoio-segments-canonical-kit.ts";
import {
  BREVO_ORIGEM_ATTRIBUTE,
  BREVO_ORIGEM_KIT_SEM_ABERTURA,
  DEFAULT_KIT_SEM_ABERTURA_LOG_PATH,
  buildEngagementIndex,
  checkNewSignupsFitAccountQuota,
  classifyDiariaBroadcasts,
  computeBacklogSlots,
  dedupeBroadcastRecords,
  diariaSendDayUtc,
  formatKitSemAberturaLogLine,
  isKitSemAberturaEnabled,
  KIT_SEM_ABERTURA_MAX_BACKLOG_REPLACEMENTS,
  parseDiariaBroadcastState,
  parseKitSemAberturaNumbers,
  planKitSemAberturaWave,
  selectKitSemAbertura,
  type BroadcastEngagement,
  type DiariaBroadcastRecord,
  type KitActiveCandidate,
  type KitSemAberturaConfig,
  type KitSemAberturaLogEntry,
} from "./lib/kit-sem-abertura.ts";
import {
  DEFAULT_KIT_ENGAGEMENT_CACHE_PATH,
  extendKitEngagementCache,
  mergeEngagementIndexes,
  planKitEngagementFetch,
  type KitEngagementCache,
} from "./lib/kit-engagement-cache.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { DEFAULT_KIT_SEM_ABERTURA_LOG_PATH };
const DEFAULT_QUEUE_CAP = 300;

export interface KitSemAberturaPlatformConfig {
  brevo_diaria?: {
    api_key_env: string;
    list_id: number | null;
    daily_send_cap?: number;
    account_daily_limit?: number;
    kit_sem_abertura?: KitSemAberturaConfig;
  };
  kit?: { diaria_exclusion_segment?: DiariaExclusionSegmentConfig };
}

/** Tudo que toca rede/disco — injetável em teste. */
export interface KitSemAberturaDeps {
  nowMs: number;
  log: (msg: string) => void;
  /** Lança se algum arquivo do registro estiver ilegível (o Passo 3c aborta). */
  readRegistry: () => DiariaBroadcastRecord[];
  listKitActive: () => Promise<KitActiveCandidate[]>;
  fetchEngagement: (broadcastId: number) => Promise<BroadcastEngagement>;
  /**
   * Cache do engajamento de broadcasts com >= 7 dias (#10514,
   * `lib/kit-engagement-cache.ts`). Ausente ⇒ relê todo o registro (como
   * antes). `read` devolve o JSON cru ou `null`; erro em `read`/`write` é
   * fail-soft (aviso + releitura completa).
   */
  engagementCache?: { read: () => unknown; write: (cache: KitEngagementCache) => void };
  findEnvioBrevoTagId: () => Promise<number | null>;
  readStore: () => BrevoDiariaStore;
  writeStore: (store: BrevoDiariaStore) => void;
  rolloutPaused: () => boolean;
  /** Consumo transacional no dia UTC do ENVIO; `null` = não lido (falha). */
  transactionalOnSendDay: (sendDay: string) => Promise<number | null>;
  /**
   * `apoio_nivel` pelo GET SINGULAR do assinante (a listagem serve `fields`
   * defasado). `null`/vazio = não é apoiador. Lança se a leitura falhar.
   */
  getApoioNivel: (subscriberId: number) => Promise<string | null>;
  /**
   * #10536 — o e-mail já está `emailBlacklisted` na conta Brevo da diária?
   * 404 (contato inexistente) = `false`. Lança se a leitura falhar (o contato
   * é adiado, nunca movido às cegas).
   */
  isBrevoBlacklisted: (email: string) => Promise<boolean>;
  ingestBrevo: (email: string) => Promise<void>;
  tagKit: (tagId: number, subscriberId: number) => Promise<void>;
  /**
   * #10557 — remove a tag do assinante no Kit e RELÊ (`listSubscriberTags`):
   * lança se a releitura ainda mostrar a tag (o 2xx do DELETE não é prova).
   * Tag já ausente (404 no DELETE) conta como removida se a releitura
   * confirmar.
   */
  untagKit: (tagId: number, subscriberId: number) => Promise<void>;
  appendLog: (line: string) => void;
}

export interface KitSemAberturaRunResult {
  code: 0 | 1 | 2;
  disabled?: boolean;
  dryRun: boolean;
  selected: number;
  moved: number;
  failed: number;
  deferred: number;
  /** Órfãos reconciliados (tag `envio-brevo` sem store) + tags pendentes confirmadas. */
  reconciled?: number;
  /** #10536 — selecionados que já estavam `emailBlacklisted` na Brevo: ficam no Kit. */
  skippedBlacklisted?: number;
  /**
   * #10557 — órfãos (tag `envio-brevo` sem store) já `emailBlacklisted` na
   * Brevo: em vez de re-ingeridos, tiveram a tag removida no Kit (releitura
   * confirmou) e voltam a receber a diária por lá. Nunca gravados no store.
   */
  orphansReturnedToKit?: number;
  summary: string;
}

/** Pura — id do subscriber Kit de uma origem `kit-sem-abertura:`; `null` se malformada. */
function kitIdFromOrigin(origin: string): number | null {
  const raw = origin.slice(ORIGIN_PREFIX.KIT_SEM_ABERTURA.length);
  return /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

/**
 * Pura o bastante pra teste (todo I/O em `deps`). Ver docstring do módulo pra
 * ordem, garantias e flags.
 */
export async function runKitSemAberturaSync(
  cfg: KitSemAberturaPlatformConfig,
  opts: { push: boolean; maxAdd?: number; sendDay?: string },
  deps: KitSemAberturaDeps,
): Promise<KitSemAberturaRunResult> {
  const { log } = deps;
  const base = { selected: 0, moved: 0, failed: 0, deferred: 0 };
  const brevo = cfg.brevo_diaria;
  if (!isKitSemAberturaEnabled(brevo?.kit_sem_abertura)) {
    return { code: 0, disabled: true, dryRun: true, ...base, summary: "brevo_diaria.kit_sem_abertura.enabled = false — nada a fazer (#10437)." };
  }
  if (!brevo || brevo.list_id == null) {
    return { code: 2, dryRun: true, ...base, summary: "brevo_diaria.list_id não configurado." };
  }
  const listId = brevo.list_id;
  const numbers = parseKitSemAberturaNumbers(brevo.kit_sem_abertura);
  if (!numbers.ok) return { code: 2, dryRun: true, ...base, summary: numbers.reason };
  const segment = parseDiariaExclusionSegment(cfg.kit?.diaria_exclusion_segment);
  if ("error" in segment) {
    return { code: 2, dryRun: true, ...base, summary: `${segment.error} Ninguém é movido com a config do segmento inválida.` };
  }
  let push = opts.push;
  if (push && !segment.enabled) {
    log(
      "AVISO: kit.diaria_exclusion_segment.enabled = false — sem o segmento no broadcast do Kit, todo movido " +
        "receberia a edição em dobro. Rodando em dry-run (#10437).",
    );
    push = false;
  }

  let records: DiariaBroadcastRecord[];
  try {
    records = deps.readRegistry();
  } catch (e) {
    return {
      code: 2,
      dryRun: !push,
      ...base,
      summary:
        `registro de broadcasts da diária com lacuna (${(e as Error).message}) — abortando o Passo 3c: o broadcast ` +
        "que falta poderia ter a abertura que tira alguém da seleção.",
    };
  }
  const { sentIds, matureIds } = classifyDiariaBroadcasts(records, deps.nowMs);
  log(`registro da diária: ${records.length} broadcast(s), ${sentIds.length} enviado(s), ${matureIds.length} maduro(s) (>=48h).`);

  const store = deps.readStore();
  const actives = await deps.listKitActive();
  const nowIso = new Date(deps.nowMs).toISOString();
  let current = store;
  let failed = 0;
  let reconciled = 0;
  let storeWriteFailed = false;
  const persist = (s: BrevoDiariaStore, email: string): boolean => {
    try {
      deps.writeStore(s);
      storeWriteFailed = false;
      return true;
    } catch (e) {
      storeWriteFailed = true;
      log(
        `FALHA ao gravar o store depois de mover ${email} (${(e as Error).message}) — a próxima rodada o reconcilia ` +
          `como órfão (tag ${KIT_ENVIO_BREVO_TAG_NAME} sem store).`,
      );
      return false;
    }
  };
  const appendLogSafe = (entry: KitSemAberturaLogEntry) => {
    try {
      deps.appendLog(formatKitSemAberturaLogLine(entry));
    } catch (e) {
      log(`aviso: falha ao gravar o log de ${entry.email} (${(e as Error).message}).`);
    }
  };

  let tagId: number | null | undefined;
  const resolveTag = async (): Promise<number | null> => {
    if (tagId === undefined) tagId = await deps.findEnvioBrevoTagId();
    return tagId;
  };

  // ── reconciliação: órfãos e tags pendentes (antes de qualquer seleção) ──
  const storeEmails = new Set(store.contacts.map((c) => normalizeEmail(c.email)));
  const orphans = actives.filter((a) => a.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME) && !storeEmails.has(normalizeEmail(a.email)));
  const pending = store.contacts.filter(
    (c) => c.status === "in_brevo" && c.kit_tag_pending === true && c.beehiiv_subscription_id.startsWith(ORIGIN_PREFIX.KIT_SEM_ABERTURA),
  );
  if (orphans.length > 0) {
    log(`${orphans.length} órfão(s): tag ${KIT_ENVIO_BREVO_TAG_NAME} no Kit e fora do store — ${push ? "reconciliando" : "seriam reconciliados"}.`);
  }
  if (pending.length > 0) log(`${pending.length} contato(s) com a tag ${KIT_ENVIO_BREVO_TAG_NAME} pendente de confirmação.`);
  let orphansReturnedToKit = 0;
  if (push) {
    for (const o of orphans) {
      // #10557 — órfão já `emailBlacklisted` na Brevo: re-ingerir o deixaria
      // `in_brevo` sem canal (a Brevo não envia, a tag o tira do segmento da
      // diária no Kit). Desfaz a movimentação: tira a tag no Kit com
      // releitura e não grava o store. Sem confirmação (leitura do blacklist
      // ou remoção da tag), conta falha e a próxima rodada retenta — o
      // contato segue órfão, nunca é ingerido às cegas.
      // Limite conhecido: o órfão não tem `added_at` (o store nunca foi
      // gravado), então não dá pra distinguir um blacklist anterior à
      // movimentação de um descadastro feito numa campanha entre a
      // movimentação e esta rodada (janela de ~1 dia). Os dois caem aqui;
      // remover a tag nunca descadastra ninguém, e o Kit segue honrando o
      // descadastro feito no próprio Kit.
      let orphanBlacklisted: boolean;
      try {
        orphanBlacklisted = await deps.isBrevoBlacklisted(o.email);
      } catch (e) {
        failed++;
        log(`FALHA ao reconciliar o órfão ${o.email} (blacklist na Brevo não lido: ${(e as Error).message}) — fica pra próxima rodada.`);
        continue;
      }
      if (orphanBlacklisted) {
        const id = await resolveTag();
        if (id === null) {
          failed++;
          log(`FALHA: órfão ${o.email} blacklisted na Brevo, mas a tag "${KIT_ENVIO_BREVO_TAG_NAME}" não foi achada no Kit — fica pra próxima rodada.`);
          continue;
        }
        try {
          await deps.untagKit(id, o.id);
        } catch (e) {
          failed++;
          log(`FALHA: órfão ${o.email} blacklisted na Brevo — tag ${KIT_ENVIO_BREVO_TAG_NAME} NÃO removida no Kit (${(e as Error).message}) — retenta na próxima rodada (#10557).`);
          continue;
        }
        orphansReturnedToKit++;
        log(`  ${o.email}: órfão já emailBlacklisted na Brevo — tag ${KIT_ENVIO_BREVO_TAG_NAME} removida, volta a receber pelo Kit (#10557).`);
        try {
          deps.appendLog(
            formatKitSemAberturaLogLine({
              ts: nowIso,
              event: "kit_tag_removed_preexisting_blacklist",
              email: normalizeEmail(o.email),
              kit_subscriber_id: o.id,
              step: "sync_orphan",
            }),
          );
        } catch (e) {
          log(`aviso: falha ao gravar o log de ${o.email} (${(e as Error).message}).`);
        }
        continue;
      }
      try {
        await deps.ingestBrevo(o.email);
      } catch (e) {
        failed++;
        log(`FALHA ao reconciliar o órfão ${o.email} (Brevo: ${(e as Error).message}) — fica pra próxima rodada.`);
        continue;
      }
      const origin = buildOrigin("kit-sem-abertura", String(o.id));
      current = upsertIngested(current, { email: o.email, beehiiv_subscription_id: origin }, nowIso);
      if (!persist(current, o.email)) {
        failed++;
        continue;
      }
      reconciled++;
      appendLogSafe({
        ts: nowIso,
        email: normalizeEmail(o.email),
        kit_subscriber_id: o.id,
        origin,
        wave: "reconcile",
        mature_sends: 0,
        brevo_list_id: listId,
        kit_tag: KIT_ENVIO_BREVO_TAG_NAME,
      });
    }
  }

  if (push && pending.length > 0) {
    const id = await resolveTag();
    if (id === null) {
      return {
        code: 2,
        dryRun: false,
        ...base,
        failed,
        reconciled,
        orphansReturnedToKit,
        summary: `tag "${KIT_ENVIO_BREVO_TAG_NAME}" não existe no Kit — crie-a (Gate B do #10437) antes de ligar a flag.`,
      };
    }
    for (const p of pending) {
      const kitId = kitIdFromOrigin(p.beehiiv_subscription_id);
      if (kitId === null) {
        failed++;
        log(`FALHA: ${p.email} com origem malformada (${p.beehiiv_subscription_id}) — tag pendente não retentada.`);
        continue;
      }
      try {
        await deps.tagKit(id, kitId);
      } catch (e) {
        failed++;
        log(`tag ainda não confirmada em ${p.email} (${(e as Error).message}) — retenta na próxima rodada.`);
        continue;
      }
      current = { contacts: current.contacts.map((c) => (c.email === p.email ? { ...c, kit_tag_pending: undefined } : c)) };
      if (persist(current, p.email)) reconciled++;
      else failed++;
    }
  }

  const minSends = numbers.minMatureSends;
  if (matureIds.length < minSends) {
    return {
      code: failed > 0 ? 1 : 0,
      dryRun: !push,
      ...base,
      failed,
      reconciled,
      orphansReturnedToKit,
      summary: `menos de ${minSends} broadcast(s) maduro(s) no registro — ninguém pode qualificar ainda.`,
    };
  }

  let cacheRaw: unknown = null;
  if (deps.engagementCache) {
    try {
      cacheRaw = deps.engagementCache.read();
    } catch (e) {
      log(`aviso: cache de engajamento ilegível (${(e as Error).message}) — relendo todos os broadcasts.`);
    }
  }
  const plan = planKitEngagementFetch({ records, sentIds, nowMs: deps.nowMs, cacheRaw });
  if (plan.discarded) log(`aviso: cache de engajamento descartado (${plan.discarded}) — relendo todos os broadcasts.`);
  const perBroadcast: BroadcastEngagement[] = [];
  for (const id of plan.toFetch) perBroadcast.push(await deps.fetchEngagement(id));
  log(`engajamento: ${plan.toFetch.length} broadcast(s) relido(s) do Kit, ${sentIds.length - plan.toFetch.length} do cache.`);
  const engagement = mergeEngagementIndexes(plan.cachedIndex, buildEngagementIndex(perBroadcast, new Set(matureIds)));
  const nextCache = deps.engagementCache ? extendKitEngagementCache(plan, perBroadcast) : null;
  if (nextCache) {
    try {
      deps.engagementCache!.write(nextCache);
    } catch (e) {
      log(`aviso: falha ao gravar o cache de engajamento (${(e as Error).message}) — a próxima rodada relê mais.`);
    }
  }

  const selection = selectKitSemAbertura({
    subscribers: actives,
    engagement,
    storeEmails: current.contacts.map((c) => c.email),
    seedEmails: EDITOR_SEED_EMAILS,
    minMatureSends: minSends,
  });
  log(
    `${actives.length} ativo(s) no Kit → ${selection.selected.length} selecionado(s). Fora: ` +
      Object.entries(selection.excluded)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
  );

  const queueCap = brevo.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  const currentActiveCount = computeCurrentActiveCount(current.contacts);
  const dailyLimit = resolveAccountDailyLimit(brevo);
  const sendDay = opts.sendDay ?? diariaSendDayUtc(deps.nowMs);
  let transactional: number | null = null;
  try {
    transactional = await deps.transactionalOnSendDay(sendDay);
  } catch (e) {
    log(`aviso: cota da conta Brevo (dia de envio ${sendDay}) não lida (${(e as Error).message}).`);
  }
  const wave = planKitSemAberturaWave({
    selected: selection.selected,
    nowMs: deps.nowMs,
    newSignupWindowDays: numbers.newSignupWindowDays,
    rolloutPaused: deps.rolloutPaused(),
    backlogSlots: (newCount) => {
      const slots = computeBacklogSlots({
        queueCap,
        currentActiveCount,
        seedCount: EDITOR_SEED_EMAILS.length,
        newCount,
        dailyLimit,
        transactionalToday: transactional,
      });
      return opts.maxAdd !== undefined ? Math.min(slots, Math.max(0, opts.maxAdd - newCount)) : slots;
    },
  });
  // `--max-add N` é teto explícito do operador sobre a rodada INTEIRA deste
  // passo, inclusive cadastros novos (`--max-add 0` = ninguém).
  const capped = opts.maxAdd !== undefined ? wave.toMove.slice(0, opts.maxAdd) : wave.toMove;
  const cappedNew = capped.filter((c) => c.wave === "novo").length;
  const quotaNew = checkNewSignupsFitAccountQuota({
    currentActiveCount,
    seedCount: EDITOR_SEED_EMAILS.length,
    newCount: cappedNew,
    dailyLimit,
    transactionalOnSendDay: transactional,
  });
  if (!quotaNew.ok) {
    const summary = `${quotaNew.reason} (dia de envio ${sendDay}) — Passo 3c abortado, ninguém movido nesta rodada.`;
    return {
      code: push ? 1 : 0,
      dryRun: !push,
      ...base,
      selected: selection.selected.length,
      deferred: selection.selected.length,
      failed,
      reconciled,
      orphansReturnedToKit,
      summary,
    };
  }
  let deferred = wave.deferred + (wave.toMove.length - capped.length);
  log(`onda: ${wave.newCount} cadastro(s) novo(s) + ${wave.backlogCount} do backlog; ${capped.length} nesta rodada, ${deferred} adiado(s).`);

  // #10664 — contato do BACKLOG pulado na confirmação (blacklisted na Brevo,
  // apoiador pelo GET singular) libera a vaga pro próximo da fila. Sem isso
  // ele, que não fica registrado em lugar nenhum, volta a ser selecionado
  // amanhã e, sendo o mais antigo, ocupa a mesma vaga todo dia: com os N mais
  // antigos blacklisted, o backlog nunca anda. Reposição só em pulo
  // DEFINITIVO; falha de leitura adia sem repor (transitória — repor
  // queimaria a fila numa instabilidade da API). Os cortados pelo
  // `--max-add` vêm primeiro (são os mais antigos fora da rodada).
  const reserve: typeof capped = [
    ...wave.toMove.slice(capped.length).filter((c) => c.wave === "backlog"),
    ...wave.backlogReserve.map((s) => ({ ...s, wave: "backlog" as const })),
  ];
  let replacements = 0;
  let replacementCapHit = false;
  const queue: typeof capped = [...capped];
  const replace = (c: (typeof capped)[number]) => {
    if (c.wave !== "backlog" || reserve.length === 0) return;
    if (replacements >= KIT_SEM_ABERTURA_MAX_BACKLOG_REPLACEMENTS) {
      replacementCapHit = true;
      return;
    }
    queue.push(reserve.shift()!);
    replacements++;
    deferred--;
  };
  const toMove: typeof capped = [];
  let skippedBlacklisted = 0;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    // #10536 — já `emailBlacklisted` na conta Brevo da diária (bloqueio no
    // onboarding transacional #6042, hard bounce antigo, contato anterior ao
    // store): a campanha nunca chegaria, a tag a tiraria do envio do Kit, e o
    // Passo 0 do evaluate leria o blacklist como saída nova. Fica no Kit.
    // Checado ANTES do GET singular no Kit (#10664): a leitura na Brevo não
    // passa pelo pacer de 750ms do Kit, então um bloco de blacklisted na
    // cabeça do backlog custa só leituras baratas.
    let blacklisted: boolean;
    try {
      blacklisted = await deps.isBrevoBlacklisted(c.email);
    } catch (e) {
      deferred++;
      log(`  ${c.email}: estado de blacklist na Brevo não lido (${(e as Error).message}) — adiado.`);
      continue;
    }
    if (blacklisted) {
      skippedBlacklisted++;
      log(`  ${c.email}: já emailBlacklisted na Brevo diária — fica no Kit, não é movido (#10536).`);
      replace(c);
      continue;
    }
    // Apoiador confirmado pelo GET singular (a listagem serve `fields` defasado).
    let nivel: string | null;
    try {
      nivel = await deps.getApoioNivel(c.id);
    } catch (e) {
      deferred++;
      log(`  ${c.email}: apoio_nivel não confirmado pelo GET singular (${(e as Error).message}) — adiado.`);
      continue;
    }
    if (typeof nivel === "string" && nivel.trim() !== "") {
      log(`  ${c.email}: apoiador (${KIT_APOIO_NIVEL_FIELD_KEY}=${nivel} no GET singular) — fora.`);
      replace(c);
      continue;
    }
    toMove.push(c);
  }
  if (skippedBlacklisted > 0) {
    log(`${skippedBlacklisted} selecionado(s) já blacklisted na Brevo — mantido(s) no Kit (#10536).`);
  }
  if (replacements > 0) {
    log(`${replacements} vaga(s) do backlog repostas com o próximo da fila (pulados na confirmação, #10664).`);
  }
  if (replacementCapHit) {
    log(
      `AVISO: teto de ${KIT_SEM_ABERTURA_MAX_BACKLOG_REPLACEMENTS} reposições do backlog atingido nesta rodada — ` +
        "vagas ficaram sem preencher; se repetir, a cabeça do backlog está dominada por pulados (#10664).",
    );
  }
  const counts = { selected: selection.selected.length, deferred, skippedBlacklisted, orphansReturnedToKit };

  if (!push) {
    for (const c of toMove) log(`  + ${c.email} (kit ${c.id}, ${c.matureSends} envio(s) maduro(s), ${c.wave})`);
    return { code: 0, dryRun: true, moved: 0, failed: 0, reconciled, ...counts, summary: "dry-run — nenhuma mutação." };
  }
  if (toMove.length === 0) {
    return { code: failed > 0 ? 1 : 0, dryRun: false, moved: 0, failed, reconciled, ...counts, summary: "nada a mover nesta rodada." };
  }

  const id = await resolveTag();
  if (id === null) {
    return {
      code: 2,
      dryRun: false,
      moved: 0,
      failed,
      reconciled,
      ...counts,
      summary: `tag "${KIT_ENVIO_BREVO_TAG_NAME}" não existe no Kit — crie-a (Gate B do #10437) antes de ligar a flag.`,
    };
  }

  let moved = 0;
  for (const c of toMove) {
    try {
      await deps.ingestBrevo(c.email);
    } catch (e) {
      failed++;
      log(`FALHA (Brevo) em ${c.email}: ${(e as Error).message} — nada tocado no Kit.`);
      continue;
    }
    let tagPending = false;
    try {
      await deps.tagKit(id, c.id);
    } catch (e) {
      failed++;
      tagPending = true;
      log(
        `FALHA (tag no Kit) em ${c.email}: ${(e as Error).message} — já está na lista da Brevo; store gravado com ` +
          "kit_tag_pending (a próxima rodada retenta a tag; até lá pode receber em dobro, nunca sem canal).",
      );
    }
    const origin = buildOrigin("kit-sem-abertura", String(c.id));
    current = upsertIngested(current, { email: c.email, beehiiv_subscription_id: origin }, nowIso);
    if (tagPending) {
      current = { contacts: current.contacts.map((x) => (x.email === normalizeEmail(c.email) ? { ...x, kit_tag_pending: true } : x)) };
    }
    if (!persist(current, c.email)) {
      if (!tagPending) failed++;
      continue;
    }
    appendLogSafe({
      ts: nowIso,
      email: c.email,
      kit_subscriber_id: c.id,
      origin,
      wave: c.wave,
      mature_sends: c.matureSends,
      brevo_list_id: listId,
      kit_tag: KIT_ENVIO_BREVO_TAG_NAME,
      ...(tagPending ? { kit_tag_pending: true } : {}),
    });
    if (!tagPending) moved++;
  }
  if (storeWriteFailed) {
    // Última tentativa: o `current` acumulado tem todo mundo desta rodada.
    persist(current, "(rodada)");
  }
  return {
    code: failed > 0 ? 1 : 0,
    dryRun: false,
    moved,
    failed,
    reconciled,
    ...counts,
    summary:
      `${moved} movido(s) pra Brevo, ${reconciled} reconciliado(s), ${skippedBlacklisted} já blacklisted na Brevo (mantido(s) no Kit), ` +
      `${orphansReturnedToKit} órfão(s) blacklisted devolvido(s) ao Kit, ${failed} falha(s).`,
  };
}

// ── I/O de produção ──────────────────────────────────────────────────────

/**
 * Lê o registro de broadcasts da diária das edições (ver
 * `parseDiariaBroadcastState`). Arquivo ilegível LANÇA: um broadcast faltando
 * tira envios da contagem (direção segura) mas também tira ABERTURAS
 * (direção perigosa: quem abriu justamente aquele seria movido).
 */
export function readDiariaBroadcastRegistry(editionsRootAbs: string): DiariaBroadcastRecord[] {
  const out: DiariaBroadcastRecord[] = [];
  const unreadable: string[] = [];
  for (const [edition, dir] of enumerateEditionDirs(editionsRootAbs)) {
    for (const path of [newsletterKitPublishedPath(dir), kitDiariaPublishedPath(dir)]) {
      if (!existsSync(path)) continue;
      try {
        const rec = parseDiariaBroadcastState(JSON.parse(readFileSync(path, "utf8")), edition);
        if (rec) out.push(rec);
      } catch (e) {
        unreadable.push(`${path} (${(e as Error).message})`);
      }
    }
  }
  if (unreadable.length > 0) throw new Error(`${unreadable.length} arquivo(s) ilegível(is): ${unreadable.join("; ")}`);
  return dedupeBroadcastRecords(out);
}

async function listKitActiveCandidates(
  log: (msg: string) => void,
  pace: () => Promise<void>,
): Promise<KitActiveCandidate[]> {
  const out: KitActiveCandidate[] = [];
  let semEmail = 0;
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    await pace();
    const res = await listSubscribers({ status: "active", include: ["tags"], perPage: 500, after });
    for (const s of res.subscribers as (typeof res.subscribers[number] & { fields?: Record<string, string | null> })[]) {
      if (typeof s.email_address !== "string" || s.email_address.trim() === "") {
        semEmail++;
        continue;
      }
      out.push({
        id: s.id,
        email: s.email_address,
        created_at: s.created_at,
        fields: s.fields,
        tagNames: (s.tags ?? []).map((t) => t.name),
      });
    }
    if (!res.pagination.has_next_page || !res.pagination.end_cursor) {
      if (semEmail > 0) log(`aviso: ${semEmail} ativo(s) do Kit sem email_address descartado(s) da listagem.`);
      return out;
    }
    after = res.pagination.end_cursor;
  }
  throw new Error("listagem de ativos do Kit não terminou em 200 páginas");
}

/** #10536 — `emailBlacklisted` do contato na conta Brevo da diária; 404 = não existe = `false`. */
export async function readBrevoBlacklisted(apiKey: string, email: string): Promise<boolean> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status === 404) return false;
  if (res.status !== 200) throw new Error(`GET /contacts falhou (HTTP ${res.status})`);
  return (res.body as { emailBlacklisted?: unknown } | undefined)?.emailBlacklisted === true;
}

/** Ingest com o atributo de origem + releitura de lista E atributo. */
async function ingestWithOrigin(apiKey: string, listId: number, email: string): Promise<void> {
  await brevoPost(apiKey, "/contacts", {
    email,
    listIds: [listId],
    updateEnabled: true,
    attributes: { [BREVO_ORIGEM_ATTRIBUTE]: BREVO_ORIGEM_KIT_SEM_ABERTURA },
  });
  const check = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (check.status !== 200) throw new Error(`releitura falhou (HTTP ${check.status})`);
  const body = check.body as { listIds?: unknown; attributes?: Record<string, unknown> } | undefined;
  if (!Array.isArray(body?.listIds) || !body!.listIds.includes(listId)) {
    throw new Error(`releitura sem a lista ${listId}: listIds=${JSON.stringify(body?.listIds)}`);
  }
  if (body?.attributes?.[BREVO_ORIGEM_ATTRIBUTE] !== BREVO_ORIGEM_KIT_SEM_ABERTURA) {
    throw new Error(
      `releitura sem ${BREVO_ORIGEM_ATTRIBUTE}=${BREVO_ORIGEM_KIT_SEM_ABERTURA} (o atributo existe na conta Brevo? Gate B do #10437)`,
    );
  }
}

async function tagAndConfirm(tagId: number, subscriberId: number, pace: () => Promise<void>): Promise<void> {
  await pace();
  await tagSubscriber(tagId, subscriberId);
  await pace();
  const tags = await listSubscriberTags(subscriberId);
  if (!tags.some((t) => t.id === tagId)) throw new Error(`releitura das tags não mostra a tag ${tagId} (2xx não é prova)`);
}

/** #10557 — remove a tag e confirma pela releitura (404 no DELETE = já ausente; a releitura decide). */
async function untagAndConfirm(tagId: number, subscriberId: number, pace: () => Promise<void>): Promise<void> {
  await pace();
  try {
    await untagSubscriber(tagId, subscriberId);
  } catch (e) {
    if (!(e instanceof KitApiError && e.status === 404)) throw e;
  }
  await pace();
  const tags = await listSubscriberTags(subscriberId);
  if (tags.some((t) => t.id === tagId)) throw new Error(`releitura das tags ainda mostra a tag ${tagId} (2xx não é prova)`);
}

/**
 * Intervalo mínimo entre TODAS as requisições ao Kit deste processo (listagem
 * de ativos, releitura de engajamento, GET singular, tag + releitura). O Kit
 * limita a ~120 req/60s por chave; a releitura percorre todo broadcast maduro
 * (3 eixos, paginados), e sem espaçamento a 1ª rodada real estourou 429 após o
 * retry padrão do kitFetch (dry-run de 19/10, 36 broadcasts). 750ms dá ~80
 * req/min: folga para outra task na mesma chave (o pacer é por processo).
 */
export const KIT_MIN_INTERVAL_MS = 750;

async function fetchDeliveredEngagement(
  id: number,
  log: (msg: string) => void,
  beforeRequest: () => Promise<void>,
): Promise<BroadcastEngagement> {
  const delivered = await fetchAudience(id, "delivered", { beforeRequest });
  const opens = await fetchAudience(id, "opens", { beforeRequest });
  const clicks = await fetchAudience(id, "clicks", { beforeRequest });
  const descartadas = delivered.descartadas + opens.descartadas + clicks.descartadas;
  if (descartadas > 0) log(`aviso: broadcast ${id}: ${descartadas} linha(s) sem e-mail descartada(s) do /subscribers/filter.`);
  return { broadcastId: id, delivered: delivered.emails, opens: opens.emails, clicks: clicks.emails };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-kit-sem-abertura-to-brevo] ${msg}\n`);

  let cfg: KitSemAberturaPlatformConfig;
  try {
    cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as KitSemAberturaPlatformConfig;
  } catch (e) {
    log(`ERRO: platform.config.json ilegível (${(e as Error).message}).`);
    process.exitCode = 2;
    return;
  }
  if (!isKitSemAberturaEnabled(cfg.brevo_diaria?.kit_sem_abertura)) {
    log("brevo_diaria.kit_sem_abertura.enabled = false — nada a fazer (#10437).");
    return;
  }
  try {
    assertStoreFileGuard(existsSync(DEFAULT_STORE_PATH), argv, DEFAULT_STORE_PATH);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  let maxAdd: number | undefined;
  let sendDay: string | undefined;
  try {
    maxAdd = getIntArg(argv, "max-add", { min: 0 });
    sendDay = getStringArg(argv, "send-day", { example: "2026-10-21" });
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (sendDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sendDay)) {
    log(`ERRO: --send-day precisa ser YYYY-MM-DD (veio ${JSON.stringify(sendDay)}).`);
    process.exitCode = 2;
    return;
  }
  const kitCfg = resolveKitConfig();
  if (!kitCfg.ok) {
    log(`ERRO: ${kitCfg.reason}`);
    process.exitCode = 2;
    return;
  }
  const brevo = cfg.brevo_diaria!;
  const apiKey = process.env[brevo.api_key_env];
  if (!apiKey) {
    log(`ERRO: ${brevo.api_key_env} não definido no ambiente.`);
    process.exitCode = 2;
    return;
  }
  const listId = brevo.list_id as number;

  const kitPacer = createRequestPacer(KIT_MIN_INTERVAL_MS);
  const result = await runKitSemAberturaSync(cfg, { push, maxAdd, sendDay }, {
    nowMs: Date.now(),
    log,
    readRegistry: () => readDiariaBroadcastRegistry(resolve(ROOT, editionsRoot())),
    listKitActive: () => listKitActiveCandidates(log, kitPacer),
    fetchEngagement: (id) => fetchDeliveredEngagement(id, log, kitPacer),
    engagementCache: {
      read: () => (existsSync(DEFAULT_KIT_ENGAGEMENT_CACHE_PATH) ? JSON.parse(readFileSync(DEFAULT_KIT_ENGAGEMENT_CACHE_PATH, "utf8")) : null),
      write: (c) => {
        mkdirSync(dirname(DEFAULT_KIT_ENGAGEMENT_CACHE_PATH), { recursive: true });
        writeFileAtomic(DEFAULT_KIT_ENGAGEMENT_CACHE_PATH, JSON.stringify(c) + "\n");
      },
    },
    findEnvioBrevoTagId: async () => {
      await kitPacer();
      return findTagIdByName(KIT_ENVIO_BREVO_TAG_NAME);
    },
    readStore: () => readStore(DEFAULT_STORE_PATH),
    writeStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
    rolloutPaused: () => readRolloutGuardrailState(undefined, log).rollout_paused,
    transactionalOnSendDay: async (day) => (await fetchAccountQuotaSnapshot(apiKey, day)).transactionalRequestsOnSendDay,
    getApoioNivel: async (id) => {
      await kitPacer();
      const s = await getSubscriberById(id);
      return s.fields?.[KIT_APOIO_NIVEL_FIELD_KEY] ?? null;
    },
    isBrevoBlacklisted: (email) => readBrevoBlacklisted(apiKey, email),
    ingestBrevo: (email) => ingestWithOrigin(apiKey, listId, email),
    tagKit: (tagId, id) => tagAndConfirm(tagId, id, kitPacer),
    untagKit: (tagId, id) => untagAndConfirm(tagId, id, kitPacer),
    appendLog: (line) => appendFileWithRetry(DEFAULT_KIT_SEM_ABERTURA_LOG_PATH, line),
  });
  log(result.summary);
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-kit-sem-abertura-to-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
