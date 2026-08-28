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
import { createOrUpdateSubscriber } from "./lib/kit-subscribers.ts";
import { resolveBeehiivConfig } from "./lib/beehiiv-config.ts";
import { fetchActiveBeehiivEmails } from "./reconcile-beehiiv-kit.ts";
import {
  computeGmailRejectedEmails,
  planNextWave,
  resolveWarmupBeehiivPartition,
  returnedEmails,
  lastPushedWaveSize,
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
    const [sent, delivered] = await todasOuNenhuma<
      [Awaited<ReturnType<typeof fetchAudience>>, Awaited<ReturnType<typeof fetchAudience>>]
    >([fetchAudience(opts.referenceBroadcastId, "sent"), fetchAudience(opts.referenceBroadcastId, "delivered")]);
    const rejected = computeGmailRejectedEmails(sent.emails, delivered.emails);
    state = buildInitialState(opts.referenceBroadcastId, rejected);
    if (opts.push) saveState(state, statePath);
  }

  const gate = await measureGate(opts.gateBroadcastId);
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
    return { state, plan, safeToTag: [], needsBeehiivDeactivation: [], pushed: false, unverifiedEmails: [], failedEmails: [] };
  }

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
  const { safeToTag, needsBeehiivDeactivation } = resolveWarmupBeehiivPartition(plan.emails, beehiivCfg.ok, activeBeehiiv);

  if (!opts.push) {
    return { state, plan, safeToTag, needsBeehiivDeactivation, pushed: false, unverifiedEmails: [], failedEmails: [] };
  }

  const tagName = readAudienceTagName();
  const tagId = await findTagIdByName(tagName);
  if (tagId === null) {
    throw new Error(
      `[kit-gmail-warmup-ramp] tag "${tagName}" (kit_diaria.audience_tag) não encontrada no Kit — abortando ` +
        `sem taguear ninguém (falha segura, mesmo padrão de resolveAudienceTagId em kit-diaria-channel.ts).`,
    );
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

  return { state, plan, safeToTag: actuallyTagged, needsBeehiivDeactivation, pushed: true, unverifiedEmails, failedEmails };
}

export function formatReport(result: WarmupRampResult): string {
  const lines: string[] = [];
  lines.push(`Cohort recusado (referência broadcast ${result.state.referenceBroadcastId}): ${result.state.totalRejected} endereço(s) Gmail.`);
  lines.push(`Já devolvidos em ondas anteriores: ${returnedEmails(result.state).size}.`);
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
