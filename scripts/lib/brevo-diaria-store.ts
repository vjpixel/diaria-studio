/**
 * brevo-diaria-store.ts (#4266)
 *
 * Store JSON simples (não SQLite — diferente de `clarice-db.ts`) que rastreia
 * o ciclo de vida de cada contato triado do segmento Pending da Beehiiv pro
 * canal Brevo próprio do editor:
 *
 *   beehiiv_pending → (ingestão) → in_brevo → (avaliação de score) →
 *     promoted_beehiiv  (score >= 60, decisão do editor)
 *     OU suppressed     (score <= -30, decisão do editor)
 *     OU permanece in_brevo (score no meio, "keep")
 *
 * Arquivo em `data/brevo-diaria/contacts.json` (mesma convenção de
 * `data/clarice-subscribers/`: dado business-sensitive, fora do repo via
 * `.gitignore` blanket de `data/`).
 *
 * Deliberadamente SEM SQLite: volume esperado (segmento Pending da Beehiiv)
 * é pequeno o bastante (cap de 300 envios/dia já é o teto operacional) pra um
 * JSON simples bastar — motivo #2 (junto com o acoplamento node:sqlite) pra
 * não reusar `clarice-db.ts` aqui.
 *
 * Toda lógica de transição de estado é PURA (recebe/devolve o array de
 * contatos) — leitura/escrita em disco ficam isoladas em `readStore`/
 * `writeStore`, injetáveis via `path` pra testes não tocarem `data/` real.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STORE_PATH = resolve(ROOT, "data/brevo-diaria/contacts.json");

export type BrevoDiariaContactStatus =
  | "in_brevo"
  | "promoted_beehiiv"
  | "suppressed";

export interface BrevoDiariaContact {
  email: string;
  /** id da subscription Beehiiv de origem (status Pending no momento da ingestão). */
  beehiiv_subscription_id: string;
  status: BrevoDiariaContactStatus;
  opens_count: number;
  sends_count: number;
  /** Score da última avaliação (`computeBrevoDiariaScore`) — null antes da 1ª avaliação. */
  last_score: number | null;
  added_at: string; // ISO — quando entrou no store (ingestão)
  last_evaluated_at: string | null; // ISO — última rodada de evaluate-brevo-diaria.ts
  promoted_at?: string; // ISO — quando status virou promoted_beehiiv
  suppressed_at?: string; // ISO — quando status virou suppressed
  /** Motivo da supressão/promoção — auditoria (#4266 self-review: nunca
   * silenciar POR QUE um contato saiu do fluxo). */
  resolution_reason?: "score_threshold" | "self_confirmed_beehiiv";
}

export interface BrevoDiariaStore {
  contacts: BrevoDiariaContact[];
}

function emptyStore(): BrevoDiariaStore {
  return { contacts: [] };
}

/** Lê o store do path dado (default `data/brevo-diaria/contacts.json`).
 * Arquivo ausente → store vazio (1ª execução, nunca erro). */
export function readStore(path: string = DEFAULT_STORE_PATH): BrevoDiariaStore {
  if (!existsSync(path)) return emptyStore();
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return emptyStore();
  const parsed = JSON.parse(raw) as Partial<BrevoDiariaStore>;
  return { contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [] };
}

/** Escreve o store (cria o diretório pai se necessário). */
export function writeStore(store: BrevoDiariaStore, path: string = DEFAULT_STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

/** Pura — email normalizado (lowercase/trim), mesma convenção do resto do repo. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findContact(store: BrevoDiariaStore, email: string): BrevoDiariaContact | undefined {
  const norm = normalizeEmail(email);
  return store.contacts.find((c) => c.email === norm);
}

/**
 * Pura — adiciona um contato novo ao store (ingestão). NUNCA sobrescreve um
 * contato já existente (idempotência: a mesma pessoa não é re-ingerida a
 * cada rodada de `sync-pending-to-brevo.ts` — dedup pelo store, não pela
 * Beehiiv, ver comentário de design em `sync-pending-to-brevo.ts`).
 * Retorna o store inalterado (mesma referência não garantida — novo objeto)
 * se o contato já existir.
 */
export function upsertIngested(
  store: BrevoDiariaStore,
  input: { email: string; beehiiv_subscription_id: string },
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(input.email);
  if (store.contacts.some((c) => c.email === norm)) return store;
  const contact: BrevoDiariaContact = {
    email: norm,
    beehiiv_subscription_id: input.beehiiv_subscription_id,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_score: null,
    added_at: now,
    last_evaluated_at: null,
  };
  return { contacts: [...store.contacts, contact] };
}

/**
 * Pura — aplica o resultado de uma avaliação de score a um contato existente
 * (by email). Só contatos com status `in_brevo` são elegíveis pra transição —
 * um contato já `promoted_beehiiv`/`suppressed` é noop (re-avaliação depois
 * da resolução não deveria acontecer, mas se o caller passar um email
 * resolvido por engano, isto não regride o estado).
 */
export function applyEvaluation(
  store: BrevoDiariaStore,
  email: string,
  update: { opens_count: number; sends_count: number; score: number; action: "promote_to_beehiiv" | "suppress" | "keep" },
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      const base: BrevoDiariaContact = {
        ...c,
        opens_count: update.opens_count,
        sends_count: update.sends_count,
        last_score: update.score,
        last_evaluated_at: now,
      };
      if (update.action === "promote_to_beehiiv") {
        return { ...base, status: "promoted_beehiiv", promoted_at: now, resolution_reason: "score_threshold" };
      }
      if (update.action === "suppress") {
        return { ...base, status: "suppressed", suppressed_at: now, resolution_reason: "score_threshold" };
      }
      return base; // "keep" — permanece in_brevo, contadores/score atualizados
    }),
  };
}

/**
 * Pura — marca um contato como promovido por AUTO-CONFIRMAÇÃO (a pessoa
 * confirmou o double opt-in da Beehiiv por conta própria, independente do
 * score) em vez de threshold. Fecha o gap de duplicidade que a própria issue
 * #4266 registrou como risco não resolvido: "quem confirma o opt-in depois
 * de já ter recebido via Brevo passa a estar nas duas bases" — a avaliação
 * periódica (`evaluate-brevo-diaria.ts`) checa o status Beehiiv atual de
 * cada contato `in_brevo` e usa esta função quando encontra `status=active`
 * (já confirmado no Beehiiv por iniciativa própria).
 */
export function applySelfConfirmed(
  store: BrevoDiariaStore,
  email: string,
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      return { ...c, status: "promoted_beehiiv", promoted_at: now, resolution_reason: "self_confirmed_beehiiv" };
    }),
  };
}
