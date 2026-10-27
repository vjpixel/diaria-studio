#!/usr/bin/env node
/**
 * scripts/sync-kit-frio.ts (#11221)
 *
 * Mantém as tags `frio`/`suprimido` no Kit (o Kit grátis não tem automação,
 * então roda pelos nossos scripts agendados: Passo 3d de
 * `brevo-diaria-run.ts`, a cada Etapa 5). Critério e regras:
 * `scripts/lib/kit-frio.ts`. Resumo:
 *
 *  - ativo sem abertura/clique em 30 dias (cadastro < 90 dias) ou 90 dias
 *    (cadastro >= 90 dias) → tag `frio` (sai da diária pelo segmento,
 *    entra na semanal de segunda);
 *  - `frio` com abertura/clique recente → tira `frio` (volta à diária);
 *  - `frio` com 12 semanais seguidas sem sinal → tag `suprimido` e tira
 *    `frio`. **Nunca descadastra** — só tags; nada aqui chama unsubscribe.
 *  - vigia: reclamação de spam da semanal > 0,1% ou queda >= 5 pp da
 *    abertura da diária no Gmail depois do início da semanal → grava a pausa
 *    em `data/kit-frio/semanal-pause.json` (o publisher da semanal recusa
 *    enquanto pausada) e abre issue de alarme.
 *
 * ## Flags (`platform.config.json` → `kit.frio`)
 *
 *  - `enabled` — liga ESTE script. Desligada ⇒ sai 0 sem rede.
 *  - `segmento_exclui_frio_confirmado` — o segmento da diária
 *    (`kit.diaria_exclusion_segment.segment_id`) já foi editado NO PAINEL pra
 *    excluir `frio` e `suprimido` (a API do Kit não edita segmento). Sem
 *    isto, `--push` vira dry-run: taguear `frio` sem o segmento só mandaria a
 *    edição de segunda em dobro, e `suprimido` não tiraria ninguém da diária.
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-frio.ts           # dry-run (lê Kit, não escreve)
 *   npx tsx scripts/sync-kit-frio.ts --push    # aplica as tags (exige as flags)
 *
 * Exit: 0 ok/desligado; 1 falha em algum assinante (os demais seguem); 2
 * precondição (config, chave, tag inexistente, registro ilegível).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { findTagIdByName } from "./lib/kit-broadcasts.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { normalizeEmail } from "./lib/brevo-diaria-store.ts";
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts";
import { parseDiariaExclusionSegment, type DiariaExclusionSegmentConfig } from "./lib/kit-diaria-audience.ts";
import type { BroadcastEngagement, DiariaBroadcastRecord } from "./lib/kit-sem-abertura.ts";
import { createRequestPacer } from "./kit-provider-split.ts";
import {
  KIT_MIN_INTERVAL_MS,
  fetchDeliveredEngagement,
  listKitActiveCandidates,
  readDiariaBroadcastRegistry,
  tagAndConfirm,
  untagAndConfirm,
} from "./sync-kit-sem-abertura-to-brevo.ts";
import {
  KIT_FRIO_TAG_NAME,
  KIT_FRIO_WINDOW_OLD_DAYS,
  KIT_SEMANAL_FRIO_PUBLISHED_FILENAME,
  KIT_SUPRIMIDO_TAG_NAME,
  buildLastSignalIndex,
  buildSemanalFrioSilentStreaks,
  decideKitFrio,
  decideSemanalFrioVigia,
  gmailOpenRate,
  isKitFrioEnabled,
  parseSemanalFrioPauseState,
  type KitFrioCandidate,
  type KitFrioConfig,
  type KitSemanalFrioPublished,
  type SemanalFrioEngagement,
  type SemanalFrioPauseState,
  type SemanalFrioVigiaVerdict,
} from "./lib/kit-frio.ts";
import { BREVO_DIARIA_MATURATION_HOURS } from "./lib/shared/brevo-diaria-score.ts";
import { ensureAlarmIssue, loadAlarmIssuesState, saveAlarmIssuesState, alarmIssueStateKey } from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_KIT_FRIO_LOG_PATH = resolve(ROOT, "data/kit-frio/frio-log.jsonl");
export const DEFAULT_SEMANAL_FRIO_PAUSE_PATH = resolve(ROOT, "data/kit-frio/semanal-pause.json");
const DEFAULT_ALARM_STATE_PATH = resolve(ROOT, "data/kit-frio/alarm-issues-state.json");
const DAY_MS = 24 * 3600 * 1000;
/** Diárias maduras de cada lado da 1ª semanal usadas pela vigia do Gmail. */
const VIGIA_GMAIL_WINDOW = 6;

export interface KitFrioPlatformConfig {
  kit?: {
    frio?: KitFrioConfig & { segmento_exclui_frio_confirmado?: boolean };
    diaria_exclusion_segment?: DiariaExclusionSegmentConfig;
  };
}

export interface KitFrioDeps {
  nowMs: number;
  log: (msg: string) => void;
  readDiariaRegistry: () => DiariaBroadcastRecord[];
  readSemanalRegistry: () => DiariaBroadcastRecord[];
  listKitActive: () => Promise<KitFrioCandidate[]>;
  fetchEngagement: (broadcastId: number) => Promise<BroadcastEngagement>;
  findTagId: (name: string) => Promise<number | null>;
  /** Aplica a tag e RELÊ (lança se a releitura não mostrar). */
  tag: (tagId: number, subscriberId: number) => Promise<void>;
  /** Remove a tag e RELÊ (lança se a releitura ainda mostrar). */
  untag: (tagId: number, subscriberId: number) => Promise<void>;
  /** E-mails hoje `complained` no Kit (vigia). */
  listComplainedEmails: () => Promise<string[]>;
  readPause: () => SemanalFrioPauseState;
  writePause: (s: SemanalFrioPauseState) => void;
  /** Abre/reusa a issue de alarme da vigia (fail-soft no caller). */
  raiseAlarm: (reasons: string[]) => void;
  appendLog: (line: string) => void;
}

export interface KitFrioRunResult {
  code: 0 | 1 | 2;
  disabled?: boolean;
  dryRun: boolean;
  taggedFrio: number;
  removedFrio: number;
  suppressed: number;
  keptFrio: number;
  failed: number;
  skipped: Record<string, number>;
  vigia?: SemanalFrioVigiaVerdict;
  summary: string;
}

/** Pura o bastante pra teste (todo I/O em `deps`). */
export async function runKitFrioSync(
  cfg: KitFrioPlatformConfig,
  opts: { push: boolean },
  deps: KitFrioDeps,
): Promise<KitFrioRunResult> {
  const { log } = deps;
  const empty = { taggedFrio: 0, removedFrio: 0, suppressed: 0, keptFrio: 0, failed: 0, skipped: {} as Record<string, number> };
  const frioCfg = cfg.kit?.frio;
  if (!isKitFrioEnabled(frioCfg)) {
    return { code: 0, disabled: true, dryRun: true, ...empty, summary: "kit.frio.enabled = false — nada a fazer (#11221)." };
  }
  let push = opts.push;
  const segment = parseDiariaExclusionSegment(cfg.kit?.diaria_exclusion_segment);
  if ("error" in segment) return { code: 2, dryRun: true, ...empty, summary: `${segment.error} Nenhuma tag aplicada.` };
  if (push && (!segment.enabled || frioCfg?.segmento_exclui_frio_confirmado !== true)) {
    log(
      "AVISO: o segmento da diária no Kit não está confirmado como excluindo frio/suprimido " +
        "(kit.diaria_exclusion_segment.enabled + kit.frio.segmento_exclui_frio_confirmado). Rodando em dry-run (#11221).",
    );
    push = false;
  }

  let diaria: DiariaBroadcastRecord[];
  let semanal: DiariaBroadcastRecord[];
  try {
    diaria = deps.readDiariaRegistry();
    semanal = deps.readSemanalRegistry();
  } catch (e) {
    return { code: 2, dryRun: !push, ...empty, summary: `registro de broadcasts ilegível (${(e as Error).message}) — nada aplicado.` };
  }
  // Só o que já saiu, e da diária só a janela mais longa (+2 dias de folga).
  const sent = (r: DiariaBroadcastRecord) => {
    const t = Date.parse(r.sentAt);
    return Number.isFinite(t) && t <= deps.nowMs;
  };
  const diariaInWindow = diaria.filter((r) => sent(r) && Date.parse(r.sentAt) >= deps.nowMs - (KIT_FRIO_WINDOW_OLD_DAYS + 2) * DAY_MS);
  const semanalSent = semanal.filter(sent);
  log(`registro: ${diariaInWindow.length} diária(s) na janela, ${semanalSent.length} semanal(is) de frio enviada(s).`);

  const diariaEng: (BroadcastEngagement & { sentAt: string })[] = [];
  for (const r of diariaInWindow) diariaEng.push({ ...(await deps.fetchEngagement(r.broadcastId)), sentAt: r.sentAt });
  const semanalEng: SemanalFrioEngagement[] = [];
  for (const r of semanalSent) semanalEng.push({ ...(await deps.fetchEngagement(r.broadcastId)), sentAt: r.sentAt });

  const lastSignal = buildLastSignalIndex([...diariaEng, ...semanalEng]);
  const silentStreaks = buildSemanalFrioSilentStreaks(semanalEng, deps.nowMs);
  const seedEmails = new Set(EDITOR_SEED_EMAILS.map(normalizeEmail));
  const actives = await deps.listKitActive();

  const plan = { tag_frio: [] as KitFrioCandidate[], remove_frio: [] as KitFrioCandidate[], suppress: [] as KitFrioCandidate[] };
  const skipped: Record<string, number> = {};
  let keptFrio = 0;
  for (const c of actives) {
    const d = decideKitFrio(c, { nowMs: deps.nowMs, lastSignal, silentStreaks, diariaRecords: diaria, seedEmails });
    if (d.action === "skip") skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
    else if (d.action === "keep_frio") keptFrio++;
    else plan[d.action].push(c);
  }
  log(
    `${actives.length} ativo(s): ${plan.tag_frio.length} esfriaram, ${plan.remove_frio.length} voltam à diária, ` +
      `${plan.suppress.length} chegam a suprimido, ${keptFrio} seguem frio. Fora: ` +
      Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(", "),
  );

  let failed = 0;
  let taggedFrio = 0;
  let removedFrio = 0;
  let suppressed = 0;
  if (push && (plan.tag_frio.length + plan.remove_frio.length + plan.suppress.length) > 0) {
    const frioId = await deps.findTagId(KIT_FRIO_TAG_NAME);
    const suprimidoId = plan.suppress.length > 0 ? await deps.findTagId(KIT_SUPRIMIDO_TAG_NAME) : -1;
    if (frioId === null || suprimidoId === null) {
      return {
        code: 2,
        dryRun: false,
        ...empty,
        skipped,
        keptFrio,
        summary: `tag "${frioId === null ? KIT_FRIO_TAG_NAME : KIT_SUPRIMIDO_TAG_NAME}" não existe no Kit — crie no painel antes de ligar kit.frio (#11221).`,
      };
    }
    const nowIso = new Date(deps.nowMs).toISOString();
    const logLine = (event: string, c: KitFrioCandidate) => {
      try {
        deps.appendLog(JSON.stringify({ ts: nowIso, event, email: normalizeEmail(c.email), kit_subscriber_id: c.id }) + "\n");
      } catch (e) {
        log(`aviso: falha ao gravar o log de ${c.email} (${(e as Error).message}).`);
      }
    };
    for (const c of plan.tag_frio) {
      try {
        await deps.tag(frioId, c.id);
        taggedFrio++;
        logLine("frio_tagged", c);
      } catch (e) {
        failed++;
        log(`FALHA ao taguear frio em ${c.email}: ${(e as Error).message}`);
      }
    }
    for (const c of plan.remove_frio) {
      try {
        await deps.untag(frioId, c.id);
        removedFrio++;
        logLine("frio_removed", c);
      } catch (e) {
        failed++;
        log(`FALHA ao tirar frio de ${c.email}: ${(e as Error).message}`);
      }
    }
    for (const c of plan.suppress) {
      // `suprimido` ANTES de tirar `frio`: se cair no meio, a pessoa fica com
      // as duas (fora de tudo), nunca volta pra diária sem sinal.
      try {
        await deps.tag(suprimidoId as number, c.id);
        await deps.untag(frioId, c.id);
        suppressed++;
        logLine("suprimido_tagged", c);
      } catch (e) {
        failed++;
        log(`FALHA ao suprimir ${c.email} (só tags, nunca descadastro): ${(e as Error).message}`);
      }
    }
  }

  // ── vigia ──
  let vigia: SemanalFrioVigiaVerdict | undefined;
  if (semanalEng.length > 0) {
    const maturation = BREVO_DIARIA_MATURATION_HOURS * 3600 * 1000;
    const matureSemanal = semanalEng
      .filter((s) => deps.nowMs - Date.parse(s.sentAt) >= maturation)
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    let complained = 0;
    let delivered = 0;
    if (matureSemanal.length > 0) {
      const latest = matureSemanal[0]!;
      const del = new Set(latest.delivered.map(normalizeEmail));
      delivered = del.size;
      try {
        for (const e of await deps.listComplainedEmails()) if (del.has(normalizeEmail(e))) complained++;
      } catch (e) {
        log(`aviso: lista de complained do Kit não lida (${(e as Error).message}) — reclamação não medida nesta rodada.`);
        delivered = 0;
      }
    }
    const firstSemanalMs = Math.min(...semanalEng.map((s) => Date.parse(s.sentAt)));
    const rates = (side: "before" | "after") =>
      diariaEng
        .filter((b) => deps.nowMs - Date.parse(b.sentAt) >= maturation)
        .filter((b) => (side === "before" ? Date.parse(b.sentAt) < firstSemanalMs : Date.parse(b.sentAt) > firstSemanalMs))
        .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
        .slice(0, VIGIA_GMAIL_WINDOW)
        .map((b) => gmailOpenRate(b.delivered, b.opens))
        .filter((r): r is number => r !== null);
    vigia = decideSemanalFrioVigia({
      semanalDelivered: delivered,
      semanalComplained: complained,
      gmailOpenRatesBefore: rates("before"),
      gmailOpenRatesAfter: rates("after"),
    });
    if (vigia.pause) {
      log(`VIGIA: semanal de frio deve PAUSAR — ${vigia.reasons.join("; ")}.`);
      if (opts.push) {
        const current = deps.readPause();
        if (!current.paused) {
          deps.writePause({ paused: true, since: new Date(deps.nowMs).toISOString(), reasons: vigia.reasons });
        }
        try {
          deps.raiseAlarm(vigia.reasons);
        } catch (e) {
          log(`aviso: issue de alarme da vigia não aberta (${(e as Error).message}) — a pausa já está gravada.`);
        }
      }
    } else {
      log(`vigia: ok (${vigia.notes.join("; ") || "reclamação e Gmail dentro do limite"}).`);
    }
  }

  return {
    code: failed > 0 ? 1 : 0,
    dryRun: !push,
    taggedFrio: push ? taggedFrio : plan.tag_frio.length,
    removedFrio: push ? removedFrio : plan.remove_frio.length,
    suppressed: push ? suppressed : plan.suppress.length,
    keptFrio,
    failed,
    skipped,
    vigia,
    summary:
      `${push ? "" : "[dry-run] "}${push ? taggedFrio : plan.tag_frio.length} frio, ` +
      `${push ? removedFrio : plan.remove_frio.length} de volta à diária, ` +
      `${push ? suppressed : plan.suppress.length} suprimido(s) (sem descadastro), ${failed} falha(s).`,
  };
}

// ── I/O de produção ──────────────────────────────────────────────────────

/** Registro das semanais de frio (`_internal/kit-semanal-frio-published.json` por edição). */
export function readSemanalFrioRegistry(editionsRootAbs: string): DiariaBroadcastRecord[] {
  const out: DiariaBroadcastRecord[] = [];
  const unreadable: string[] = [];
  for (const [edition, dir] of enumerateEditionDirs(editionsRootAbs)) {
    const path = resolve(dir, "_internal", KIT_SEMANAL_FRIO_PUBLISHED_FILENAME);
    if (!existsSync(path)) continue;
    try {
      const s = JSON.parse(readFileSync(path, "utf8")) as Partial<KitSemanalFrioPublished>;
      if (s.status === "scheduled" && typeof s.broadcast_id === "number" && typeof s.scheduled_at === "string") {
        out.push({ broadcastId: s.broadcast_id, sentAt: s.scheduled_at, edition });
      }
    } catch (e) {
      unreadable.push(`${path} (${(e as Error).message})`);
    }
  }
  if (unreadable.length > 0) throw new Error(`${unreadable.length} arquivo(s) ilegível(is): ${unreadable.join("; ")}`);
  return out;
}

export function readSemanalFrioPause(path: string = DEFAULT_SEMANAL_FRIO_PAUSE_PATH): SemanalFrioPauseState {
  return parseSemanalFrioPauseState(existsSync(path) ? readFileSync(path, "utf8") : null);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-kit-frio] ${msg}\n`);
  let cfg: KitFrioPlatformConfig;
  try {
    cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as KitFrioPlatformConfig;
  } catch (e) {
    log(`ERRO: platform.config.json ilegível (${(e as Error).message}).`);
    process.exitCode = 2;
    return;
  }
  if (!isKitFrioEnabled(cfg.kit?.frio)) {
    log("kit.frio.enabled = false — nada a fazer (#11221).");
    console.log(JSON.stringify({ code: 0, disabled: true }));
    return;
  }
  const kitCfg = resolveKitConfig();
  if (!kitCfg.ok) {
    log(`ERRO: ${kitCfg.reason}`);
    process.exitCode = 2;
    return;
  }
  const pace = createRequestPacer(KIT_MIN_INTERVAL_MS);
  const result = await runKitFrioSync(cfg, { push }, {
    nowMs: Date.now(),
    log,
    readDiariaRegistry: () => readDiariaBroadcastRegistry(resolve(ROOT, editionsRoot())),
    readSemanalRegistry: () => readSemanalFrioRegistry(resolve(ROOT, editionsRoot())),
    listKitActive: () => listKitActiveCandidates(log, pace),
    fetchEngagement: (id) => fetchDeliveredEngagement(id, log, pace),
    findTagId: async (name) => {
      await pace();
      return findTagIdByName(name);
    },
    tag: (tagId, id) => tagAndConfirm(tagId, id, pace),
    untag: (tagId, id) => untagAndConfirm(tagId, id, pace),
    listComplainedEmails: async () => (await listAllKitSubscribers(undefined, { status: "complained" })).map((s) => s.email_address),
    readPause: () => readSemanalFrioPause(),
    writePause: (s) => {
      mkdirSync(dirname(DEFAULT_SEMANAL_FRIO_PAUSE_PATH), { recursive: true });
      writeFileSync(DEFAULT_SEMANAL_FRIO_PAUSE_PATH, JSON.stringify(s, null, 2) + "\n");
    },
    raiseAlarm: (reasons) => {
      const check = "kit-semanal-frio-vigia";
      const fingerprint = `${check}:pausa`;
      const state = loadAlarmIssuesState(DEFAULT_ALARM_STATE_PATH);
      const key = alarmIssueStateKey(check, fingerprint);
      const r = ensureAlarmIssue(
        {
          check,
          fingerprint,
          family: "estado",
          priority: "P1",
          labels: ["bug"],
          title: "Vigia da semanal de frio do Kit pausou o envio (#11221)",
          body:
            "A vigia da semanal de frio (#11221) pausou o broadcast de segunda pra tag `frio`:\n\n" +
            reasons.map((r) => `- ${r}`).join("\n") +
            `\n\nEstado em \`data/kit-frio/semanal-pause.json\`. Pra retomar depois de investigar: apagar o arquivo ` +
            "(ou gravar `{\"paused\": false}`).",
        },
        state[key],
        ROOT,
      );
      if (r.issueNumber !== null && r.url !== null) {
        state[key] = { missingStreak: state[key]?.missingStreak ?? 0, closedAt: state[key]?.closedAt ?? null, issueNumber: r.issueNumber, url: r.url, family: "estado" };
        saveAlarmIssuesState(state, DEFAULT_ALARM_STATE_PATH);
      }
    },
    appendLog: (line) => appendFileWithRetry(DEFAULT_KIT_FRIO_LOG_PATH, line),
  });
  log(result.summary);
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-kit-frio] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
