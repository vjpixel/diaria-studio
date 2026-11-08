/**
 * weekly-social-reschedule.ts (#12375) — miolo do `--reschedule` de
 * `scripts/publish-weekly-social.ts`.
 *
 * Problema: depois de agendado, o carrossel semanal de um modo não tinha como
 * mudar de horário. O skip-existing pula tudo que já está `scheduled`, e o
 * caminho manual (DELETE na fila do Worker pra Instagram/Threads/LinkedIn,
 * DELETE do post agendado do Facebook na Graph API, limpar as entradas do modo
 * em `06-weekly-published.json`, apagar a linha de rotação do dia em
 * `data/social-schedule-rotation.jsonl`, rodar de novo) duplica post se um
 * passo sair fora de ordem (mesma classe do #6607).
 *
 * Ordem garantida aqui:
 *   1. `planWeeklyReschedule` (puro): monta os alvos a partir do registro e
 *      ABORTA antes de qualquer DELETE se uma entrada `scheduled` do modo não
 *      tiver o id de cancelamento, ou se o horário dela já passou (ou está a
 *      menos de `minLeadMs` de disparar). No Facebook isso é o que protege o
 *      post público: DELETE num post agendado que já saiu apaga o post
 *      publicado, a Graph API não devolve 404 nesse caso. Aborta também se
 *      alguma entrada do modo já está `published`/`send_unknown` (#12397:
 *      o post saiu e o redespacho o duplicaria). Entradas do X (`twitter`,
 *      de `prep-weekly-twitter.ts`) ficam fora do plano e do registro.
 *   2. `executeWeeklyReschedule`: DELETEs em sequência, fila do Worker antes
 *      do Facebook (o 404 da fila é o sinal confiável de "já disparou"). Para
 *      no primeiro 404/erro, e reavalia a margem com o relógio real antes de
 *      cada DELETE (#12397).
 *   3. Só com todos os DELETEs ok o caller limpa o registro
 *      (`dropRescheduledEntries`) e a linha de rotação (`dropWeekendRotationLines`)
 *      e reagenda. Abortado no meio, o registro mantém a entrada que deu 404
 *      e as não tentadas; as já canceladas viram `status: "deleted"`
 *      (`markCancelledEntries`) — nada é removido, e o registro não afirma um
 *      agendamento que não existe mais.
 *
 * Idempotente: sem entrada `scheduled` do modo (e sem `published`/
 * `send_unknown`), o plano é vazio e o fluxo vira um agendamento normal; rodar `--reschedule` duas vezes cancela o
 * agendamento da 1ª rodada (com as chaves novas) e reagenda de novo.
 */

import type { PostEntry } from "./social-published-store.ts";
import { resolvePostPage } from "./social-published-store.ts";

/** Plataformas cujo agendamento mora na fila do Worker `diaria-linkedin-cron`. */
export const WORKER_QUEUE_PLATFORMS = ["instagram", "threads", "linkedin"] as const;

/**
 * #12397: plataformas que gravam no MESMO `06-weekly-published.json` mas que
 * este script não agenda — o X (`twitter`) vem de `prep-weekly-twitter.ts`,
 * cujo guard de re-agendamento lê justamente essa entrada. O `--reschedule`
 * não cancela, não apaga e não redespacha nada delas: só avisa.
 */
export const OUT_OF_SCOPE_PLATFORMS = ["twitter"] as const;

/**
 * #12397: status de entrada que prova (ou pode provar) que o post já saiu —
 * `verify-weekly-worker-dispatch.ts` promove `scheduled` para eles depois do
 * disparo. Reagendar por cima publicaria o carrossel de novo.
 */
export const RESCHEDULE_BLOCKING_STATUSES = ["published", "send_unknown"] as const;

/** Margem mínima até o disparo para aceitar cancelar (default 5 min). */
export const DEFAULT_RESCHEDULE_MIN_LEAD_MS = 5 * 60 * 1000;

export type RescheduleTarget =
  | { kind: "worker_queue"; platform: string; key: string; scheduledAt: string }
  | { kind: "facebook"; platform: "facebook"; page: string; fbPostId: string; scheduledAt: string };

/**
 * `outOfScope`: rótulos (`twitter (scheduled)`) das entradas do modo que o
 * `--reschedule` deixa como estão (#12397) — o caller avisa o editor.
 */
export type ReschedulePlan = { ok: true; targets: RescheduleTarget[]; outOfScope: string[] } | { ok: false; reason: string };

/** Rótulo curto de um alvo para log (`instagram`, `facebook:diaria`). */
export function targetLabel(t: RescheduleTarget): string {
  return t.kind === "facebook" ? `facebook:${t.page}` : t.platform;
}

function entryLabel(p: PostEntry): string {
  return p.platform === "facebook" ? `facebook:${resolvePostPage(p)}` : p.platform;
}

/**
 * Pure (#12397): motivo para NÃO cancelar um alvo agendado para `scheduledAt`
 * no instante `now` (horário ilegível, já passou ou dispara em menos de
 * `minLeadMs`); `null` = seguro. Usado no plano e de novo imediatamente antes
 * de cada DELETE, porque entre os dois há minutos de resolução de imagem.
 */
export function rescheduleLeadProblem(
  label: string,
  scheduledAt: string,
  now: Date,
  minLeadMs: number = DEFAULT_RESCHEDULE_MIN_LEAD_MS,
): string | null {
  const when = Date.parse(scheduledAt);
  if (!scheduledAt || Number.isNaN(when)) {
    return `${label} está scheduled sem scheduled_at legível — confira o post à mão antes de reagendar.`;
  }
  if (when - now.getTime() < minLeadMs) {
    return (
      `${label} estava agendado para ${scheduledAt}, que já passou ou dispara em menos de ` +
      `${Math.round(minLeadMs / 60000)} min — o post pode já ter saído.`
    );
  }
  return null;
}

/**
 * Pure: alvos de cancelamento do modo `destaqueKey` (`weekly-{mode}`). Só
 * entradas `scheduled` viram alvo (`failed`/`skipped`/`deleted` não têm nada
 * agendado; `draft` não é gravado pelo semanal). Ordem: fila do Worker na
 * ordem do registro, depois Facebook.
 *
 * #12397: aborta se qualquer entrada do modo estiver `published` ou
 * `send_unknown` — o post já saiu (ou pode ter saído) e o redespacho o
 * duplicaria. Entradas de `OUT_OF_SCOPE_PLATFORMS` (X) não entram no plano
 * nem bloqueiam: voltam em `outOfScope` para aviso.
 */
export function planWeeklyReschedule(
  posts: readonly PostEntry[],
  destaqueKey: string,
  now: Date,
  minLeadMs: number = DEFAULT_RESCHEDULE_MIN_LEAD_MS,
): ReschedulePlan {
  const queue: RescheduleTarget[] = [];
  const facebook: RescheduleTarget[] = [];
  const outOfScope: string[] = [];
  for (const p of posts) {
    if (p.destaque !== destaqueKey) continue;
    if ((OUT_OF_SCOPE_PLATFORMS as readonly string[]).includes(p.platform)) {
      outOfScope.push(`${p.platform} (${p.status})`);
      continue;
    }
    const label = entryLabel(p);
    if ((RESCHEDULE_BLOCKING_STATUSES as readonly string[]).includes(p.status)) {
      return {
        ok: false,
        reason:
          `${label}/${destaqueKey} já está "${p.status}" — o post já saiu (ou pode ter saído) e reagendar o publicaria de novo. ` +
          `Nada foi cancelado.`,
      };
    }
    if (p.status !== "scheduled") continue;
    const scheduledAt = typeof p.scheduled_at === "string" ? p.scheduled_at : "";
    const lead = rescheduleLeadProblem(`${label}/${destaqueKey}`, scheduledAt, now, minLeadMs);
    if (lead) return { ok: false, reason: `${lead} Nada foi cancelado.` };
    if (p.platform === "facebook") {
      const fbPostId = typeof p.fb_post_id === "string" && p.fb_post_id ? p.fb_post_id : null;
      if (!fbPostId) return { ok: false, reason: `${label}/${destaqueKey} está scheduled sem fb_post_id — cancele à mão.` };
      facebook.push({ kind: "facebook", platform: "facebook", page: resolvePostPage(p), fbPostId, scheduledAt });
    } else if ((WORKER_QUEUE_PLATFORMS as readonly string[]).includes(p.platform)) {
      const key = typeof p.worker_queue_key === "string" && p.worker_queue_key ? p.worker_queue_key : null;
      if (!key) return { ok: false, reason: `${label}/${destaqueKey} está scheduled sem worker_queue_key — cancele à mão.` };
      queue.push({ kind: "worker_queue", platform: p.platform, key, scheduledAt });
    } else {
      return { ok: false, reason: `${label}/${destaqueKey}: plataforma sem caminho de cancelamento conhecido.` };
    }
  }
  return { ok: true, targets: [...queue, ...facebook], outOfScope };
}

/** Resultado de um DELETE: `alreadyGone` = 404 (post já disparou ou já foi removido). */
export interface CancelOutcome {
  alreadyGone: boolean;
}

export interface RescheduleDeps {
  deleteQueueKey: (key: string) => Promise<CancelOutcome>;
  deleteFacebookPost: (page: string, fbPostId: string) => Promise<CancelOutcome>;
  /**
   * #12397: relógio lido imediatamente antes de CADA DELETE (default: relógio
   * real). O plano mede a margem no início da execução; os DELETEs só rodam
   * minutos depois (imagens, geração sob demanda, upload de capa/CTA), e um
   * DELETE na Graph API depois do disparo apaga o post publicado.
   */
  now?: () => Date;
  minLeadMs?: number;
}

export type RescheduleExecution =
  | { ok: true; cancelled: RescheduleTarget[] }
  | { ok: false; cancelled: RescheduleTarget[]; failedTarget: RescheduleTarget; reason: string };

/**
 * DELETEs em sequência, na ordem do plano. Para no primeiro 404
 * (`alreadyGone`), erro ou margem vencida (#12397, reavaliada com `deps.now`
 * logo antes de cada DELETE): nenhum DELETE depois dele é tentado.
 */
export async function executeWeeklyReschedule(targets: readonly RescheduleTarget[], deps: RescheduleDeps): Promise<RescheduleExecution> {
  const cancelled: RescheduleTarget[] = [];
  const clock = deps.now ?? (() => new Date());
  for (const t of targets) {
    const lead = rescheduleLeadProblem(targetLabel(t), t.scheduledAt, clock(), deps.minLeadMs ?? DEFAULT_RESCHEDULE_MIN_LEAD_MS);
    if (lead) {
      return { ok: false, cancelled, failedTarget: t, reason: `margem reavaliada antes do DELETE: ${lead}` };
    }
    let outcome: CancelOutcome;
    try {
      outcome = t.kind === "facebook" ? await deps.deleteFacebookPost(t.page, t.fbPostId) : await deps.deleteQueueKey(t.key);
    } catch (e) {
      return { ok: false, cancelled, failedTarget: t, reason: `DELETE de ${targetLabel(t)} falhou: ${(e as Error).message}` };
    }
    if (outcome.alreadyGone) {
      return {
        ok: false,
        cancelled,
        failedTarget: t,
        reason: `DELETE de ${targetLabel(t)} devolveu 404 — o post já disparou ou já tinha sido removido.`,
      };
    }
    cancelled.push(t);
  }
  return { ok: true, cancelled };
}

/**
 * Pure (#12397): registro depois de um cancelamento completo, antes do
 * redespacho. Substitui o antigo `dropModeEntries`, que apagava TODAS as
 * entradas do modo (inclusive `published` com `published_at` e as do X).
 *
 * Só sai do registro o que o redespacho vai regravar: entrada cancelada de
 * canal redespachado e entrada `failed`/`skipped`/`deleted` de canal
 * redespachado. Canal redespachado = Instagram/Threads/LinkedIn, ou
 * Facebook numa das `redispatchFacebookPages`. Entrada cancelada de canal que
 * NÃO volta (página do Facebook desabilitada) vira `status: "deleted"` — o
 * post sumiu e o registro não pode afirmar o contrário. O resto (X,
 * `published`/`send_unknown`, outro modo) fica intacto.
 */
export function dropRescheduledEntries(
  posts: readonly PostEntry[],
  destaqueKey: string,
  cancelled: readonly RescheduleTarget[],
  redispatchFacebookPages: readonly string[],
): PostEntry[] {
  const redispatched = (p: PostEntry): boolean =>
    (WORKER_QUEUE_PLATFORMS as readonly string[]).includes(p.platform) ||
    (p.platform === "facebook" && redispatchFacebookPages.includes(resolvePostPage(p)));
  const out: PostEntry[] = [];
  for (const p of posts) {
    if (p.destaque !== destaqueKey || (OUT_OF_SCOPE_PLATFORMS as readonly string[]).includes(p.platform)) {
      out.push(p);
      continue;
    }
    if (cancelled.some((t) => sameTarget(p, t, destaqueKey))) {
      if (!redispatched(p)) out.push({ ...p, status: "deleted", reason: "reschedule_cancelled_not_redispatched" });
      continue;
    }
    if (redispatched(p) && (p.status === "failed" || p.status === "skipped" || p.status === "deleted")) continue;
    out.push(p);
  }
  return out;
}

function sameTarget(p: PostEntry, t: RescheduleTarget, destaqueKey: string): boolean {
  if (p.destaque !== destaqueKey || p.status !== "scheduled") return false;
  if (t.kind === "facebook") return p.platform === "facebook" && resolvePostPage(p) === t.page && p.fb_post_id === t.fbPostId;
  return p.platform === t.platform && p.worker_queue_key === t.key;
}

/**
 * Pure: abort no meio — as entradas já canceladas viram `status: "deleted"`
 * (com `reason`), todas as outras ficam intactas. Nada é removido.
 */
export function markCancelledEntries(
  posts: readonly PostEntry[],
  destaqueKey: string,
  cancelled: readonly RescheduleTarget[],
  reason = "reschedule_cancelled_then_aborted",
): PostEntry[] {
  return posts.map((p) => (cancelled.some((t) => sameTarget(p, t, destaqueKey)) ? { ...p, status: "deleted" as const, reason } : p));
}

/**
 * Pure: conteúdo do JSONL de rotação sem as linhas `weekend` da data
 * `isoDate` (AAAA-MM-DD, data de PUBLICAÇÃO do modo). Linha ilegível fica
 * como está. Devolve também quantas linhas saíram.
 */
export function dropWeekendRotationLines(content: string, isoDate: string): { content: string; removed: number } {
  let removed = 0;
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    if (line.trim()) {
      try {
        const row = JSON.parse(line) as { kind?: unknown; date?: unknown };
        if (row.kind === "weekend" && row.date === isoDate) {
          removed++;
          continue;
        }
      } catch {
        // linha corrompida: preservar
      }
    }
    kept.push(line);
  }
  return { content: kept.join("\n"), removed };
}

/**
 * DELETE do post agendado do Facebook na Graph API. 404, ou 400 com
 * `error.code === 100` (objeto inexistente), vira `alreadyGone`; outro não-2xx
 * lança. Token no header, nunca na query string (#7779).
 */
export async function deleteFacebookScheduledPost(
  fbPostId: string,
  pageToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelOutcome> {
  const res = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(fbPostId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${pageToken}` },
  });
  if (res.ok) return { alreadyGone: false };
  const body = await res.text();
  if (res.status === 404) return { alreadyGone: true };
  if (res.status === 400) {
    try {
      const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
      if (code === 100) return { alreadyGone: true };
    } catch {
      // corpo não-JSON: cai no erro abaixo
    }
  }
  throw new Error(`Graph API DELETE HTTP ${res.status}: ${body.slice(0, 300)}`);
}
