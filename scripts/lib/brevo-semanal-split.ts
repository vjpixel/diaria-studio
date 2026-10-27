/**
 * scripts/lib/brevo-semanal-split.ts (#11286)
 *
 * Divisão segunda/terça da semanal da Brevo diária (cadastros não
 * confirmados), resíduo do #11226. Decisão do editor (/diaria-desbloqueia
 * 261027), desenho (a):
 *
 * - a lista principal (`brevo_diaria.list_id`) continua com TODO mundo — o
 *   reconcile de órfãos (#4579), `verifySuppressedInBrevo` e
 *   `verifyUnlinkedFromBrevoList` seguem lendo só ela;
 * - uma 2ª lista, "terça" (`brevo_diaria.semanal.terca_list_id`), guarda a
 *   metade "terça" da divisão fixa por pessoa (`semanalSplitGroup`);
 * - acima de `split_threshold`, a campanha de segunda vai pra
 *   `listIds: [principal]` + `exclusionListIds: [terca]` e a de terça pra
 *   `listIds: [terca]`, mesma edição e mesmo intro, agendada 24h depois
 *   (`schedule-daily-brevo.ts`).
 *
 * ## Por que a lista de terça é RECONCILIADA, e não mantida por cada unlink
 *
 * A decisão pede que todo unlink/supressão desvincule as duas listas. O
 * efeito que importa é um invariante: **a lista de terça nunca tem quem não
 * está na principal** (senão a campanha de terça alcança quem foi promovido
 * ao Kit, suprimido sem blacklist ou excluído por estar ativo no Kit). Há
 * ~17 pontos de unlink só no `evaluate-brevo-diaria.ts`, mais o guard
 * Kit-ativo (#6485) e unlinks feitos à mão no painel. Em vez de espalhar o
 * 2º unlink por todos eles (e depender de nenhum caminho novo esquecer),
 * `reconcileTercaList` recalcula a lista de terça a partir da principal AO
 * VIVO logo antes de a campanha nascer — e a Brevo congela os destinatários
 * no agendamento (Etapa 6, minutos depois), então é o único instante em que
 * a membership da lista de terça decide alguma coisa. Sobrar alguém na
 * lista de terça que não está na principal depois do reconcile é erro duro
 * (o publish não cria a campanha); faltar alguém só faz a pessoa receber na
 * segunda (não é excluída), e vira aviso.
 */

import { semanalSplitGroup } from "./brevo-diaria-semanal.ts";

/** Lote máximo do add/remove síncrono de contatos em lista da Brevo (mesmo de `clarice-list-consolidation.ts`). */
export const TERCA_LIST_BATCH_SIZE = 150;

/** Intervalo entre a campanha de segunda e a de terça. */
export const TERCA_OFFSET_MS = 24 * 3600 * 1000;

export type SemanalSplitDecision =
  | { split: false; warning?: string }
  | { split: true; tercaListId: number }
  | { error: string };

/**
 * Pura — esta campanha sai dividida? Só no regime semanal efetivo, numa
 * segunda de verdade (nunca com `--fora-da-segunda`), acima do teto e com a
 * lista de terça configurada. Lista de terça igual à principal é erro de
 * config (a exclusão tiraria todo mundo da segunda).
 */
export function decideSemanalSplit(input: {
  semanalMondaySend: boolean;
  recipients: number;
  threshold: number;
  tercaListId: number | null;
  mainListId: number;
}): SemanalSplitDecision {
  if (input.tercaListId !== null && input.tercaListId === input.mainListId) {
    return { error: `brevo_diaria.semanal.terca_list_id (${input.tercaListId}) não pode ser a lista principal (list_id).` };
  }
  if (!input.semanalMondaySend || input.recipients <= input.threshold) return { split: false };
  if (input.tercaListId === null) {
    return {
      split: false,
      warning:
        `semanal com ${input.recipients} destinatário(s), acima de ${input.threshold}, mas sem ` +
        "brevo_diaria.semanal.terca_list_id — sai inteira na segunda (#11286).",
    };
  }
  return { split: true, tercaListId: input.tercaListId };
}

/** Pura — `recipients` da campanha principal: com divisão, exclui a lista de terça. */
export function buildMainCampaignRecipients(mainListId: number, tercaListId: number | null): {
  listIds: number[];
  exclusionListIds?: number[];
} {
  return tercaListId === null ? { listIds: [mainListId] } : { listIds: [mainListId], exclusionListIds: [tercaListId] };
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export interface TercaListPlan {
  /** E-mails (normalizados) que a lista de terça deve conter: principal ∩ grupo "terça". */
  desired: string[];
  /** Da principal, no grupo "terça", ainda fora da lista de terça (grafia da principal). */
  toAdd: string[];
  /** Na lista de terça mas fora do desejado — saiu da principal ou não é do grupo (grafia da lista de terça). */
  toRemove: string[];
}

/** Pura — diferença entre a lista de terça atual e a desejada. */
export function planTercaListReconcile(mainEmails: readonly string[], tercaEmails: readonly string[]): TercaListPlan {
  const desiredByNorm = new Map<string, string>();
  for (const e of mainEmails) {
    const n = norm(e);
    if (n && semanalSplitGroup(n) === "terca" && !desiredByNorm.has(n)) desiredByNorm.set(n, e);
  }
  const currentNorm = new Set(tercaEmails.map(norm));
  const toAdd = [...desiredByNorm.entries()].filter(([n]) => !currentNorm.has(n)).map(([, e]) => e);
  const seenRemove = new Set<string>();
  const toRemove: string[] = [];
  for (const e of tercaEmails) {
    const n = norm(e);
    if (!desiredByNorm.has(n) && !seenRemove.has(n)) {
      seenRemove.add(n);
      toRemove.push(e);
    }
  }
  return { desired: [...desiredByNorm.keys()], toAdd, toRemove };
}

export interface TercaListDeps {
  /** `GET /contacts/lists/{id}/contacts`, paginado (`brevoListContacts`). */
  listContacts: (listId: number) => Promise<string[]>;
  /** `POST /contacts/lists/{id}/contacts/add` com ≤150 e-mails. */
  addToList: (listId: number, emails: string[]) => Promise<void>;
  /** `POST /contacts/lists/{id}/contacts/remove` com ≤150 e-mails. */
  removeFromList: (listId: number, emails: string[]) => Promise<void>;
}

export interface TercaListReconcileResult {
  /** Destinatários da lista de terça depois do reconcile. */
  terca: number;
  /** Destinatários da principal que ficam na segunda (principal − terça). */
  segunda: number;
  added: number;
  removed: number;
  /** Do grupo "terça" que a releitura não mostrou na lista — recebem na segunda. */
  missing: string[];
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * I/O injetável — leva a lista de terça a principal ∩ grupo "terça" e RELÊ.
 * Lança se, na releitura, a lista de terça tiver alguém fora do desejado
 * (a campanha de terça alcançaria quem já saiu da principal). Remove antes
 * de adicionar: se a remoção falhar no meio, nada novo entrou.
 */
export async function reconcileTercaList(
  deps: TercaListDeps,
  opts: { mainListId: number; tercaListId: number },
): Promise<TercaListReconcileResult> {
  const mainEmails = await deps.listContacts(opts.mainListId);
  const before = await deps.listContacts(opts.tercaListId);
  const plan = planTercaListReconcile(mainEmails, before);
  for (const chunk of batches(plan.toRemove, TERCA_LIST_BATCH_SIZE)) await deps.removeFromList(opts.tercaListId, chunk);
  for (const chunk of batches(plan.toAdd, TERCA_LIST_BATCH_SIZE)) await deps.addToList(opts.tercaListId, chunk);

  const after = new Set((await deps.listContacts(opts.tercaListId)).map(norm));
  const desired = new Set(plan.desired);
  const extras = [...after].filter((e) => !desired.has(e));
  if (extras.length > 0) {
    throw new Error(
      `lista de terça (${opts.tercaListId}) segue com ${extras.length} contato(s) fora da lista principal ou do grupo ` +
        `"terça" depois do reconcile: ${extras.slice(0, 10).join(", ")}${extras.length > 10 ? " …" : ""}. ` +
        "A campanha de terça não é criada com essa lista (#11286).",
    );
  }
  const missing = plan.desired.filter((e) => !after.has(e));
  const mainSize = new Set(mainEmails.map(norm)).size;
  return { terca: after.size, segunda: mainSize - after.size, added: plan.toAdd.length, removed: plan.toRemove.length, missing };
}

/** Pura — horário da campanha de terça: o da segunda + 24h, em ISO. */
export function tercaScheduledAt(mondayIso: string): string | null {
  const ms = Date.parse(mondayIso);
  return Number.isFinite(ms) ? new Date(ms + TERCA_OFFSET_MS).toISOString() : null;
}
