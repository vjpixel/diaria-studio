#!/usr/bin/env node
import { alarmDelivery, alreadyAlarmed, emailPending, nextAlarmState, parseAlarmState } from "./lib/diaria/shorts-timer-alarm-state.ts";
/**
 * scripts/shorts-instagram-timer.ts (#11265, #10940)
 *
 * Passo do timer do `300` (`Diaria-Shorts-Instagram` e o `-Catchup`,
 * `scripts/lib/scheduled-tasks.ts`) que publica o Reels do vertical no
 * Instagram no horário do vertical, sem tarefa manual por edição e sem URL
 * pública: o Instagram não agenda Reels pela API, então alguém precisa rodar
 * o `--publish` depois do horário (decisão do editor 27/10/2026: timer no
 * 300; o túnel #11307 caiu pelo risco de ToS da Cloudflare e o R2 ainda não
 * estava habilitado. Ele foi habilitado depois, em 27/10/2026, #10772, e o
 * editor manteve o timer, #11411).
 *
 *   1. edição = hoje em BRT (o vertical sai no dia da própria edição);
 *   2. `decideInstagramTimerRun` (puro): Instagram desligado, backend que não
 *      é `timer-300`, dia sem `02-reviewed.md` ou `instagram` já registrado
 *      em qualquer arquivo do registro (inclusive `send_unknown` e as cópias
 *      de conflito do OneDrive) → nada a fazer; antes do horário do vertical
 *      (`resolveShortTime` — com `timer-300` o plano do publish-shorts usa o
 *      MESMO horário pro Instagram, fora da grade, `instagramTimerSlot`) →
 *      espera; até 3 h depois → publica; depois → não publica, e alarma só se
 *      o dia teve vertical (`videoSeen`);
 *   3. o vídeo (`chooseInstagramVideo`): o Drive é SEMPRE consultado pelo
 *      vertical único da pasta `Final/` (fallback: `_Outras redes_`, `_Instagram_`) (#11222, `fetch-drive-video.ts
 *      --target instagram`); o corte vai pra
 *      `diaria-comentada-{AAMMDD}-short-instagram.mp4` e é rebaixado quando
 *      o id ou o `modifiedTime` mudam (`_internal/.shorts-instagram-cut.json`).
 *      Drive ambíguo (`needs-editor`) espera e alarma (proporção ainda
 *      desconhecida no Drive: espera, e só alarma 1 h depois), nunca cai no genérico;
 *      o vertical genérico só entra quando o Drive diz que NÃO há corte, e só
 *      se já estiver no disco (quem o baixa é o timer do LinkedIn);
 *   4. `publish-shorts.ts AAMMDD --only instagram --publish --instagram-timer
 *      --video P [--from-drive ID]`. A rodada do timer confere a conta antes
 *      de publicar (`instagramTimerGate`) e grava no registro próprio (#11157);
 *   5. `interpretInstagramTimerOutput` (puro, tipado contra o `ShortsPlanItem`)
 *      lê o JSON do publish-shorts e, quando o editor precisa agir, abre um
 *      alarme por MOTIVO (`InstagramTimerAlarmKey`, fingerprint
 *      `{AAMMDD}:{motivo}`, família `evento`; `urgente` quando o Reels não saiu
 *      no dia, então o e-mail sai mesmo com `email_policy: urgent_only`). O
 *      mesmo motivo não repete a cada hora (`_internal/.shorts-instagram-timer-alarm.json`);
 *      e-mail devido que não saiu fica pendente ali e é reenviado na execução
 *      seguinte (`forceEmail`), mesmo com a issue já aberta.
 *
 * #11368: motivos que juntam causas (`publish-failed`, `crash`, `no-output`,
 * `drive-error`) deduplicam por motivo + hash curto da causa (`alarmId`); aviso
 * do publish (collab descartado) vira alarme `acao`; corte do disco que sumiu
 * do Drive não é reaproveitado; o publish recebe `--now` (o timer já decidiu
 * dentro da janela); depois do teto o Drive é consultado uma vez por edição
 * (`INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE`); erro do Drive nunca vira "dia sem
 * vertical". I/O injetável em `runInstagramTimer` (testes de ponta a ponta).
 *
 * #11389: vertical acima do teto de duração da API na conta autora
 * (`instagram_api_max_seconds_by_account`, #10916) é limite CONHECIDO, não
 * falha: o Reels sai pelo Chrome (Passo B3b, @vjpixel autor com a @diar.ia.br
 * em collab, #11390). O timer manda um lembrete (`guided`, uma vez por
 * edição) já antes do horário quando o corte do Instagram está no disco, e
 * depois do teto de 3 h troca o `late` pelo mesmo lembrete
 * (`instagramOverApiCap`). Cortar uma versão ≤ teto (opção b da issue) fica
 * de fora: muda o conteúdo e é decisão editorial.
 *
 * Lock O_EXCL em `_internal/.shorts-instagram-timer.lock` (o mesmo
 * `acquireTimerLock` do timer do LinkedIn): a task diária e a de hora em hora
 * nunca publicam juntas.
 *
 * Fica de fora (premissa registrada na #11265): X (Buffer) e Threads pessoal
 * recebem o vídeo só por URL pública; saem pelo `/diaria-publica-video` com o
 * vertical no R2 (habilitado em 27/10/2026, #10772), e só numa máquina sem os
 * secrets do R2 ficam pulados com aviso e PENDENTES (#11478/#11498): o
 * `-short.mp4` fica no disco e uma máquina com os secrets publica.
 *
 * Uso: npx tsx scripts/shorts-instagram-timer.ts [--edition AAMMDD] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem publicar e sem alarme (lê o Drive).
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (Drive,
 * publish, alarme não aberto, exceção); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import {
  notifyEditor,
  type NotifyEditorDeps,
  type NotifySeverity,
} from "./lib/editor-notify.ts";
import { aammddBrt, MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import {
  INSTAGRAM_CHROME_ROUTE,
  instagramChromeRouteText,
  instagramReelsApiFit,
  loadInstagramApiMaxSeconds,
  loadShortScheduleConfig,
  loadShortsConfig,
  mp4DurationSeconds,
  parseShortsPublishedFile,
  resolveShortTime,
  shortInstagramVideoFileName,
  shortVideoFileName,
} from "./lib/diaria/short-video.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";
import { acquireTimerLock } from "./shorts-linkedin-profile-timer.ts";
// Só tipo: importar o publish-shorts em runtime carregaria o .env no import.
import type { ShortsPlanItem } from "./publish-shorts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[shorts-instagram-timer]";
export const INSTAGRAM_TIMER_LOCK_FILE = "_internal/.shorts-instagram-timer.lock";
/** Motivos já avisados ao editor nesta edição (não repete o mesmo a cada hora). */
export const INSTAGRAM_TIMER_ALARM_STATE_FILE = "_internal/.shorts-instagram-timer-alarm.json";
/** Id e `modifiedTime` do corte do Instagram baixado (rebaixa quando mudam). */
export const INSTAGRAM_CUT_SIDECAR_FILE = "_internal/.shorts-instagram-cut.json";
/** Sem vídeo para o Instagram 1 h depois do horário do vertical: alarma cedo, com o motivo real. */
export const MISSING_VIDEO_ALARM_AFTER_MS = 60 * 60_000;
/**
 * #11368: sem corte do Instagram, mas com o vertical genérico (`_Outras redes_`)
 * no Drive e ainda fora do disco — quem o baixa é o timer do LinkedIn. Dá mais
 * 1 h antes do e-mail urgente.
 */
export const GENERIC_PENDING_ALARM_AFTER_MS = 2 * 60 * 60_000;
/**
 * #11368: depois de `horário + 3 h`, num dia sem vertical no disco, o Drive é
 * consultado UMA vez por edição; a resposta "sem vertical" fica aqui e as
 * execuções seguintes (de hora em hora) não voltam ao Drive.
 */
export const INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE = "_internal/.shorts-instagram-timer-late-drive.json";

/**
 * Motivo do alarme — chave estável (vira o fingerprint `{AAMMDD}:{motivo}` e a
 * dedup local), nunca texto variável.
 */
export type InstagramTimerAlarmKey =
  | "late"
  | "guided"
  | "missing-video"
  | "drive-needs-editor"
  | "drive-error"
  | "credentials"
  | "publish-failed"
  | "published-unregistered"
  | "check-permalink"
  /** A conferência da conta não deixou publicar: pode já haver Reels da edição na conta. */
  | "preflight-blocked"
  /** A leitura da conta falhou (token expirado, 5xx no `/media`): o Reels não sai até a conta voltar a responder. */
  | "preflight-read-failed"
  /**
   * #11421: nada na conta da API, mas o perfil do @vjpixel (autor da rota do
   * Chrome, onde fica o Reels à mão com collab pendente) não pôde ser conferido
   * por falta da credencial da página: o timer não publica (fail-closed).
   */
  | "author-unchecked"
  | "no-output"
  | "crash"
  /** #11368: o Reels saiu, mas o publish devolveu aviso (o Instagram descartou o convite de collab). */
  | "collab"
  /** #11368: o Drive não respondeu e o timer publicou o corte já baixado, sem conferir se ainda é o do Drive. */
  | "cut-unverified";

/** O Reels ainda está no ar? Esses avisam com `acao`; o resto é "não saiu hoje" (`urgente`). */
const PUBLISHED_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["published-unregistered", "check-permalink"]);

/**
 * Motivos em que publicar pela API resolve (o comando manual com `--publish`
 * só aparece nestes). Acima do teto (`guided`), sem credencial, sem vídeo ou
 * com o Drive ambíguo, a API não resolve.
 */
const API_OPTION_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["late", "publish-failed", "no-output", "crash"]);

/** Motivos em que a próxima execução (de hora em hora, até `horário + 3 h`) tenta de novo sozinha. */
const RETRY_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["publish-failed", "credentials", "no-output", "crash", "drive-error", "preflight-read-failed"]);

/**
 * Motivos que dizem "não reposte" (o Reels pode estar no ar): depois de um
 * deles, `late` não sai — o corpo dele manda publicar.
 */
const LATE_BLOCKER_KEYS: ReadonlyArray<InstagramTimerAlarmKey> = ["guided", "preflight-blocked", "author-unchecked", "published-unregistered", "check-permalink"];

/** O Reels saiu (ou pode ter saído) e o editor só confere: `acao`, nunca `urgente`. */
const ACAO_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["preflight-blocked", "author-unchecked", "collab", "cut-unverified"]);

export function alarmSeverity(key: InstagramTimerAlarmKey): NotifySeverity {
  return PUBLISHED_KEYS.has(key) || ACAO_KEYS.has(key) ? "acao" : "urgente";
}

/**
 * Motivos que juntam causas diferentes (#11368): a dedup deles leva também um
 * hash curto do detalhe, senão uma 2ª falha com OUTRA causa na mesma edição
 * (ex.: `ProcessingFailedError` depois de um erro transitório) não avisaria.
 */
const MULTI_CAUSE_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["publish-failed", "crash", "no-output", "drive-error"]);

/**
 * Puro (#11368): identidade do alarme na dedup local e no fingerprint
 * (`{AAMMDD}:{id}`). Motivo de causa única = a própria chave; motivo que junta
 * causas = `chave#hash8` da 1ª linha do detalhe, com dígitos normalizados (o
 * mesmo erro com outro exit code, request id ou minuto não vira alarme novo a
 * cada hora; a cauda do stderr do `no-output` fica fora do hash).
 */
export function alarmId(key: InstagramTimerAlarmKey, detail: string): string {
  if (!MULTI_CAUSE_KEYS.has(key)) return key;
  const firstLine = detail.split("\n")[0] ?? "";
  const norm = firstLine.toLowerCase().replace(/\d+/g, "0").replace(/\s+/g, " ").trim().slice(0, 200);
  return `${key}#${createHash("sha256").update(norm).digest("hex").slice(0, 8)}`;
}

/** Puro: a chave de um id do estado (`publish-failed#ab12cd34` → `publish-failed`). */
export function alarmKeyOf(id: string): string {
  return id.split("#")[0] ?? id;
}

/** Puro: `HH:MM` BRT de um instante ISO. */
function hhmmBrt(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Puro: `HH:MM` BRT do fim da janela do timer (`horário do vertical + 3 h`). */
export function instagramTimerDeadlineHhmm(at: string): string {
  return hhmmBrt(Date.parse(at) + MAX_FIRE_LATENESS_MS);
}

/**
 * Puro (#11389): o vídeo do Instagram já no disco passa do teto de duração da
 * API na conta autora (`publishing.shorts.instagram_api_max_seconds_by_account`,
 * #10916)? Mesma regra do plano do publish-shorts (`instagramReelsApiFit`):
 * duração ilegível ou teto desligado = cabe (a API decide). Acima do teto o
 * Reels sai pelo Chrome (Passo B3b) e o timer não tenta publicar nem manda
 * `late` por isso: manda um lembrete (`guided`), uma vez por edição.
 */
export function instagramOverApiCap(config: unknown, durationSeconds: number | null): { over: true; reason: string } | { over: false } {
  const cfg = loadShortsConfig(config);
  const label = cfg.instagramAuthorPage === null ? "da diar.ia.br (env)" : `vinculada à página ${cfg.instagramAuthorPage}`;
  const fit = instagramReelsApiFit(durationSeconds, loadInstagramApiMaxSeconds(config, cfg.instagramAuthorPage), label);
  return fit.fits ? { over: false } : { over: true, reason: fit.reason };
}

export type InstagramTimerDecision =
  /** `unseenLate`: passou de 3 h e só não alarma porque nada LOCAL mostra o vertical (o Drive ainda pode mostrar). */
  | { kind: "skip"; reason: string; unseenLate?: true }
  | { kind: "wait"; reason: string; at: string; hhmm: string }
  | { kind: "late"; reason: string; at: string; hhmm: string }
  | { kind: "publish"; at: string; hhmm: string };

/** Puro: o que fazer nesta execução, antes de tocar no Drive ou na API. */
export function decideInstagramTimerRun(input: {
  config: unknown;
  reviewedExists: boolean;
  /** Todos os arquivos do registro da edição (`readShortsRegistryRaws`). */
  registryRaws: ReadonlyArray<{ path: string; raw: string }>;
  aammdd: string;
  now: Date;
  /**
   * O dia teve vertical? (corte ou genérico no disco, corte já baixado, ou o
   * `/diaria-publica-video` já registrou outro destino; ou o Drive mostra o
   * vertical em `Final/`, `driveShowsVertical`). Sem isso, passar do horário
   * não alarma: a Etapa 5 pode seguir sem vídeo.
   */
  videoSeen: boolean;
}): InstagramTimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.instagram) return { kind: "skip", reason: "publishing.shorts.instagram = false" };
  if (cfg.instagramBackend !== "timer-300") {
    return { kind: "skip", reason: `publishing.shorts.instagram_backend = ${cfg.instagramBackend} (o timer só age com timer-300)` };
  }
  if (!input.reviewedExists) return { kind: "skip", reason: `sem 02-reviewed.md da edição ${input.aammdd} (dia sem edição)` };
  for (const { path, raw } of input.registryRaws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o Reels).
    const entry = parseShortsPublishedFile(raw, input.aammdd, path).entries.find((e) => e.destination === "instagram");
    if (entry) return { kind: "skip", reason: `instagram já registrado (${entry.status}${entry.url ? `, ${entry.url}` : ""} em ${basename(path)})` };
  }
  const { hhmm } = resolveShortTime(loadShortScheduleConfig(input.config), input.aammdd);
  const at = resolveEditionScheduledAt(input.aammdd, hhmm);
  const deltaMs = input.now.getTime() - Date.parse(at);
  if (deltaMs < 0) return { kind: "wait", reason: `antes do horário do vertical (${hhmm} BRT)`, at, hhmm };
  if (deltaMs > MAX_FIRE_LATENESS_MS) {
    if (!input.videoSeen) return { kind: "skip", reason: `${hhmm} BRT passou há mais de 3 h e o dia não teve vertical — nada a avisar`, unseenLate: true };
    return {
      kind: "late",
      at,
      hhmm,
      reason: `${hhmm} BRT passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e o Reels não está registrado`,
    };
  }
  return { kind: "publish", at, hhmm };
}

/** Puro: sem vídeo pro Instagram até `horário + 1 h`, num dia que teve vertical, alarma. */
export function shouldAlarmMissingVideo(now: Date, at: string, videoSeen: boolean): boolean {
  return videoSeen && now.getTime() - Date.parse(at) >= MISSING_VIDEO_ALARM_AFTER_MS;
}

export type InstagramCutLookup =
  | { kind: "found"; fileId: string; name: string; modifiedTime: string | null }
  /** O Drive diz que não há corte do Instagram (ou não tem nada a dizer sobre ele). */
  | { kind: "none"; reason: string }
  /**
   * Ambíguo, pasta duplicada: o editor escolhe (`immediate`: alarma já). Sem
   * proporção (`orientation-unknown`, o Drive ainda processando o metadado):
   * espera, e só alarma depois de `MISSING_VIDEO_ALARM_AFTER_MS`.
   */
  | { kind: "needs-editor"; reason: string; immediate: boolean }
  | { kind: "error"; reason: string };

/** Puro: o Drive mostra um vertical da edição em `Final/` (achado ou ambíguo)? */
export function driveShowsVertical(lookup: InstagramCutLookup): boolean {
  return lookup.kind === "found" || lookup.kind === "needs-editor";
}

/** Puro: lê a saída do `fetch-drive-video.ts --orientation vertical --target instagram`. */
export function interpretInstagramCutLookup(exitCode: number | null, stdout: string): InstagramCutLookup {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "error", reason: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = out?.action;
  if (action === "print-id" && typeof out.file?.id === "string" && out.file.id) {
    return { kind: "found", fileId: out.file.id, name: String(out.file.name ?? ""), modifiedTime: typeof out.file.modifiedTime === "string" ? out.file.modifiedTime : null };
  }
  if (action === "none") return { kind: "none", reason: `nenhum vertical no Drive (${out.reason ?? "sem motivo"})` };
  // `exists`/`already-published` não vêm com --target instagram (o corte não é
  // o arquivo local que o fetch confere); se vierem, não dizem nada do corte.
  if (action === "exists" || action === "already-published") return { kind: "none", reason: `fetch-drive-video.ts: ${action} (nada sobre o corte do Instagram)` };
  if (action === "needs-editor") {
    if (out.selection === "orientation-unknown") {
      return {
        kind: "needs-editor",
        immediate: false,
        reason: "o Drive ainda não mostra a proporção do vídeo final (metadado processando, orientation-unknown) — se continuar assim, confira o arquivo em Final/ (Passo B1 do /diaria-publica-video)",
      };
    }
    return {
      kind: "needs-editor",
      immediate: true,
      reason: `o Drive tem mais de um candidato ou um arquivo ambíguo (${out.selection ?? "?"}) — o editor escolhe (Passo B1 do /diaria-publica-video); o timer não escolhe`,
    };
  }
  return { kind: "error", reason: `fetch-drive-video.ts: ${action ?? "sem action"} (exit ${exitCode})${out?.error ? ` — ${out.error}` : ""}` };
}

export interface InstagramCutSidecar {
  fileId: string;
  modifiedTime: string | null;
}

export type InstagramVideoChoice =
  /**
   * `unverified`: o Drive não respondeu e o corte do disco vai sem conferência
   * (#11368); se o Reels sair, o timer avisa (`cut-unverified`).
   */
  | { kind: "use-local"; path: string; source: "instagram-cut" | "generic"; note?: string; unverified?: true }
  | { kind: "download"; path: string; fileId: string; name: string; modifiedTime: string | null }
  /** `alarmNow`: avisa já; senão só depois de `MISSING_VIDEO_ALARM_AFTER_MS` (`shouldAlarmMissingVideo`). */
  | { kind: "wait"; reason: string; alarm: "missing-video" | "drive-needs-editor"; alarmNow: boolean }
  | { kind: "error"; reason: string };

/**
 * Puro: qual arquivo o timer publica. O corte do Instagram vence (é o recorte
 * para o teto de duração dele, #11222) e é rebaixado quando o Drive mostra
 * outro id ou `modifiedTime`. O genérico só quando o Drive diz que não há
 * corte, e só se já estiver no disco. Ambíguo nunca cai no genérico.
 * Corte do disco que veio do Drive (sidecar com `fileId`) e sumiu de lá: o
 * editor apagou ou trocou o `_Instagram_`, e ele não é reaproveitado (#11368).
 */
export function chooseInstagramVideo(input: {
  instagramCutPath: string;
  instagramCutExists: boolean;
  /** O que foi baixado da última vez (`INSTAGRAM_CUT_SIDECAR_FILE`); null = desconhecido. */
  cutSidecar: InstagramCutSidecar | null;
  genericPath: string;
  genericExists: boolean;
  lookup: InstagramCutLookup;
}): InstagramVideoChoice {
  const { lookup } = input;
  switch (lookup.kind) {
    case "found": {
      const same = input.instagramCutExists && input.cutSidecar?.fileId === lookup.fileId && input.cutSidecar.modifiedTime === lookup.modifiedTime;
      if (same) return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut" };
      return { kind: "download", path: input.instagramCutPath, fileId: lookup.fileId, name: lookup.name, modifiedTime: lookup.modifiedTime };
    }
    case "needs-editor":
      return { kind: "wait", reason: lookup.reason, alarm: "drive-needs-editor", alarmNow: lookup.immediate };
    case "none": {
      // Sem sidecar o corte não veio do Drive pelo timer (posto à mão): segue valendo.
      const staleId = input.instagramCutExists && input.cutSidecar?.fileId ? input.cutSidecar.fileId : null;
      if (input.instagramCutExists && !staleId) return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut", note: `${lookup.reason}; usando o corte já baixado` };
      const stale = staleId ? `; o corte já baixado (${staleId}) não está mais no Drive e não é reaproveitado` : "";
      if (input.genericExists) return { kind: "use-local", path: input.genericPath, source: "generic", note: `${lookup.reason}${stale}` };
      return { kind: "wait", reason: `${lookup.reason}${stale} e sem o vertical genérico no disco`, alarm: "missing-video", alarmNow: false };
    }
    case "error":
      // Fail-soft só com o corte já no disco; sem ele, nunca cai no genérico em silêncio.
      if (input.instagramCutExists) {
        return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut", note: `Drive indisponível (${lookup.reason}); usando o corte já baixado`, unverified: true };
      }
      return { kind: "error", reason: lookup.reason };
  }
}

export type InstagramTimerOutcome =
  | { kind: "done"; detail: string }
  | { kind: "wait"; detail: string }
  /** `failed`: sai exit 1 (unit `failed`) além do alarme. */
  | { kind: "alarm"; key: InstagramTimerAlarmKey; detail: string; failed: boolean };

type PlanAction = ShortsPlanItem["action"];

/** Puro: lê a saída do `publish-shorts.ts --only instagram --publish --instagram-timer`. */
export function interpretInstagramTimerOutput(exitCode: number | null, stdout: string, stderrTail = ""): InstagramTimerOutcome {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "alarm", key: "no-output", failed: true, detail: `publish-shorts.ts sem JSON (exit ${exitCode})${stderrTail ? `. Fim do stderr:\n${stderrTail}` : ""}` };
  }
  const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === "instagram") : undefined;
  if (result) {
    const e = result.entry;
    const where = e ? (e.url ?? e.id) : "";
    if (result.ok && e) {
      if (result.alreadyRegistered && result.matchedBy === "time-window") {
        return { kind: "alarm", key: "check-permalink", failed: false, detail: `Reels sem o marcador da edição achado só pelo horário e registrado (${where}) — confira o permalink` };
      }
      // #11368: aviso do publish (convite de collab descartado) não fica só no journal.
      const warnings: string[] = Array.isArray(result.warnings) ? result.warnings.filter((w: unknown): w is string => typeof w === "string" && w.length > 0) : [];
      if (!result.alreadyRegistered && warnings.length) {
        return { kind: "alarm", key: "collab", failed: false, detail: `Reels publicado (${e.status} ${where}) com aviso: ${warnings.join("; ")}` };
      }
      return { kind: "done", detail: `${result.alreadyRegistered ? "já estava na conta/registro" : "publicado"}: ${e.status} ${where}` };
    }
    if (e) {
      // Inclui o gate que ACHOU o Reels na conta e não conseguiu gravar (cause "preflight", persist-failed).
      return { kind: "alarm", key: "published-unregistered", failed: true, detail: `o Reels ESTÁ NO AR (${where}), mas o registro não foi gravado: ${result.error ?? "?"}. Não reposte; registre com --mark instagram=${e.url ?? "URL"}` };
    }
    if (result.cause === "preflight") {
      // A conferência da conta não deixou publicar: nunca "o publish falhou" (o corpo mandaria repostar).
      // `read-failed`: a conta não respondeu (credencial, 5xx) — urgente, o Reels não sai;
      // o resto (`blocked`, ou motivo desconhecido) pode ter Reels na conta.
      // `author-unchecked` (#11421): o perfil do @vjpixel não foi conferido (sem credencial) — pode ter o Reels à mão.
      const key: InstagramTimerAlarmKey =
        result.preflight === "read-failed" ? "preflight-read-failed" : result.preflight === "author-unchecked" ? "author-unchecked" : "preflight-blocked";
      return { kind: "alarm", key, failed: true, detail: `conferência da conta (${result.preflight ?? "?"}): ${result.error ?? "sem mensagem"}` };
    }
    return { kind: "alarm", key: "publish-failed", failed: true, detail: String(result.error ?? "falha sem mensagem") };
  }
  const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === "instagram") : undefined;
  if (!item) return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano sem o destino instagram (exit ${exitCode})` };
  const detail = String(item.detail ?? "");
  const action = item.action as PlanAction;
  switch (action) {
    case "skip_done":
      return { kind: "done", detail: "já registrado" };
    case "pending_schedule":
      return { kind: "wait", detail: detail || "antes do horário" };
    case "guided":
      return { kind: "alarm", key: "guided", failed: false, detail: `acima do teto de duração da API: ${detail || "passo guiado"}` };
    case "skip_late":
      return { kind: "alarm", key: "late", failed: false, detail };
    case "skip_missing_credentials":
      return { kind: "alarm", key: "credentials", failed: true, detail: `sem credencial do Instagram no 300: ${detail}` };
    case "skip_invalid":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `legenda/plano inválido: ${detail}` };
    case "skip_delegated":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `a rodada do timer recebeu skip_delegated (backend do Instagram mudou?): ${detail}` };
    case "publish":
    case "enqueue":
    case "buffer":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano com ${action} e sem resultado do instagram (exit ${exitCode})` };
    default: {
      const unknown: never = action;
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `ação inesperada do plano: ${String(unknown)} (exit ${exitCode})` };
    }
  }
}

/** Puro: corpo do alarme, por motivo, com os comandos já com a edição e o arquivo. */
export function buildInstagramTimerAlarm(input: {
  aammdd: string;
  key: InstagramTimerAlarmKey;
  reason: string;
  /**
   * `--video` do comando manual: caminho RELATIVO à raiz do repo (o comando
   * roda no 300, cwd no checkout), nunca o absoluto da máquina. null = não há
   * vídeo no disco nem id do corte no Drive (#11368): o comando pela API sai
   * do corpo, que diz por quê.
   */
  videoArg: string | null;
  /** Id do corte no Drive, quando conhecido (vira `--from-drive ID`). */
  driveFileId?: string | null;
  /** `HH:MM` BRT do fim da janela (`instagramTimerDeadlineHhmm`); null = desconhecido. */
  deadlineHhmm?: string | null;
  /** #11389: `HH:MM` BRT do horário do vertical (o lembrete `guided` diz quando postar); null = desconhecido. */
  verticalHhmm?: string | null;
}): { subject: string; body: string } {
  const { aammdd, key, reason, videoArg, driveFileId, deadlineHhmm, verticalHhmm } = input;
  const published = PUBLISHED_KEYS.has(key);
  const lines = [
    "Achado automático da task `Diaria-Shorts-Instagram`",
    "(`scripts/shorts-instagram-timer.ts`, #11265).",
    "",
    `Motivo (${key}): ${reason}`,
    "",
  ];
  const confirm = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --confirm-instagram\``;
  const manual = videoArg
    ? `\`npx tsx scripts/publish-shorts.ts ${aammdd} --only instagram --instagram-timer --publish --now --video ${videoArg}${driveFileId ? ` --from-drive ${driveFileId}` : ""}\``
    : null;
  let subject: string;
  if (key === "guided") {
    // #11389: limite conhecido da API, não falha: lembrete único por edição, nunca `late`.
    lines.push(
      "Lembrete, não é falha: o vertical desta edição passa do teto de duração da API do Instagram nesta conta, então o timer do 300 não publica o Reels. Ele sai pelo Chrome.",
      "O que fazer:",
      `- Postar pelo instagram.com no Chrome (Passo B3b do \`/diaria-publica-video\`)${verticalHhmm ? ` às ${verticalHhmm} BRT` : " no horário do vertical"}, ${instagramChromeRouteText()}.`,
      `- Registrar com ${confirm} (procura também no perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} enquanto o convite de collab está pendente) ou com \`--confirm-instagram --url URL\`.`,
      "Este lembrete sai uma vez por edição, e o timer não manda o alarme de atraso (`late`) por esse motivo.",
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: postar pelo Chrome${verticalHhmm ? ` às ${verticalHhmm}` : ""} (acima do teto da API, lembrete)`;
  } else if (key === "collab") {
    lines.push(
      "O Reels está no ar e registrado; NÃO reposte.",
      "O Instagram devolveu um aviso depois de publicar (ex.: o convite de collab descartado). Confira o Reels no app e, se o collab sumiu, convide a conta de novo editando o post.",
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: publicado com aviso (${key})`;
  } else if (key === "cut-unverified") {
    lines.push(
      "O Drive não respondeu e o timer publicou o corte `_Instagram_` já baixado, sem conferir se ele ainda é o que está no Drive.",
      "Se você trocou ou apagou o corte no Drive depois do download, confira o Reels publicado; o timer não reposta sozinho.",
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: publicado sem conferir o corte no Drive (${key})`;
  } else if (published) {
    lines.push(
      key === "check-permalink"
        ? "O Reels está registrado. Confira se o permalink é mesmo o desta edição; se não for, corrija o registro com `--mark instagram=URL`."
        : `O Reels está no ar. NÃO reposte: registre com \`npx tsx scripts/publish-shorts.ts ${aammdd} --mark instagram=URL\` (ou ${confirm}).`,
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: conferir registro (${key})`;
  } else if (key === "preflight-blocked") {
    // Nunca sugerir publicar: a conta pode já ter o Reels da edição.
    lines.push(
      "Confira a conta antes; não reposte. O timer não publicou porque não conseguiu afirmar que o Reels da edição ainda não está na conta.",
      `- Se o Reels da edição está lá: registre com ${confirm} (com \`--media-id ID\` quando houver mais de um candidato).`,
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: conferir a conta (${key})`;
  } else if (key === "author-unchecked") {
    // #11421: o Reels pode estar no perfil do autor (collab pendente) — nunca sugerir publicar pela API.
    lines.push(
      `O timer não publicou: a conta da API não tem o Reels da edição, mas o perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} (onde fica o Reels postado à mão enquanto o collab está pendente) não pôde ser conferido por falta da credencial da página ${INSTAGRAM_CHROME_ROUTE.authorPage} no 300. Publicar sem conferir poderia duplicar o Reels em conta pública.`,
      "O que fazer (uma das duas):",
      `- Postar pelo instagram.com no Chrome (Passo B3b do \`/diaria-publica-video\`), ${instagramChromeRouteText()}, e registrar com ${confirm} ou com \`--confirm-instagram --url URL\`. Se já postou, só registre.`,
      `- Ou fornecer a credencial da página ${INSTAGRAM_CHROME_ROUTE.authorPage} no 300; a próxima execução (de hora em hora${deadlineHhmm ? `, até ${deadlineHhmm} BRT` : ""}) confere o perfil e publica se o Reels não estiver lá.`,
      "Este alarme sai uma vez por edição.",
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd}: postar pelo Chrome ou fornecer a credencial do @${INSTAGRAM_CHROME_ROUTE.authorUsername} (${key})`;
  } else if (key === "preflight-read-failed") {
    // A conta não respondeu: o Reels não sai, mas nada diz que ele não está lá — nunca sugerir publicar.
    lines.push(
      "O timer não conseguiu ler a conta do Instagram (token expirado, permissão ou erro da API) e não publicou: o Reels não sai enquanto a leitura falhar.",
      `A próxima execução (de hora em hora${deadlineHhmm ? `, até ${deadlineHhmm} BRT` : ""}) confere a conta de novo sozinha.`,
      "O que fazer: confira a conta e a credencial do Instagram no 300 antes de qualquer repost.",
      `- Se o Reels da edição já está na conta: registre com ${confirm}.`,
      "- Se não está: renove a credencial; a próxima execução publica dentro da janela.",
    );
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd} não saiu: a leitura da conta falhou (${key})`;
  } else {
    if (key === "late") lines.push("Passadas 3 h do horário do vertical o timer NÃO publica mais sozinho.");
    if (key === "missing-video") {
      lines.push(`Suba o vertical \`_Vertical_\` em \`${aammdd}/Final/\` no Drive; até 3 h depois do horário do vertical${deadlineHhmm ? ` (${deadlineHhmm} BRT)` : ""} a próxima execução (de hora em hora) publica.`);
    }
    if (key === "drive-needs-editor") {
      lines.push(
        `Deixe um só \`_Vertical_\` em \`${aammdd}/Final/\` no Drive (ou uma só pasta \`${aammdd}\`; se o Drive ainda não mostra a proporção do arquivo, confira se ele terminou de processar); a próxima execução publica.`,
      );
    }
    if (RETRY_KEYS.has(key)) {
      lines.push(
        `O timer volta a tentar sozinho de hora em hora${deadlineHhmm ? ` até ${deadlineHhmm} BRT (3 h depois do horário do vertical)` : " até 3 h depois do horário do vertical"}; resolvida a causa, não precisa fazer nada.`,
      );
    }
    lines.push("O que fazer:", `- Postar no instagram.com (Passo B3b do \`/diaria-publica-video\`) e registrar com ${confirm}.`);
    if (API_OPTION_KEYS.has(key) && !manual) {
      lines.push("- Pela API, daqui não: não há vídeo do Instagram no disco do 300 nem o id do corte no Drive (baixe antes, Passo B1 do `/diaria-publica-video`).");
    } else if (API_OPTION_KEYS.has(key)) {
      lines.push(
        `- Ou publicar pela API, conferindo antes que o Reels não está na conta: ${manual}. ` +
          "Rode SÓ NO 300: de outra máquina o comando vira um segundo escritor (o lock do timer não cruza máquina) e o Reels sai duplicado.",
      );
    }
    subject = `[diar.ia.br] Reels do Instagram de ${aammdd} não saiu pelo timer do 300 (${key})`;
  }
  return { subject, body: lines.join("\n") };
}

/**
 * Puro: este alarme já está coberto pelo estado da edição? O mesmo alarme
 * (`alarmId`: motivo, e a causa nos motivos que juntam causas) não repete
 * (salvo com o e-mail pendente: aí reenvia); e `late` não sai depois de um
 * motivo que diz "não reposte" (`guided`, `preflight-blocked`,
 * `published-unregistered`, `check-permalink` — entregue ou pendente): o corpo
 * do `late` manda publicar e o Reels pode estar no ar (ou, no `guided`, é o
 * mesmo problema e seria um 2º e-mail urgente).
 */
export function alarmSuppressed(stateRaw: string | null, key: InstagramTimerAlarmKey, id: string = key): boolean {
  const state = parseAlarmState(stateRaw);
  const seen = [...state.alarmed, ...state.emailPending].map(alarmKeyOf);
  if (key === "late" && LATE_BLOCKER_KEYS.some((k) => seen.includes(k))) return true;
  if (state.emailPending.includes(id)) return false;
  return state.alarmed.includes(id);
}

/** Puro: lê o sidecar do corte; ilegível = desconhecido (rebaixa). */
export function parseCutSidecar(raw: string | null): InstagramCutSidecar | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o?.fileId !== "string") return null;
    return { fileId: o.fileId, modifiedTime: typeof o.modifiedTime === "string" ? o.modifiedTime : null };
  } catch {
    return null;
  }
}

export type DriveVerticalCheck = { kind: "yes" } | { kind: "no" } | { kind: "error"; reason: string };

/**
 * Puro (#11368): o Drive mostra o vertical da edição em `Final/`? O corte do
 * Instagram (achado ou ambíguo) já basta, sem a 2ª consulta; senão o vertical
 * genérico (`_Outras redes_`). Num dia em que só o `_Instagram_` existe no
 * Drive o genérico não acharia nada. Erro de qualquer das consultas sem
 * resposta positiva da outra = `error`, nunca "sem vertical" (esconderia
 * `late`/`missing-video`).
 */
export function driveVerticalCheck(instagram: InstagramCutLookup, generic: () => InstagramCutLookup): DriveVerticalCheck {
  if (driveShowsVertical(instagram)) return { kind: "yes" };
  const g = generic();
  if (driveShowsVertical(g)) return { kind: "yes" };
  if (instagram.kind === "error") return { kind: "error", reason: instagram.reason };
  if (g.kind === "error") return { kind: "error", reason: g.reason };
  return { kind: "no" };
}

/** Puro: argumentos do publish-shorts da rodada do timer. */
export function instagramPublishArgs(aammdd: string, choice: Extract<InstagramVideoChoice, { kind: "use-local" | "download" }>): string[] {
  // `--now` (#11368): o timer já decidiu publicar dentro da janela; o publish-shorts
  // não recalcula o teto de 3 h depois do download (a 2h58 viraria skip_late).
  const args = ["scripts/publish-shorts.ts", aammdd, "--only", "instagram", "--publish", "--instagram-timer", "--now", "--video", choice.path];
  if (choice.kind === "download") args.push("--from-drive", choice.fileId);
  return args;
}

function runTsx(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tail(text: string, lines = 15): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Contexto do comando manual do alarme. */
interface AlarmContext {
  /**
   * Vídeo do `--video` (absoluto aqui; o corpo leva relativo à raiz do repo).
   * Ausente = o que houver no disco (`manualVideoFor`); null = nenhum.
   */
  videoPath?: string | null;
  driveFileId?: string | null;
  /** Horário do vertical (ISO) → `HH:MM` BRT do fim da janela. */
  at?: string | null;
}

/**
 * Vídeo do comando manual quando o chamador não sabe qual (#11368): o corte
 * do disco; sem ele, o corte pelo id do último download (`--from-drive`);
 * sem os dois, o genérico do disco; sem nada, null (o corpo não oferece a API
 * com um `--video` que não existe).
 */
function manualVideoFor(dir: string, aammdd: string): { videoPath: string | null; driveFileId: string | null } {
  const cut = join(dir, shortInstagramVideoFileName(aammdd));
  if (existsSync(cut)) return { videoPath: cut, driveFileId: null };
  const sidecarPath = join(dir, INSTAGRAM_CUT_SIDECAR_FILE);
  const sidecar = parseCutSidecar(existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : null);
  if (sidecar?.fileId) return { videoPath: cut, driveFileId: sidecar.fileId };
  const generic = join(dir, shortVideoFileName(aammdd));
  if (existsSync(generic)) return { videoPath: generic, driveFileId: null };
  return { videoPath: null, driveFileId: null };
}

/** `--video` do comando manual: relativo à raiz do repo (o comando roda no checkout do 300). */
function videoArgFor(path: string): string {
  const rel = relative(ROOT, path);
  return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path).split(sep).join("/");
}

/**
 * Abre (ou reaproveita) a issue do alarme, manda o e-mail e grava o estado.
 * `notifyDeps` é injetável (testes: `gh` e envio falsos); produção usa `{ cwd: ROOT }`.
 */
export async function alarm(
  dir: string,
  aammdd: string,
  key: InstagramTimerAlarmKey,
  reason: string,
  ctx: AlarmContext = {},
  notifyDeps: NotifyEditorDeps = { cwd: ROOT },
): Promise<boolean> {
  const statePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const id = alarmId(key, reason);
  if (alarmSuppressed(stateRaw, key, id)) {
    console.log(`${LOG_PREFIX} ${aammdd}: alarme "${id}" já coberto nesta edição${key === "late" && !alreadyAlarmed(stateRaw, id) ? " (por um motivo que diz para não repostar)" : ""} — não repete`);
    return true;
  }
  // E-mail devido que falhou numa execução anterior: a issue já existe (volta
  // `reused` e a política não mandaria de novo) — força o reenvio.
  const forceEmail = emailPending(stateRaw, id);
  const fallback = ctx.videoPath === undefined ? manualVideoFor(dir, aammdd) : null;
  const videoPath = fallback ? fallback.videoPath : (ctx.videoPath ?? null);
  const driveFileId = ctx.driveFileId !== undefined ? ctx.driveFileId : (fallback?.driveFileId ?? null);
  const { subject, body } = buildInstagramTimerAlarm({
    aammdd,
    key,
    reason,
    videoArg: videoPath ? videoArgFor(videoPath) : null,
    driveFileId,
    deadlineHhmm: ctx.at ? instagramTimerDeadlineHhmm(ctx.at) : null,
    verticalHhmm: ctx.at ? hhmmBrt(Date.parse(ctx.at)) : null,
  });
  const res = await notifyEditor(
    { check: "shorts-instagram-timer", fingerprint: `${aammdd}:${id}`, severity: alarmSeverity(key), family: "evento", subject, body, forceEmail },
    notifyDeps,
  );
  const delivery = alarmDelivery(res);
  const next = nextAlarmState(stateRaw, aammdd, id, delivery);
  if (next !== null) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileAtomic(statePath, next);
  }
  if (delivery.kind !== "delivered") {
    console.error(`${LOG_PREFIX} ${aammdd}: alarme "${id}" NÃO entregue — ${delivery.error}; tenta de novo na próxima execução`);
    return false;
  }
  console.log(`${LOG_PREFIX} ${aammdd}: alarme "${id}" ${res.issue?.action ?? "registrado"}${res.issue?.url ? ` ${res.issue.url}` : ""}${res.emailSent ? " (e-mail enviado)" : ""}`);
  return true;
}

/** I/O da execução do timer, injetável nos testes (#11368: ligação do `run()` testada de ponta a ponta). */
export interface InstagramTimerRunDeps {
  config: unknown;
  now: Date;
  /** Corte `_Instagram_` da pasta `Final/` (`fetch-drive-video.ts --target instagram`, só imprime o id). */
  lookupInstagramCut: () => InstagramCutLookup;
  /** Vertical genérico (`_Outras redes_`, target default, também só imprime o id). */
  lookupGenericVertical: () => InstagramCutLookup;
  /** Roda `npx tsx <args>` (o publish-shorts). */
  runScript: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  notify: NotifyEditorDeps;
  /** #11389: duração (s) de um MP4 do disco; null = ilegível. Ausente = lê o arquivo (`mp4DurationSeconds`). */
  videoDurationSeconds?: (path: string) => number | null;
}

function readMp4Duration(path: string): number | null {
  try {
    return mp4DurationSeconds(readFileSync(path));
  } catch {
    return null;
  }
}

function defaultRunDeps(aammdd: string, dir: string): InstagramTimerRunDeps {
  const lookup = (target: string[]) => () => {
    const f = runTsx(["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", ...target, "--edition-dir", dir]);
    return interpretInstagramCutLookup(f.status, f.stdout);
  };
  return {
    config: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    now: new Date(),
    lookupInstagramCut: lookup(["--target", "instagram"]),
    lookupGenericVertical: lookup([]),
    runScript: runTsx,
    notify: { cwd: ROOT },
  };
}

export async function runInstagramTimer(aammdd: string, dir: string, dryRun: boolean, deps: InstagramTimerRunDeps = defaultRunDeps(aammdd, dir)): Promise<number> {
  const { config, now } = deps;
  const instagramCutPath = join(dir, shortInstagramVideoFileName(aammdd));
  const genericPath = join(dir, shortVideoFileName(aammdd));
  const sidecarPath = join(dir, INSTAGRAM_CUT_SIDECAR_FILE);
  const registryRaws = readShortsRegistryRaws(dir);
  let videoSeen =
    existsSync(instagramCutPath) ||
    existsSync(genericPath) ||
    existsSync(sidecarPath) ||
    registryRaws.some(({ path, raw }) => parseShortsPublishedFile(raw, aammdd, path).entries.length > 0);
  const decideWith = (seen: boolean) => decideInstagramTimerRun({ config, reviewedExists: existsSync(join(dir, "02-reviewed.md")), registryRaws, aammdd, now, videoSeen: seen });
  let decision = decideWith(videoSeen);
  let lateNote = "";
  // Passou de 3 h e nada local mostra o vertical: o Drive ainda pode mostrar (o
  // vertical nunca baixado). Consultado uma vez por edição (#11368): "sem
  // vertical" fica gravado e as execuções seguintes não voltam ao Drive.
  if (decision.kind === "skip" && decision.unseenLate) {
    const checkPath = join(dir, INSTAGRAM_TIMER_LATE_DRIVE_CHECK_FILE);
    if (existsSync(checkPath)) {
      console.log(`${LOG_PREFIX} ${aammdd}: nada a fazer — ${decision.reason} (Drive já conferido depois do teto: sem vertical)`);
      return 0;
    }
    const check = driveVerticalCheck(deps.lookupInstagramCut(), deps.lookupGenericVertical);
    if (check.kind === "no") {
      if (!dryRun) {
        mkdirSync(dirname(checkPath), { recursive: true });
        writeFileAtomic(checkPath, JSON.stringify({ aammdd, checkedAt: now.toISOString(), vertical: false }, null, 2) + "\n");
      }
    } else {
      videoSeen = true;
      decision = decideWith(true);
      // Drive sem resposta não vira "sem vertical" (esconderia o late): avisa dizendo que não deu pra conferir.
      if (check.kind === "error") lateNote = ` (o Drive não respondeu ao conferir se o dia teve vertical: ${check.reason} — se a edição saiu sem vídeo, ignore)`;
    }
  }
  // #11389: o vídeo do Instagram já no disco passa do teto da API da conta? O
  // primeiro arquivo existente da lista decide (o corte vence o genérico).
  const durationOf = deps.videoDurationSeconds ?? readMp4Duration;
  const overCapOnDisk = (paths: string[]): { over: true; reason: string; path: string } | null => {
    const path = paths.find((p) => existsSync(p));
    if (!path) return null;
    const r = instagramOverApiCap(config, durationOf(path));
    return r.over ? { ...r, path } : null;
  };
  if (decision.kind === "wait") {
    console.log(`${LOG_PREFIX} ${aammdd}: esperando — ${decision.reason}`);
    // #11389: lembrete ANTECIPADO. Só o corte do Instagram conta aqui: o genérico
    // acima do teto pode ainda ganhar um corte que cabe, e o lembrete mandaria
    // postar à mão o que o timer publicaria.
    // Lembrete já entregue: não relê o vídeo a cada hora.
    const statePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);
    if (alreadyAlarmed(existsSync(statePath) ? readFileSync(statePath, "utf8") : null, "guided")) return 0;
    const over = overCapOnDisk([instagramCutPath]);
    if (!over || dryRun) return 0;
    return (await alarm(dir, aammdd, "guided", over.reason, { at: decision.at, videoPath: over.path, driveFileId: null }, deps.notify)) ? 0 : 1;
  }
  if (decision.kind === "skip") {
    console.log(`${LOG_PREFIX} ${aammdd}: nada a fazer — ${decision.reason}`);
    return 0;
  }
  const sidecar = parseCutSidecar(existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : null);
  if (decision.kind === "late") {
    // #11389: acima do teto conhecido da API não é atraso: o Reels sai pelo
    // Chrome. Vira o lembrete `guided` (uma vez por edição), nunca `late`.
    const over = overCapOnDisk([instagramCutPath, genericPath]);
    if (over) {
      console.log(`${LOG_PREFIX} ${aammdd}: ${decision.reason}, mas o vídeo passa do teto da API — lembrete do Passo B3b, sem late`);
      if (dryRun) return 0;
      return (await alarm(dir, aammdd, "guided", over.reason, { at: decision.at, videoPath: over.path, driveFileId: null }, deps.notify)) ? 0 : 1;
    }
    const reason = `${decision.reason}${lateNote}`;
    console.log(`${LOG_PREFIX} ${aammdd}: ${reason}`);
    if (dryRun) return 0;
    // Vídeo do comando manual: o que houver no disco (`manualVideoFor`), nunca um --video inexistente.
    return (await alarm(dir, aammdd, "late", reason, { at: decision.at }, deps.notify)) ? 0 : 1;
  }

  // Fix do review do PR #11395: lembrete `guided` entregue nesta edição = o
  // editor foi mandado postar pelo Chrome. O timer nunca publica pela API
  // depois disso, mesmo que o corte no disco passe a caber (troca de corte):
  // o post à mão pode já existir e o gate não o enxerga com certeza.
  const guidedStatePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);
  if (alreadyAlarmed(existsSync(guidedStatePath) ? readFileSync(guidedStatePath, "utf8") : null, "guided")) {
    console.log(`${LOG_PREFIX} ${aammdd}: o lembrete do Passo B3b (guided) já saiu nesta edição — não publica pela API (registre o Reels com --confirm-instagram)`);
    return 0;
  }

  const release = dryRun ? () => {} : acquireTimerLock(join(dir, INSTAGRAM_TIMER_LOCK_FILE));
  if (!release) {
    console.log(`${LOG_PREFIX} ${aammdd}: outra execução está no meio (${INSTAGRAM_TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  const at = decision.at;
  try {
    const lookup = deps.lookupInstagramCut();
    const choice = chooseInstagramVideo({
      instagramCutPath,
      instagramCutExists: existsSync(instagramCutPath),
      cutSidecar: sidecar,
      genericPath,
      genericExists: existsSync(genericPath),
      lookup,
    });
    if (choice.kind === "wait") {
      console.log(`${LOG_PREFIX} ${aammdd}: ${choice.reason} — tenta de novo na próxima execução`);
      if (dryRun) return 0;
      // Ambíguo alarma já (o editor precisa escolher); corte faltando ou proporção
      // ainda desconhecida, 1 h depois do horário — num dia que teve vertical,
      // inclusive só no Drive.
      if (choice.alarmNow) return (await alarm(dir, aammdd, choice.alarm, choice.reason, { at }, deps.notify)) ? 0 : 1;
      if (!shouldAlarmMissingVideo(now, at, true)) return 0;
      let seen = videoSeen;
      let reason = choice.reason;
      let after = MISSING_VIDEO_ALARM_AFTER_MS;
      if (driveShowsVertical(lookup)) {
        seen = true;
      } else {
        const g = deps.lookupGenericVertical();
        if (g.kind === "found") {
          // O genérico está no Drive e ainda não no disco: quem baixa é o timer do LinkedIn (#11368).
          seen = true;
          after = GENERIC_PENDING_ALARM_AFTER_MS;
          reason += "; o vertical genérico (_Outras redes_) está no Drive e ainda não chegou ao disco do 300 (quem baixa é o timer do LinkedIn)";
        } else if (g.kind === "needs-editor") {
          seen = true;
        } else if (g.kind === "error") {
          // Erro do Drive não vira "dia sem vertical" (esconderia o alarme).
          seen = true;
          reason += `; o Drive não respondeu ao conferir o vertical genérico (${g.reason})`;
        }
      }
      if (seen && now.getTime() - Date.parse(at) >= after) return (await alarm(dir, aammdd, choice.alarm, reason, { at }, deps.notify)) ? 0 : 1;
      return 0;
    }
    if (choice.kind === "error") {
      console.error(`${LOG_PREFIX} ${aammdd}: ${choice.reason}`);
      if (!dryRun) await alarm(dir, aammdd, "drive-error", `Drive: ${choice.reason}`, { at }, deps.notify);
      return 1;
    }
    const publishArgs = instagramPublishArgs(aammdd, choice);
    if (choice.kind === "download") {
      console.log(`${LOG_PREFIX} ${aammdd}: corte do Instagram no Drive: ${choice.name} (${choice.fileId}, ${choice.modifiedTime ?? "sem data"}) → ${choice.path}`);
    } else {
      console.log(`${LOG_PREFIX} ${aammdd}: vídeo = ${choice.source === "instagram-cut" ? "corte do Instagram" : "vertical genérico"} no disco (${choice.path})${choice.note ? ` — ${choice.note}` : ""}`);
    }
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    const before = choice.kind === "download" ? mtimeOf(choice.path) : null;
    const r = deps.runScript(publishArgs);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    let downloaded = false;
    if (choice.kind === "download") {
      const after = mtimeOf(choice.path);
      // Só grava o que baixou de fato (o download falho deixa o arquivo antigo intacto).
      if (after !== null && after !== before) {
        downloaded = true;
        mkdirSync(dirname(sidecarPath), { recursive: true });
        writeFileAtomic(sidecarPath, JSON.stringify({ fileId: choice.fileId, modifiedTime: choice.modifiedTime, name: choice.name }, null, 2) + "\n");
      }
    }
    const outcome = interpretInstagramTimerOutput(r.status, r.stdout, tail(r.stderr));
    console.log(`${LOG_PREFIX} ${aammdd}: ${outcome.kind}${outcome.kind === "alarm" ? ` (${outcome.key})` : ""} — ${outcome.detail}`);
    // #11368: o Reels saiu com o corte do disco sem conferir o Drive — avisa (acao), sem mudar o exit.
    const reelOut = outcome.kind === "done" || (outcome.kind === "alarm" && outcome.key === "collab");
    if (reelOut && choice.kind === "use-local" && choice.unverified) {
      await alarm(dir, aammdd, "cut-unverified", `${choice.note ?? "Drive indisponível"}; ${outcome.detail}`, { at, videoPath: choice.path, driveFileId: null }, deps.notify);
    }
    if (outcome.kind !== "alarm") return 0;
    // Corte que não chegou ao disco: o comando manual baixa de novo (`--from-drive`).
    const driveFileId = choice.kind === "download" && !downloaded ? choice.fileId : null;
    const alarmed = await alarm(dir, aammdd, outcome.key, outcome.detail, { at, videoPath: choice.path, driveFileId }, deps.notify);
    return outcome.failed || !alarmed ? 1 : 0;
  } finally {
    release();
  }
}

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? aammddBrt(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error("uso: shorts-instagram-timer.ts [--edition AAMMDD] [--dry-run]");
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const dir = editionDirFor(aammdd);
  try {
    return await runInstagramTimer(aammdd, dir, dryRun);
  } catch (e) {
    // Exceção (registro ilegível, config, spawn): o Reels do dia fica sem dono — alarme próprio.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG_PREFIX} ${aammdd}: erro: ${msg}`);
    if (!dryRun) {
      try {
        await alarm(dir, aammdd, "crash", `o timer falhou com exceção: ${msg}`, {});
      } catch (e2) {
        console.error(`${LOG_PREFIX} ${aammdd}: nem o alarme saiu: ${e2 instanceof Error ? e2.message : e2}`);
      }
    }
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-instagram-timer:", e instanceof Error ? e.message : e) });
}

export { alarmDelivery, alreadyAlarmed, emailPending, nextAlarmState, parseAlarmState, type AlarmDelivery, type ShortsTimerAlarmState as InstagramTimerAlarmState } from "./lib/diaria/shorts-timer-alarm-state.ts";
