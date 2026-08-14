#!/usr/bin/env node
/**
 * check-acquisition-health.ts (#5249)
 *
 * Task semanal: alarme de saúde de aquisição por canal, sobre os snapshots
 * já existentes de `data/beehiiv-backup/` (`Diaria-Beehiiv-Backup`, #5229) +
 * o mapa de origem recuperada (`scripts/build-origem-map.ts`, #5235 Parte 2,
 * usado só como referência de contexto no leitor humano do e-mail — a
 * DETECÇÃO em si roda sobre `utm_source`/`referring_site` bruto de cada
 * snapshot, ver `scripts/lib/acquisition-health.ts`). **NUNCA chama a API
 * Beehiiv ao vivo** — leitura local apenas (guard de publicação do
 * overnight/develop).
 *
 * ## Por que até 3 snapshots (não só 2)
 *
 * Sobrevivência/CTR comparam "semana atual" (snapshot mais recente) vs
 * "semana anterior" (2º mais recente) — 2 snapshots bastam. `canal_parou`
 * (sinal 3a) precisa saber se o canal JÁ estava entregando cadastros antes
 * de zerar — isso exige uma 3ª data pra formar a janela "semana anterior"
 * (`(data[-3], data[-2]]`) e compará-la contra a janela atual
 * (`(data[-2], data[-1]]`). Com só 2 snapshots disponíveis (early do
 * `Diaria-Beehiiv-Backup`, #5229, ainda sem 3 semanas de histórico), o sinal
 * `canal_parou` fica automaticamente desligado (janela anterior nunca >0)
 * até o histórico crescer — degradação silenciosa e correta, não um erro.
 *
 * Uso:
 *   npx tsx scripts/check-acquisition-health.ts [--dry-run] [--to email@x.com]
 *     [--root data/beehiiv-backup] [--state data/acquisition-health/state.json]
 *
 *   --dry-run  computa os findings e avalia se alarmaria, mas NÃO envia
 *              e-mail nem avança o state (mesmo contrato dos outros alarmes
 *              locais deste repo — cursos-error-alarm.ts, apoios-diff-alarm.ts).
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais) pra ENVIAR o alarme — a leitura/detecção em si
 * não precisa de credencial nenhuma. Requer o junction `data/` (OneDrive)
 * pra ler os snapshots e persistir o state.
 *
 * Fail-soft: menos de 1 snapshot disponível → log + exit 0 (nada pra
 * avaliar ainda, não é erro — mesmo espírito do #4740/#4750: task agendada
 * que roda antes da 1ª dependência existir não deve virar alarme de
 * infraestrutura). Exatamente 1 snapshot → estabelece `knownChannels` sem
 * comparação (sem "semana anterior" pra comparar).
 *
 * Snapshot MAIS RECENTE ausente/incompleto (#5281): diferente do fail-soft
 * acima, isso NÃO é "nada pra avaliar ainda" — é uma falha real do backup
 * que merece barulho. `isSubscribersSnapshotUsable` (`beehiiv-backup-
 * snapshots.ts`) checa `manifest.json` (status `error`/`skipped` do endpoint
 * `subscribers`) e o conteúdo de fato de `subscribers.jsonl`; se
 * inutilizável, o script emite `console.warn` explícito e retorna **sem**
 * avançar `lastCheckedSnapshotDate` — avançar mascararia a falha como
 * "avaliado: limpo" e a próxima rodada (mesmo snapshot ainda quebrado)
 * ficaria presa no guard de idempotência achando que já foi checado.
 *
 * Estado (idempotência + baseline de canais conhecidos):
 *   `data/acquisition-health/state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { listSnapshotDates, readSnapshotSubscribers, isSubscribersSnapshotUsable } from "./lib/beehiiv-backup-snapshots.ts";
import {
  computeChannelStats,
  snapshotDateToEpochSeconds,
  detectAcquisitionHealthFindings,
  computeFindingsFingerprint,
  buildNextKnownChannels,
  buildAcquisitionHealthEmail,
  emptyAcquisitionHealthState,
  type AcquisitionHealthState,
} from "./lib/acquisition-health.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const DEFAULT_STATE_PATH = resolve(ROOT, "data/acquisition-health/state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[check-acquisition-health]";

export function loadState(statePath: string): AcquisitionHealthState {
  if (!existsSync(statePath)) return emptyAcquisitionHealthState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<AcquisitionHealthState>;
    return {
      knownChannels: Array.isArray(raw.knownChannels) ? raw.knownChannels : [],
      ctrBelowBaseStreak:
        raw.ctrBelowBaseStreak && typeof raw.ctrBelowBaseStreak === "object" ? raw.ctrBelowBaseStreak : {},
      lastCheckedAt: typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null,
      lastCheckedSnapshotDate: typeof raw.lastCheckedSnapshotDate === "string" ? raw.lastCheckedSnapshotDate : null,
      lastAlarmedFingerprint: typeof raw.lastAlarmedFingerprint === "string" ? raw.lastAlarmedFingerprint : null,
    };
  } catch {
    return emptyAcquisitionHealthState();
  }
}

export function saveState(state: AcquisitionHealthState, statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const root = getArg(argv, "root") || DEFAULT_BACKUP_ROOT;
  const statePath = getArg(argv, "state") || DEFAULT_STATE_PATH;

  const dates = listSnapshotDates(root); // ascendente
  if (dates.length === 0) {
    console.log(`${LOG_PREFIX} nenhum snapshot encontrado em ${root} — nada a avaliar ainda.`);
    return;
  }

  const state = loadState(statePath);
  const currentDate = dates[dates.length - 1];

  // Guard de idempotência por data só vale pra execução REAL — avança
  // `state.json` e não deve reavaliar o mesmo snapshot 2×. `--dry-run` NUNCA
  // toca o state (ver retorno mais abaixo), então precisa poder reinspecionar
  // os achados quantas vezes o operador quiser, mesmo com a semana já
  // processada (debug story de `docs/acquisition-health-alarm-setup.md`).
  if (!isDryRun && state.lastCheckedSnapshotDate === currentDate) {
    console.log(
      `${LOG_PREFIX} snapshot ${currentDate} já foi avaliado nesta rodada (idempotência por data) — nada a fazer.`,
    );
    return;
  }

  // Guard contra snapshot ausente/incompleto virando "avaliado: limpo" (#5281)
  // — checa ANTES de gastar qualquer cálculo, e retorna sem tocar o state
  // (nem em modo real: reavaliar o mesmo snapshot quebrado na próxima
  // rodada é o comportamento certo, não idempotência).
  const usability = isSubscribersSnapshotUsable(root, currentDate);
  if (!usability.usable) {
    console.warn(
      `${LOG_PREFIX} snapshot de ${currentDate} ausente ou incompleto (${usability.reason}) — ` +
        `alarme não pôde rodar, não marcado como avaliado.`,
    );
    return;
  }

  const previousDate = dates.length >= 2 ? dates[dates.length - 2] : null;
  const olderDate = dates.length >= 3 ? dates[dates.length - 3] : null;

  const currentSubs = readSnapshotSubscribers(root, currentDate);
  const previousSubs = previousDate ? readSnapshotSubscribers(root, previousDate) : null;

  const currentWindowSince = previousDate ? snapshotDateToEpochSeconds(previousDate) : null;
  const currentWindowUntil = previousDate ? snapshotDateToEpochSeconds(currentDate) : null;
  const currentStats = computeChannelStats(currentSubs, currentWindowSince, currentWindowUntil);

  let previousStats = null;
  if (previousSubs) {
    const prevWindowSince = olderDate ? snapshotDateToEpochSeconds(olderDate) : null;
    const prevWindowUntil = olderDate ? snapshotDateToEpochSeconds(previousDate as string) : null;
    previousStats = computeChannelStats(previousSubs, prevWindowSince, prevWindowUntil);
  }

  const { findings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(currentStats, previousStats, state);

  console.log(
    `${LOG_PREFIX} snapshot=${currentDate} canais=${currentStats.length} findings=${findings.length} ` +
      `(3 snapshots disponíveis: ${olderDate != null}).`,
  );
  for (const f of findings) {
    console.log(`${LOG_PREFIX}   [${f.type}] ${f.channel}: ${f.detail}`);
  }

  const fingerprint = findings.length > 0 ? computeFindingsFingerprint(findings) : null;
  const shouldSend = fingerprint != null && fingerprint !== state.lastAlarmedFingerprint;

  if (shouldSend) {
    const { subject, body } = buildAcquisitionHealthEmail(findings, currentDate);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else if (findings.length > 0) {
    console.log(`${LOG_PREFIX} findings inalterados desde o último alarme (mesmo fingerprint) — sem novo e-mail.`);
  } else {
    console.log(`${LOG_PREFIX} nenhum achado nesta rodada.`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: state NÃO avançado.`);
    return;
  }

  const nextState: AcquisitionHealthState = {
    knownChannels: buildNextKnownChannels(state, currentStats),
    ctrBelowBaseStreak: nextCtrBelowBaseStreak,
    lastCheckedAt: new Date().toISOString(),
    lastCheckedSnapshotDate: currentDate,
    // Sempre sincroniza com o fingerprint desta rodada (não só quando um
    // e-mail novo saiu) — `null` (sem findings) RE-ARMA o cursor, mesmo
    // padrão de `hub-drift-check.ts`: o drift sendo resolvido tira o canal
    // do conjunto pendente, e se ele voltar a aparecer depois, alarma de
    // novo em vez de ficar preso ao último fingerprint não-vazio.
    lastAlarmedFingerprint: fingerprint,
  };
  saveState(nextState, statePath);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
