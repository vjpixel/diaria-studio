#!/usr/bin/env node
/**
 * scripts/sync-kit-sem-abertura-to-brevo.ts (#10437)
 *
 * Move pra Brevo (lista 7, `brevo_diaria`) quem está `active` no Kit e recebeu
 * 6 edições da diária sem abrir nem clicar. Saída do Kit por TAG de exclusão
 * `envio-brevo`, nunca descadastro (decisão do editor, 19/10/2026; armadilha 4
 * da issue: descadastro no Kit não tem volta, e a promoção de volta travaria).
 * Critério e exclusões: `scripts/lib/kit-sem-abertura.ts`.
 *
 * ## Duas flags, ambas desligadas por default
 *
 * - `brevo_diaria.kit_sem_abertura.enabled` — liga ESTE script. Desligada ⇒
 *   sai 0 sem nenhuma chamada de rede (e `brevo-diaria-run.ts` nem o invoca).
 * - `kit.diaria_exclusion_segment.enabled` — troca o `subscriber_filter` do
 *   broadcast da diária pra o segmento "ativos sem a tag". Este script EXIGE
 *   as duas pra mover alguém: tag sem o segmento no envio é edição em dobro
 *   pra todo movido, todo dia. Com a 1ª ligada e a 2ª não, só faz dry-run.
 *
 * ## Ordem por contato (corpo da issue)
 *
 * 1. Ingere na lista 7 com o atributo `ORIGEM_DIARIA = kit_sem_abertura`
 *    (intro própria na Brevo, decisão do editor de 19/10) e RELÊ: lista E
 *    atributo precisam conferir.
 * 2. Aplica a tag `envio-brevo` no Kit e relê (`listSubscriberTags`, a
 *    direção sem atraso de propagação).
 * 3. Upsert no store com origem própria `kit-sem-abertura:{id}` (armadilha 5:
 *    o Passo 1 de `evaluate-brevo-diaria.ts` tira da Brevo todo `kit:` ativo
 *    no Kit; estes continuam ativos lá de propósito).
 * 4. Uma linha em `data/brevo-diaria/kit-sem-abertura-log.jsonl`.
 *
 * Brevo antes do Kit: falha no meio deixa envio duplicado (visível,
 * reversível), nunca uma pessoa sem canal. Falha no passo 2 NÃO grava o store:
 * a próxima rodada seleciona de novo (o ingest é idempotente) e retenta a tag.
 * O store é gravado a cada contato, então uma queda no meio não perde quem já
 * foi movido.
 *
 * ## Onda
 *
 * Cadastros novos (até `new_signup_window_days`, default 30) entram sempre; o
 * backlog entra limitado pela fila (`daily_send_cap`) e pela cota da conta
 * (`checkAccountSendQuota`). Circuit breaker pausado zera a rodada.
 *
 * Sem MillionVerifier: são contatos que confirmaram o double opt-in (mesmo
 * raciocínio do #5807).
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts            # dry-run
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts --push     # exige as 2 flags
 *   npx tsx scripts/sync-kit-sem-abertura-to-brevo.ts --push --max-add 5
 *
 * Exit: 0 ok/desligado; 1 falha em algum contato (os demais seguem); 2
 * precondição (config, chave, store ausente, tag `envio-brevo` inexistente).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getIntArg } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { listSubscribers } from "./lib/kit-client.ts";
import { findTagIdByName, tagSubscriber, listSubscriberTags } from "./lib/kit-broadcasts.ts";
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";
import { readRolloutGuardrailState } from "./lib/brevo-diaria-guardrail.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { computeCurrentActiveCount, assertStoreFileGuard } from "./sync-pending-to-brevo.ts";
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts";
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts";
import { fetchAccountQuotaSnapshot, resolveAccountDailyLimit, toStatsDay } from "./lib/brevo-account-quota.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { fetchAudience, kitDiariaPublishedPath, newsletterKitPublishedPath } from "./kit-provider-split.ts";
import { isDiariaExclusionSegmentEnabled, KIT_ENVIO_BREVO_TAG_NAME, type DiariaExclusionSegmentConfig } from "./lib/kit-diaria-audience.ts";
import {
  BREVO_ORIGEM_ATTRIBUTE,
  BREVO_ORIGEM_KIT_SEM_ABERTURA,
  KIT_SEM_ABERTURA_MIN_MATURE_SENDS,
  KIT_SEM_ABERTURA_NEW_SIGNUP_WINDOW_DAYS,
  buildEngagementIndex,
  classifyDiariaBroadcasts,
  computeBacklogSlots,
  dedupeBroadcastRecords,
  formatKitSemAberturaLogLine,
  isKitSemAberturaEnabled,
  parseDiariaBroadcastState,
  planKitSemAberturaWave,
  selectKitSemAbertura,
  type BroadcastEngagement,
  type DiariaBroadcastRecord,
  type KitActiveCandidate,
  type KitSemAberturaConfig,
  type KitSemAberturaLogEntry,
} from "./lib/kit-sem-abertura.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_KIT_SEM_ABERTURA_LOG_PATH = resolve(ROOT, "data/brevo-diaria/kit-sem-abertura-log.jsonl");
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
  readRegistry: () => DiariaBroadcastRecord[];
  listKitActive: () => Promise<KitActiveCandidate[]>;
  fetchEngagement: (broadcastId: number) => Promise<BroadcastEngagement>;
  findEnvioBrevoTagId: () => Promise<number | null>;
  readStore: () => BrevoDiariaStore;
  writeStore: (store: BrevoDiariaStore) => void;
  rolloutPaused: () => boolean;
  /** `null` = não lido (falha) ⇒ backlog 0 nesta rodada. */
  transactionalToday: () => Promise<number | null>;
  ingestBrevo: (email: string) => Promise<void>;
  tagKit: (tagId: number, subscriberId: number) => Promise<void>;
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
  summary: string;
}

/**
 * Pura o bastante pra teste (todo I/O em `deps`). Ver docstring do módulo pra
 * ordem e flags.
 */
export async function runKitSemAberturaSync(
  cfg: KitSemAberturaPlatformConfig,
  opts: { push: boolean; maxAdd?: number },
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
  const segmentOn = isDiariaExclusionSegmentEnabled(cfg.kit?.diaria_exclusion_segment);
  let push = opts.push;
  if (push && !segmentOn) {
    log(
      "AVISO: kit.diaria_exclusion_segment.enabled = false — sem o segmento no broadcast do Kit, todo movido " +
        "receberia a edição em dobro. Rodando em dry-run (#10437).",
    );
    push = false;
  }

  const records = deps.readRegistry();
  const { sentIds, matureIds } = classifyDiariaBroadcasts(records, deps.nowMs);
  log(`registro da diária: ${records.length} broadcast(s), ${sentIds.length} enviado(s), ${matureIds.length} maduro(s) (>=48h).`);
  const minSends = brevo.kit_sem_abertura?.min_mature_sends ?? KIT_SEM_ABERTURA_MIN_MATURE_SENDS;
  if (matureIds.length < minSends) {
    return { code: 0, dryRun: !push, ...base, summary: `menos de ${minSends} broadcast(s) maduro(s) no registro — ninguém pode qualificar ainda.` };
  }

  const perBroadcast: BroadcastEngagement[] = [];
  for (const id of sentIds) perBroadcast.push(await deps.fetchEngagement(id));
  const engagement = buildEngagementIndex(perBroadcast, new Set(matureIds));

  const store = deps.readStore();
  const actives = await deps.listKitActive();
  const selection = selectKitSemAbertura({
    subscribers: actives,
    engagement,
    storeEmails: store.contacts.map((c) => c.email),
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
  const currentActiveCount = computeCurrentActiveCount(store.contacts);
  const dailyLimit = resolveAccountDailyLimit(brevo);
  let transactional: number | null = null;
  try {
    transactional = await deps.transactionalToday();
  } catch (e) {
    log(`aviso: cota da conta Brevo não lida (${(e as Error).message}) — backlog fica pra próxima rodada.`);
  }
  const wave = planKitSemAberturaWave({
    selected: selection.selected,
    nowMs: deps.nowMs,
    newSignupWindowDays: brevo.kit_sem_abertura?.new_signup_window_days ?? KIT_SEM_ABERTURA_NEW_SIGNUP_WINDOW_DAYS,
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
  log(`onda: ${wave.newCount} cadastro(s) novo(s) + ${wave.backlogCount} do backlog; ${wave.deferred} adiado(s).`);
  const counts = { selected: selection.selected.length, deferred: wave.deferred };

  if (!push) {
    for (const c of wave.toMove) log(`  + ${c.email} (kit ${c.id}, ${c.matureSends} envio(s) maduro(s), ${c.wave})`);
    return { code: 0, dryRun: true, moved: 0, failed: 0, ...counts, summary: "dry-run — nenhuma mutação." };
  }
  if (wave.toMove.length === 0) {
    return { code: 0, dryRun: false, moved: 0, failed: 0, ...counts, summary: "nada a mover nesta rodada." };
  }

  const tagId = await deps.findEnvioBrevoTagId();
  if (tagId === null) {
    return {
      code: 2,
      dryRun: false,
      moved: 0,
      failed: 0,
      ...counts,
      summary: `tag "${KIT_ENVIO_BREVO_TAG_NAME}" não existe no Kit — crie-a (Gate B do #10437) antes de ligar a flag.`,
    };
  }

  let current = store;
  let moved = 0;
  let failed = 0;
  for (const c of wave.toMove) {
    try {
      await deps.ingestBrevo(c.email);
    } catch (e) {
      failed++;
      log(`FALHA (Brevo) em ${c.email}: ${(e as Error).message} — nada tocado no Kit.`);
      continue;
    }
    try {
      await deps.tagKit(tagId, c.id);
    } catch (e) {
      failed++;
      log(
        `FALHA (tag no Kit) em ${c.email}: ${(e as Error).message} — já está na lista da Brevo (envio duplicado ` +
          "até a próxima rodada retentar a tag); store NÃO gravado.",
      );
      continue;
    }
    const origin = buildOrigin("kit-sem-abertura", String(c.id));
    current = upsertIngested(current, { email: c.email, beehiiv_subscription_id: origin }, new Date(deps.nowMs).toISOString());
    deps.writeStore(current);
    const entry: KitSemAberturaLogEntry = {
      ts: new Date(deps.nowMs).toISOString(),
      email: c.email,
      kit_subscriber_id: c.id,
      origin,
      wave: c.wave,
      mature_sends: c.matureSends,
      brevo_list_id: brevo.list_id,
      kit_tag: KIT_ENVIO_BREVO_TAG_NAME,
    };
    try {
      deps.appendLog(formatKitSemAberturaLogLine(entry));
    } catch (e) {
      log(`aviso: falha ao gravar o log de ${c.email} (${(e as Error).message}) — store já gravado.`);
    }
    moved++;
  }
  return {
    code: failed > 0 ? 1 : 0,
    dryRun: false,
    moved,
    failed,
    ...counts,
    summary: `${moved} movido(s) pra Brevo, ${failed} falha(s).`,
  };
}

// ── I/O de produção ──────────────────────────────────────────────────────

/** Lê o registro de broadcasts da diária das edições (ver `parseDiariaBroadcastState`). */
export function readDiariaBroadcastRegistry(editionsRootAbs: string, warn: (msg: string) => void): DiariaBroadcastRecord[] {
  const out: DiariaBroadcastRecord[] = [];
  for (const [edition, dir] of enumerateEditionDirs(editionsRootAbs)) {
    for (const path of [newsletterKitPublishedPath(dir), kitDiariaPublishedPath(dir)]) {
      if (!existsSync(path)) continue;
      try {
        const rec = parseDiariaBroadcastState(JSON.parse(readFileSync(path, "utf8")), edition);
        if (rec) out.push(rec);
      } catch (e) {
        // Broadcast faltando = menos envios contados = seleção MENOR (direção segura).
        warn(`aviso: ${path} ilegível (${(e as Error).message}) — broadcast fora da contagem.`);
      }
    }
  }
  return dedupeBroadcastRecords(out);
}

async function listKitActiveCandidates(): Promise<KitActiveCandidate[]> {
  const out: KitActiveCandidate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await listSubscribers({ status: "active", include: ["tags"], perPage: 500, after });
    for (const s of res.subscribers as (typeof res.subscribers[number] & { fields?: Record<string, string | null> })[]) {
      out.push({
        id: s.id,
        email: s.email_address,
        created_at: s.created_at,
        fields: s.fields,
        tagNames: (s.tags ?? []).map((t) => t.name),
      });
    }
    if (!res.pagination.has_next_page || !res.pagination.end_cursor) return out;
    after = res.pagination.end_cursor;
  }
  throw new Error("listagem de ativos do Kit não terminou em 200 páginas");
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

async function tagAndConfirm(tagId: number, subscriberId: number): Promise<void> {
  await tagSubscriber(tagId, subscriberId);
  const tags = await listSubscriberTags(subscriberId);
  if (!tags.some((t) => t.id === tagId)) throw new Error(`releitura das tags não mostra a tag ${tagId} (2xx não é prova)`);
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
  try {
    maxAdd = getIntArg(argv, "max-add", { min: 0 });
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
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

  const result = await runKitSemAberturaSync(cfg, { push, maxAdd }, {
    nowMs: Date.now(),
    log,
    readRegistry: () => readDiariaBroadcastRegistry(resolve(ROOT, editionsRoot()), log),
    listKitActive: () => listKitActiveCandidates(),
    fetchEngagement: async (id) => ({
      broadcastId: id,
      sent: (await fetchAudience(id, "sent")).emails,
      opens: (await fetchAudience(id, "opens")).emails,
      clicks: (await fetchAudience(id, "clicks")).emails,
    }),
    findEnvioBrevoTagId: () => findTagIdByName(KIT_ENVIO_BREVO_TAG_NAME),
    readStore: () => readStore(DEFAULT_STORE_PATH),
    writeStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
    rolloutPaused: () => readRolloutGuardrailState(undefined, log).rollout_paused,
    transactionalToday: async () => {
      const today = toStatsDay(new Date());
      const snap = await fetchAccountQuotaSnapshot(apiKey, today, today);
      return snap.transactionalRequestsOnSendDay;
    },
    ingestBrevo: (email) => ingestWithOrigin(apiKey, listId, email),
    tagKit: (tagId, id) => tagAndConfirm(tagId, id),
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
