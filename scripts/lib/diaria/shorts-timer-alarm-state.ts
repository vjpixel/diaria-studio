import { notifyEditorResultReachedEditor, type NotifyEditorResult } from "../editor-notify.ts";

/**
 * Estado dos alarmes da edição: `alarmed` = motivos entregues ao editor;
 * `emailPending` = motivos com a issue aberta e o e-mail devido que NÃO saiu
 * (a próxima execução reenvia com `forceEmail`).
 */
export interface ShortsTimerAlarmState {
  alarmed: string[];
  emailPending: string[];
}

/** Puro: lê o estado; ilegível = vazio (avisa de novo: melhor um alarme a mais do que nenhum). */
export function parseAlarmState(stateRaw: string | null): ShortsTimerAlarmState {
  if (!stateRaw) return { alarmed: [], emailPending: [] };
  try {
    const o = JSON.parse(stateRaw);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
    return { alarmed: list(o?.alarmed), emailPending: list(o?.emailPending) };
  } catch {
    return { alarmed: [], emailPending: [] };
  }
}

/** Puro: o e-mail deste alarme (`alarmId`) ficou pendente numa execução anterior? */
export function emailPending(stateRaw: string | null, id: string): boolean {
  return parseAlarmState(stateRaw).emailPending.includes(id);
}

export type AlarmDelivery =
  /** Chegou ao editor (issue + e-mail, ou só a issue quando a política não manda e-mail): grava em `alarmed`. */
  | { kind: "delivered" }
  /** Issue aberta, e-mail devido que não saiu: grava em `emailPending` (a próxima execução reenvia). */
  | { kind: "email-pending"; error: string }
  /** Issue não aberta: não grava nada (a próxima execução tenta tudo de novo). */
  | { kind: "retry"; error: string };

/** Puro: o que gravar depois do `notifyEditor` (`notifyEditorResultReachedEditor` decide o "chegou"). */
export function alarmDelivery(res: NotifyEditorResult): AlarmDelivery {
  if (!res.issue || res.issue.action === "failed") return { kind: "retry", error: `issue não aberta (${res.issue?.error ?? "?"})` };
  if (notifyEditorResultReachedEditor(res)) return { kind: "delivered" };
  return { kind: "email-pending", error: `e-mail não enviado (${res.emailError ?? "?"})` };
}

/** Puro: o estado depois da entrega do alarme `id`; null = não grava (`retry`). */
export function nextAlarmState(stateRaw: string | null, aammdd: string, id: string, delivery: AlarmDelivery): string | null {
  if (delivery.kind === "retry") return null;
  const state = parseAlarmState(stateRaw);
  const alarmed = delivery.kind === "delivered" ? [...new Set([...state.alarmed, id])] : state.alarmed;
  const pending = delivery.kind === "delivered" ? state.emailPending.filter((k) => k !== id) : [...new Set([...state.emailPending, id])];
  return JSON.stringify({ aammdd, alarmed, emailPending: pending }, null, 2) + "\n";
}

/** Puro: o alarme (`alarmId`; a chave pura nos de causa única) já foi avisado nesta edição? */
export function alreadyAlarmed(stateRaw: string | null, id: string): boolean {
  return parseAlarmState(stateRaw).alarmed.includes(id);
}
