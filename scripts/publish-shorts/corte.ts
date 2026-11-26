/**
 * Ciclo do corte avulso: autorização, agendamento, timer do 300 e o ciclo de vida (`--corte-lifecycle`).
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { agendamentosPath, loadAgendamentos, saveAgendamentos, transicionarAgendamento } from "../lib/diaria/agendamentos.ts";
import { parseCorteSlug } from "../lib/diaria/cortes-estoque.ts";
import { pecaDoCorte } from "../lib/diaria/agendamentos-verificar.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import {
  CORTE_SPEC_FILE,
  corteVideoFileName,
  corteVideoRef,
  mergeCorteSpec,
  resolveCorteVideo,
  parseCorteSpec,
  type CorteSpec,
  corteAuthorizedDestinations,
  corteContentCheck,
  planCorteAuthorizationRestore,
  withCorteCancellation,
  withCortePublishAuthorization,
  withoutCortePublishAuthorization,
  type CorteContentFingerprint,
  type CorteRevocationKind,
} from "../lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../lib/diaria/corte-content.ts";
import { CORTE_LIFECYCLE_MIN_LEAD_MS, executeCorteLifecycle, planCorteLifecycle, type CorteLifecycleOp } from "../lib/diaria/short-corte-lifecycle.ts";
import { loadResolvedFacebookPages, type ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import type { ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import { persistShortEntry, readShortsRegistry } from "../lib/diaria/shorts-published-store.ts";
import { openSendingMarks, readShortsSending } from "../lib/diaria/shorts-sending-marker.ts";
import { defaultYouTubeUploadDeps, missingYouTubeCredentials, rescheduleScheduledVideo } from "../lib/diaria/youtube-upload.ts";
import { SHORT_COVER_FILE } from "../lib/diaria/short-cover.ts";
import { ROOT } from "./_shared.ts";
import { defaultGraphDeps, cancelFacebookScheduledVideo, rescheduleFacebookScheduledVideo } from "./facebook.ts";

/** #11795: flags que não valem no corte avulso (timers do 300 e conferência do Instagram são da edição). */
export const CORTE_FORBIDDEN_FLAGS = ["linkedin-timer", "instagram-timer", "threads-timer", "confirm-instagram"] as const;

/** #11912: uma autorização ("pode publicar") do corte que caiu nesta rodada; vai no JSON de saída. */
export interface CorteRevocation {
  at: string;
  destinations: string[];
  reason: string;
  /** `plan`: o `--update-scheduled --publish` pode devolver; `content`: só um `--publish` explícito. */
  reason_kind: CorteRevocationKind;
}

/**
 * #11912: `--require-corte-authorization` (o filho do timer do 300) só vale
 * com `--corte` e `--publish`, sem `--update-scheduled` e sem flag que mude o
 * corte ou grave registro: o filho confere, nunca grava. Puro; `null` = ok.
 */
export function corteRequireAuthArgsError(flags: ReadonlySet<string>, values: Record<string, string | undefined>): string | null {
  if (!flags.has("require-corte-authorization")) return null;
  if (values["corte"] === undefined) return "--require-corte-authorization só vale com --corte";
  const planFlags = ["date", "at", "title", "hook", "video", "from-drive", "cover", "mark"].filter((k) => values[k] !== undefined);
  if (!flags.has("publish") || flags.has("update-scheduled") || planFlags.length) {
    return `--require-corte-authorization só vale com --publish e sem mudar o corte${planFlags.length ? ` (recebeu ${planFlags.map((k) => `--${k}`).join(", ")})` : ""}`;
  }
  return null;
}

/**
 * #11795: prepara a rodada do corte avulso — lê `data/cortes/{slug}/corte.json`,
 * aplica as flags desta rodada, grava a spec se mudou e copia a capa
 * (`--cover`) pra pasta do corte. Lança em spec ilegível ou incompleta.
 *
 * #11912: plano novo (título, gancho, horário, data: queda `plan`; outro
 * `--video`: queda `content`) derruba o "pode publicar" e registra
 * `publish_revoked_*`; cada derrubada vai para `onRevoked` (o `main` põe no
 * JSON da rodada). A conferência do conteúdo contra a impressão digital
 * aprovada só roda quando ESTA rodada trouxe conteúdo (`--cover`, `--video`;
 * o `--from-drive` confere depois do download, no `main`): uma cópia do
 * OneDrive atrasada ou parcial não derruba a autorização (o timer alarma).
 * `readOnly` (o filho do timer, `--require-corte-authorization`): não grava
 * nada e lança se as flags mudariam o corte.
 */
export function prepareCorteRun(input: {
  slug: string;
  dir: string;
  values: Record<string, string>;
  positionalDate: string;
  log: (line: string) => void;
  now?: () => Date;
  onRevoked?: (r: CorteRevocation) => void;
  readOnly?: boolean;
  unwatchedDirWarning?: string;
}): CorteSpec {
  const specPath = join(input.dir, CORTE_SPEC_FILE);
  const existing = existsSync(specPath) ? parseCorteSpec(readFileSync(specPath, "utf8"), specPath) : null;
  const { values } = input;
  if (values["video"] !== undefined && values["from-drive"] !== undefined) {
    throw new Error("--corte: passe --video OU --from-drive, não os dois (o --from-drive baixa sempre para a pasta do corte)");
  }
  if (values["date"] !== undefined && input.positionalDate && values["date"] !== input.positionalDate) {
    throw new Error(`data ambígua: --date ${values["date"]} e AAMMDD ${input.positionalDate}`);
  }
  // #11825: o --from-drive baixa SEMPRE para data/cortes/{slug}/corte-{slug}.mp4, nunca para o `video`
  // já registrado (que pode ser o arquivo original do editor); o caminho fica relativo à pasta do corte.
  const video = values["video"] !== undefined
    ? corteVideoRef(input.dir, resolve(values["video"]))
    : values["from-drive"] !== undefined
      ? corteVideoFileName(input.slug)
      : undefined;
  const merged = mergeCorteSpec(input.slug, existing, {
    date: values["date"] ?? (input.positionalDate || undefined),
    at: values["at"],
    title: values["title"],
    hook: values["hook"],
    video,
  });
  if (!merged.ok) throw new Error(merged.error);
  if (input.readOnly) {
    // #11912: o filho do timer nunca grava (nem o corte, nem autorização, nem derrubada).
    if (!existing) throw new Error(`${specPath} não existe: o filho do timer não registra corte`);
    if (merged.changed.length || values["cover"] !== undefined) throw new Error(`o filho do timer não muda o corte (${[...merged.changed, ...(values["cover"] !== undefined ? ["cover"] : [])].join(", ")})`);
    return existing;
  }
  const coverSrc = values["cover"] !== undefined ? resolve(values["cover"]) : null;
  if (coverSrc !== null && !existsSync(coverSrc)) throw new Error(`--cover: ${coverSrc} não existe`);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  // A spec do arquivo (com a autorização) por baixo, o plano desta rodada por cima.
  let spec: CorteSpec = existing ? { ...existing, ...merged.spec } : merged.spec;
  if (existing && merged.changed.length) {
    // Outro `--video` é outro conteúdo: a queda não pode ser devolvida pelo --update-scheduled.
    const kind: CorteRevocationKind = merged.changed.includes("video") ? "content" : "plan";
    spec = revokeCorteAuthorization(spec, nowIso, `o plano do corte mudou (${merged.changed.join(", ")})`, kind, input);
  }
  const warningChanged = input.unwatchedDirWarning !== undefined && spec.unwatched_dir_warning !== input.unwatchedDirWarning;
  if (input.unwatchedDirWarning !== undefined) spec.unwatched_dir_warning = input.unwatchedDirWarning;
  if (merged.changed.length || warningChanged) {
    mkdirSync(input.dir, { recursive: true });
    writeFileAtomic(specPath, JSON.stringify(spec, null, 2) + "\n");
    input.log(`[ok] corte "${input.slug}": ${existing ? `atualizado (${[...merged.changed, ...(warningChanged ? ["unwatched_dir_warning"] : [])].join(", ")})` : "registrado"} em ${specPath}`);
  }
  if (coverSrc !== null) {
    mkdirSync(input.dir, { recursive: true });
    copyFileSync(coverSrc, join(input.dir, SHORT_COVER_FILE));
    input.log(`[ok] corte "${input.slug}": capa copiada para ${join(input.dir, SHORT_COVER_FILE)}`);
  }
  // #11912: só esta rodada trazendo conteúdo (capa, vídeo) confere contra o aprovado.
  if (coverSrc === null && values["video"] === undefined) return spec;
  return syncCorteAuthorizationWithContent(input.dir, nowIso, input);
}

function revokeCorteAuthorization(
  spec: CorteSpec,
  nowIso: string,
  reason: string,
  kind: CorteRevocationKind,
  io: { log: (line: string) => void; onRevoked?: (r: CorteRevocation) => void },
): CorteSpec {
  const r = withoutCortePublishAuthorization(spec, nowIso, kind);
  if (!r.revoked) return spec;
  const how = kind === "plan"
    ? "um novo --publish --confirm-publish, ou o --update-scheduled --publish --confirm-publish do corte"
    : "um novo --publish --confirm-publish (o --update-scheduled não devolve: o vídeo ou a capa mudou)";
  io.log(`[aviso] corte "${spec.slug}": o "pode publicar" caiu (${reason}); os destinos que estavam autorizados (${r.revoked.join(", ")}) só saem pelo timer do 300 depois de ${how}, e o timer alarma (revoked) se o horário chegar antes`);
  io.onRevoked?.({ at: nowIso, destinations: r.revoked, reason, reason_kind: kind });
  return r.spec;
}

/**
 * #11912: confere o vídeo e a capa da pasta do corte contra a impressão
 * digital do "pode publicar". Arquivo diferente (outra `--cover`, outro
 * `--from-drive`) → derruba a autorização (`content`) e grava. Vídeo ou capa
 * aprovada AUSENTE nesta máquina não derruba (cópia do OneDrive atrasada: o
 * timer alarma). Só chamada quando a rodada trouxe conteúdo novo. Devolve a
 * spec atual.
 */
export function syncCorteAuthorizationWithContent(
  dir: string,
  nowIso: string,
  io: { log: (line: string) => void; onRevoked?: (r: CorteRevocation) => void },
): CorteSpec {
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  if (!corteAuthorizedDestinations(spec)) {
    // #11923: título e --cover na mesma rodada: a queda `plan` já gravada (antes da cópia da capa)
    // vira `content` quando o arquivo deixa de ser o aprovado — o alarme diz o motivo certo e o
    // --update-scheduled não promete devolver o que não devolve.
    if (spec.publish_revoked_reason_kind !== "plan" || !spec.publish_revoked_content) return spec;
    const prior = corteContentCheck(spec.publish_revoked_content, corteContentFingerprint(dir, spec));
    if (prior.kind !== "changed") return spec;
    const { publish_revoked_content: _approved, ...rest } = spec;
    const next: CorteSpec = { ...rest, publish_revoked_at: nowIso, publish_revoked_reason_kind: "content" };
    io.log(`[aviso] corte "${spec.slug}": ${prior.reason}; a queda do "pode publicar" passa a ser por conteúdo (só um novo --publish --confirm-publish devolve)`);
    writeFileAtomic(specPath, JSON.stringify(next, null, 2) + "\n");
    return next;
  }
  const check = corteContentCheck(spec.publish_confirmed_content, corteContentFingerprint(dir, spec));
  if (check.kind !== "changed") return spec;
  const next = revokeCorteAuthorization(spec, nowIso, check.reason, "content", io);
  writeFileAtomic(specPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** #12960: só agenda o item existente quando cada destino tem envio ou timer autorizado. */
export function syncCorteAgendamento(root: string, spec: CorteSpec, entries: readonly ShortPublishedEntry[], timerDestinations: readonly string[], now: Date): void {
  const origem = parseCorteSlug(spec.slug);
  if (!origem) return;
  const path = agendamentosPath(root);
  const banco = loadAgendamentos(path);
  const item = banco.itens.find(it => it.id === `${origem.edicao}-${pecaDoCorte(origem.corte)}`);
  if (!item || item.estado === "agendado" || item.estado === "publicado") return;
  const authorized = corteAuthorizedDestinations(spec) ?? [];
  const covered = item.destinos.every(dest =>
    entries.some(e => e.destination === dest && (e.status === "scheduled" || e.status === "published")) ||
    (timerDestinations.includes(dest) && authorized.includes(dest)),
  );
  if (!covered) return;
  saveAgendamentos(path, transicionarAgendamento(banco, {
    id: item.id, para: "agendado", nota: `modo corte ${spec.slug}: destinos com envio registrado ou timer autorizado (#12960)`,
  }, now));
}

/**
 * #12960 (review): o post já saiu quando o banco é sincronizado, então erro do
 * banco (arquivo ilegível, revisão concorrente, spec do corte ilegível) não
 * pode derrubar a rodada antes do resumo e da limpeza. Vira aviso explícito
 * em stderr, com o erro, e devolve `false` para quem quiser saber.
 */
export function syncCorteAgendamentoFailSoft(
  sync: () => void,
  warn: (msg: string) => void = (msg) => console.error(msg),
): boolean {
  try {
    sync();
    return true;
  } catch (e) {
    warn(
      `[aviso] modo corte: o post saiu, mas o banco de agendamentos não foi atualizado (#12960) — ` +
        `marque o item como agendado à mão. Erro: ${(e as Error)?.message ?? String(e)}`,
    );
    return false;
  }
}

/**
 * #11912: grava no `corte.json` a autorização do `--publish --confirm-publish`.
 * `main` chama só depois de TODAS as validações que podem abortar a rodada
 * (confirmação, escopo dos timers, plano com o `--only`, vídeo presente) e
 * antes do 1º envio: um `--publish` que sai com exit 2 não deixa o corte
 * autorizado. `onlyRaw` é o `--only` da rodada; `known` são os destinos
 * válidos da config (`knownDestinationIds`) e, sem `--only`, viram a lista
 * gravada (destino ligado depois não herda a autorização). Destino
 * desconhecido lança antes de ler ou gravar qualquer coisa: nome errado no
 * marcador faria o timer ignorar o destino certo. `content` é a impressão
 * digital dos bytes que esta rodada publica (o vídeo já lido e a capa do
 * `readShortCover`); vídeo ausente lança. #11923: `coverUnreadable` (o
 * `unreadable` do `readShortCover`: a capa existe e a leitura falhou) também
 * lança — gravar `cover_sha256: null` faria o timer alarmar `content-changed`
 * falso quando a capa voltasse a ser lida.
 */
export function recordCortePublishAuthorization(
  dir: string,
  onlyRaw: string | undefined,
  known: ReadonlySet<string>,
  content: CorteContentFingerprint,
  nowIso: string,
  log: (line: string) => void,
  coverUnreadable?: string,
): void {
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const unknown = (only ?? []).filter((d) => !known.has(d));
  if (unknown.length) {
    throw new Error(`"pode publicar" não gravado: --only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...known].join(", ")})`);
  }
  if (coverUnreadable !== undefined) {
    throw new Error(`"pode publicar" não gravado: a capa do corte existe mas não pôde ser lida (${coverUnreadable}); rode de novo quando o arquivo estiver acessível`);
  }
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  if (content.video_sha256 === null) throw new Error(`"pode publicar" não gravado: vídeo do corte ausente (${resolveCorteVideo(dir, spec.video)})`);
  const next = withCortePublishAuthorization(spec, only ?? [...known], content, nowIso);
  if (!next.changed) return;
  writeFileAtomic(specPath, JSON.stringify(next.spec, null, 2) + "\n");
  log(`[ok] corte "${spec.slug}": "pode publicar" gravado em ${specPath} (destinos: ${(corteAuthorizedDestinations(next.spec) ?? []).join(", ")})`);
}

/** #11912: por que o filho do timer recusou; o timer mapeia para o alarme (`interpretCorteTimerOutput`). */
export type CorteAuthorizationRefusal = "revoked" | "content-changed" | "missing-content" | "spec-unreadable" | "replanned";

/**
 * #11912: `--require-corte-authorization` (o filho do timer do 300). Confere,
 * sem gravar nada, que a autorização atual do `corte.json` cobre esta rodada:
 * existe, cobre todo o `--only` (obrigatório) e o vídeo/capa que a rodada
 * publica batem com a impressão digital. `null` = pode publicar.
 */
export function corteRunAuthorizationError(
  spec: CorteSpec,
  only: readonly string[] | null,
  content: CorteContentFingerprint,
): { refused: CorteAuthorizationRefusal; reason: string } | null {
  const authorized = corteAuthorizedDestinations(spec);
  if (!authorized) {
    return { refused: "revoked", reason: `corte "${spec.slug}" sem o "pode publicar" no corte.json${spec.publish_revoked_at ? ` (caiu em ${spec.publish_revoked_at})` : ""}` };
  }
  if (!only || !only.length) return { refused: "revoked", reason: "--require-corte-authorization exige --only (os destinos que o timer vai publicar)" };
  const outside = only.filter((d) => !authorized.includes(d));
  if (outside.length) return { refused: "revoked", reason: `destinos fora do "pode publicar" do corte "${spec.slug}": ${outside.join(", ")} (autorizados: ${authorized.join(", ")})` };
  const check = corteContentCheck(spec.publish_confirmed_content, content);
  if (check.kind === "ok") return null;
  return { refused: check.kind === "missing" ? "missing-content" : "content-changed", reason: `corte "${spec.slug}": ${check.reason}` };
}

/**
 * #11912 (H): o `corte.json` relido logo antes de publicar ainda é o plano
 * com que esta rodada montou título e gancho? Lista os campos que mudaram no
 * meio (outra máquina regravou o corte); vazio = o mesmo plano. Puro.
 */
export function corteRunSpecDrift(fresh: CorteSpec, used: CorteSpec): string[] {
  return (["title", "hook", "date", "hhmm", "video"] as const).filter((k) => fresh[k] !== used[k]);
}

/**
 * Puro: a recusa do filho do timer (`--require-corte-authorization`), com o
 * `corte.json` relido logo antes de publicar (`fresh`) e a spec com que a
 * rodada montou título e gancho (`used`). `null` = pode publicar.
 *
 * #11923: plano que mudou no meio da rodada com o "pode publicar" do plano
 * NOVO já gravado (o editor restaurou enquanto o filho rodava) é `replanned`:
 * nada sai com o plano velho, mas o timer não alarma `revoked` (a próxima
 * execução publica o plano novo). Sem autorização para o plano novo segue
 * `revoked`.
 */
export function corteTimerChildRefusal(
  fresh: CorteSpec,
  used: CorteSpec,
  only: readonly string[] | null,
  content: CorteContentFingerprint,
): { refused: CorteAuthorizationRefusal; reason: string } | null {
  const drift = corteRunSpecDrift(fresh, used);
  const authError = corteRunAuthorizationError(fresh, only, content);
  if (!drift.length) return authError;
  const changed = `o corte.json mudou durante a rodada (${drift.join(", ")}): nada publicado com o plano velho`;
  return authError === null
    ? { refused: "replanned", reason: `${changed}; o plano novo já tem o "pode publicar" e sai na próxima execução do timer` }
    : { refused: "revoked", reason: changed };
}

/**
 * #11912: `--update-scheduled --publish --confirm-publish` do corte. Corrigir
 * título/gancho derruba a autorização (queda `plan`); a confirmação desta
 * rodada é o "pode publicar" do plano novo, então ele volta para os destinos
 * derrubados (`planCorteAuthorizationRestore`: só queda `plan`, só destinos da
 * config, só os do `--only`), desde que o vídeo e a capa nesta máquina sejam
 * os aprovados antes da queda. `main` chama só depois de as atualizações
 * terem dado certo. Nunca lança: o motivo de não restaurar volta no JSON.
 */
export function restoreCorteAuthorizationAfterUpdate(
  dir: string,
  nowIso: string,
  known: ReadonlySet<string>,
  only: readonly string[] | null,
  log: (line: string) => void,
): { restored: true; destinations: string[] } | { restored: false; reason: string } {
  try {
    return restoreCorteAuthorizationAfterUpdateUnsafe(dir, nowIso, known, only, log);
  } catch (e) {
    // #11923: as atualizações já deram certo; uma leitura/escrita falha aqui não pode perder o JSON final.
    return { restored: false, reason: `falha ao regravar o "pode publicar": ${(e as Error).message}` };
  }
}

function restoreCorteAuthorizationAfterUpdateUnsafe(
  dir: string,
  nowIso: string,
  known: ReadonlySet<string>,
  only: readonly string[] | null,
  log: (line: string) => void,
): { restored: true; destinations: string[] } | { restored: false; reason: string } {
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  const plan = planCorteAuthorizationRestore(spec, only, known);
  if (!plan.ok) return { restored: false, reason: plan.reason };
  const content = corteContentFingerprint(dir, spec);
  if (content.video_sha256 === null) {
    return { restored: false, reason: `vídeo do corte ausente nesta máquina (${resolveCorteVideo(dir, spec.video)}): rode --publish --confirm-publish onde o vídeo está` };
  }
  const check = corteContentCheck(spec.publish_revoked_content, content);
  if (check.kind !== "ok") return { restored: false, reason: `${check.reason}: dê o "pode publicar" explícito com --publish --confirm-publish` };
  const next = withCortePublishAuthorization(spec, plan.destinations, content, nowIso);
  if (next.changed) writeFileAtomic(specPath, JSON.stringify(next.spec, null, 2) + "\n");
  log(`[ok] corte "${spec.slug}": "pode publicar" regravado com o plano corrigido (destinos: ${plan.destinations.join(", ")})`);
  return { restored: true, destinations: plan.destinations };
}

/**
 * Puro (#11955): os destinos cuja falha no `--update-scheduled` segura a
 * regravação do "pode publicar" do corte. O `youtube_shorts` não entra: a falha
 * dele (escopo do token, vídeo já no ar) tem contorno no YouTube Studio e não
 * muda o que o timer do 300 publica (LinkedIn e Threads pessoais, Instagram);
 * sem isso uma falha só no YouTube deixava os timers parados até um
 * `--publish --confirm-publish` extra.
 */
export function corteRestoreBlockingFailures(results: ReadonlyArray<{ destination: string; ok: boolean }>): string[] {
  return results.filter((r) => !r.ok && r.destination !== "youtube_shorts").map((r) => r.destination);
}

/** #13000: flags que não combinam com `--cancel`/`--reschedule` (eles só mexem no horário do corte). */
export const CORTE_LIFECYCLE_FORBIDDEN_VALUES = ["title", "hook", "video", "from-drive", "cover", "mark", "only", "confirm-publish", "edition"] as const;
export const CORTE_LIFECYCLE_FORBIDDEN_FLAGS = ["publish", "now", "update-scheduled", "require-corte-authorization", "force-youtube"] as const;

/**
 * Puro (#13000): confere a combinação de flags do `--cancel`/`--reschedule`.
 * `null` = ok, senão a mensagem de uso.
 */
export function corteLifecycleArgsError(flags: ReadonlySet<string>, values: Record<string, string | undefined>): string | null {
  const cancel = flags.has("cancel");
  const reschedule = flags.has("reschedule");
  if (!cancel && !reschedule) return null;
  if (cancel && reschedule) return "--cancel e --reschedule não combinam";
  const name = cancel ? "--cancel" : "--reschedule";
  if (values["corte"] === undefined) return `${name} só vale com --corte SLUG (o vertical da edição não tem este caminho, #13000)`;
  const bad = [
    ...CORTE_LIFECYCLE_FORBIDDEN_VALUES.filter((k) => values[k] !== undefined),
    ...CORTE_LIFECYCLE_FORBIDDEN_FLAGS.filter((f) => flags.has(f)),
  ];
  if (bad.length) return `${name} não combina com ${bad.map((k) => `--${k}`).join(", ")} (só mexe no horário do corte; aplique com --confirm SLUG)`;
  if (cancel && (values["date"] !== undefined || values["at"] !== undefined)) return "--cancel não leva --date/--at";
  if (reschedule && (values["date"] === undefined || values["at"] === undefined)) return "--reschedule precisa de --date AAMMDD e --at HH:MM";
  if (values["confirm"] !== undefined && values["confirm"] !== values["corte"]) {
    return `--confirm precisa repetir o slug do corte (${values["corte"]}), recebeu ${JSON.stringify(values["confirm"])}`;
  }
  return null;
}

/**
 * #13000: `--corte SLUG --cancel` / `--reschedule --date AAMMDD --at HH:MM`.
 * Sem `--confirm SLUG`, só o plano (nada é tocado). Com ele:
 *   - cancelar: primeiro tira o "pode publicar" do corte.json (o timer do 300
 *     para de agir mesmo que a rodada caia no meio), depois YouTube (private
 *     sem agendamento) e Facebook (DELETE do agendado), e regrava o corte.json
 *     com os destinos de fato cancelados;
 *   - reagendar: YouTube e Facebook para o horário novo e, só se nenhum
 *     falhar, `date`/`hhmm` no corte.json (o timer do 300 segue o novo) e
 *     `scheduled_at` no registro (com o `aammdd` realinhado, #12998). O "pode
 *     publicar" fica: o `--confirm` é a decisão do editor sobre o horário.
 * Buffer (X/TikTok) volta como instrução para a skill. Já publicado nunca é
 * tocado.
 */
export async function runCorteLifecycle(input: { dir: string; slug: string; flags: ReadonlySet<string>; values: Record<string, string> }): Promise<number> {
  const { dir, slug, values } = input;
  const specPath = join(dir, CORTE_SPEC_FILE);
  if (!existsSync(specPath)) {
    console.error(`publish-shorts: ${specPath} não existe: não há corte "${slug}" para cancelar/reagendar`);
    return 2;
  }
  let spec: CorteSpec;
  let entries: ShortPublishedEntry[];
  let openMarks: ReturnType<typeof openSendingMarks>;
  try {
    spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
    entries = readShortsRegistry(dir, spec.date).entries;
    openMarks = openSendingMarks(readShortsSending(dir, spec.date), entries);
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  const op: CorteLifecycleOp = input.flags.has("cancel") ? { kind: "cancel" } : { kind: "reschedule", date: values["date"], hhmm: values["at"] };
  const label = op.kind === "cancel" ? "cancel" : "reschedule";
  const plan = planCorteLifecycle({ op, spec, entries, openMarks, now: new Date() });
  for (const i of plan.items) if (i.action === "refuse") console.error(`[aviso] ${i.destination}: ${i.reason}`);
  const apply = values["confirm"] === slug;
  if (plan.blockers.length) {
    for (const b of plan.blockers) console.error(`[erro] ${b}`);
    console.log(JSON.stringify({ dry_run: !apply, [label]: true, corte: slug, plan, applied: false }, null, 2));
    return 1;
  }
  if (!apply) {
    console.error(`[premissa] plano apenas (nada foi tocado): para aplicar, repita com --confirm ${slug}`);
    console.log(JSON.stringify({ dry_run: true, [label]: true, corte: slug, plan }, null, 2));
    return 0;
  }
  const rereadSpec = () => parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  const timerDests = plan.items.filter((i) => i.action === "corte_timer").map((i) => i.destination);
  if (op.kind === "cancel") {
    // Antes de qualquer API: o timer do 300 deixa de publicar mesmo que esta rodada caia no meio.
    writeFileAtomic(specPath, JSON.stringify(withCorteCancellation(rereadSpec(), new Date().toISOString(), timerDests), null, 2) + "\n");
    console.error(`[ok] corte "${slug}": "pode publicar" retirado (o timer do 300 não publica ${timerDests.length ? timerDests.join(", ") : "nada"})`);
  }
  const persistDate = op.kind === "reschedule" ? op.date : spec.date;
  let pagesCache: ReturnType<typeof loadResolvedFacebookPages> | null = null;
  const pages = () => (pagesCache ??= loadResolvedFacebookPages(ROOT, JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))));
  const page = (pageSlug: string): ResolvedFacebookPage => {
    const p = pages().pages.find((x) => x.slug === pageSlug);
    if (!p || p.missing.length) throw new Error(`página ${pageSlug} sem credencial (${p ? p.missing.join(", ") : "fora de publishing.social.facebook.pages"})`);
    return p;
  };
  const results = await executeCorteLifecycle(plan, entries, {
    youtube: async (videoId, publishAt) => {
      const missing = missingYouTubeCredentials(process.env);
      if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
      await rescheduleScheduledVideo(defaultYouTubeUploadDeps, {
        clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (process.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (process.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      }, videoId, publishAt, CORTE_LIFECYCLE_MIN_LEAD_MS);
    },
    facebookCancel: (pageSlug, videoId) => cancelFacebookScheduledVideo(defaultGraphDeps, page(pageSlug), pages().apiVersion, videoId),
    facebookReschedule: (pageSlug, videoId, at) => rescheduleFacebookScheduledVideo(defaultGraphDeps, page(pageSlug), pages().apiVersion, videoId, at),
    persist: (entry) => {
      persistShortEntry(dir, persistDate, "main", entry);
    },
    now: () => new Date(),
  });
  for (const r of results) {
    if (r.outcome === "failed") console.error(`[erro] ${r.destination}: ${r.error}`);
    else if (r.outcome === "skill") console.error(`[ok] ${r.destination}: falta o ${r.buffer!.tool} na Buffer (skill), post ${r.buffer!.bufferId}`);
    else if (r.outcome === "done") console.error(`[ok] ${r.destination}: ${op.kind === "cancel" ? "agendamento cancelado" : `reagendado para ${plan.newAt}`}`);
    if (r.warning) console.error(`[aviso] ${r.destination}: ${r.warning}`);
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.destination);
  const stillLive = results.filter((r) => r.outcome === "refused").map((r) => r.destination);
  let corteJson: string;
  if (op.kind === "cancel") {
    const cancelled = [...timerDests, ...results.filter((r) => r.outcome === "done").map((r) => r.destination)];
    const cur = rereadSpec();
    writeFileAtomic(specPath, JSON.stringify({ ...cur, cancelled_destinations: [...new Set([...(cur.cancelled_destinations ?? []), ...cancelled])] }, null, 2) + "\n");
    corteJson = `cancelado (destinos: ${cancelled.join(", ") || "nenhum"})`;
    if (stillLive.length || failed.length) {
      console.error(`[aviso] corte "${slug}": cancelamento PARCIAL — ${[...stillLive.map((d) => `${d} (recusado)`), ...failed.map((d) => `${d} (falhou)`)].join(", ")} segue(m) como estava(m)`);
    }
  } else if (failed.length) {
    corteJson = `NÃO alterado: ${failed.join(", ")} falhou; o timer do 300 segue no horário antigo (${spec.hhmm} BRT de ${spec.date}). Corrija e rode de novo (o que já mudou vira noop)`;
    console.error(`[erro] corte "${slug}": ${corteJson}`);
  } else {
    const cur = rereadSpec();
    writeFileAtomic(specPath, JSON.stringify({ ...cur, date: op.date, hhmm: op.hhmm }, null, 2) + "\n");
    corteJson = `reagendado para ${op.hhmm} BRT de ${op.date}`;
    console.error(`[ok] corte "${slug}": corte.json ${corteJson} (o timer do 300 segue o horário novo)`);
  }
  console.log(JSON.stringify({ dry_run: false, [label]: true, corte: slug, plan, results, corte_json: corteJson, ...(stillLive.length ? { still_live: stillLive } : {}) }, null, 2));
  return failed.length ? 1 : 0;
}
