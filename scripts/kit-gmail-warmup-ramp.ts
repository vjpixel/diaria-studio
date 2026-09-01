#!/usr/bin/env node
/**
 * scripts/kit-gmail-warmup-ramp.ts (#6504 item 2)
 *
 * Decide, a cada rodada, a PRÓXIMA fatia dos endereços Gmail recusados pelo
 * canal `kit_diaria` (#6504 — 343 de 594 no 1º disparo em massa) que pode
 * voltar a receber a edição — em ondas de volume crescente, gated pelo
 * mesmo veredito de entrega que já governa a tag (`avaliarRampa`,
 * `scripts/lib/provider-split.ts`, #6505). Miolo puro em
 * `scripts/lib/kit-gmail-warmup.ts` — ver aquele módulo pro raciocínio
 * completo (por que é só aditivo, por que o gate é reusado e não
 * recalculado, por que a seleção é determinística).
 *
 * `--dry-run` é o DEFAULT (mesmo padrão de `clarice-schedule-ramp.ts`) —
 * chamar sem `--push` nunca escreve estado nem chama a API do Kit para
 * mutação (só leitura: sent/delivered do broadcast + lista de ativos da
 * Beehiiv). `--push` faz a mutação real: `tagSubscriber` na tag de
 * `kit_diaria.audience_tag` (`platform.config.json`) pra cada endereço
 * SEGURO da onda (ver partição abaixo), e persiste o estado.
 *
 * ## Partição Beehiiv — o guard que evita duplicar envio
 *
 * `kit_diaria.audience_tag_note` (`platform.config.json`) documenta o risco:
 * quem ganha a tag do Kit e AINDA está ativo na Beehiiv recebe a edição em
 * DOBRO, e a desativação do lado da Beehiiv é passo MANUAL, sem guard de
 * código. Este script nunca taguea automaticamente quem está ativo na
 * Beehiiv — a onda proposta é sempre partida em `safeToTag` (taguado em
 * `--push`) e `needsBeehiivDeactivation` (impresso como ação pendente pro
 * editor, nunca tocado). Um endereço em `needsBeehiivDeactivation` volta a
 * ser candidato na PRÓXIMA rodada assim que sair da lista de ativos da
 * Beehiiv — não é preciso re-propor manualmente.
 *
 * ## Estado (`data/kit-gmail-warmup/state.json`, default)
 *
 * 1ª invocação: requer `--reference-broadcast <id>` — captura o cohort
 * recusado (imutável depois; `--reset` explícito apaga e recomeça). Toda
 * invocação requer `--gate-broadcast <id>` — o broadcast mais recente cujo
 * sent/delivered mede a saúde ATUAL da entrega (normalmente o broadcast da
 * edição de ontem/hoje, não o de referência que pode estar dias velho).
 *
 * Uso:
 *   npx tsx scripts/kit-gmail-warmup-ramp.ts --reference-broadcast 25622689 --gate-broadcast 25622689
 *   npx tsx scripts/kit-gmail-warmup-ramp.ts --gate-broadcast <broadcast-de-hoje>       # rodadas seguintes
 *   npx tsx scripts/kit-gmail-warmup-ramp.ts --gate-broadcast <id> --push               # aplica a onda
 *   npx tsx scripts/kit-gmail-warmup-ramp.ts --gate-broadcast <id> --json
 *   npx tsx scripts/kit-gmail-warmup-ramp.ts --reset --reference-broadcast <id> --gate-broadcast <id>
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { fetchAudience, todasOuNenhuma } from "./kit-provider-split.ts";
import { computeProviderSplit, verificarIntegridade, avaliarRampa, type RampaVeredito } from "./lib/provider-split.ts";
import { getBroadcastStats } from "./lib/kit-client.ts";
import { findTagIdByName, tagSubscriber, listSubscriberTags } from "./lib/kit-broadcasts.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { listAllSubscribersForTag, findKitSubscriberByEmail, fetchSubscriberTagIds } from "./kit-ramp-cohort.ts";
import { createOrUpdateSubscriber, listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { isApoioNivel, type ApoioNivel } from "./sync-apoio-nivel-beehiiv.ts";
import { resolveBeehiivConfig } from "./lib/beehiiv-config.ts";
import { fetchActiveBeehiivEmails } from "./reconcile-beehiiv-kit.ts";
import {
  computeGmailRejectedEmails,
  planNextWave,
  resolveWarmupBeehiivPartition,
  returnedEmails,
  lastPushedWaveSize,
  computeOutOfBandReturned,
  buildOutOfBandWaveEntry,
  partitionByConfirmedTag,
  buildInitialState,
  buildWaveEntry,
  DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH,
  type KitGmailWarmupState,
  type WavePlan,
} from "./lib/kit-gmail-warmup.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Nome da tag lida de `platform.config.json` → `kit_diaria.audience_tag`. */
export function readAudienceTagName(rootDir: string = ROOT): string {
  const path = resolve(rootDir, "platform.config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { kit_diaria?: { audience_tag?: string } };
  const tag = cfg.kit_diaria?.audience_tag;
  if (!tag) {
    throw new Error(`[kit-gmail-warmup-ramp] platform.config.json → kit_diaria.audience_tag ausente em ${path}.`);
  }
  return tag;
}

export function loadState(path: string = DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH): KitGmailWarmupState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as KitGmailWarmupState;
}

export function saveState(state: KitGmailWarmupState, path: string = DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Mapa e-mail→nível de apoio, pra priorizar apoiadores na ordem de captura
 * do cohort recusado (#6504, pedido do editor 28/08: "pegue os apoiadores").
 * Fail-soft: qualquer erro de rede vira `Map` vazio (a rampa cai de volta
 * pra ordem puramente alfabética — nunca aborta a captura do cohort por
 * causa disto, que é só priorização, não correção). `status: "all"` porque
 * um apoiador pode estar `cancelled`/`inactive` no Kit e ainda assim valer
 * priorizar (é sinal de relação, não de assinatura ativa).
 */
async function resolveApoioNivelByEmail(): Promise<Map<string, ApoioNivel>> {
  const out = new Map<string, ApoioNivel>();
  try {
    const subs = await listAllKitSubscribers(undefined, { status: "all" });
    for (const sub of subs) {
      const raw = sub.fields?.apoio_nivel;
      if (raw && isApoioNivel(raw)) out.set(sub.email_address.trim().toLowerCase(), raw);
    }
  } catch (e) {
    process.stderr.write(
      `[kit-gmail-warmup-ramp] aviso: não consegui resolver apoio_nivel dos assinantes (${e instanceof Error ? e.message : String(e)}) — ` +
        "seguindo sem priorização de apoiadores nesta captura.\n",
    );
  }
  return out;
}

/**
 * Resolve o id da tag de audiência, abortando se ela não existir — falha
 * segura, mesmo padrão de `resolveAudienceTagId` em `kit-diaria-channel.ts`.
 * Resolvida no INÍCIO da rodada (não só no caminho de `--push`) porque a
 * reconciliação out-of-band do #6964 precisa ler a tag também em dry-run.
 */
async function resolveAudienceTagId(tagName: string): Promise<number> {
  const tagId = await findTagIdByName(tagName);
  if (tagId === null) {
    throw new Error(
      `[kit-gmail-warmup-ramp] tag "${tagName}" (kit_diaria.audience_tag) não encontrada no Kit — abortando ` +
        `sem taguear ninguém (falha segura, mesmo padrão de resolveAudienceTagId em kit-diaria-channel.ts).`,
    );
  }
  return tagId;
}

/**
 * Membros atuais da tag de audiência — a fonte de verdade sobre quem já
 * migrou (#6964, ver `computeOutOfBandReturned`).
 *
 * **Fail-fast de propósito, nunca fail-soft.** Tratar erro de leitura como
 * "ninguém migrou" reproduziria exatamente o bug que este caminho existe pra
 * corrigir — a rampa re-proporia endereços já tagueados, em silêncio. Abortar
 * não perde nada: nesta altura da rodada nada foi escrito ainda.
 */
async function listTaggedEmails(tagId: number): Promise<string[]> {
  const resolved = resolveKitConfig();
  if (!resolved.ok) {
    throw new Error(
      `[kit-gmail-warmup-ramp] credenciais do Kit indisponíveis (${resolved.reason}) — abortando antes de planejar: ` +
        "sem ler a tag não há como saber quem já migrou fora da rampa (#6964).",
    );
  }
  return listAllSubscribersForTag(tagId, resolved.config);
}

/**
 * Espaçamento entre chamadas SINGULARES ao Kit. A docstring de
 * `kit-client.ts` (§Rate limit, #6047) mede o limite e dá a regra: endpoints
 * singulares toleram só dezenas de chamadas sequenciais sem espera antes de
 * 429; o retry embutido absorve um blip ISOLADO mas **não** é recuperação de
 * rate limit; quem itera precisa se auto-espaçar em ~350ms. Medido nesta
 * issue: uma onda de 102 endereços (2 chamadas cada) sem espaçamento tomou
 * 429 já nas primeiras dezenas.
 */
const KIT_CALL_SPACING_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirma, pela direção CONFIÁVEL, quais dos endereços dados já estão na
 * tag — `GET /v4/subscribers/{id}/tags`, a leitura que a armadilha 5 de
 * `kit-client.ts` mediu refletindo a mutação IMEDIATAMENTE (ao contrário da
 * listagem por tag, que mentiu por 180s com `has_next_page: false`).
 *
 * Chamada só sobre a onda prestes a ser proposta, nunca sobre o cohort
 * inteiro: 2 chamadas por endereço custam pouco em cima de uma onda e muito
 * em cima de 300 endereços. Com o espaçamento obrigatório
 * (`KIT_CALL_SPACING_MS`), uma onda de 100 endereços leva ~70s de relógio —
 * custo aceito de propósito numa rodada diária, em troca de nunca propor
 * quem acabou de migrar.
 *
 * Erro por endereço NÃO aborta a rodada e NÃO é engolido: o e-mail sai em
 * `unconfirmed`, segue sendo proposto (re-taguear é idempotente, e a
 * partição Beehiiv ainda protege contra envio em dobro) e aparece no
 * relatório. Falhar fechado aqui — abortar a onda inteira por uma consulta
 * flaky — custaria mais do que o risco que evita.
 */
async function confirmTaggedEmails(
  emails: readonly string[],
  tagId: number,
  spacingMs: number = KIT_CALL_SPACING_MS,
): Promise<{ tagged: Set<string>; unconfirmed: string[] }> {
  const resolved = resolveKitConfig();
  if (!resolved.ok) {
    throw new Error(
      `[kit-gmail-warmup-ramp] credenciais do Kit indisponíveis (${resolved.reason}) — abortando antes de propor a onda.`,
    );
  }
  const tagged = new Set<string>();
  const unconfirmed: string[] = [];
  let first = true;
  for (const email of emails) {
    if (!first && spacingMs > 0) await sleep(spacingMs);
    first = false;
    try {
      const subscriber = await findKitSubscriberByEmail(email, resolved.config);
      if (!subscriber) continue; // nunca criado no Kit ⇒ certamente não tagueado
      if (spacingMs > 0) await sleep(spacingMs);
      const tagIds = await fetchSubscriberTagIds(subscriber.id, resolved.config);
      if (tagIds.has(tagId)) tagged.add(email.trim().toLowerCase());
    } catch (e) {
      unconfirmed.push(email);
      process.stderr.write(
        `[kit-gmail-warmup-ramp] aviso: não consegui confirmar a tag de ${email} ` +
          `(${e instanceof Error ? e.message : String(e)}) — seguindo com ele na onda (re-taguear é idempotente).\n`,
      );
    }
  }
  return { tagged, unconfirmed };
}

/** Mede o gate (entrega+abertura Gmail) de um broadcast — mesmo cálculo de `kit-provider-split.ts`. */
async function measureGate(broadcastId: number): Promise<RampaVeredito> {
  const [sent, delivered, opens, clicks, stats] = await todasOuNenhuma<
    [Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof getBroadcastStats>>]
  >([
    fetchAudience(broadcastId, "sent"),
    fetchAudience(broadcastId, "delivered"),
    fetchAudience(broadcastId, "opens"),
    fetchAudience(broadcastId, "clicks"),
    getBroadcastStats(broadcastId),
  ]);
  const split = computeProviderSplit({
    sent: sent.emails,
    delivered: delivered.emails,
    openers: opens.emails,
    clickers: clicks.emails,
  });
  const avisos = verificarIntegridade({
    split,
    destinatariosReportados: stats.recipients,
    registrosDescartados: sent.descartadas + delivered.descartadas + opens.descartadas + clicks.descartadas,
  });
  return avaliarRampa(split, avisos);
}

/**
 * Guarda contra um `--reference-broadcast` ser silenciosamente IGNORADO
 * quando já existe estado com um `referenceBroadcastId` diferente — o
 * cohort recusado é imutável por design (ver docstring do módulo). Pura,
 * testável sem I/O — extraída de `runWarmupRamp` só por isso.
 */
export function assertReferenceBroadcastImmutable(
  state: KitGmailWarmupState | null,
  referenceBroadcastId: number | undefined,
): void {
  if (state && referenceBroadcastId !== undefined && referenceBroadcastId !== state.referenceBroadcastId) {
    throw new Error(
      `[kit-gmail-warmup-ramp] estado já existe com referenceBroadcastId=${state.referenceBroadcastId}; ` +
        `--reference-broadcast ${referenceBroadcastId} seria IGNORADO em silêncio (o cohort é imutável). ` +
        `Passe --reset explícito pra recapturar, ou omita a flag pra usar o cohort já capturado.`,
    );
  }
}

export interface WarmupRampResult {
  state: KitGmailWarmupState;
  plan: WavePlan;
  safeToTag: string[];
  needsBeehiivDeactivation: string[];
  pushed: boolean;
  unverifiedEmails: string[];
  /** E-mails cujo create/tag/releitura LANÇOU (rede, 5xx, JSON malformado) —
   *  distinto de `unverifiedEmails` (mutação foi aceita mas a releitura não
   *  reflete a tag ainda). Nunca aborta a onda inteira (fleet review, mesma
   *  classe de bug já corrigida em #6507/kit-ramp-cohort.ts) — a onda é
   *  construída e salva com quem TEVE sucesso, mesmo que outros e-mails da
   *  mesma onda falhem. */
  failedEmails: Array<{ email: string; error: string }>;
  /** #6964 — endereços do cohort que já estavam na tag do Kit sem nenhuma
   *  onda desta rampa tê-los registrado (aplicados por `kit-ramp-cohort.ts`).
   *  Absorvidos no estado ANTES de planejar esta rodada; em dry-run a
   *  absorção existe só em memória. Vazio quando estado e tag concordam. */
  outOfBandReturned: string[];
  /** Subconjunto de `outOfBandReturned` que continua ATIVO na Beehiiv —
   *  violação do invariante de envio em dobro (`kit-ramp-cohort.ts` tagueou
   *  no Kit mas a Fase B de desativação não fechou pra esses). Absorver não
   *  pode fazer isso sumir: o editor precisa desativá-los à mão. Vazio no
   *  caminho normal. */
  outOfBandStillActiveOnBeehiiv: string[];
  /** Endereços da onda cuja pertença à tag NÃO pôde ser confirmada pela
   *  releitura (erro de rede/API na consulta). Seguem na onda — re-taguear é
   *  idempotente —, mas ficam visíveis em vez de virarem silêncio. */
  unconfirmedTagEmails: string[];
}

export async function runWarmupRamp(opts: {
  referenceBroadcastId?: number;
  gateBroadcastId: number;
  push: boolean;
  /** Descarta o estado existente e recomeça a captura do cohort — exige
   *  `--reference-broadcast` (mesma exigência da 1ª rodada). Sem isto, um
   *  `--reference-broadcast` passado numa rodada com estado já existente é
   *  IGNORADO — o cohort é imutável por design (ver docstring do módulo). */
  reset?: boolean;
  statePath?: string;
}): Promise<WarmupRampResult> {
  const statePath = opts.statePath ?? DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH;
  let state = opts.reset ? null : loadState(statePath);

  assertReferenceBroadcastImmutable(state, opts.referenceBroadcastId);

  if (!state) {
    if (opts.referenceBroadcastId === undefined) {
      throw new Error(
        "[kit-gmail-warmup-ramp] nenhum estado em " +
          `${statePath} ainda — passe --reference-broadcast <id> na 1ª invocação (ou após --reset) pra capturar ` +
          "o cohort recusado.",
      );
    }
    const [sent, delivered, apoioNivelByEmail] = await todasOuNenhuma<
      [Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof fetchAudience>>, Map<string, ApoioNivel>]
    >([
      fetchAudience(opts.referenceBroadcastId, "sent"),
      fetchAudience(opts.referenceBroadcastId, "delivered"),
      resolveApoioNivelByEmail(),
    ]);
    const rejected = computeGmailRejectedEmails(sent.emails, delivered.emails, apoioNivelByEmail);
    state = buildInitialState(opts.referenceBroadcastId, rejected);
    if (opts.push) saveState(state, statePath);
  }

  const gate = await measureGate(opts.gateBroadcastId);

  const tagName = readAudienceTagName();
  const tagId = await resolveAudienceTagId(tagName);

  // Ativos na Beehiiv: resolvido ANTES da absorção (finding 2 do review da
  // PR #6984) porque quem migrou fora da rampa e continua ativo na Beehiiv
  // viola o invariante de envio em dobro — absorver sem checar tornaria esse
  // defeito silencioso (ver docstring de `buildOutOfBandWaveEntry`).
  const beehiivCfg = resolveBeehiivConfig();
  const activeBeehiiv = beehiivCfg.ok
    ? new Set((await fetchActiveBeehiivEmails(beehiivCfg.config.apiKey, beehiivCfg.config.publicationId)).map((e) => e.trim().toLowerCase()))
    : new Set<string>();
  if (!beehiivCfg.ok) {
    process.stderr.write(
      `[kit-gmail-warmup-ramp] aviso: não consegui checar ativos na Beehiiv (${beehiivCfg.reason}) — ` +
        `tratando TODOS os endereços da onda como "precisa de desativação manual" (falha segura, nunca duplica envio).\n`,
    );
  }

  const outOfBandReturned: string[] = [];
  const outOfBandStillActiveOnBeehiiv: string[] = [];
  /** Absorve no estado quem já migrou fora da rampa, registrando quem entre
   *  eles continua ativo na Beehiiv. Persiste SEPARADAMENTE da onda desta
   *  rodada: se o tagueamento adiante falhar no meio, o que já era verdade no
   *  Kit continua registrado. */
  const absorb = (base: KitGmailWarmupState, emails: string[]): KitGmailWarmupState => {
    if (emails.length === 0) return base;
    const stillActive = emails.filter((e) => activeBeehiiv.has(e.trim().toLowerCase()));
    const next: KitGmailWarmupState = {
      ...base,
      waves: [...base.waves, buildOutOfBandWaveEntry(base, opts.gateBroadcastId, gate, emails, stillActive)],
    };
    outOfBandReturned.push(...emails);
    outOfBandStillActiveOnBeehiiv.push(...stillActive);
    if (opts.push) saveState(next, statePath);
    return next;
  };

  // #6964 passo 1 — reconciliação em MASSA com a tag do Kit. Sempre ANTES de
  // taguear qualquer coisa nesta rodada, pra que a leitura não enxergue a
  // própria escrita. É um PISO: a listagem por tag pode sub-reportar por
  // ~180s (armadilha 5 de `kit-client.ts`); o passo 2 cobre o resto.
  state = absorb(
    state,
    computeOutOfBandReturned(state.rejectedEmails, returnedEmails(state), await listTaggedEmails(tagId)),
  );

  const plan = planNextWave({
    rejectedEmails: state.rejectedEmails,
    alreadyReturned: returnedEmails(state),
    lastWaveSize: lastPushedWaveSize(state),
    gate,
  });

  if (plan.emails.length === 0) {
    // Onda vazia (segurada pelo gate, ou já esgotada) — registrar como
    // proposta não-empurrada é ruído (nenhum e-mail, nenhuma decisão nova) e
    // infla o histórico sem valor; não grava wave.
    return { state, plan, safeToTag: [], needsBeehiivDeactivation: [], pushed: false, unverifiedEmails: [], failedEmails: [], outOfBandReturned, outOfBandStillActiveOnBeehiiv, unconfirmedTagEmails: [] };
  }

  // #6964 passo 2 (finding 1 do review da PR #6984) — confere a onda proposta
  // pela direção CONFIÁVEL antes de propor. A listagem em massa acima mente
  // por ~180s depois de uma escrita, e a sequência que ESTA issue trata é
  // justamente "rodar `kit-ramp-cohort.ts` e em seguida a rampa": sem esta
  // conferência, a onda sairia com endereços que acabaram de migrar.
  const { tagged: confirmedTagged, unconfirmed: unconfirmedTagEmails } = await confirmTaggedEmails(plan.emails, tagId);
  const { alreadyTagged, stillPending } = partitionByConfirmedTag(plan.emails, confirmedTagged);
  state = absorb(state, alreadyTagged);

  // A onda pode sair MENOR que o tamanho planejado quando a listagem em massa
  // estava defasada — preferível a propor quem já migrou. A rodada seguinte
  // parte do número correto, porque estes acabaram de ser absorvidos.
  const effectivePlan: WavePlan =
    alreadyTagged.length === 0
      ? plan
      : {
          ...plan,
          emails: stillPending,
          size: stillPending.length,
          skipped: stillPending.length === 0,
          reason:
            stillPending.length === 0
              ? `os ${alreadyTagged.length} endereço(s) da onda já estavam na tag do Kit (releitura confirmou) — nada novo a propor nesta rodada.`
              : `${plan.reason} — ${alreadyTagged.length} já estava(m) na tag e foi(ram) absorvido(s).`,
        };

  if (effectivePlan.emails.length === 0) {
    return { state, plan: effectivePlan, safeToTag: [], needsBeehiivDeactivation: [], pushed: false, unverifiedEmails: [], failedEmails: [], outOfBandReturned, outOfBandStillActiveOnBeehiiv, unconfirmedTagEmails };
  }

  const { safeToTag, needsBeehiivDeactivation } = resolveWarmupBeehiivPartition(effectivePlan.emails, beehiivCfg.ok, activeBeehiiv);

  if (!opts.push) {
    return { state, plan: effectivePlan, safeToTag, needsBeehiivDeactivation, pushed: false, unverifiedEmails: [], failedEmails: [], outOfBandReturned, outOfBandStillActiveOnBeehiiv, unconfirmedTagEmails };
  }

  const unverifiedEmails: string[] = [];
  const actuallyTagged: string[] = [];
  const failedEmails: Array<{ email: string; error: string }> = [];
  // Cada e-mail é protegido individualmente (fleet review — mesma classe de
  // bug já corrigida em #6507/kit-ramp-cohort.ts): sem isto, uma exceção no
  // create/tag/releitura de UM e-mail (rede, 5xx, JSON malformado) propagava
  // sem tratamento, abortando a onda inteira antes de `buildWaveEntry`/
  // `saveState` — perdendo o rastro de e-mails já tagueados de verdade em
  // produção, e fazendo o próximo `planNextWave` reoferecê-los como se nada
  // tivesse sido tentado.
  for (const email of safeToTag) {
    try {
      const subscriber = await createOrUpdateSubscriber({ email_address: email });
      await tagSubscriber(tagId, subscriber.id);
      // Confirma por releitura (subscriber→tags, sem atraso de propagação
      // medido — ver docstring de listSubscriberTags), nunca só pelo 2xx da
      // mutação (kit-client.ts, "Armadilhas da API v4").
      const tags = await listSubscriberTags(subscriber.id);
      actuallyTagged.push(email); // mutação foi tentada/aceita — conta pra returnedEmails
      if (!tags.some((t) => t.id === tagId)) {
        unverifiedEmails.push(email);
      }
    } catch (e) {
      failedEmails.push({ email, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const wave = buildWaveEntry(state, opts.gateBroadcastId, gate, actuallyTagged, needsBeehiivDeactivation, true, new Date(), unverifiedEmails);
  state = { ...state, waves: [...state.waves, wave] };
  saveState(state, statePath);

  return { state, plan: effectivePlan, safeToTag: actuallyTagged, needsBeehiivDeactivation, pushed: true, unverifiedEmails, failedEmails, outOfBandReturned, outOfBandStillActiveOnBeehiiv, unconfirmedTagEmails };
}

export function formatReport(result: WarmupRampResult): string {
  const lines: string[] = [];
  lines.push(`Cohort recusado (referência broadcast ${result.state.referenceBroadcastId}): ${result.state.totalRejected} endereço(s) Gmail.`);
  lines.push(`Já devolvidos em ondas anteriores: ${returnedEmails(result.state).size}.`);
  if (result.outOfBandReturned.length > 0) {
    lines.push(
      `  ↳ ${result.outOfBandReturned.length} deles migrados FORA desta rampa (tag do Kit, tipicamente kit-ramp-cohort.ts) e ` +
        `absorvidos ${result.pushed ? "no estado" : "só em memória (dry-run)"} agora — #6964:\n` +
        result.outOfBandReturned.map((e) => `      - ${e}`).join("\n"),
    );
  }
  if (result.outOfBandStillActiveOnBeehiiv.length > 0) {
    // Invariante de envio em dobro violado: tagueado no Kit E ativo na
    // Beehiiv. Absorver não pode engolir isto (ver buildOutOfBandWaveEntry).
    lines.push(
      `  ⚠️ ENVIO EM DOBRO — ${result.outOfBandStillActiveOnBeehiiv.length} do(s) absorvido(s) continua(m) ATIVO(s) na Beehiiv ` +
        `(tagueado no Kit sem a desativação correspondente). Desativar à mão na Beehiiv, ou rodar ` +
        `\`kit-ramp-cohort.ts --audit\`:\n` +
        result.outOfBandStillActiveOnBeehiiv.map((e) => `      - ${e}`).join("\n"),
    );
  }
  if (result.unconfirmedTagEmails.length > 0) {
    lines.push(
      `  ⚠️ não deu pra confirmar a tag de ${result.unconfirmedTagEmails.length} endereço(s) da onda (erro na releitura) — ` +
        `seguem propostos, re-taguear é idempotente: ${result.unconfirmedTagEmails.join(", ")}`,
    );
  }
  if (result.plan.skipped) {
    lines.push(`\nNenhuma onda proposta: ${result.plan.reason}`);
    return lines.join("\n");
  }
  lines.push(`\nOnda proposta: ${result.plan.size} endereço(s). ${result.plan.reason}`);
  lines.push(`  seguro taguear agora: ${result.safeToTag.length}`);
  if (result.needsBeehiivDeactivation.length > 0) {
    lines.push(
      `  PRECISA de desativação manual na Beehiiv antes (${result.needsBeehiivDeactivation.length}):\n` +
        result.needsBeehiivDeactivation.map((e) => `    - ${e}`).join("\n"),
    );
  }
  if (result.unverifiedEmails.length > 0) {
    lines.push(
      `  ⚠️ tagueados mas a releitura NÃO confirmou (retry manual recomendado): ${result.unverifiedEmails.join(", ")}`,
    );
  }
  if (result.failedEmails.length > 0) {
    lines.push(
      `  ❌ falharam (create/tag/releitura lançou — não confundir com "tagueado mas não confirmado" acima):\n` +
        result.failedEmails.map((f) => `    - ${f.email}: ${f.error}`).join("\n"),
    );
  }
  lines.push(result.pushed ? "\n--push: onda aplicada e estado persistido." : "\n--dry-run: nada foi escrito. Rode com --push para aplicar.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const json = hasFlag(argv, "json");
  const reset = hasFlag(argv, "reset");
  const referenceBroadcastId = getIntArg(argv, "reference-broadcast", { min: 1 });
  const gateBroadcastId = getIntArg(argv, "gate-broadcast", { min: 1 });
  if (gateBroadcastId === undefined) {
    throw new Error(
      "uso: npx tsx scripts/kit-gmail-warmup-ramp.ts --gate-broadcast <id> [--reference-broadcast <id>] [--push] [--reset] [--json]",
    );
  }

  // Absolutiza contra a raiz do repo, não o CWD do processo (pode não ser a
  // raiz — ex: task agendada) — mesmo padrão de `resolve(ROOT, editionDir(...))`
  // em `eia-compose.ts` e vizinhos.
  const statePath = resolve(ROOT, DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH);
  const result = await runWarmupRamp({ referenceBroadcastId, gateBroadcastId, push, reset, statePath });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatReport(result));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[kit-gmail-warmup-ramp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
