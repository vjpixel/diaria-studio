/**
 * scripts/lib/diaria/short-scheduled-replace.ts (#12279)
 *
 * Troca o vídeo de um vertical JÁ AGENDADO (V1 por V2) com
 * `publish-shorts.ts AAMMDD --replace-scheduled`. Nenhuma plataforma troca a
 * mídia de um post existente: o post antigo sai (YouTube: volta a private sem
 * agendamento, nada apagado; Facebook: `DELETE` do agendado; X/TikTok: a skill
 * apaga na Buffer) e um novo sobe NO MESMO HORÁRIO.
 *
 * ## Desenho (decisão do editor de 15/11/2026: exceção explícita no grant)
 *
 * 1. Dry-run `--replace-scheduled`: escolhe os alvos (`planScheduledReplacements`)
 *    e grava o manifesto de SUBSTITUIÇÃO
 *    (`_internal/video-publish-plan.vertical-replace.json`): por destino, o ID
 *    do post antigo e o horário dele (`replaces`), o hash dos bytes novos
 *    (`media.video_sha256`) e o texto. O `plan_sha256` vai ao editor.
 * 2. `video-publish-authorize.ts grant AAMMDD --part vertical --replace-scheduled`:
 *    a única exceção à recusa de nova autorização para destino já registrado
 *    (`retryRefusal`, #12654). O grant confere o manifesto contra o registro
 *    local (`replacementGrantRefusal`): o ID ainda é o registrado, agendado,
 *    no mesmo horário, com folga.
 * 3. `--replace-scheduled --publish`: sob o lock da substituição, consome a
 *    autorização de TODOS os alvos ANTES da 1ª exclusão
 *    (`runScheduledReplacement`); consumo recusado = nada apagado. Depois, por
 *    destino de API: relê a plataforma, cancela o post antigo, grava o
 *    histórico (`recordShortReplacement`) e só então o envio novo sai no
 *    horário preservado (nunca "na hora"). X/TikTok: o publisher só sobe o
 *    vídeo novo ao R2 e devolve `pending_buffer_create`; a skill apaga o post
 *    antigo e cria o novo DEPOIS dessa rodada (o consumo já aconteceu).
 *
 * Sem I/O aqui: as dependências entram por parâmetro.
 */
import type { ShortPublishedEntry } from "./short-video.ts";
import type { ShortSendingMark } from "./shorts-sending-marker.ts";
import type { VideoPlanManifest } from "./video-publish-plan.ts";

/** Folga mínima entre agora e o horário do post antigo para trocá-lo (plano, grant e antes de apagar). */
export const REPLACE_MIN_LEAD_MS = 30 * 60_000;

/** Folga mínima para o envio novo sair AGENDADO (abaixo disso o publisher sairia "na hora": recusado). */
export const REPLACE_UPLOAD_MIN_LEAD_MS = 10 * 60_000;

/** ID de post da Buffer no registro (`buffer:{id}`): a mesma regra em todo o fluxo da troca. */
export const BUFFER_ID_RE = /^buffer:[A-Za-z0-9_-]+$/;

interface ShortReplacementTargetBase {
  destination: string;
  /** Horário do post antigo: o envio novo sai nele. */
  at: string;
}

/** Alvo de API (YouTube Shorts, Facebook): o publisher cancela e sobe de novo. */
export interface ApiReplacementTarget extends ShortReplacementTargetBase {
  kind: "api";
  /** ID do vídeo antigo na plataforma. */
  old_id: string;
}

/** Alvo da Buffer (X, TikTok): a skill apaga e cria pela MCP. */
export interface BufferReplacementTarget extends ShortReplacementTargetBase {
  kind: "buffer";
  /** `buffer:{id}` do post antigo. */
  old_id: string;
}

export type ShortReplacementTarget = ApiReplacementTarget | BufferReplacementTarget;

export interface ShortReplacementSkip {
  destination: string;
  reason: string;
}

export interface ShortReplacementSelection {
  targets: ShortReplacementTarget[];
  skipped: ShortReplacementSkip[];
}

/** Destino com API de cancelamento de agendado (o publisher apaga e sobe de novo). */
export function isApiReplaceableDestination(destination: string): boolean {
  return destination === "youtube_shorts" || destination.startsWith("facebook:");
}

/** Destino da Buffer (a skill apaga e cria pela MCP). */
export function isBufferReplaceableDestination(destination: string, id: string): boolean {
  return (destination === "x" || destination === "tiktok") && BUFFER_ID_RE.test(id);
}

/**
 * Pure: os destinos que a substituição troca. Só post AGENDADO no registro,
 * com horário a mais de `REPLACE_MIN_LEAD_MS`, sem envio em aberto, num
 * destino com caminho de troca, e com bytes diferentes do vídeo novo (mesmo
 * hash registrado = nada a trocar). Publicado, envio ambíguo (`send_unknown`),
 * cancelado ou horário desconhecido nunca é trocado. `only` com destino sem
 * registro lança (o pedido não bate com o registro).
 */
export function planScheduledReplacements(
  entries: readonly ShortPublishedEntry[],
  input: { now: Date; only: readonly string[] | null; videoSha256: string; openMarks?: readonly ShortSendingMark[] },
): ShortReplacementSelection {
  if (input.only) {
    const missing = input.only.filter((d) => !entries.some((e) => e.destination === d));
    if (missing.length) throw new Error(`--only com destino sem registro (nada agendado a trocar): ${missing.join(", ")}`);
  }
  const targets: ShortReplacementTarget[] = [];
  const skipped: ShortReplacementSkip[] = [];
  for (const e of entries) {
    if (input.only && !input.only.includes(e.destination)) continue;
    const skip = (reason: string) => skipped.push({ destination: e.destination, reason });
    const api = isApiReplaceableDestination(e.destination);
    const buffer = isBufferReplaceableDestination(e.destination, e.id);
    if (!api && !buffer) {
      skip("destino sem caminho de troca de post agendado (só YouTube Shorts, Facebook, X e TikTok)");
      continue;
    }
    if (e.status !== "scheduled") {
      skip(`registro ${e.status}: só post AGENDADO é trocado (publicado ou envio ambíguo fica como está)`);
      continue;
    }
    if (e.cancelled_at) {
      skip(`agendamento cancelado em ${e.cancelled_at}`);
      continue;
    }
    const atMs = e.scheduled_at ? Date.parse(e.scheduled_at) : Number.NaN;
    if (!e.scheduled_at || Number.isNaN(atMs)) {
      skip("registro sem horário do agendamento: nada a preservar");
      continue;
    }
    if (atMs - input.now.getTime() <= REPLACE_MIN_LEAD_MS) {
      skip(`horário ${e.scheduled_at} a ${Math.round(REPLACE_MIN_LEAD_MS / 60_000)} min ou menos: não dá para trocar com segurança`);
      continue;
    }
    if (input.openMarks?.some((m) => m.destination === e.destination)) {
      skip("envio em curso ou sem desfecho (marca de envio aberta): confira a conta antes de trocar");
      continue;
    }
    if (e.video_sha256 && e.video_sha256 === input.videoSha256) {
      skip("o post agendado já tem estes bytes (mesmo video_sha256): nada a trocar");
      continue;
    }
    const atIso = new Date(atMs).toISOString();
    targets.push(api ? { destination: e.destination, kind: "api", old_id: e.id, at: atIso } : { destination: e.destination, kind: "buffer", old_id: e.id, at: atIso });
  }
  return { targets, skipped };
}

/**
 * Pure: o plano do vertical para os alvos, com o horário PRESERVADO de cada
 * post antigo. Cada alvo precisa sair na rodada (`publish` para os de API,
 * `buffer` para X/TikTok); qualquer outra ação recusa a substituição inteira
 * (nada é apagado). Devolve só os itens dos alvos.
 */
export function applyReplacementTimes<T extends { destination: string; action: string }>(
  items: readonly T[],
  targets: readonly ShortReplacementTarget[],
): { ok: true; items: T[] } | { ok: false; error: string } {
  const out: T[] = [];
  const errors: string[] = [];
  for (const t of targets) {
    const item = items.find((i) => i.destination === t.destination);
    const want = t.kind === "api" ? "publish" : "buffer";
    if (!item || item.action !== want) {
      errors.push(`${t.destination}: o envio novo não sai nesta rodada (plano: ${item?.action ?? "ausente"}; esperado ${want})`);
      continue;
    }
    out.push({ ...item, scheduledAt: t.at });
  }
  return errors.length ? { ok: false, error: `${errors.join("; ")}: nada apagado` } : { ok: true, items: out };
}

/**
 * Pure: o grant de substituição confere o manifesto contra o registro local
 * (a plataforma é relida pelo publisher antes de apagar). Cada destino trocado
 * precisa estar no registro com o MESMO ID, agendado, no MESMO horário e com
 * folga. `null` = confere; senão, o motivo.
 */
export function replacementGrantRefusal(
  manifest: VideoPlanManifest,
  entries: readonly ShortPublishedEntry[],
  now: Date,
  openMarks: readonly ShortSendingMark[] = [],
): string | null {
  const problems: string[] = [];
  for (const d of manifest.destinations) {
    if (!d.replaces) {
      problems.push(`${d.id}: sem o post antigo no plano`);
      continue;
    }
    const e = entries.find((x) => x.destination === d.id);
    if (!e) {
      problems.push(`${d.id}: sem registro (o post ${d.replaces.id} já foi trocado ou nunca foi registrado)`);
      continue;
    }
    if (e.id !== d.replaces.id) {
      problems.push(`${d.id}: o registro aponta ${e.id}, não o ${d.replaces.id} do plano`);
      continue;
    }
    if (e.status !== "scheduled" || e.cancelled_at) {
      problems.push(`${d.id}: o post ${e.id} não está agendado no registro (${e.cancelled_at ? `cancelado em ${e.cancelled_at}` : e.status})`);
      continue;
    }
    const regMs = e.scheduled_at ? Date.parse(e.scheduled_at) : Number.NaN;
    if (Number.isNaN(regMs) || regMs !== Date.parse(d.replaces.at) || d.effective_at === null || Date.parse(d.effective_at) !== regMs) {
      problems.push(`${d.id}: o horário do plano (${d.effective_at ?? "nenhum"}) não é o do post agendado (${e.scheduled_at ?? "nenhum"})`);
      continue;
    }
    if (regMs - now.getTime() <= REPLACE_MIN_LEAD_MS) {
      problems.push(`${d.id}: o horário ${e.scheduled_at} está a ${Math.round(REPLACE_MIN_LEAD_MS / 60_000)} min ou menos`);
      continue;
    }
    if (openMarks.some((m) => m.destination === d.id)) problems.push(`${d.id}: envio em curso ou sem desfecho (marca de envio aberta)`);
  }
  return problems.length ? `substituição recusada (#12279): ${problems.join("; ")}` : null;
}

/**
 * Desfecho por alvo da fase destrutiva. `cancelled`: post antigo fora e
 * histórico gravado (segue para o envio novo); `buffer`: fica com a skill;
 * `failed`: nada cancelado (ou cancelado sem histórico, `phase: "record"`),
 * sem envio novo; `uncertain`: a escrita na plataforma saiu e a resposta não
 * confirmou: o post antigo PODE ter sido cancelado, a marca "cancelando" fica
 * e nada é enviado até o editor conferir a conta.
 */
export type ReplacementCancelResult =
  | { outcome: "cancelled"; target: ApiReplacementTarget }
  | { outcome: "buffer"; target: BufferReplacementTarget }
  | { outcome: "failed"; target: ApiReplacementTarget; phase: "cancel" | "record"; error: string }
  | { outcome: "uncertain"; target: ApiReplacementTarget; phase: "cancel"; error: string };

export interface ReplacementPhaseDeps {
  /** Consome (uso único) a autorização de substituição de todos os alvos. Chamado ANTES de qualquer exclusão. */
  consume: () => { ok: true } | { ok: false; error: string };
  /**
   * Relê a plataforma e cancela o post antigo. `onBeforeWrite` é chamado logo
   * antes da escrita (o `videos.update`/`DELETE`): exceção antes dele = nada
   * alterado; depois dele = desfecho incerto.
   */
  cancel: (target: ApiReplacementTarget, onBeforeWrite: () => void) => Promise<void>;
  /** Grava a marca "cancelando" do destino ANTES de chamar a plataforma (a releitura e o dry-run a acusam). */
  markCancelling: (target: ApiReplacementTarget) => void;
  /** Tira a marca "cancelando" quando a plataforma recusou antes de qualquer escrita. */
  clearCancelling: (destination: string) => void;
  /** Grava o histórico da substituição (só depois do cancelamento confirmado). */
  record: (target: ApiReplacementTarget) => void;
  /** Limpa as marcas de envio do destino (o post antigo saiu). */
  clearMarks: (destination: string) => void;
  /** Relê o registro: o alvo ainda é o mesmo post? (outra sessão pode ter mexido). */
  stillRegistered: (target: ShortReplacementTarget) => boolean;
  /** Aviso não fatal (marca não apagada). */
  warn: (message: string) => void;
}

/**
 * #12279: a fase destrutiva da substituição. Ordem fixa: (1) consumo da
 * autorização de TODOS os alvos (recusa = nada apagado, `refused`); (2) por
 * alvo de API, releitura do registro, marca "cancelando", cancelamento na
 * plataforma, histórico e limpeza das marcas. Falha num alvo não desfaz os
 * outros (a troca não é atômica entre plataformas) e o alvo que falhou ou
 * ficou incerto não recebe envio novo. Os alvos da Buffer não são tocados
 * aqui: a skill apaga depois desta rodada.
 */
export async function runScheduledReplacement(
  targets: readonly ShortReplacementTarget[],
  deps: ReplacementPhaseDeps,
): Promise<{ refused: string } | { refused: null; results: ReplacementCancelResult[] }> {
  if (!targets.length) return { refused: "nenhum post agendado a trocar" };
  const auth = deps.consume();
  if (!auth.ok) return { refused: auth.error };
  const results: ReplacementCancelResult[] = [];
  for (const target of targets) {
    if (target.kind === "buffer") {
      results.push({ target, outcome: "buffer" });
      continue;
    }
    const fail = (error: string, phase: "cancel" | "record" = "cancel") => results.push({ target, outcome: "failed", phase, error });
    let same: boolean;
    try {
      same = deps.stillRegistered(target);
    } catch (e) {
      fail(`post antigo ${target.old_id} NÃO cancelado: registro ilegível na releitura (${(e as Error).message})`);
      continue;
    }
    if (!same) {
      fail(`o registro de ${target.destination} mudou desde o plano (não é mais o post ${target.old_id} agendado): nada cancelado`);
      continue;
    }
    try {
      deps.markCancelling(target);
    } catch (e) {
      fail(`post antigo ${target.old_id} NÃO cancelado: marca de cancelamento não gravada (${(e as Error).message})`);
      continue;
    }
    let sent = false;
    try {
      await deps.cancel(target, () => {
        sent = true;
      });
    } catch (e) {
      if (sent) {
        results.push({
          target,
          outcome: "uncertain",
          phase: "cancel",
          error: `o cancelamento do post antigo ${target.old_id} saiu e a resposta não confirmou (${(e as Error).message}): ele PODE ter sido cancelado. Confira a conta antes de qualquer coisa; nada enviado, a marca "cancelando" fica`,
        });
        continue;
      }
      try {
        deps.clearCancelling(target.destination);
      } catch (ce) {
        deps.warn(`${target.destination}: marca "cancelando" não apagada (${(ce as Error).message}): a releitura vai acusá-la`);
      }
      fail(`post antigo ${target.old_id} NÃO cancelado: ${(e as Error).message}`);
      continue;
    }
    try {
      deps.record(target);
    } catch (e) {
      // O post antigo já saiu: sem o histórico, o registro ainda o aponta. O envio novo não sai, a marca fica.
      fail(
        `post antigo ${target.old_id} CANCELADO na plataforma, mas o histórico da substituição não foi gravado (${(e as Error).message}): nada enviado. ` +
          `A marca "cancelando" de ${target.destination} FICA e trava as próximas rodadas (a releitura a acusa e a troca pula o destino). ` +
          `Registre o histórico à mão (_internal/06-shorts-replaced.json: destination ${target.destination}, id ${target.old_id}, scheduled_at ${target.at}) ` +
          `e só então tire a marca de _internal/06-shorts-sending*.json`,
        "record",
      );
      continue;
    }
    try {
      deps.clearMarks(target.destination);
    } catch (e) {
      deps.warn(`${target.destination}: marcas de envio não apagadas (${(e as Error).message}): a releitura vai acusá-las como "pode ter saído"`);
    }
    results.push({ target, outcome: "cancelled" });
  }
  return { refused: null, results };
}

/** Pure: os destinos que recebem envio novo (cancelado na API, ou Buffer com a skill). */
export function replacementSurvivors(results: readonly ReplacementCancelResult[]): Set<string> {
  return new Set(results.filter((r) => r.outcome === "cancelled" || r.outcome === "buffer").map((r) => r.target.destination));
}

/** Pure: o envio novo sai agendado no horário preservado, com folga (`null` = ok), para qualquer destino. */
export function replacementUploadRefusal(scheduledAt: string | null | undefined, now: Date): string | null {
  const atMs = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  if (!Number.isNaN(atMs) && atMs - now.getTime() > REPLACE_UPLOAD_MIN_LEAD_MS) return null;
  return `horário preservado (${scheduledAt ?? "nenhum"}) a ${Math.round(REPLACE_UPLOAD_MIN_LEAD_MS / 60_000)} min ou menos: a substituição não publica na hora, nada enviado`;
}

/** Pure: a mensagem de uma falha de envio novo DEPOIS de o post antigo ter sido cancelado. */
export function afterCancelMessage(target: ShortReplacementTarget | undefined, msg: string): string {
  if (!target || target.kind !== "api") return msg;
  return (
    `post antigo ${target.old_id} já cancelado (histórico em _internal/06-shorts-replaced.json), envio novo FALHOU: ${msg}. ` +
    "Confira a conta antes de qualquer coisa (envio ambíguo fica send_unknown no registro). Recuperação: docs/shorts-replace-scheduled.md (#12279)"
  );
}

/**
 * Pure (#12279): os passos da skill para um alvo da Buffer, na ordem: conferir
 * e apagar o antigo, `--mark-replaced` logo depois do `delete_post`, criar o
 * novo e registrá-lo com `--replaces`.
 */
export function bufferReplaceNextSteps(destination: string, oldId: string, at: string, videoSha256: string): string {
  return (
    `get_post ${oldId.slice("buffer:".length)} (na fila, não enviado, dueAt ${at}), delete_post, ` +
    `logo em seguida --mark-replaced ${destination}=${oldId}, create_post com este buffer, ` +
    `e então --mark ${destination}=buffer:NOVO --replaces ${oldId} --scheduled-at ${at} --video-sha256 ${videoSha256}`
  );
}

/** Pure: o comando da rodada de substituição (dono dos destinos no manifesto). */
export function replacementPublishCommand(aammdd: string, source: { video?: string } = {}): string {
  const src = source.video ? ` --video ${source.video}` : "";
  return `npx tsx scripts/publish-shorts.ts ${aammdd} --replace-scheduled${src} --publish --confirm-publish ${aammdd}`;
}

/** Pure: aviso do dry-run quando o vídeo local não é o que um destino registrou (#12279). */
export function shortVideoChangeWarnings(entries: readonly ShortPublishedEntry[], videoSha256: string): string[] {
  return entries
    .filter((e) => e.video_sha256 && e.video_sha256 !== videoSha256)
    .map((e) =>
      e.status === "scheduled"
        ? `${e.destination}: o vídeo local não é o que este post agendado subiu (video_sha256 diferente): para trocar a mídia, publish-shorts.ts --replace-scheduled (#12279)`
        : `${e.destination}: o vídeo local não é o que este destino subiu (video_sha256 diferente, registro ${e.status}): post já no ar não é trocado (#12279)`,
    );
}
