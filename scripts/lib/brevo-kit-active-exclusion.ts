/**
 * brevo-kit-active-exclusion.ts (#6485)
 *
 * Guard pré-dispatch da campanha diária Brevo (`publish-daily-brevo.ts`):
 * um contato que já está `active` no Kit (backend de envio novo, #6114) e
 * ainda é membro da lista Brevo de reativação (`brevo_diaria.list_id`, "lista
 * 7") recebe a MESMA edição duas vezes — uma pelo Kit, outra pela campanha
 * Brevo. Medido ao vivo em 28/08/2026 (#6485): 7 e-mails na interseção, 5
 * `EDITOR_SEED_EMAILS` (sondas propositais nas duas pontas, isentas) + 2
 * assinantes reais (`sumaya.lima@gmail.com`, `eduardo.britto@wero.com.br`)
 * que entraram no Kit via `sync-beehiiv-subscribers-kit.ts` sem terem sido
 * retirados da fila de reativação Brevo.
 *
 * ## Design: pura + I/O separados (mesmo padrão do resto do repo)
 *
 * `computeKitActiveExclusions` é PURA — recebe os dois conjuntos de e-mails
 * já resolvidos (lista Brevo, ativos Kit) e devolve quem deve sair, sem
 * fetch nenhum. `applyKitActiveExclusionGuard` é a casca de I/O injetável
 * (mesmo padrão de `Stage5BrevoDeps` em `brevo-diaria-stage5-dispatch.ts`):
 * remove os excluídos da lista Brevo via `POST /contacts/lists/{id}/contacts/remove`,
 * atualiza `data/brevo-diaria/contacts.json` (status `converted_to_kit`,
 * `applyConvertedToKit`) pros e-mails que existirem no store, e grava 1
 * linha por exclusão em `data/brevo-diaria/kit-exclusion-log.jsonl`
 * (append-only, mesmo formato de `sunset-log.jsonl` em
 * `sunset-dead-subscribers.ts` — auditoria/reversão manual).
 *
 * ## Case-insensitive por construção (#6485 self-review)
 *
 * `computeKitActiveExclusions` normaliza (`trim().toLowerCase()`) TODOS os
 * três conjuntos (lista Brevo, ativos Kit, seeds) antes de comparar — um
 * e-mail cadastrado com capitalização diferente nos dois backends (comum:
 * Kit preserva o que a pessoa digitou, Brevo normaliza em alguns fluxos)
 * nunca deveria escapar do guard por essa diferença cosmética.
 *
 * ## Exceção: `EDITOR_SEED_EMAILS`
 *
 * As sondas do editor ficam PERMANENTEMENTE nas duas pontas de propósito
 * (inbox placement por provedor) — nunca são candidatas a exclusão, mesmo
 * quando `active` no Kit.
 *
 * ## Guard de publicação (#6485 — ver issue)
 *
 * Este módulo é código puro + I/O injetável — a chamada REAL contra a
 * Brevo/Kit (`applyKitActiveExclusionGuard` com deps de produção) nunca
 * rodou nesta unidade (mesma disciplina de `sunset-dead-subscribers.ts`:
 * `--push` existe no código, mas nenhuma sessão autônoma o invoca contra a
 * API real). Os 2 contatos reais já detectados na medição da issue seguem
 * na lista 7 até o próximo dispatch real (`publish-daily-brevo.ts`) exercitar
 * o guard, ou até uma limpeza manual/sessão supervisionada rodar antes disso.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brevoPost } from "./brevo-client.ts";
import { fetchBrevoListEmails } from "../evaluate-brevo-diaria.ts";
import { listAllKitSubscribers } from "./kit-subscribers.ts";
import type { KitConfig } from "./kit-config.ts";
import {
  applyConvertedToKit,
  normalizeEmail,
  readStore,
  writeStore,
  type BrevoDiariaStore,
} from "./brevo-diaria-store.ts";
import { EDITOR_SEED_EMAILS } from "./editor-copy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_KIT_EXCLUSION_LOG_PATH = resolve(ROOT, "data/brevo-diaria/kit-exclusion-log.jsonl");

// ---------------------------------------------------------------------------
// Pura
// ---------------------------------------------------------------------------

/**
 * Pura — quem deve ser removido da lista Brevo: está na lista E `active` no
 * Kit, exceto `EDITOR_SEED_EMAILS`. Case-insensitive (trim + lowercase) nos
 * 3 conjuntos — ver docstring do módulo. Devolve e-mails NORMALIZADOS
 * (lowercase/trim), não a grafia original de nenhum dos dois lados.
 */
export function computeKitActiveExclusions(params: {
  brevoListEmails: readonly string[];
  kitActiveEmails: readonly string[];
  seedEmails?: readonly string[];
}): string[] {
  const { brevoListEmails, kitActiveEmails, seedEmails = EDITOR_SEED_EMAILS } = params;
  const kitActiveSet = new Set(kitActiveEmails.map(normalizeEmail));
  const seedSet = new Set(seedEmails.map(normalizeEmail));
  const brevoNormalized = new Set(brevoListEmails.map(normalizeEmail));
  const excluded: string[] = [];
  for (const email of brevoNormalized) {
    if (kitActiveSet.has(email) && !seedSet.has(email)) excluded.push(email);
  }
  return excluded.sort();
}

// ---------------------------------------------------------------------------
// I/O — log de auditoria (mesmo padrão de `appendSunsetLog`)
// ---------------------------------------------------------------------------

export interface KitExclusionLogEntry {
  email: string;
  excluded_at: string;
  brevo_list_id: number;
  origem: "kit-active-exclusion";
}

/** I/O — grava 1 linha jsonl append-only (cria o diretório pai se necessário). */
export function appendKitExclusionLog(
  entry: KitExclusionLogEntry,
  path: string = DEFAULT_KIT_EXCLUSION_LOG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// I/O — orquestração injetável
// ---------------------------------------------------------------------------

export type RemoveFromBrevoListFn = (
  apiKey: string,
  listId: number,
  emails: string[],
) => Promise<{ contacts: { success: string[]; failure: string[] } }>;

/** Default de produção — `POST /contacts/lists/{listId}/contacts/remove` (mesmo endpoint de `split-wave-brevo.ts`). */
export const removeFromBrevoList: RemoveFromBrevoListFn = async (apiKey, listId, emails) => {
  return (await brevoPost(apiKey, `/contacts/lists/${listId}/contacts/remove`, { emails })) as {
    contacts: { success: string[]; failure: string[] };
  };
};

export interface KitActiveExclusionDeps {
  fetchBrevoListEmails: (apiKey: string, listId: number) => Promise<string[]>;
  fetchKitActiveEmails: (config?: KitConfig) => Promise<string[]>;
  removeFromBrevoList: RemoveFromBrevoListFn;
  readStore: () => BrevoDiariaStore;
  writeStore: (store: BrevoDiariaStore) => void;
  appendLog: (entry: KitExclusionLogEntry) => void;
  now: () => string;
}

export function productionKitActiveExclusionDeps(): KitActiveExclusionDeps {
  return {
    fetchBrevoListEmails,
    fetchKitActiveEmails: async (config) =>
      (await listAllKitSubscribers(config, { status: "active" })).map((s) => s.email_address),
    removeFromBrevoList,
    readStore: () => readStore(),
    writeStore: (store) => writeStore(store),
    appendLog: (entry) => appendKitExclusionLog(entry),
    now: () => new Date().toISOString(),
  };
}

export interface KitActiveExclusionResult {
  /** E-mails (normalizados) removidos da lista Brevo nesta rodada. */
  excluded: string[];
  /** Subconjunto de `excluded` que a Brevo confirmou (`contacts.success`). */
  removedFromList: string[];
  /** Subconjunto de `excluded` que a Brevo recusou remover. */
  failedToRemove: string[];
}

/**
 * I/O — aplica o guard completo: lê a lista Brevo + ativos Kit, calcula a
 * interseção (menos seeds), remove da lista Brevo, marca `converted_to_kit`
 * no store (só quem existir lá — a lista Brevo pode ter contato nunca
 * ingerido por este store, ex: seed ou legado), e loga cada exclusão.
 * Fail-soft NÃO se aplica aqui de propósito — diferente de
 * `brevo-diaria-stage5-dispatch.ts`, uma falha neste guard deve abortar o
 * dispatch da campanha (não faz sentido enviar sabendo que a exclusão não
 * rodou) — é o CALLER (`publish-daily-brevo.ts`) que decide como reagir a
 * uma exceção lançada aqui.
 */
export async function applyKitActiveExclusionGuard(
  params: { brevoApiKey: string; brevoListId: number; kitConfig?: KitConfig; seedEmails?: readonly string[] },
  deps: KitActiveExclusionDeps = productionKitActiveExclusionDeps(),
): Promise<KitActiveExclusionResult> {
  const [brevoListEmails, kitActiveEmails] = await Promise.all([
    deps.fetchBrevoListEmails(params.brevoApiKey, params.brevoListId),
    deps.fetchKitActiveEmails(params.kitConfig),
  ]);

  const excluded = computeKitActiveExclusions({
    brevoListEmails,
    kitActiveEmails,
    seedEmails: params.seedEmails,
  });

  if (excluded.length === 0) {
    return { excluded: [], removedFromList: [], failedToRemove: [] };
  }

  const removeResult = await deps.removeFromBrevoList(params.brevoApiKey, params.brevoListId, excluded);
  const removedSet = new Set(removeResult.contacts.success.map(normalizeEmail));

  let store = deps.readStore();
  const now = deps.now();
  for (const email of excluded) {
    if (!removedSet.has(email)) continue; // só marca store/log pro que a Brevo confirmou
    store = applyConvertedToKit(store, email, now);
    deps.appendLog({ email, excluded_at: now, brevo_list_id: params.brevoListId, origem: "kit-active-exclusion" });
  }
  deps.writeStore(store);

  return {
    excluded,
    removedFromList: removeResult.contacts.success.map(normalizeEmail),
    failedToRemove: removeResult.contacts.failure.map(normalizeEmail),
  };
}
