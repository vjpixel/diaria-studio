/**
 * scripts/lib/weekly-cancelling-stuck-alarm.ts (#12421)
 *
 * Lógica PURA do alarme de entrada presa em `cancelling` no registro do
 * carrossel semanal (`data/weekly/{AAMMDD}/06-weekly-published.json`). O I/O
 * (varrer os registros, abrir a issue, mandar o e-mail) mora em
 * `scripts/retro-semanal-staleness-alarm.ts`, que já roda toda semana.
 *
 * ## O buraco
 *
 * O `--reschedule` de `publish-weekly-social.ts` marca os alvos `cancelling`
 * antes do 1º DELETE (#12417) e deixa a entrada assim quando o DELETE lança
 * (#12419). Enquanto o horário antigo não passa, a próxima rodada com
 * `--schedule` retoma o cancelamento sozinha. Depois que passa, ninguém sabe
 * mais se o post saiu: o DELETE pode ter apagado a chave, ou o Worker/Facebook
 * pode ter disparado. O conciliador (`reconcileWorkerEntry`) só resolve o caso
 * da DLQ (vira `failed`); ausente da fila é ambíguo, porque o Worker não guarda
 * histórico de disparo. Toda rodada seguinte aborta na checagem de margem e
 * nada avisava. Este alarme é o aviso: conferir o perfil e corrigir o registro.
 *
 * ## Prazo
 *
 * Entrada `cancelling` cujo `scheduled_at` (o horário antigo) já passou, ou
 * que não tem `scheduled_at` legível (não dá pra saber se passou, então avisa).
 * Antes do horário o estado ainda se resolve sozinho na rodada seguinte; um
 * DELETE que falha de forma persistente (token, permissão) também cai aqui,
 * porque a entrada continua `cancelling` até o horário passar.
 */

import type { PostEntry } from "./social-published-store.ts";
import { resolvePostPage } from "./social-published-store.ts";
import type { AlarmFinding, AlarmIssueResult } from "./alarm-issues.ts";

export const WEEKLY_CANCELLING_STUCK_CHECK = "weekly-social-cancelling-stuck";

export interface StuckCancellingEntry {
  /** Pasta da semana (`AAMMDD` do sábado). */
  week: string;
  platform: string;
  destaque: string;
  /** Só o Facebook (`diaria` quando ausente). */
  page?: string;
  scheduledAt: string | null;
  /** Id de cancelamento: `worker_queue_key` (Worker) ou `fb_post_id` (Facebook). */
  cancelId: string | null;
}

/** @pure Entradas `cancelling` cujo horário antigo já passou (ou é ilegível). */
export function findStuckCancellingEntries(week: string, posts: readonly PostEntry[], now: Date): StuckCancellingEntry[] {
  const out: StuckCancellingEntry[] = [];
  for (const p of posts) {
    if (p.status !== "cancelling") continue;
    const t = typeof p.scheduled_at === "string" ? Date.parse(p.scheduled_at) : NaN;
    if (Number.isFinite(t) && t > now.getTime()) continue;
    const key = typeof p.worker_queue_key === "string" && p.worker_queue_key ? p.worker_queue_key : null;
    const fbId = typeof p.fb_post_id === "string" && p.fb_post_id ? p.fb_post_id : null;
    out.push({
      week,
      platform: p.platform,
      destaque: typeof p.destaque === "string" ? p.destaque : "?",
      ...(p.platform === "facebook" ? { page: resolvePostPage(p) } : {}),
      scheduledAt: typeof p.scheduled_at === "string" ? p.scheduled_at : null,
      cancelId: key ?? fbId,
    });
  }
  return out;
}

function entryLabel(e: StuckCancellingEntry): string {
  return e.page ? `${e.platform}:${e.page}/${e.destaque}` : `${e.platform}/${e.destaque}`;
}

/** @pure Linha legível de uma entrada presa, pra issue e e-mail. */
export function describeStuckCancellingEntry(e: StuckCancellingEntry): string {
  return (
    `- ${entryLabel(e)} (semana ${e.week}): horário antigo ${e.scheduledAt ?? "ausente/ilegível"}, ` +
    `id de cancelamento ${e.cancelId ?? "ausente"}`
  );
}

/**
 * @pure Um `AlarmFinding` por entrada presa. Família `estado`: a issue fecha
 * sozinha quando a entrada deixa de ser `cancelling` (o editor corrigiu o
 * registro, ou uma rodada resolveu). Fingerprint estável por semana + canal +
 * destaque, então a mesma entrada reusa a mesma issue. Sem PII.
 */
export function toStuckCancellingFinding(e: StuckCancellingEntry): AlarmFinding {
  return {
    check: WEEKLY_CANCELLING_STUCK_CHECK,
    fingerprint: `${WEEKLY_CANCELLING_STUCK_CHECK}:${e.week}:${e.platform}:${e.page ?? ""}:${e.destaque}`,
    family: "estado",
    title: `[diar.ia.br] Carrossel semanal: ${entryLabel(e)} (semana ${e.week}) preso em "cancelling"`,
    body: [
      "Achado automático do alarme semanal (`scripts/retro-semanal-staleness-alarm.ts`, #12421).",
      "",
      `A entrada abaixo de data/weekly/${e.week}/06-weekly-published.json está em "cancelling" e o horário`,
      "antigo dela já passou. Um --reschedule gravou a intenção de cancelar e o DELETE não terminou (lançou,",
      "ou a rodada caiu no meio). Não dá pra saber pelo registro se o post saiu: o DELETE pode ter apagado o",
      "agendamento, ou o Worker/Facebook pode ter disparado. Toda rodada nova com --schedule aborta na",
      "checagem de margem enquanto a entrada estiver assim.",
      "",
      describeStuckCancellingEntry(e),
      "",
      "O que fazer: conferir o perfil na rede. Se o post saiu, trocar o status da entrada para \"published\";",
      "se não saiu, para \"deleted\" (e reagendar, se ainda fizer sentido). Esta issue fecha sozinha quando a",
      "entrada deixar de estar em \"cancelling\".",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** @pure E-mail ao editor com as entradas presas que pedem aviso nesta execução. */
export function buildStuckCancellingEmail(
  entries: readonly StuckCancellingEntry[],
  issueRefs: readonly AlarmIssueResult[],
): { subject: string; body: string } {
  const issues = issueRefs
    .map((r) => (r.action === "failed" ? `Issue: falha ao criar/reusar (${r.error})` : `Issue: #${r.issueNumber} (${r.url})`))
    .join("\n");
  return {
    subject: `⚠️ Carrossel semanal: ${entries.length} entrada(s) presa(s) em "cancelling"`,
    body:
      `O registro do carrossel semanal tem entrada(s) em "cancelling" com o horário antigo já passado. ` +
      `Não dá pra saber pelo registro se o post saiu: conferir o perfil e corrigir o status à mão ` +
      `("published" se saiu, "deleted" se não).\n\n` +
      entries.map(describeStuckCancellingEntry).join("\n") +
      (issues ? `\n\n${issues}` : ""),
  };
}
