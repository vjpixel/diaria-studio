#!/usr/bin/env node
/**
 * scripts/shorts-corte-timer.ts (#11795)
 *
 * Passo do timer do `300` (`Diaria-Shorts-Cortes`, de hora em hora,
 * `scripts/lib/scheduled-tasks.ts`) que publica os destinos de um CORTE
 * AVULSO (`publish-shorts.ts --corte SLUG`, `data/cortes/{slug}/`) cuja API
 * não agenda: `linkedin_profile`, `threads_profile` e `instagram`. Os timers da
 * edição (#10982, #11265, #11410) procuram a pasta da edição e não enxergam o
 * corte; em 01/11/2026 o corte "Tratar IA como humano" saiu com um
 * `systemd-run` feito à mão no 300, que não alertava em falha (o resultado só
 * ficava num log e na conferência de uma task do Neo).
 *
 *   1. varre `data/cortes/*\/corte.json`;
 *   2. `decideCorteTimerRun` (puro): `publishing.shorts.corte_via_timer`
 *      desligado, corte sem o "pode publicar" no `corte.json` (#11912: só o
 *      `--publish --confirm-publish` do corte grava `publish_confirmed_at` e os
 *      destinos do `--only`; dry-run nunca, e sem ele nem o `late` sai; se uma
 *      autorização existiu e caiu, `publish_revoked_*`, no horário vira alarme
 *      `revoked` para os destinos que ela cobria e seguem pendentes), ou
 *      nenhum dos três destinos autorizados pendente no registro do corte
 *      (inclusive `send_unknown` e as cópias de conflito do OneDrive) → nada a
 *      fazer; antes do `--at` → espera; até 3 h depois → publica; depois →
 *      alarme `late` (até 48 h depois do horário; corte mais velho é ignorado);
 *   3. `publish-shorts.ts --corte SLUG --only {pendentes} --publish --now
 *      --confirm-publish {data}`: a autorização é o "pode publicar" do editor
 *      gravado no `corte.json` pelo `--publish` confirmado (#11741, #11912), e
 *      os pendentes são só os destinos que ele autorizou. Antes, vídeo e capa
 *      são conferidos contra o sha256 aprovado (diferente → alarme
 *      `content-changed`, nada publicado; vídeo ou capa aprovada ausente →
 *      `missing-video`), e o filho roda com `--require-corte-authorization`:
 *      só confere e nunca grava nada no `corte.json`; a recusa dele sai em
 *      JSON (`authorization_refused`) e vira o alarme do motivo. Destino
 *      derrubado e pendente (mesmo com outros autorizados) alarma `revoked`, e
 *      destino autorizado fora da config, `unknown-destination`;
 *   4. `interpretCorteTimerOutput` (puro) lê o JSON e devolve um desfecho por
 *      destino; cada falha vira um alarme ao editor (`notifyEditor`, issue +
 *      e-mail), um por destino e motivo, sem repetir a cada hora
 *      (`_internal/.shorts-corte-timer-alarm.json` na pasta do corte).
 *
 * Lock O_EXCL por corte em `_internal/.shorts-corte-timer.lock`. O filho tem
 * teto de 75 min (`CORTE_TIMER_CHILD_TIMEOUT_MS`, abaixo dos 90 min de lock
 * velho, #11966): estourado, vira alarme `child-timeout` (conferir a conta).
 * #11964: o lock só serializa execuções do timer; quem impede a rodada manual
 * de publicar junto é o plano do publish-shorts, que entrega os três destinos
 * ao timer (`skip_delegated`) de 10 min antes do horário até 3 h depois.
 *
 * Conferência da conta antes de publicar (#11795, fecha o limite do review do
 * PR #11894): o `publish-shorts --corte` passa o Instagram pela mesma
 * conferência do timer da edição (`instagramTimerGate`, #11265), com o título
 * e o gancho do corte como marcadores e sem contar o Reels da edição do dia; o
 * Threads pessoal, pela conferência do perfil (`threadsProfilePreflight`,
 * #11742). Achado na conta → registra e não publica; ambíguo → alarme
 * `account-check` (`acao`, nunca manda postar de novo); leitura que falha →
 * `account-read-failed` (tenta de novo na próxima hora).
 *
 * Uso: npx tsx scripts/shorts-corte-timer.ts [--corte SLUG] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem publicar e sem alarme.
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (publish,
 * alarme não entregue, exceção); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor, type NotifyEditorDeps, type NotifySeverity } from "./lib/editor-notify.ts";
import { MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import { knownDestinationIds, loadShortsConfig, parseShortsPublishedFile } from "./lib/diaria/short-video.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_TASK, CORTES_REL_DIR, corteBaseCommand, parseCorteSpec, resolveCorteVideo, type CorteSpec } from "./lib/diaria/short-corte.ts";
import { corteAuthorizedDestinations, corteContentCheck, corteRevokedDestinations, type CorteContentFingerprint } from "./lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "./lib/diaria/corte-content.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";
import { corteUnscheduledDestinations } from "./lib/diaria/corte-owner-watch.ts";
import { acquireTimerLock } from "./shorts-linkedin-profile-timer.ts";
import { alarmDelivery, emailPending, nextAlarmState, parseAlarmState } from "./lib/diaria/shorts-timer-alarm-state.ts";
import { publishConfirmArgs, publishConfirmSuffix } from "./lib/diaria/publish-confirm.ts";
// Só tipo: importar o publish-shorts em runtime carregaria o .env no import.
import type { ShortsPlanItem } from "./publish-shorts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[shorts-corte-timer]";
export { CORTES_REL_DIR };
export const CORTE_TIMER_LOCK_FILE = "_internal/.shorts-corte-timer.lock";
export const CORTE_TIMER_ALARM_STATE_FILE = "_internal/.shorts-corte-timer-alarm.json";
/** Depois disto o corte não é mais olhado (nem pra alarmar): o `late` já saiu dentro da janela. */
export const CORTE_TIMER_HORIZON_MS = 48 * 3_600_000;

/** Motivo do alarme — chave estável (dedup e fingerprint), nunca texto variável. */
export type CorteTimerAlarmKey =
  | "late"
  | "missing-video"
  | "credentials"
  | "public-video"
  | "invalid"
  | "publish-failed"
  /** Envio ambíguo (`send_unknown`): o post pode estar no ar. */
  | "send-unknown"
  /** O post saiu, mas o registro não foi gravado. */
  | "published-unregistered"
  /** #11795/#11742: a conta pode já ter o vídeo do corte (postado à mão, ou ambíguo): a conferência não deixou publicar. */
  | "account-check"
  /** #11795/#11742: a leitura da conta antes de publicar falhou (fail-closed). */
  | "account-read-failed"
  | "no-output"
  | "crash"
  /** #11912: vídeo ou capa mudou depois do "pode publicar": o timer não publica o arquivo novo. */
  | "content-changed"
  /** #11912: o corte tinha "pode publicar", ele caiu (plano/conteúdo mudou) e o horário chegou com destinos pendentes. */
  | "revoked"
  /** #11912: o "pode publicar" cita um destino que a config atual não conhece: nunca filtrado em silêncio. */
  | "unknown-destination"
  /** #11966: o publish-shorts passou do teto e foi morto: o envio pode ter saído sem registro. */
  | "child-timeout";

/** O post pode estar (ou está) no ar: `acao`, e o corpo nunca manda publicar de novo. */
const MAYBE_PUBLISHED_KEYS: ReadonlySet<CorteTimerAlarmKey> = new Set(["send-unknown", "published-unregistered", "account-check", "child-timeout"]);

/** Motivos em que a próxima execução (até 3 h depois do horário) tenta de novo sozinha. */
const RETRY_KEYS: ReadonlySet<CorteTimerAlarmKey> = new Set(["missing-video", "credentials", "public-video", "publish-failed", "account-read-failed", "no-output", "crash"]);

export function corteAlarmSeverity(key: CorteTimerAlarmKey): NotifySeverity {
  // #11912: autorização derrubada ou com destino desconhecido é decisão pendente do editor, não falha: urgência normal.
  return MAYBE_PUBLISHED_KEYS.has(key) || key === "revoked" || key === "unknown-destination" ? "acao" : "urgente";
}

/** Destinos do timer que o config liga (#11911: a mesma lista que a vigia dos timers da edição usa). */
export const corteTimerDestinations = corteUnscheduledDestinations;

/**
 * #11912: alarme que acompanha a decisão, independente de publicar: destino
 * cujo "pode publicar" caiu e segue pendente (`revoked`) ou destino autorizado
 * que a config não conhece (`unknown-destination`). Só no horário (até o
 * horizonte), como o `late`.
 */
export interface CorteTimerSideAlarm {
  destination: string;
  key: "revoked" | "unknown-destination";
  reason: string;
}

export type CorteTimerDecision =
  | { kind: "skip"; reason: string; alarms?: CorteTimerSideAlarm[] }
  | { kind: "wait"; reason: string; at: string }
  | { kind: "late"; reason: string; at: string; pending: string[]; alarms?: CorteTimerSideAlarm[] }
  | { kind: "publish"; at: string; pending: string[]; alarms?: CorteTimerSideAlarm[] };

/** Puro: o que fazer com um corte nesta execução, antes de tocar em qualquer API. */
export function decideCorteTimerRun(input: {
  config: unknown;
  spec: CorteSpec;
  /** Todos os arquivos do registro do corte (`readShortsRegistryRaws`). */
  registryRaws: ReadonlyArray<{ path: string; raw: string }>;
  now: Date;
}): CorteTimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.corteViaTimer) return { kind: "skip", reason: "publishing.shorts.corte_via_timer = false (a skill agenda a re-execução)" };
  const { spec } = input;
  // #11912: sem o "pode publicar" (gravado só pelo --publish --confirm-publish do corte) o
  // timer não publica nem alarma `late`: corte nunca aprovado não está atrasado.
  const authorized = corteAuthorizedDestinations(spec) ?? [];
  const revoked = corteRevokedDestinations(spec);
  const done = new Set<string>();
  for (const { path, raw } of input.registryRaws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o post).
    for (const e of parseShortsPublishedFile(raw, spec.date, path).entries) done.add(e.destination);
  }
  const enabled = corteTimerDestinations(input.config);
  const at = resolveEditionScheduledAt(spec.date, spec.hhmm);
  const deltaMs = input.now.getTime() - Date.parse(at);
  const inWindow = deltaMs >= 0 && deltaMs <= CORTE_TIMER_HORIZON_MS;
  // #11912: lidos SEMPRE, mesmo com autorização (um --only menor depois da queda não silencia os outros).
  const alarms: CorteTimerSideAlarm[] = [];
  if (inWindow) {
    const known = knownDestinationIds(cfg);
    for (const d of authorized.filter((x) => !known.has(x))) {
      alarms.push({ destination: d, key: "unknown-destination", reason: `o "pode publicar" do corte cita ${d}, que a config atual não conhece: o timer não publica nada nele` });
    }
    // #11923: destino derrubado e depois renomeado na config também alarma (o `revoked` abaixo só vê os da config).
    for (const d of revoked.filter((x) => !known.has(x) && !authorized.includes(x) && !done.has(x))) {
      alarms.push({ destination: d, key: "unknown-destination", reason: `o "pode publicar" do ${d} caiu em ${spec.publish_revoked_at} e a config atual não conhece ${d}: o timer não publica nada nele` });
    }
    const lost = enabled.filter((d) => revoked.includes(d) && !authorized.includes(d) && !done.has(d));
    for (const d of lost) {
      alarms.push({
        destination: d,
        key: "revoked",
        reason: `o "pode publicar" do ${d} caiu em ${spec.publish_revoked_at} (${spec.publish_revoked_reason_kind === "plan" ? "o plano mudou" : "o vídeo/capa mudou"}) e ele não saiu: o timer não publica sem um novo --publish --confirm-publish`,
      });
    }
  }
  const withAlarms = alarms.length ? { alarms } : {};
  if (!authorized.length) {
    const noAuth = 'sem o "pode publicar": o corte.json não tem publish_confirmed_at (só o --publish --confirm-publish do corte grava; o dry-run nunca autoriza, #11912)';
    if (!revoked.length) return { kind: "skip", reason: noAuth };
    if (deltaMs < 0) return { kind: "skip", reason: `${noAuth}; a autorização anterior caiu em ${spec.publish_revoked_at}: alarma no horário (${spec.hhmm} BRT) se não vier um novo "pode publicar"` };
    return { kind: "skip", reason: `${noAuth}; a autorização anterior caiu em ${spec.publish_revoked_at}`, ...withAlarms };
  }
  // #11912: só os destinos do --only autorizado; os deixados de fora nunca saem pelo timer.
  const allowed = enabled.filter((d) => authorized.includes(d));
  const pending = allowed.filter((d) => !done.has(d));
  if (!pending.length) {
    const left = enabled.filter((d) => !allowed.includes(d) && !done.has(d));
    return {
      kind: "skip",
      reason: `nenhum destino do timer pendente (todos registrados ou desligados no config)${left.length ? `; fora do "pode publicar" (--only autorizado): ${left.join(", ")}` : ""}`,
      ...withAlarms,
    };
  }
  if (deltaMs < 0) return { kind: "wait", reason: `antes do horário do corte (${spec.hhmm} BRT de ${spec.date})`, at };
  if (deltaMs > CORTE_TIMER_HORIZON_MS) return { kind: "skip", reason: `horário do corte passou há mais de ${CORTE_TIMER_HORIZON_MS / 3_600_000} h` };
  if (deltaMs > MAX_FIRE_LATENESS_MS) {
    return {
      kind: "late",
      at,
      pending,
      reason: `${spec.hhmm} BRT de ${spec.date} passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e ${pending.join(", ")} não está registrado`,
      ...withAlarms,
    };
  }
  return { kind: "publish", at, pending, ...withAlarms };
}

/**
 * Puro: argumentos do publish-shorts da rodada do timer. #11912:
 * `--require-corte-authorization` faz o filho só CONFERIR o "pode publicar"
 * (presente, cobre o `--only`, vídeo/capa iguais aos aprovados) e recusar com
 * exit 2 sem ele; nunca gravar autorização nova (o `--confirm-publish` do
 * timer não é decisão do editor).
 */
export function cortePublishArgs(spec: CorteSpec, pending: readonly string[]): string[] {
  return ["scripts/publish-shorts.ts", "--corte", spec.slug, "--only", pending.join(","), "--publish", "--now", ...publishConfirmArgs(spec.date), "--require-corte-authorization"];
}

export type CorteDestinationOutcome =
  | { destination: string; kind: "done"; detail: string }
  | { destination: string; kind: "wait"; detail: string }
  | { destination: string; kind: "alarm"; key: CorteTimerAlarmKey; detail: string };

type PlanAction = ShortsPlanItem["action"];

/** Puro: lê a saída do `publish-shorts.ts --corte SLUG --only … --publish` — um desfecho por destino pendente. */
export function interpretCorteTimerOutput(exitCode: number | null, stdout: string, pending: readonly string[], stderrTail = ""): CorteDestinationOutcome[] {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    const detail = `publish-shorts.ts sem JSON (exit ${exitCode})${stderrTail ? `. Fim do stderr:\n${stderrTail}` : ""}`;
    return pending.map((destination) => ({ destination, kind: "alarm", key: "no-output", detail }));
  }
  // #11912: o filho (`--require-corte-authorization`) recusou sem publicar nada: o motivo vira o alarme certo.
  if (typeof out?.authorization_refused === "string") {
    // #11923: o plano mudou no meio da rodada e o novo já tem o "pode publicar": a próxima execução publica.
    if (out.authorization_refused === "replanned") {
      const detail = `o plano mudou durante a rodada e o novo já está autorizado; sai na próxima execução: ${String(out.reason ?? "sem motivo")}`;
      return pending.map((destination) => ({ destination, kind: "wait", detail }));
    }
    const refused: Record<string, CorteTimerAlarmKey> = { revoked: "revoked", "content-changed": "content-changed", "missing-content": "missing-video", "spec-unreadable": "crash" };
    // #11923: motivo desconhecido (timer e filho em versões diferentes) não vira "revoked" enganoso.
    const key = refused[out.authorization_refused] ?? "crash";
    const detail = `o publish-shorts recusou sem publicar (${out.authorization_refused}): ${String(out.reason ?? "sem motivo")}`;
    return pending.map((destination) => ({ destination, kind: "alarm", key, detail }));
  }
  return pending.map((destination): CorteDestinationOutcome => {
    const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === destination) : undefined;
    if (result) {
      const e = result.entry;
      const where = e ? (e.url ?? e.id) : "";
      if (result.ok && e) {
        if (e.status === "send_unknown") return { destination, kind: "alarm", key: "send-unknown", detail: `envio ambíguo (${e.id}): ${(result.warnings ?? []).join("; ") || "sem detalhe"}` };
        return { destination, kind: "done", detail: `${result.alreadyRegistered ? "já registrado" : "publicado"}: ${e.status} ${where}` };
      }
      if (e) return { destination, kind: "alarm", key: "published-unregistered", detail: `o post SAIU (${where}), mas o registro não foi gravado: ${result.error ?? "?"}` };
      // #11795/#11742: a conferência da conta (Instagram) ou do perfil (Threads) não deixou publicar.
      if (result.cause === "preflight") {
        return result.preflight === "read-failed"
          ? { destination, kind: "alarm", key: "account-read-failed", detail: `a conferência da conta antes de publicar falhou: ${result.error ?? "?"}` }
          : { destination, kind: "alarm", key: "account-check", detail: `a conta pode já ter o vídeo do corte: ${result.error ?? "?"}` };
      }
      return { destination, kind: "alarm", key: "publish-failed", detail: String(result.error ?? "falha sem mensagem") };
    }
    const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === destination) : undefined;
    if (!item) return { destination, kind: "alarm", key: "publish-failed", detail: `plano sem o destino ${destination} (exit ${exitCode})` };
    const detail = String(item.detail ?? "");
    const action = item.action as PlanAction;
    switch (action) {
      case "skip_done":
        return { destination, kind: "done", detail: "já registrado" };
      case "pending_schedule":
        return { destination, kind: "wait", detail: detail || "antes do horário" };
      case "skip_late":
        return { destination, kind: "alarm", key: "late", detail };
      case "skip_missing_credentials":
        return item.cause === "public_video"
          ? { destination, kind: "alarm", key: "public-video", detail: `sem URL pública do vertical no 300: ${detail}` }
          : { destination, kind: "alarm", key: "credentials", detail: `sem credencial no 300: ${detail}` };
      case "skip_invalid":
        return { destination, kind: "alarm", key: "invalid", detail: `texto/plano inválido: ${detail}` };
      case "skip_delegated":
      case "publish":
      case "enqueue":
      case "buffer":
      case "guided":
        return { destination, kind: "alarm", key: "publish-failed", detail: `plano com ${action} e sem resultado do ${destination} (exit ${exitCode})${detail ? `: ${detail}` : ""}` };
      default: {
        const unknown: never = action;
        return { destination, kind: "alarm", key: "publish-failed", detail: `ação inesperada do plano: ${String(unknown)} (exit ${exitCode})` };
      }
    }
  });
}

/** Puro: corpo do alarme, por motivo, com os comandos já com o corte. */
export function buildCorteTimerAlarm(input: { spec: CorteSpec; destination: string; key: CorteTimerAlarmKey; reason: string }): { subject: string; body: string } {
  const { spec, destination, key, reason } = input;
  const base = corteBaseCommand(spec.slug);
  const mark = `\`${base} --mark ${destination}=URL\``;
  // #11964: até 3 h depois do horário o publish-shorts manual delega os destinos do timer (não publica
  // em dobro com ele): "publicar agora" é rodar o próprio timer no 300. Depois das 3 h (`late`) o timer
  // não publica mais, e aí sim o publish-shorts com --now.
  const manual =
    key === "late"
      ? `\`${base} --only ${destination} --publish --now ${publishConfirmSuffix(spec.date)}\``
      : `\`npx tsx scripts/shorts-corte-timer.ts --corte ${spec.slug}\``;
  const lines = [
    `Achado automático da task \`${CORTE_TIMER_TASK}\` (\`scripts/shorts-corte-timer.ts\`, #11795).`,
    "",
    `Corte: "${spec.title}" (${spec.slug}), ${spec.hhmm} BRT de ${spec.date}. Destino: ${destination}.`,
    `Motivo (${key}): ${reason}`,
    "",
  ];
  let subject: string;
  if (MAYBE_PUBLISHED_KEYS.has(key)) {
    lines.push(
      "Confira a conta antes de qualquer coisa; NÃO poste de novo sem conferir.",
      `- Se o vídeo do corte está lá: registre com ${mark}.`,
      `- Se não está: publique com ${manual} (no 300; até 3 h depois do horário, passadas as 3 h com \`${base} --only ${destination} --publish --now ${publishConfirmSuffix(spec.date)}\`) e confira.`,
    );
    if (key === "account-check") {
      lines.push(`- Se o vídeo que a conferência acusou é de outra edição ou outro corte, a publicação pelo script vai parar no mesmo ponto: poste à mão e registre com ${mark}.`);
    }
    subject = `[diar.ia.br] Corte "${spec.slug}" no ${destination}: conferir a conta (${key})`;
  } else {
    if (key === "late") lines.push("Passadas 3 h do horário do corte o timer NÃO publica mais sozinho.");
    if (key === "revoked") {
      lines.push(
        'O corte tinha o "pode publicar", mas ele caiu quando o plano (título, gancho, horário, data, vídeo) ou o conteúdo (vídeo/capa) mudou, e o timer não publica o plano novo sem uma nova confirmação.',
        `Se o plano atual está certo, dê o "pode publicar" de novo: \`${base} --only ${destination} --publish --confirm-publish ${spec.date}\` (publica o que a API publica na hora; o resto fica com o timer, até 3 h depois do horário).`,
        `Passadas 3 h do horário o timer não publica mais, nem com o "pode publicar" novo: publique à mão com \`${base} --only ${destination} --publish --now --confirm-publish ${spec.date}\` (no 300), ou poste à mão e registre com ${mark}.`,
      );
    }
    if (key === "unknown-destination") {
      lines.push(
        `O "pode publicar" do corte cita ${destination}, que não existe na config atual (\`publishing.shorts\`): o timer não publica nada nele.`,
        `Se o destino mudou de nome, dê o "pode publicar" com o nome atual (\`${base} --only {destino} --publish --confirm-publish ${spec.date}\`).`,
      );
    }
    if (key === "content-changed") {
      lines.push(
        'O vídeo ou a capa na pasta do corte não é o arquivo aprovado no "pode publicar" (re-export, outro --from-drive, outra --cover). O timer não publica conteúdo que o editor não aprovou.',
        `Confira o arquivo. Se o novo está certo, dê o "pode publicar" de novo: \`${base} --only ${destination} --publish --confirm-publish ${spec.date}\`. Se não, volte o arquivo aprovado: o timer confere de novo a cada hora, até 3 h depois do horário.`,
      );
    }
    if (key === "missing-video") lines.push(`O vídeo do corte (${spec.video}) ou a capa aprovada não está nesta máquina (cópia do OneDrive atrasada?): copie para a pasta do corte em data/cortes/${spec.slug}/ ou rode de novo com --from-drive.`);
    if (key === "public-video") lines.push("O destino recebe o vídeo por URL pública: confira os secrets do R2 (`SHORTS_R2_*`) no `.env` do 300.");
    if (key === "credentials") lines.push("Confira a credencial do destino no `.env` do 300 (LINKEDIN_PERSONAL_*, THREADS_PERSONAL_*, INSTAGRAM_*).");
    if (RETRY_KEYS.has(key)) lines.push("O timer volta a tentar sozinho de hora em hora até 3 h depois do horário do corte; resolvida a causa, não precisa fazer nada.");
    lines.push("O que fazer:", `- Publicar agora: ${manual} (no 300).`, `- Ou postar à mão e registrar com ${mark}.`);
    subject = `[diar.ia.br] Corte "${spec.slug}" não saiu no ${destination} pelo timer do 300 (${key})`;
  }
  return { subject, body: lines.join("\n") };
}

/**
 * #11912 (E): id do alarme (dedup e fingerprint). `revoked` e
 * `content-changed` levam a variante (a data da queda; o sha256 do arquivo
 * atual): uma 2ª queda, ou um 2º arquivo trocado, avisa de novo em vez de
 * cair no "já avisado" da 1ª. #11923: `late` e `missing-video` levam a data e
 * o horário do plano (replanejar o corte para outro dia avisa de novo);
 * `unknown-destination`, a data da autorização (ou da queda) que cita o nome.
 * #11967: todo motivo sem variante própria leva a do plano; o `todos:crash` do
 * `main`, o dia da execução (`corteCrashAlarmVariant`), só até o horizonte
 * de 48 h (#11995; depois, variante fixa).
 */
export function corteAlarmId(destination: string, key: CorteTimerAlarmKey, variant?: string): string {
  return variant ? `${destination}:${key}:${variant}` : `${destination}:${key}`;
}

/** Puro (#11912): a variante do id do alarme por motivo (ver `corteAlarmId`). */
export function corteAlarmVariant(key: CorteTimerAlarmKey, spec: CorteSpec, content: CorteContentFingerprint | null): string | undefined {
  if (key === "revoked") return spec.publish_revoked_at ?? spec.publish_confirmed_at ?? corteAlarmPlanVariant(spec);
  if (key === "content-changed" && content) return `${(content.video_sha256 ?? "sem-video").slice(0, 12)}-${(content.cover_sha256 ?? "sem-capa").slice(0, 12)}`;
  if (key === "unknown-destination") return spec.publish_confirmed_at ?? spec.publish_revoked_at ?? corteAlarmPlanVariant(spec);
  // #11923 (late, missing-video) e #11967 (todos os demais): a data e o horário do plano. O estado
  // dos alarmes fica na pasta do corte (por slug, não por data): sem a variante, o mesmo motivo
  // num corte replanejado para outro dia caía no "já avisado" do plano antigo.
  return corteAlarmPlanVariant(spec);
}

/** #11967: variante do plano (`{data}-{hh:mm}`); `undefined` só sem data nem horário (spec sintética). */
function corteAlarmPlanVariant(spec: Pick<CorteSpec, "date" | "hhmm">): string | undefined {
  return spec.date || spec.hhmm ? `${spec.date}-${spec.hhmm}` : undefined;
}

/** #11995: variante fixa do `todos:crash` de corte parado além do horizonte (avisa uma vez só). */
export const CORTE_CRASH_STALE_VARIANT = "alem-do-horizonte";

/**
 * Puro (#11967): variante do alarme `todos:crash` do `main` (exceção antes de
 * ler o corte, sem plano conhecido): o dia UTC da execução. Avisa de novo a
 * cada dia em que o corte segue quebrado, em vez de uma única vez na vida do corte.
 *
 * #11995: só dentro do horizonte do timer (`CORTE_TIMER_HORIZON_MS`, 48 h),
 * contado da última mudança da pasta do corte (`lastChangeMs`, ver
 * `corteLastChangeMs`). Corte antigo quebrado (ex.: `corte.json` de agosto
 * corrompido por conflito do OneDrive) já não publica nada e lançaria em toda
 * execução: com a variante diária, um alarme urgente novo por dia, para sempre.
 * Além do horizonte a variante é fixa e o alarme sai uma vez só. Editar o
 * corte (replanejar, consertar) renova a mtime e volta à variante diária.
 * `lastChangeMs` ausente (stat falhou) mantém a diária: na dúvida, avisa.
 */
export function corteCrashAlarmVariant(now: Date, lastChangeMs?: number | null): string {
  if (typeof lastChangeMs === "number" && Number.isFinite(lastChangeMs) && now.getTime() - lastChangeMs > CORTE_TIMER_HORIZON_MS) {
    return CORTE_CRASH_STALE_VARIANT;
  }
  return now.toISOString().slice(0, 10);
}

/**
 * #11995: instante da última mudança do corte, para o horizonte do
 * `todos:crash`: a mtime do `corte.json` (o arquivo que o editor edita e que o
 * `--publish --confirm-publish` regrava), ou a da pasta se o `corte.json` não
 * responde ao stat. `null` se nenhum dos dois responde.
 */
export function corteLastChangeMs(dir: string): number | null {
  for (const p of [join(dir, CORTE_SPEC_FILE), dir]) {
    try {
      return statSync(p).mtimeMs;
    } catch {
      // tenta o próximo; sem nenhum, `null` (variante diária).
    }
  }
  return null;
}

/** Abre (ou reaproveita) a issue do alarme, manda o e-mail e grava o estado. `true` = entregue (ou já coberto). */
export async function corteAlarm(
  dir: string,
  spec: CorteSpec,
  destination: string,
  key: CorteTimerAlarmKey,
  reason: string,
  notifyDeps: NotifyEditorDeps,
  variant?: string,
): Promise<boolean> {
  const statePath = join(dir, CORTE_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const id = corteAlarmId(destination, key, variant);
  const state = parseAlarmState(stateRaw);
  if (state.alarmed.includes(id) && !state.emailPending.includes(id)) {
    console.log(`${LOG_PREFIX} ${spec.slug}: alarme "${id}" já avisado — não repete`);
    return true;
  }
  const { subject, body } = buildCorteTimerAlarm({ spec, destination, key, reason });
  const res = await notifyEditor(
    { check: "shorts-corte-timer", fingerprint: `${spec.slug}:${id}`, severity: corteAlarmSeverity(key), family: "evento", subject, body, forceEmail: emailPending(stateRaw, id) },
    notifyDeps,
  );
  const delivery = alarmDelivery(res);
  const next = nextAlarmState(stateRaw, spec.date, id, delivery);
  if (next !== null) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileAtomic(statePath, next);
  }
  if (delivery.kind !== "delivered") {
    console.error(`${LOG_PREFIX} ${spec.slug}: alarme "${id}" NÃO entregue — ${delivery.error}; tenta de novo na próxima execução`);
    return false;
  }
  console.log(`${LOG_PREFIX} ${spec.slug}: alarme "${id}" ${res.issue?.action ?? "registrado"}${res.issue?.url ? ` ${res.issue.url}` : ""}${res.emailSent ? " (e-mail enviado)" : ""}`);
  return true;
}

/** I/O da execução, injetável nos testes. */
export interface CorteTimerRunDeps {
  config: unknown;
  now: Date;
  /** Roda `npx tsx <args>` (o publish-shorts). `timedOut` (#11966): morto pelo teto. */
  runScript: (args: string[]) => CorteTimerChildRun;
  notify: NotifyEditorDeps;
  /** Teste: troca o alarme real (notifyEditor). `variant`: ver `corteAlarmId`. */
  alarm?: (dir: string, spec: CorteSpec, destination: string, key: CorteTimerAlarmKey, reason: string, variant?: string) => Promise<boolean>;
}

/**
 * #11966: teto do filho (`publish-shorts.ts`). Fica abaixo da idade de lock velho
 * (`SHORTS_TIMER_LOCK_STALE_MS`, 90 min, a do `acquireTimerLock`): sem ele, um
 * filho travado (upload do Reels, leitura do R2) segurava o lock e, passados os
 * 90 min, a execução seguinte tomava o lock como velho e publicava junto com
 * ele. Mesmo teto do timer do Instagram (`INSTAGRAM_TIMER_CHILD_TIMEOUT_MS`, #11774).
 */
export const CORTE_TIMER_CHILD_TIMEOUT_MS = 75 * 60_000;

/** Saída do filho. `timedOut`: passou do teto e foi morto (o envio pode ter saído). */
export interface CorteTimerChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function runTsx(args: string[]): CorteTimerChildRun {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: CORTE_TIMER_CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (r.error && !timedOut) throw r.error;
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(timedOut ? { timedOut: true } : {}) };
}

/**
 * Puro (#11966): o filho morto pelo teto pode ter publicado algum destino sem
 * registrar. Cada pendente vira o alarme `child-timeout` (`acao`: conferir a
 * conta antes de qualquer coisa), nunca "falhou, tenta de novo".
 */
export function corteTimerTimeoutOutcomes(pending: readonly string[], stderrTail = ""): CorteDestinationOutcome[] {
  const detail =
    `o publish-shorts passou de ${CORTE_TIMER_CHILD_TIMEOUT_MS / 60_000} min e foi encerrado (#11966): o envio pode ter saído sem registro` +
    (stderrTail ? `. Fim do stderr:\n${stderrTail}` : "");
  return pending.map((destination) => ({ destination, kind: "alarm", key: "child-timeout", detail }));
}

/** Um corte: decide, publica os pendentes e alarma cada falha. Devolve o exit code parcial (0/1). */
export async function runCorteTimerFor(dir: string, dryRun: boolean, deps: CorteTimerRunDeps): Promise<number> {
  const alarm = deps.alarm ?? ((d, s, dest, key, reason, variant) => corteAlarm(d, s, dest, key, reason, deps.notify, variant));
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  const decision = decideCorteTimerRun({ config: deps.config, spec, registryRaws: readShortsRegistryRaws(dir), now: deps.now });
  if (decision.kind === "wait") {
    console.log(`${LOG_PREFIX} ${spec.slug}: esperando — ${decision.reason}`);
    return 0;
  }
  // #11912: destinos que perderam o "pode publicar" (ou com nome desconhecido) alarmam em toda decisão, nunca silêncio.
  let sideOk = true;
  for (const a of decision.alarms ?? []) {
    console.log(`${LOG_PREFIX} ${spec.slug} ${a.destination}: ${a.key} — ${a.reason}`);
    if (!dryRun) sideOk = (await alarm(dir, spec, a.destination, a.key, a.reason, corteAlarmVariant(a.key, spec, null))) && sideOk;
  }
  if (decision.kind === "skip") {
    console.log(`${LOG_PREFIX} ${spec.slug}: nada a publicar — ${decision.reason}`);
    return sideOk ? 0 : 1;
  }
  if (decision.kind === "late") {
    console.log(`${LOG_PREFIX} ${spec.slug}: ${decision.reason}`);
    if (dryRun) return 0;
    let ok = sideOk;
    for (const d of decision.pending) ok = (await alarm(dir, spec, d, "late", decision.reason, corteAlarmVariant("late", spec, null))) && ok;
    return ok ? 0 : 1;
  }
  const release = dryRun ? () => {} : acquireTimerLock(join(dir, CORTE_TIMER_LOCK_FILE), deps.now.getTime());
  if (!release) {
    console.log(`${LOG_PREFIX} ${spec.slug}: outra execução está no meio (${CORTE_TIMER_LOCK_FILE}) — sai sem publicar`);
    return sideOk ? 0 : 1;
  }
  try {
    const video = resolveCorteVideo(dir, spec.video);
    if (!existsSync(video)) {
      const reason = `vídeo do corte ausente nesta máquina: ${video}`;
      console.error(`${LOG_PREFIX} ${spec.slug}: ${reason}`);
      if (dryRun) return 0;
      let ok = sideOk;
      for (const d of decision.pending) ok = (await alarm(dir, spec, d, "missing-video", reason, corteAlarmVariant("missing-video", spec, null))) && ok;
      return ok ? 0 : 1;
    }
    // #11912: vídeo/capa trocados depois do "pode publicar" não saem (alarme, não silêncio); capa
    // aprovada ausente (cópia do OneDrive atrasada) alarma como o vídeo ausente e tenta de novo.
    const content = corteContentFingerprint(dir, spec);
    const check = corteContentCheck(spec.publish_confirmed_content, content);
    if (check.kind !== "ok") {
      const key: CorteTimerAlarmKey = check.kind === "missing" ? "missing-video" : "content-changed";
      const reason = check.kind === "missing" ? check.reason : `${check.reason}: o timer não publica conteúdo que o editor não aprovou`;
      console.error(`${LOG_PREFIX} ${spec.slug}: ${reason}`);
      if (dryRun) return 0;
      let ok = sideOk;
      for (const d of decision.pending) ok = (await alarm(dir, spec, d, key, reason, corteAlarmVariant(key, spec, content))) && ok;
      return ok ? 0 : 1;
    }
    const args = cortePublishArgs(spec, decision.pending);
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${args.join(" ")}`);
      return 0;
    }
    const r = deps.runScript(args);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const stderrTail = r.stderr.trimEnd().split("\n").slice(-15).join("\n");
    // #11966: filho morto pelo teto não é "sem JSON, tenta de novo": o envio pode ter saído.
    const outcomes = r.timedOut ? corteTimerTimeoutOutcomes(decision.pending, stderrTail) : interpretCorteTimerOutput(r.status, r.stdout, decision.pending, stderrTail);
    let failed = !sideOk;
    for (const o of outcomes) {
      console.log(`${LOG_PREFIX} ${spec.slug} ${o.destination}: ${o.kind}${o.kind === "alarm" ? ` (${o.key})` : ""} — ${o.detail}`);
      if (o.kind !== "alarm") continue;
      // A recusa do filho relê o corte: a variante é a da queda/arquivo de agora.
      // #11923: se reler falha (OneDrive), segue com a variante do plano — o alarme não pode se perder por isso.
      // #11923: os demais (late, missing-video) levam a variante do plano desta rodada.
      const rereads = o.key === "revoked" || o.key === "content-changed";
      // #11967: sem a releitura, a variante do plano desta rodada (nunca o id fixo).
      let variant = corteAlarmVariant(o.key, spec, null);
      if (rereads) {
        try {
          variant = corteAlarmVariant(o.key, parseCorteSpec(readFileSync(specPath, "utf8"), specPath), corteContentFingerprint(dir, spec));
        } catch (e) {
          console.error(`${LOG_PREFIX} ${spec.slug}: variante do alarme "${o.key}" indisponível (${(e as Error).message}); segue com a do plano`);
        }
      }
      const delivered = await alarm(dir, spec, o.destination, o.key, o.detail, variant);
      if (!delivered || o.key !== "late") failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    release();
  }
}

/** Puro: as pastas de corte com `corte.json` (nome = slug). */
export function listCorteDirs(cortesDir: string): string[] {
  if (!existsSync(cortesDir)) return [];
  return readdirSync(cortesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(cortesDir, d.name, CORTE_SPEC_FILE)))
    .map((d) => join(cortesDir, d.name))
    .sort();
}

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const cortesDir = join(ROOT, CORTES_REL_DIR);
  const only = values["corte"];
  const dirs = listCorteDirs(cortesDir).filter((d) => !only || basename(d) === only);
  if (only && !dirs.length) {
    console.error(`uso: shorts-corte-timer.ts [--corte SLUG] [--dry-run] — corte "${only}" sem ${CORTE_SPEC_FILE} em ${cortesDir}`);
    return 2;
  }
  if (!dirs.length) {
    console.log(`${LOG_PREFIX} nenhum corte em ${cortesDir} — nada a fazer`);
    return 0;
  }
  const deps: CorteTimerRunDeps = {
    config: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    now: new Date(),
    runScript: runTsx,
    notify: { cwd: ROOT },
  };
  let exit = 0;
  for (const dir of dirs) {
    try {
      exit = Math.max(exit, await runCorteTimerFor(dir, dryRun, deps));
    } catch (e) {
      // Exceção (corte.json/registro ilegível, spawn): o corte fica sem dono — alarme próprio.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`${LOG_PREFIX} ${basename(dir)}: erro: ${msg}`);
      exit = 1;
      if (dryRun) continue;
      const spec: CorteSpec = { slug: basename(dir), date: "", hhmm: "", title: basename(dir), hook: "", video: "" };
      try {
        await corteAlarm(dir, spec, "todos", "crash", `o timer falhou com exceção: ${msg}`, deps.notify, corteCrashAlarmVariant(deps.now, corteLastChangeMs(dir)));
      } catch (e2) {
        console.error(`${LOG_PREFIX} ${basename(dir)}: nem o alarme saiu: ${e2 instanceof Error ? e2.message : e2}`);
      }
    }
  }
  return exit;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-corte-timer:", e instanceof Error ? e.message : e) });
}
