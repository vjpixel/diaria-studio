/**
 * scripts/lib/diaria/short-corte-lifecycle.ts (#13000)
 *
 * Cancelar e reagendar um corte avulso (`publish-shorts.ts --corte SLUG
 * --cancel` / `--reschedule --date AAMMDD --at HH:MM`) depois de ele já estar
 * agendado. Em 13/11/2026 os dois saíram à mão: `deletePost`/`editPost` na
 * Buffer, `videos.update` no YouTube, `DELETE`/`scheduled_publish_time` no
 * Graph e edição de `corte.json` e do registro. O ajuste à mão esqueceu o
 * `aammdd` do registro e o timer do corte quebrou de hora em hora (#12998).
 *
 * Miolo PURO (`planCorteLifecycle`) + executor com I/O injetável
 * (`executeCorteLifecycle`). O que cada destino recebe:
 *   - `youtube_shorts` agendado: `videos.update` do `publishAt` (reagendar) ou
 *     private sem `publishAt` (cancelar: nada é apagado);
 *   - `facebook:{slug}` agendado: `POST /{video-id}` com
 *     `scheduled_publish_time` (reagendar) ou `DELETE /{video-id}` (cancelar),
 *     sempre depois de reler `published: false` e o horário com folga;
 *   - `x`/`tiktok` (Buffer): o script não alcança a Buffer (MCP, só a skill);
 *     o plano devolve o `delete_post`/`edit_post` que a skill executa;
 *   - Instagram, LinkedIn e Threads pessoais ainda não publicados: seguem o
 *     `corte.json` (o timer do 300), então reagendar é mudar `date`/`hhmm` e
 *     cancelar é tirar o "pode publicar";
 *   - o que já está no ar, envio ambíguo, horário já passado ou perto demais:
 *     RECUSADO. Cancelar nunca apaga conteúdo publicado.
 *
 * Folga mínima (`CORTE_LIFECYCLE_MIN_LEAD_MS`, 15 min): nenhuma operação mexe
 * num post a menos disso do horário dele. O horário de publicação agendada é
 * o da plataforma; a folga cobre a janela entre a releitura e a escrita. O
 * risco que sobra é o editor publicar à mão o mesmo post nessa janela de
 * milissegundos (registrado no corpo da PR).
 */

import { resolveEditionScheduledAt } from "../edition-scheduled-at.ts";
import { CORTE_TIMER_DESTINATIONS, corteAuthorizedDestinations, type CorteSpec } from "./short-corte.ts";
import type { ShortPublishedEntry } from "./short-video.ts";
import type { ShortSendingMark } from "./shorts-sending-marker.ts";

/** Nenhuma operação mexe num post a menos disto do horário dele. */
export const CORTE_LIFECYCLE_MIN_LEAD_MS = 15 * 60_000;

export type CorteLifecycleOp =
  | { kind: "cancel" }
  | { kind: "reschedule"; date: string; hhmm: string };

export type CorteLifecycleItem =
  | { destination: string; action: "youtube"; videoId: string; currentAt: string }
  | { destination: string; action: "facebook"; slug: string; videoId: string; currentAt: string }
  /** A skill executa na Buffer (`delete_post` no cancelamento, `edit_post` com `dueAt` no reagendamento). */
  | { destination: string; action: "buffer"; bufferId: string; currentAt: string }
  /** Destino do timer do 300, ainda não publicado: segue o `corte.json`. */
  | { destination: string; action: "corte_timer" }
  /** Já está no horário novo (re-execução depois de uma rodada parcial). */
  | { destination: string; action: "noop"; reason: string }
  /** Não é tocado; a operação segue para os outros. */
  | { destination: string; action: "refuse"; reason: string };

export interface CorteLifecyclePlan {
  op: CorteLifecycleOp;
  /** Horário atual do corte (ISO). */
  currentAt: string;
  /** Horário novo (ISO), só no reagendamento. */
  newAt: string | null;
  items: CorteLifecycleItem[];
  /** Motivos que impedem a operação inteira (nada é tocado). */
  blockers: string[];
}

const DATE_RE = /^\d{6}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Pure: o que o `--cancel`/`--reschedule` faria em cada destino do corte. */
export function planCorteLifecycle(input: {
  op: CorteLifecycleOp;
  spec: CorteSpec;
  entries: readonly ShortPublishedEntry[];
  /** Marcas de envio em curso abertas (`openSendingMarks`). */
  openMarks: readonly ShortSendingMark[];
  now: Date;
  minLeadMs?: number;
}): CorteLifecyclePlan {
  const { op, spec } = input;
  const minLead = input.minLeadMs ?? CORTE_LIFECYCLE_MIN_LEAD_MS;
  const nowMs = input.now.getTime();
  const blockers: string[] = [];
  const currentAt = resolveEditionScheduledAt(spec.date, spec.hhmm);
  let newAt: string | null = null;
  if (op.kind === "reschedule") {
    if (!DATE_RE.test(op.date)) blockers.push(`--date precisa ser AAMMDD (recebeu ${JSON.stringify(op.date)})`);
    if (!HHMM_RE.test(op.hhmm)) blockers.push(`--at precisa ser HH:MM (recebeu ${JSON.stringify(op.hhmm)})`);
    if (!blockers.length) {
      newAt = resolveEditionScheduledAt(op.date, op.hhmm);
      if (Date.parse(newAt) - nowMs <= minLead) blockers.push(`o horário novo (${op.hhmm} BRT de ${op.date}) precisa estar a mais de ${minLead / 60_000} min no futuro`);
    }
  }
  if (spec.cancelled_at) {
    blockers.push(
      op.kind === "cancel"
        ? `o corte já foi cancelado em ${spec.cancelled_at}`
        : `o corte foi cancelado em ${spec.cancelled_at}: para voltar a publicá-lo, dê um novo --publish --confirm-publish com o horário novo (--date/--at)`,
    );
  }
  for (const m of input.openMarks) blockers.push(`envio em curso de ${m.destination} desde ${m.started_at} (marca em _internal/06-shorts-sending*.json): espere a rodada terminar`);

  const items: CorteLifecycleItem[] = [];
  const registered = new Set<string>();
  for (const e of input.entries) {
    registered.add(e.destination);
    if (e.cancelled_at) {
      items.push({ destination: e.destination, action: "refuse", reason: `agendamento já cancelado em ${e.cancelled_at}` });
      continue;
    }
    if (e.status === "published") {
      items.push({ destination: e.destination, action: "refuse", reason: op.kind === "cancel" ? "já publicado: o cancelamento nunca apaga conteúdo no ar (apague na plataforma, se quiser)" : "já publicado: não há o que reagendar" });
      continue;
    }
    if (e.status === "send_unknown") {
      items.push({ destination: e.destination, action: "refuse", reason: "envio ambíguo (send_unknown): confira na plataforma e registre com --mark antes" });
      continue;
    }
    const at = e.scheduled_at ?? null;
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (op.kind === "reschedule" && newAt && at && atMs === Date.parse(newAt)) {
      items.push({ destination: e.destination, action: "noop", reason: "já está no horário novo" });
      continue;
    }
    if (!at || Number.isNaN(atMs) || atMs - nowMs <= minLead) {
      items.push({
        destination: e.destination,
        action: "refuse",
        reason: `agendado para ${at ?? "?"}, que já passou ou está a menos de ${minLead / 60_000} min: pode já estar no ar, confira na plataforma`,
      });
      continue;
    }
    if (e.destination === "youtube_shorts") {
      items.push({ destination: e.destination, action: "youtube", videoId: e.id, currentAt: at });
    } else if (e.destination.startsWith("facebook:")) {
      items.push({ destination: e.destination, action: "facebook", slug: e.destination.slice("facebook:".length), videoId: e.id, currentAt: at });
    } else if ((e.destination === "x" || e.destination === "tiktok") && e.id.startsWith("buffer:")) {
      items.push({ destination: e.destination, action: "buffer", bufferId: e.id.slice("buffer:".length), currentAt: at });
    } else {
      items.push({
        destination: e.destination,
        action: "refuse",
        reason: e.destination === "linkedin_page_repost"
          ? "o repost está na fila do Worker diaria-linkedin-cron: cancele/reagende lá (GET /list), o script não mexe na fila"
          : "o script não sabe cancelar/reagendar este destino pela API: faça na plataforma",
      });
    }
  }
  // Destinos do timer do 300 ainda não publicados: seguem o corte.json.
  const pendingTimer = (corteAuthorizedDestinations(spec) ?? []).filter((d) => CORTE_TIMER_DESTINATIONS.includes(d) && !registered.has(d));
  for (const d of pendingTimer) items.push({ destination: d, action: "corte_timer" });
  if (pendingTimer.length && Date.parse(currentAt) - nowMs <= minLead) {
    blockers.push(
      `o horário atual do corte (${spec.hhmm} BRT de ${spec.date}) já chegou ou está a menos de ${minLead / 60_000} min, com ${pendingTimer.join(", ")} pendente(s): o timer do 300 pode estar publicando agora`,
    );
  }
  // `noop` (reagendamento já aplicado na plataforma) ainda pede o corte.json atualizado: conta como ação.
  if (!blockers.length && !items.some((i) => i.action !== "refuse")) {
    blockers.push(`nada a ${op.kind === "cancel" ? "cancelar" : "reagendar"}: nenhum destino agendado com folga`);
  }
  return { op, currentAt, newAt, items, blockers };
}

/** I/O do executor, injetável nos testes. */
export interface CorteLifecycleDeps {
  /** `publishAt: null` = cancelar (private sem agendamento). */
  youtube: (videoId: string, publishAt: string | null) => Promise<void>;
  facebookCancel: (slug: string, videoId: string) => Promise<void>;
  facebookReschedule: (slug: string, videoId: string, at: string) => Promise<void>;
  persist: (entry: ShortPublishedEntry) => void;
  now: () => Date;
}

export interface CorteLifecycleResult {
  destination: string;
  ok: boolean;
  /** `done`: aplicado; `skill`: falta a skill na Buffer; `corte_json`: segue o corte.json; `noop`/`refused`: nada feito. */
  outcome: "done" | "skill" | "corte_json" | "noop" | "refused" | "failed";
  error?: string;
  reason?: string;
  warning?: string;
  /** Buffer: o que a skill executa (nada foi alterado pelo script). */
  buffer?: { bufferId: string; tool: "delete_post" | "edit_post"; dueAt?: string; note: string };
}

/**
 * Aplica o plano (sem bloqueios). Falha de um destino não para os outros.
 * Cada destino aplicado é gravado no registro logo em seguida
 * (`cancelled_at` no cancelamento, `scheduled_at` novo no reagendamento).
 */
export async function executeCorteLifecycle(plan: CorteLifecyclePlan, entries: readonly ShortPublishedEntry[], deps: CorteLifecycleDeps): Promise<CorteLifecycleResult[]> {
  if (plan.blockers.length) throw new Error(`plano com bloqueio: ${plan.blockers.join("; ")}`);
  const cancel = plan.op.kind === "cancel";
  const results: CorteLifecycleResult[] = [];
  for (const item of plan.items) {
    if (item.action === "refuse") {
      results.push({ destination: item.destination, ok: true, outcome: "refused", reason: item.reason });
      continue;
    }
    if (item.action === "noop") {
      results.push({ destination: item.destination, ok: true, outcome: "noop", reason: item.reason });
      continue;
    }
    if (item.action === "corte_timer") {
      results.push({ destination: item.destination, ok: true, outcome: "corte_json" });
      continue;
    }
    if (item.action === "buffer") {
      results.push({
        destination: item.destination,
        ok: true,
        outcome: "skill",
        buffer: cancel
          ? { bufferId: item.bufferId, tool: "delete_post", note: "a skill apaga o post na Buffer; o registro local segue como estava" }
          : {
            bufferId: item.bufferId,
            tool: "edit_post",
            dueAt: plan.newAt!,
            note: `a Buffer exige reenviar text + assets (+ metadata.tiktok) no edit_post: leia o post com get_post antes; depois registre com --mark ${item.destination}=buffer:${item.bufferId} --scheduled-at ${plan.newAt}`,
          },
      });
      continue;
    }
    try {
      if (item.action === "youtube") await deps.youtube(item.videoId, cancel ? null : plan.newAt);
      else if (cancel) await deps.facebookCancel(item.slug, item.videoId);
      else await deps.facebookReschedule(item.slug, item.videoId, plan.newAt!);
    } catch (e) {
      results.push({ destination: item.destination, ok: false, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const entry = entries.find((e) => e.destination === item.destination);
    let warning: string | undefined;
    if (entry) {
      const nowIso = deps.now().toISOString();
      const next: ShortPublishedEntry = cancel ? { ...entry, cancelled_at: nowIso } : { ...entry, scheduled_at: plan.newAt, updated_at: nowIso };
      try {
        deps.persist(next);
      } catch (e) {
        warning = `${cancel ? "cancelado" : "reagendado"} na plataforma, mas o registro não gravou: ${(e as Error).message}`;
      }
    }
    results.push({ destination: item.destination, ok: true, outcome: "done", ...(warning ? { warning } : {}) });
  }
  return results;
}
