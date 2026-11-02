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
 *      `content-changed`, nada publicado), e o filho roda com
 *      `--require-corte-authorization`: só confere, nunca grava autorização;
 *   4. `interpretCorteTimerOutput` (puro) lê o JSON e devolve um desfecho por
 *      destino; cada falha vira um alarme ao editor (`notifyEditor`, issue +
 *      e-mail), um por destino e motivo, sem repetir a cada hora
 *      (`_internal/.shorts-corte-timer-alarm.json` na pasta do corte).
 *
 * Lock O_EXCL por corte em `_internal/.shorts-corte-timer.lock`.
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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor, type NotifyEditorDeps, type NotifySeverity } from "./lib/editor-notify.ts";
import { MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import { loadShortsConfig, parseShortsPublishedFile } from "./lib/diaria/short-video.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_TASK, CORTES_REL_DIR, corteBaseCommand, parseCorteSpec, resolveCorteVideo, type CorteSpec } from "./lib/diaria/short-corte.ts";
import { corteAuthorizedDestinations, corteContentMismatch } from "./lib/diaria/short-corte.ts";
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
  | "revoked";

/** O post pode estar (ou está) no ar: `acao`, e o corpo nunca manda publicar de novo. */
const MAYBE_PUBLISHED_KEYS: ReadonlySet<CorteTimerAlarmKey> = new Set(["send-unknown", "published-unregistered", "account-check"]);

/** Motivos em que a próxima execução (até 3 h depois do horário) tenta de novo sozinha. */
const RETRY_KEYS: ReadonlySet<CorteTimerAlarmKey> = new Set(["missing-video", "credentials", "public-video", "publish-failed", "account-read-failed", "no-output", "crash"]);

export function corteAlarmSeverity(key: CorteTimerAlarmKey): NotifySeverity {
  // #11912: autorização derrubada é decisão pendente do editor, não falha: urgência normal.
  return MAYBE_PUBLISHED_KEYS.has(key) || key === "revoked" ? "acao" : "urgente";
}

/** Destinos do timer que o config liga (#11911: a mesma lista que a vigia dos timers da edição usa). */
export const corteTimerDestinations = corteUnscheduledDestinations;

export type CorteTimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "wait"; reason: string; at: string }
  | { kind: "late"; reason: string; at: string; pending: string[] }
  /** #11912: o "pode publicar" caiu e o horário chegou com destinos que estavam autorizados pendentes. */
  | { kind: "revoked"; reason: string; at: string; pending: string[] }
  | { kind: "publish"; at: string; pending: string[] };

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
  // #11912: sem o "pode publicar" (gravado só pelo --publish --confirm-publish do corte) o
  // timer não publica nem alarma `late`: corte nunca aprovado não está atrasado.
  const authorized = corteAuthorizedDestinations(input.spec);
  const done = new Set<string>();
  for (const { path, raw } of input.registryRaws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o post).
    for (const e of parseShortsPublishedFile(raw, input.spec.date, path).entries) done.add(e.destination);
  }
  const enabled = corteTimerDestinations(input.config);
  if (!authorized) {
    const noAuth = 'sem o "pode publicar": o corte.json não tem publish_confirmed_at (só o --publish --confirm-publish do corte grava; o dry-run nunca autoriza, #11912)';
    // #11912: autorização que EXISTIU e caiu (plano/conteúdo mudou) com destinos pendentes vira alarme no horário, nunca skip silencioso.
    const revoked = input.spec.publish_revoked_at ? input.spec.publish_revoked_destinations : undefined;
    if (revoked === undefined) return { kind: "skip", reason: noAuth };
    const lost = (revoked === "all" ? enabled : enabled.filter((d) => revoked.includes(d))).filter((d) => !done.has(d));
    if (!lost.length) return { kind: "skip", reason: `${noAuth}; a autorização anterior caiu em ${input.spec.publish_revoked_at}, sem destino do timer pendente` };
    const at = resolveEditionScheduledAt(input.spec.date, input.spec.hhmm);
    const deltaMs = input.now.getTime() - Date.parse(at);
    if (deltaMs < 0) return { kind: "skip", reason: `${noAuth}; a autorização anterior caiu em ${input.spec.publish_revoked_at}: alarma no horário (${input.spec.hhmm} BRT) se não vier um novo "pode publicar"` };
    if (deltaMs > CORTE_TIMER_HORIZON_MS) return { kind: "skip", reason: `horário do corte passou há mais de ${CORTE_TIMER_HORIZON_MS / 3_600_000} h` };
    return {
      kind: "revoked",
      at,
      pending: lost,
      reason: `o "pode publicar" do corte caiu em ${input.spec.publish_revoked_at} (o plano ou o vídeo/capa mudou) e ${lost.join(", ")} não saiu: o timer não publica sem um novo --publish --confirm-publish`,
    };
  }
  // #11912: só os destinos do --only autorizado; os deixados de fora nunca saem pelo timer.
  const allowed = authorized === "all" ? enabled : enabled.filter((d) => authorized.includes(d));
  const pending = allowed.filter((d) => !done.has(d));
  if (!pending.length) {
    const left = enabled.filter((d) => !allowed.includes(d) && !done.has(d));
    return {
      kind: "skip",
      reason: `nenhum destino do timer pendente (todos registrados ou desligados no config)${left.length ? `; fora do "pode publicar" (--only autorizado): ${left.join(", ")}` : ""}`,
    };
  }
  const at = resolveEditionScheduledAt(input.spec.date, input.spec.hhmm);
  const deltaMs = input.now.getTime() - Date.parse(at);
  if (deltaMs < 0) return { kind: "wait", reason: `antes do horário do corte (${input.spec.hhmm} BRT de ${input.spec.date})`, at };
  if (deltaMs > CORTE_TIMER_HORIZON_MS) return { kind: "skip", reason: `horário do corte passou há mais de ${CORTE_TIMER_HORIZON_MS / 3_600_000} h` };
  if (deltaMs > MAX_FIRE_LATENESS_MS) {
    return {
      kind: "late",
      at,
      pending,
      reason: `${input.spec.hhmm} BRT de ${input.spec.date} passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e ${pending.join(", ")} não está registrado`,
    };
  }
  return { kind: "publish", at, pending };
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
  const manual = `\`${base} --only ${destination} --publish --now ${publishConfirmSuffix(spec.date)}\``;
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
      `- Se não está: publique com ${manual} (no 300) e confira.`,
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
      );
    }
    if (key === "content-changed") {
      lines.push(
        'O vídeo ou a capa na pasta do corte não é o arquivo aprovado no "pode publicar" (re-export, outro --from-drive, outra --cover). O timer não publica conteúdo que o editor não aprovou.',
        `Confira o arquivo. Se o novo está certo, dê o "pode publicar" de novo: \`${base} --only ${destination} --publish --confirm-publish ${spec.date}\`. Se não, volte o arquivo aprovado: o timer confere de novo a cada hora, até 3 h depois do horário.`,
      );
    }
    if (key === "missing-video") lines.push(`O vídeo do corte não está nesta máquina (${spec.video}): copie para a pasta do corte em data/cortes/${spec.slug}/ ou rode de novo com --from-drive.`);
    if (key === "public-video") lines.push("O destino recebe o vídeo por URL pública: confira os secrets do R2 (`SHORTS_R2_*`) no `.env` do 300.");
    if (key === "credentials") lines.push("Confira a credencial do destino no `.env` do 300 (LINKEDIN_PERSONAL_*, THREADS_PERSONAL_*, INSTAGRAM_*).");
    if (RETRY_KEYS.has(key)) lines.push("O timer volta a tentar sozinho de hora em hora até 3 h depois do horário do corte; resolvida a causa, não precisa fazer nada.");
    lines.push("O que fazer:", `- Publicar agora: ${manual} (no 300).`, `- Ou postar à mão e registrar com ${mark}.`);
    subject = `[diar.ia.br] Corte "${spec.slug}" não saiu no ${destination} pelo timer do 300 (${key})`;
  }
  return { subject, body: lines.join("\n") };
}

/** Abre (ou reaproveita) a issue do alarme, manda o e-mail e grava o estado. `true` = entregue (ou já coberto). */
export async function corteAlarm(dir: string, spec: CorteSpec, destination: string, key: CorteTimerAlarmKey, reason: string, notifyDeps: NotifyEditorDeps): Promise<boolean> {
  const statePath = join(dir, CORTE_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const id = `${destination}:${key}`;
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
  /** Roda `npx tsx <args>` (o publish-shorts). */
  runScript: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  notify: NotifyEditorDeps;
  /** Teste: troca o alarme real (notifyEditor). */
  alarm?: (dir: string, spec: CorteSpec, destination: string, key: CorteTimerAlarmKey, reason: string) => Promise<boolean>;
}

function runTsx(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Um corte: decide, publica os pendentes e alarma cada falha. Devolve o exit code parcial (0/1). */
export async function runCorteTimerFor(dir: string, dryRun: boolean, deps: CorteTimerRunDeps): Promise<number> {
  const alarm = deps.alarm ?? ((d, s, dest, key, reason) => corteAlarm(d, s, dest, key, reason, deps.notify));
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  const decision = decideCorteTimerRun({ config: deps.config, spec, registryRaws: readShortsRegistryRaws(dir), now: deps.now });
  if (decision.kind === "skip" || decision.kind === "wait") {
    console.log(`${LOG_PREFIX} ${spec.slug}: ${decision.kind === "skip" ? "nada a fazer" : "esperando"} — ${decision.reason}`);
    return 0;
  }
  if (decision.kind === "late" || decision.kind === "revoked") {
    console.log(`${LOG_PREFIX} ${spec.slug}: ${decision.reason}`);
    if (dryRun) return 0;
    let ok = true;
    for (const d of decision.pending) ok = (await alarm(dir, spec, d, decision.kind, decision.reason)) && ok;
    return ok ? 0 : 1;
  }
  const release = dryRun ? () => {} : acquireTimerLock(join(dir, CORTE_TIMER_LOCK_FILE), deps.now.getTime());
  if (!release) {
    console.log(`${LOG_PREFIX} ${spec.slug}: outra execução está no meio (${CORTE_TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  try {
    const video = resolveCorteVideo(dir, spec.video);
    if (!existsSync(video)) {
      const reason = `vídeo do corte ausente nesta máquina: ${video}`;
      console.error(`${LOG_PREFIX} ${spec.slug}: ${reason}`);
      if (dryRun) return 0;
      let ok = true;
      for (const d of decision.pending) ok = (await alarm(dir, spec, d, "missing-video", reason)) && ok;
      return ok ? 0 : 1;
    }
    // #11912: vídeo/capa trocados depois do "pode publicar" não saem (alarme, não silêncio).
    const mismatch = corteContentMismatch(spec.publish_confirmed_content, corteContentFingerprint(dir, spec));
    if (mismatch) {
      const reason = `${mismatch}: o timer não publica conteúdo que o editor não aprovou`;
      console.error(`${LOG_PREFIX} ${spec.slug}: ${reason}`);
      if (dryRun) return 0;
      let ok = true;
      for (const d of decision.pending) ok = (await alarm(dir, spec, d, "content-changed", reason)) && ok;
      return ok ? 0 : 1;
    }
    const args = cortePublishArgs(spec, decision.pending);
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${args.join(" ")}`);
      return 0;
    }
    const r = deps.runScript(args);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const outcomes = interpretCorteTimerOutput(r.status, r.stdout, decision.pending, r.stderr.trimEnd().split("\n").slice(-15).join("\n"));
    let failed = false;
    for (const o of outcomes) {
      console.log(`${LOG_PREFIX} ${spec.slug} ${o.destination}: ${o.kind}${o.kind === "alarm" ? ` (${o.key})` : ""} — ${o.detail}`);
      if (o.kind !== "alarm") continue;
      const delivered = await alarm(dir, spec, o.destination, o.key, o.detail);
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
        await corteAlarm(dir, spec, "todos", "crash", `o timer falhou com exceção: ${msg}`, deps.notify);
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
