#!/usr/bin/env node
import { alarmDelivery, alreadyAlarmed, emailPending, nextAlarmState, parseAlarmState } from "./lib/diaria/shorts-timer-alarm-state.ts";
/**
 * scripts/shorts-linkedin-profile-timer.ts (#10982)
 *
 * Passo do timer do `300` (`Diaria-Shorts-LinkedIn-Profile` e o `-Catchup`,
 * `scripts/lib/scheduled-tasks.ts`) que publica o vertical da edição do dia no
 * LinkedIn PESSOAL do editor sem tarefa manual por edição:
 *
 *   1. edição = hoje em BRT (o vertical sai no dia da própria edição);
 *   2. sem `02-reviewed.md` (fim de semana, feriado), `linkedin_profile` já
 *      registrado em `_internal/06-shorts-published.json` (ou no registro do
 *      próprio timer / numa cópia de conflito do OneDrive, #11157), ou o destino
 *      desligado no config (`linkedin_profile` / `linkedin_profile_via_timer`)
 *      → nada a fazer, exit 0;
 *   3. vertical fora do disco → `fetch-drive-video.ts --orientation vertical`
 *      acha o id no Drive (decisão do editor 23/10/2026: o editor salva no
 *      Drive e o 300 baixa sozinho) e o download vai pelo `--from-drive` do
 *      `publish-shorts.ts`. Nenhum vertical "final" ainda → exit 0 (a próxima
 *      execução tenta de novo); dois candidatos → exit 0 com aviso (quem
 *      escolhe é o editor, no `/diaria-shorts`). #11618: as duas esperas
 *      alarmam o editor (`linkedinAlarm`, issue + e-mail `urgente`, uma vez por
 *      motivo e edição, `_internal/.shorts-linkedin-timer-alarm.json`) quando
 *      o dia teve vídeo (a pasta `{AAMMDD}/` existe no Drive, ou outro destino
 *      já está no registro): sem vertical 1 h depois do horário do vertical
 *      (`missing-video`), ou candidatos ambíguos a partir do horário
 *      (`drive-needs-editor`). Antes disso o timer saía em silêncio e o post
 *      do dia não saía sem ninguém saber (29/10/2026);
 *   4. `publish-shorts.ts AAMMDD --only linkedin_profile --publish
 *      --linkedin-timer`. O horário é o do vertical (#10831): antes dele o
 *      destino fica `pending_schedule` (nada sai), depois dele publica, e
 *      passadas 3 h vira `skip_late` (nunca publica fora da janela do teste).
 *      Sem `--now` de propósito: o horário do vertical alterna por dia, e a
 *      task das :31/hora cheia cobre os três;
 *   5. #11631: `interpretLinkedinTimerOutput` (puro, tipado contra o
 *      `ShortsPlanItem`) lê o JSON do publish-shorts e alarma pelo mesmo
 *      `linkedinAlarm` quando o editor precisa agir: `skip_late`, falha de
 *      publicação, credencial, envio ambíguo, post sem registro, saída
 *      ilegível (os mesmos motivos dos timers do Threads e do Instagram).
 *      Antes só o exit code era lido e esses casos terminavam sem aviso.
 *
 * Lock O_EXCL em `_internal/.shorts-linkedin-timer.lock` (lock com mais de
 * 90 min é tratado como resto de um processo morto): a task diária e a de
 * hora em hora nunca publicam juntas. Antes de baixar do Drive, recua se o
 * timer do Threads pessoal (que baixa o mesmo vertical) está no meio de uma
 * execução ou se há `.part` fresco (#11432).
 *
 * Uso: npx tsx scripts/shorts-linkedin-profile-timer.ts [--edition AAMMDD] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem rodar nenhum.
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (Drive,
 * publish, alarme não entregue); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor, type NotifyEditorDeps, type NotifySeverity } from "./lib/editor-notify.ts";
import { aammddBrt, MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import {
  SHORTS_PUBLISHED_FILE,
  loadShortScheduleConfig,
  loadShortsConfig,
  parseShortsPublishedFile,
  resolveShortTime,
  shortVideoFileName,
} from "./lib/diaria/short-video.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";
import {
  SHORTS_LINKEDIN_TIMER_LOCK_FILE,
  SHORTS_THREADS_TIMER_LOCK_FILE,
  SHORTS_TIMER_LOCK_STALE_MS,
  verticalDownloadBusy,
} from "./lib/diaria/vertical-download-guard.ts";
// Só tipo: importar o publish-shorts em runtime carregaria o .env no import.
import type { ShortsPlanItem } from "./publish-shorts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TIMER_LOCK_FILE = SHORTS_LINKEDIN_TIMER_LOCK_FILE;
export const TIMER_LOCK_STALE_MS = SHORTS_TIMER_LOCK_STALE_MS;

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * #11432: o timer do Threads pessoal (#11410) baixa o MESMO vertical. Com o
 * `.part` fresco ou o lock dele de pé, este timer recua (exit 0, tenta na
 * próxima execução) em vez de rodar `--from-drive` por cima do download do
 * outro. Devolve o motivo, ou null. Lê só mtimes do disco.
 */
export function linkedinVerticalDownloadBusy(dir: string, videoPath: string, nowMs: number = Date.now()): string | null {
  return verticalDownloadBusy({
    partMtimeMs: mtimeOf(`${videoPath}.part`),
    otherLockMtimeMs: mtimeOf(join(dir, SHORTS_THREADS_TIMER_LOCK_FILE)),
    otherLabel: "Threads pessoal",
    otherLockFile: SHORTS_THREADS_TIMER_LOCK_FILE,
    nowMs,
  });
}

export type TimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "publish"; fromDrive: boolean };

/** Puro: o que fazer, antes de tocar no Drive. */
export function decideTimerRun(input: {
  config: unknown;
  reviewedExists: boolean;
  /** Conteúdo de `06-shorts-published.json`; null = ausente. */
  publishedRaw: string | null;
  /**
   * #11157: os outros arquivos do registro (o do próprio timer,
   * `06-shorts-published.linkedin-timer.json`, e cópias de conflito do
   * OneDrive). Entrada em qualquer um deles conta como registrada.
   */
  otherRegistryRaws?: ReadonlyArray<{ path: string; raw: string }>;
  aammdd: string;
  videoExists: boolean;
}): TimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.linkedinProfile) return { kind: "skip", reason: "publishing.shorts.linkedin_profile = false" };
  if (!cfg.linkedinProfileViaTimer) return { kind: "skip", reason: "publishing.shorts.linkedin_profile_via_timer = false (o /diaria-publica-video publica)" };
  if (!input.reviewedExists) return { kind: "skip", reason: `sem 02-reviewed.md da edição ${input.aammdd} (dia sem edição)` };
  const raws = [
    ...(input.publishedRaw !== null ? [{ path: SHORTS_PUBLISHED_FILE, raw: input.publishedRaw }] : []),
    ...(input.otherRegistryRaws ?? []),
  ];
  for (const { path, raw } of raws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o post).
    const file = parseShortsPublishedFile(raw, input.aammdd, path);
    const entry = file.entries.find((e) => e.destination === "linkedin_profile");
    if (entry) return { kind: "skip", reason: `linkedin_profile já registrado (${entry.status}${entry.url ? `, ${entry.url}` : ""}${path === SHORTS_PUBLISHED_FILE ? "" : ` em ${basename(path)}`})` };
  }
  return { kind: "publish", fromDrive: !input.videoExists };
}

export type DriveLookup =
  | { kind: "found"; fileId: string; name: string }
  | { kind: "exists" }
  /**
   * Espera: `why` diz o motivo (#11618) — sem vertical (`none`) ou o editor
   * precisa escolher (`needs-editor`). `editionFolderSeen`: a pasta
   * `{AAMMDD}/` existe no Drive, ou seja, o dia teve vídeo (é onde o bruto e
   * `Final/` moram); sem ela, dia sem vídeo, nada a avisar. `selection`
   * (#11628): o `selection` do `needs-editor` (ex.: `ambiguous-cover`, que é a
   * capa Still, não o vertical), para o alarme orientar o passo certo.
   * `videoSelection` (#11650): no `ambiguous-cover`, como ficou a escolha do
   * vertical (`found` = único); ausente = desconhecido.
   */
  | { kind: "wait"; reason: string; why: "none" | "needs-editor"; editionFolderSeen: boolean; selection?: string; videoSelection?: string }
  | { kind: "error"; reason: string };

/** Puro: lê a saída do `fetch-drive-video.ts --orientation vertical`. */
export function interpretDriveLookup(exitCode: number | null, stdout: string): DriveLookup {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "error", reason: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = out?.action;
  if (action === "print-id" && typeof out.file?.id === "string" && out.file.id) return { kind: "found", fileId: out.file.id, name: String(out.file.name ?? "") };
  if (action === "exists") return { kind: "exists" };
  const editionFolderSeen = typeof out?.edition_folder_id === "string" && out.edition_folder_id.length > 0;
  if (action === "none") {
    return { kind: "wait", why: "none", editionFolderSeen, reason: `nenhum vertical "final" no Drive ainda (${out.reason ?? "sem motivo"})` };
  }
  if (action === "needs-editor") {
    // `duplicate-edition-folder` não traz `edition_folder_id`, mas é o Drive com DUAS pastas da edição: o dia teve vídeo.
    return {
      kind: "wait",
      why: "needs-editor",
      editionFolderSeen: editionFolderSeen || out.selection === "duplicate-edition-folder",
      ...(typeof out.selection === "string" ? { selection: out.selection } : {}),
      ...(typeof out.video_selection === "string" ? { videoSelection: out.video_selection } : {}),
      reason: `o Drive tem mais de um candidato (${out.selection}) — o editor escolhe no /diaria-publica-video (Passo B1); o timer não escolhe`,
    };
  }
  return { kind: "error", reason: `fetch-drive-video.ts: ${action ?? "sem action"} (exit ${exitCode})${out?.error ? ` — ${out.error}` : ""}` };
}

/** Lock O_EXCL; devolve o release, ou null se outra execução está no meio. */
export function acquireTimerLock(path: string, now: number = Date.now()): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const tryOpen = () => {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (!tryOpen()) {
    let age = 0;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      age = 0;
    }
    if (age <= TIMER_LOCK_STALE_MS) return null;
    rmSync(path, { force: true });
    if (!tryOpen()) return null;
  }
  return () => rmSync(path, { force: true });
}

/** Motivos já avisados ao editor nesta edição (não repete o mesmo a cada hora, #11618). */
export const LINKEDIN_TIMER_ALARM_STATE_FILE = "_internal/.shorts-linkedin-timer-alarm.json";
/** Sem vertical 1 h depois do horário, num dia que teve vídeo: alarma (o mesmo prazo do Threads e do Instagram). */
export const LINKEDIN_MISSING_VIDEO_ALARM_AFTER_MS = 60 * 60_000;

/**
 * Motivo do alarme (#11618, #11631) — chave estável (fingerprint
 * `{AAMMDD}:{motivo}` e dedup). Os de espera do Drive (#11618) e os da
 * rodada do publish-shorts (#11631, mesmos motivos dos timers do Threads e do
 * Instagram): `late` (`skip_late`, passou de 3 h do horário), falha de
 * publicação, credencial, envio ambíguo, publicado sem registro, saída ilegível.
 */
export type LinkedinTimerAlarmKey =
  | "missing-video"
  | "drive-needs-editor"
  | "late"
  | "publish-failed"
  | "credentials"
  /** Envio ambíguo (`send_unknown`): o post pode estar no ar. */
  | "send-unknown"
  /** O post está no perfil, mas o registro não foi gravado. */
  | "published-unregistered"
  | "no-output";

/** O post pode estar (ou está) no ar: `acao`, e o corpo nunca manda publicar (#11631). */
const LINKEDIN_MAYBE_PUBLISHED_KEYS: ReadonlySet<LinkedinTimerAlarmKey> = new Set(["send-unknown", "published-unregistered"]);

/** Puro (#11631): severidade do alarme — `urgente` quando o post do dia não saiu, `acao` quando pode estar no ar. */
export function linkedinAlarmSeverity(key: LinkedinTimerAlarmKey): NotifySeverity {
  return LINKEDIN_MAYBE_PUBLISHED_KEYS.has(key) ? "acao" : "urgente";
}

export type LinkedinTimerOutcome =
  | { kind: "done"; detail: string }
  | { kind: "wait"; detail: string }
  /** `failed`: sai exit 1 (unit `failed`) além do alarme. */
  | { kind: "alarm"; key: LinkedinTimerAlarmKey; detail: string; failed: boolean };

type PlanAction = ShortsPlanItem["action"];

const LATE_FALLBACK_REASON = "passou do teto de 3 h depois do horário do vertical";

/**
 * Puro (#11651): do `detail` do `skip_late` fica só o atraso
 * (`08:00 BRT passou há 200 min (teto 3 h)`). O resto foi escrito para o agente
 * da skill e oferece um comando que não publica quando o timer é o dono.
 */
export function lateReason(detail: string): string {
  const head = detail.split(" — ")[0].trim();
  if (!head || /agente|--only|--publish|--now|--mark/.test(head)) return LATE_FALLBACK_REASON;
  return head;
}

/**
 * Puro (#11631): lê a saída do `publish-shorts.ts --only linkedin_profile
 * --publish --linkedin-timer`. Antes o timer só olhava o exit code: `skip_late`
 * (exit 0) e falha de publicação (exit 1) terminavam sem aviso ao editor.
 */
export function interpretLinkedinTimerOutput(exitCode: number | null, stdout: string): LinkedinTimerOutcome {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "alarm", key: "no-output", failed: true, detail: `publish-shorts.ts sem JSON (exit ${exitCode})` };
  }
  const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === "linkedin_profile") : undefined;
  if (result) {
    const e = result.entry;
    const where = e ? (e.url ?? e.id) : "";
    if (result.ok && e) {
      if (e.status === "send_unknown") {
        return { kind: "alarm", key: "send-unknown", failed: false, detail: `envio ambíguo no LinkedIn pessoal (${e.id}): ${(result.warnings ?? []).join("; ") || "sem detalhe"}` };
      }
      return { kind: "done", detail: `${result.alreadyRegistered ? "já estava registrado" : "publicado"}: ${e.status} ${where}` };
    }
    if (e) {
      return { kind: "alarm", key: "published-unregistered", failed: true, detail: `o post ESTÁ no LinkedIn pessoal (${where}), mas o registro não foi gravado: ${result.error ?? "?"}` };
    }
    return { kind: "alarm", key: "publish-failed", failed: true, detail: String(result.error ?? "falha sem mensagem") };
  }
  const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === "linkedin_profile") : undefined;
  if (!item) return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano sem o destino linkedin_profile (exit ${exitCode})` };
  const detail = String(item.detail ?? "");
  const action = item.action as PlanAction;
  switch (action) {
    case "skip_done":
      return { kind: "done", detail: "já registrado" };
    case "pending_schedule":
      return { kind: "wait", detail: detail || "antes do horário" };
    case "skip_late":
      // #11651: o `detail` do planner foi escrito para o agente da skill
      // ("O agente publica com --only linkedin_profile --publish --now …"), e
      // esse comando cai em skip_delegated com o timer dono do destino. O
      // alarme leva só o atraso; o remédio certo está no corpo do alarme.
      return { kind: "alarm", key: "late", failed: false, detail: lateReason(detail) };
    case "skip_missing_credentials":
      return { kind: "alarm", key: "credentials", failed: true, detail: `sem credencial do LinkedIn pessoal no 300: ${detail}` };
    case "skip_invalid":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `texto/plano inválido: ${detail}` };
    case "skip_delegated":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `a rodada do timer recebeu skip_delegated (config mudou?): ${detail}` };
    case "publish":
    case "enqueue":
    case "buffer":
    case "guided":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano com ${action} e sem resultado do linkedin_profile (exit ${exitCode})` };
    default: {
      const unknown: never = action;
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `ação inesperada do plano: ${String(unknown)} (exit ${exitCode})` };
    }
  }
}

/**
 * Puro (#11631): o alarme já está coberto pelo estado da edição? O mesmo motivo
 * não repete (salvo com e-mail pendente: aí reenvia), e `late` não sai depois
 * de um motivo que diz "o post pode estar no ar" — o corpo do `late` manda postar à mão.
 */
export function linkedinAlarmSuppressed(stateRaw: string | null, key: LinkedinTimerAlarmKey): boolean {
  const state = parseAlarmState(stateRaw);
  const seen = [...state.alarmed, ...state.emailPending];
  if (key === "late" && [...LINKEDIN_MAYBE_PUBLISHED_KEYS].some((k) => seen.includes(k))) return true;
  if (state.emailPending.includes(key)) return false;
  return state.alarmed.includes(key);
}

/** Puro: horário do vertical da edição (`resolveShortTime`), como instante ISO e `HH:MM` BRT. */
export function linkedinVerticalTime(config: unknown, aammdd: string): { at: string; hhmm: string } {
  const { hhmm } = resolveShortTime(loadShortScheduleConfig(config), aammdd);
  return { at: resolveEditionScheduledAt(aammdd, hhmm), hhmm };
}

/**
 * Puro (#11618): a espera do Drive vira alarme? Só num dia que teve vídeo
 * (`videoSeen`: a pasta da edição no Drive ou outro destino registrado) — dia
 * sem vídeo não avisa (a Etapa 5 segue sem). Ambíguo: a partir do horário do
 * vertical (o editor precisa escolher). Sem vertical: 1 h depois do horário
 * (o export pode estar subindo). Antes disso, null: espera calada.
 */
export function linkedinWaitAlarm(input: { why: "none" | "needs-editor"; videoSeen: boolean; now: Date; at: string }): LinkedinTimerAlarmKey | null {
  if (!input.videoSeen) return null;
  const deltaMs = input.now.getTime() - Date.parse(input.at);
  if (input.why === "needs-editor") return deltaMs >= 0 ? "drive-needs-editor" : null;
  return deltaMs >= LINKEDIN_MISSING_VIDEO_ALARM_AFTER_MS ? "missing-video" : null;
}

/** Puro: `HH:MM` BRT de um instante. */
function hhmmBrt(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Puro: corpo do alarme, com os comandos já com a edição. */
export function buildLinkedinTimerAlarm(input: {
  aammdd: string;
  key: LinkedinTimerAlarmKey;
  reason: string;
  at: string;
  selection?: string;
  /** #11650: escolha do vertical no `ambiguous-cover`; só `found` permite dizer "o vertical já é único". */
  videoSelection?: string;
}): { subject: string; body: string } {
  const { aammdd, key, reason, at, selection, videoSelection } = input;
  const deadline = hhmmBrt(Date.parse(at) + MAX_FIRE_LATENESS_MS);
  const mark = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --mark linkedin_profile=URL\``;
  // #11651: com `linkedin_profile_via_timer` (o único caso em que o timer roda),
  // só a rodada `--linkedin-timer` publica o destino; o `/diaria-publica-video`
  // e o comando sem a flag caem em skip_delegated. `--now` passa do teto de 3 h.
  const publishNow = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --only linkedin_profile --publish --linkedin-timer --now\``;
  const lines = [
    "Achado automático da task `Diaria-Shorts-LinkedIn-Profile`",
    "(`scripts/shorts-linkedin-profile-timer.ts`, #10982/#11618/#11631).",
    "",
    `Motivo (${key}): ${reason}`,
    "",
  ];
  if (LINKEDIN_MAYBE_PUBLISHED_KEYS.has(key)) {
    // #11631: nunca sugerir publicar — o post pode estar no perfil.
    lines.push(
      "Confira o LinkedIn pessoal antes de qualquer coisa; NÃO reposte sem conferir.",
      `- Se o vertical da edição está lá: registre com ${mark}.`,
      "- Se não está: poste à mão e registre com o mesmo comando.",
    );
    return { subject: `[diar.ia.br] Vertical no LinkedIn pessoal de ${aammdd}: conferir o perfil (${key})`, body: lines.join("\n") };
  }
  if (key === "late") {
    lines.push("Passadas 3 h do horário do vertical o timer NÃO publica mais sozinho (`skip_late`).");
  } else if (key === "credentials") {
    lines.push(`Confira \`LINKEDIN_PERSONAL_*\` no \`.env\` do 300. O timer volta a tentar de hora em hora até ${deadline} BRT; resolvida a causa, não precisa fazer nada.`);
  } else if (key === "publish-failed" || key === "no-output") {
    lines.push(`A publicação pelo \`publish-shorts.ts\` falhou. O timer volta a tentar de hora em hora até ${deadline} BRT (3 h depois do horário do vertical); se a próxima execução publicar, não precisa fazer nada.`);
  } else if (key === "missing-video") {
    lines.push(`O vertical "Outras redes" não está no disco do 300 nem em \`${aammdd}/Final/\` no Drive. Salve-o lá; a próxima execução (de hora em hora) baixa e publica até ${deadline} BRT (3 h depois do horário do vertical).`);
  } else if (selection === "ambiguous-cover") {
    // #11628: o que trava o download é a capa Still (que o LinkedIn nem usa).
    // #11650: "o vertical já é único" só quando o fetch apurou a escolha como única.
    const coverFix = `há mais de uma capa Still em \`${aammdd}/Final/\` (ou \`Editados/\`) no Drive. Deixe uma só capa Still lá; a próxima execução publica até ${deadline} BRT.`;
    lines.push(
      videoSelection === "found"
        ? `O vertical já é único; o bloqueio é a capa: ${coverFix}`
        : `O bloqueio agora é a capa: ${coverFix} A escolha do vertical ainda não está resolvida (${videoSelection ?? "não informada"}): confira também que há um só vertical "final" em \`${aammdd}/Final/\`.`,
    );
  } else {
    lines.push(`Deixe um só vertical "final" em \`${aammdd}/Final/\` no Drive (ou escolha no Passo B1 do \`/diaria-publica-video\`); a próxima execução publica até ${deadline} BRT.`);
  }
  lines.push(
    "",
    key === "late" ? "O que fazer:" : "Depois desse horário o timer não publica mais sozinho. O que fazer então:",
    `- Postar o vertical à mão no LinkedIn pessoal e registrar com ${mark}.`,
    `- Ou, no 300 (onde o vertical está no disco), publicar fora da janela com ${publishNow}. O \`/diaria-publica-video\` não serve aqui: com o timer dono do LinkedIn pessoal ele devolve \`skip_delegated\` e não publica.`,
  );
  return { subject: `[diar.ia.br] Vertical no LinkedIn pessoal de ${aammdd} não saiu pelo timer do 300 (${key})`, body: lines.join("\n") };
}

/**
 * Abre (ou reaproveita) a issue do alarme, manda o e-mail (`urgente`: o post
 * do dia não saiu) e grava o estado. Mesmas regras de estado dos timers do
 * Instagram e do Threads: entregue não repete; e-mail pendente é reenviado.
 */
export async function linkedinAlarm(
  dir: string,
  aammdd: string,
  key: LinkedinTimerAlarmKey,
  reason: string,
  at: string,
  notifyDeps: NotifyEditorDeps = { cwd: ROOT },
  drive: { selection?: string; videoSelection?: string } = {},
): Promise<boolean> {
  const statePath = join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  if (linkedinAlarmSuppressed(stateRaw, key)) {
    console.log(`[shorts-linkedin-timer] ${aammdd}: alarme "${key}" já coberto nesta edição${key === "late" && !alreadyAlarmed(stateRaw, key) ? " (por um motivo que diz que o post pode estar no ar)" : ""} — não repete`);
    return true;
  }
  const { subject, body } = buildLinkedinTimerAlarm({ aammdd, key, reason, at, ...drive });
  const res = await notifyEditor(
    { check: "shorts-linkedin-timer", fingerprint: `${aammdd}:${key}`, severity: linkedinAlarmSeverity(key), family: "evento", subject, body, forceEmail: emailPending(stateRaw, key) },
    notifyDeps,
  );
  const delivery = alarmDelivery(res);
  const next = nextAlarmState(stateRaw, aammdd, key, delivery);
  if (next !== null) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileAtomic(statePath, next);
  }
  if (delivery.kind !== "delivered") {
    console.error(`[shorts-linkedin-timer] ${aammdd}: alarme "${key}" NÃO entregue — ${delivery.error}; tenta de novo na próxima execução`);
    return false;
  }
  console.log(`[shorts-linkedin-timer] ${aammdd}: alarme "${key}" ${res.issue?.action ?? "registrado"}${res.issue?.url ? ` ${res.issue.url}` : ""}${res.emailSent ? " (e-mail enviado)" : ""}`);
  return true;
}

function runTsx(args: string[], capture: boolean): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: capture ? (r.stdout ?? "") : "" };
}

/** I/O da execução, injetável nos testes (#11618). */
export interface LinkedinTimerRunDeps {
  config: unknown;
  now: Date;
  /** Roda `npx tsx <args>`; `capture` devolve o stdout (o fetch-drive-video). */
  runScript: (args: string[], capture: boolean) => { status: number | null; stdout: string };
  notify: NotifyEditorDeps;
}

function defaultRunDeps(): LinkedinTimerRunDeps {
  return { config: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")), now: new Date(), runScript: runTsx, notify: { cwd: ROOT } };
}

export async function runLinkedinTimer(aammdd: string, dir: string, dryRun: boolean, deps: LinkedinTimerRunDeps = defaultRunDeps()): Promise<number> {
  const { config, now } = deps;
  const publishedPath = join(dir, SHORTS_PUBLISHED_FILE);
  const videoPath = join(dir, shortVideoFileName(aammdd));
  const publishedRaw = existsSync(publishedPath) ? readFileSync(publishedPath, "utf8") : null;
  const otherRegistryRaws = readShortsRegistryRaws(dir).filter((r) => r.path !== publishedPath);
  const decision = decideTimerRun({
    config,
    reviewedExists: existsSync(join(dir, "02-reviewed.md")),
    publishedRaw,
    otherRegistryRaws,
    aammdd,
    videoExists: existsSync(videoPath),
  });
  if (decision.kind === "skip") {
    console.log(`[shorts-linkedin-timer] ${aammdd}: nada a fazer — ${decision.reason}`);
    return 0;
  }

  const release = dryRun ? () => {} : acquireTimerLock(join(dir, TIMER_LOCK_FILE), now.getTime());
  if (!release) {
    console.log(`[shorts-linkedin-timer] ${aammdd}: outra execução está no meio (${TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  try {
    const publishArgs = ["scripts/publish-shorts.ts", aammdd, "--only", "linkedin_profile", "--publish", "--linkedin-timer"];
    if (decision.fromDrive) {
      const busy = linkedinVerticalDownloadBusy(dir, videoPath);
      if (busy) {
        console.log(`[shorts-linkedin-timer] ${aammdd}: ${busy} — tenta de novo na próxima execução`);
        return 0;
      }
      const fetchArgs = ["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", "--edition-dir", dir];
      const r = deps.runScript(fetchArgs, true);
      const lookup = interpretDriveLookup(r.status, r.stdout);
      if (lookup.kind === "wait") {
        console.log(`[shorts-linkedin-timer] ${aammdd}: ${lookup.reason} — tenta de novo na próxima execução`);
        if (dryRun) return 0;
        // #11618: a espera calada deixava o post do dia sem sair e sem ninguém saber.
        const registrySeen = [...(publishedRaw !== null ? [{ path: publishedPath, raw: publishedRaw }] : []), ...otherRegistryRaws].some(
          ({ path, raw }) => parseShortsPublishedFile(raw, aammdd, path).entries.length > 0,
        );
        const { at } = linkedinVerticalTime(config, aammdd);
        const key = linkedinWaitAlarm({ why: lookup.why, videoSeen: lookup.editionFolderSeen || registrySeen, now, at });
        if (key === null) return 0;
        return (await linkedinAlarm(dir, aammdd, key, lookup.reason, at, deps.notify, { selection: lookup.selection, videoSelection: lookup.videoSelection })) ? 0 : 1;
      }
      if (lookup.kind === "error") {
        console.error(`[shorts-linkedin-timer] ${aammdd}: ${lookup.reason}`);
        return 1;
      }
      if (lookup.kind === "found") {
        console.log(`[shorts-linkedin-timer] ${aammdd}: vertical no Drive: ${lookup.name} (${lookup.fileId})`);
        publishArgs.push("--from-drive", lookup.fileId);
      }
    }
    if (dryRun) {
      console.log(`[shorts-linkedin-timer] dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    // #11631: o stdout (JSON do publish-shorts) é lido para alarmar skip_late e falha, como nos timers do Threads e do Instagram.
    const r = deps.runScript(publishArgs, true);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const outcome = interpretLinkedinTimerOutput(r.status, r.stdout);
    console.log(`[shorts-linkedin-timer] ${aammdd}: ${outcome.kind}${outcome.kind === "alarm" ? ` (${outcome.key})` : ""} — ${outcome.detail}`);
    if (outcome.kind !== "alarm") return r.status === 0 ? 0 : 1;
    const { at } = linkedinVerticalTime(config, aammdd);
    const alarmed = await linkedinAlarm(dir, aammdd, outcome.key, outcome.detail, at, deps.notify);
    return outcome.failed || !alarmed ? 1 : 0;
  } finally {
    release();
  }
}

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? aammddBrt(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error("uso: shorts-linkedin-profile-timer.ts [--edition AAMMDD] [--dry-run]");
    return 2;
  }
  return runLinkedinTimer(aammdd, editionDirFor(aammdd), flags.has("dry-run"));
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-linkedin-profile-timer:", e instanceof Error ? e.message : e) });
}
