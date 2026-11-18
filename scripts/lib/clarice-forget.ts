/**
 * clarice-forget.ts (#13573) — lista de esquecimento (LGPD) do store da
 * Clarice: registro durável do pedido, minimização no store e na Brevo.
 *
 * Por que existe: em 18/11/2026 (#13534) uma leitora pediu a exclusão dos
 * dados; a minimização feita à mão no store não durava, porque o rebuild
 * (`clarice-build-db.ts`) regravava nome e ids do Stripe a partir do export,
 * que continua tendo a pessoa. As regras do store (o que fica, o que sai, por
 * que a linha não é apagada) estão em `clarice-db.ts`, seção "Lista de
 * esquecimento"; aqui ficam o que envolve arquivo e rede:
 *
 *   - LEDGER em `data/clarice-subscribers/forget-requests.jsonl` (append-only,
 *     1 pedido por linha). Cópia do pedido FORA do `.db`: se o store for
 *     recriado do zero, `clarice-build-db.ts` reimporta o ledger antes de
 *     ingerir o Stripe, e o pedido não se perde junto com o arquivo.
 *   - Brevo: minimiza o contato SEM apagá-lo (apagar tiraria a blacklist):
 *     blacklist, sai de todas as listas, atributos de texto zerados.
 *
 * Consumidores: `scripts/clarice-forget.ts` (CLI) e
 * `scripts/clarice-replies-triage.ts --apply` (respostas com `data_deletion`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizeGmail } from "./canonicalize-gmail.ts";
import {
  listForgetRequests,
  minimizeForgottenRows,
  recordForgetRequest,
  type ForgetRequest,
} from "./clarice-db.ts";

const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "..") : process.cwd();

export const DEFAULT_FORGET_LEDGER_PATH = resolve(ROOT, "data/clarice-subscribers/forget-requests.jsonl");

// ---------------------------------------------------------------------------
// Ledger (arquivo)
// ---------------------------------------------------------------------------

export interface LedgerRead {
  /** O arquivo existe? Ausente = nenhum pedido NESTE arquivo (ver `importForgetLedger`). */
  exists: boolean;
  entries: ForgetRequest[];
}

/**
 * Lê o ledger. Arquivo ausente = `{ exists: false, entries: [] }`. Erro de
 * leitura LANÇA, e linha que não é um pedido válido também LANÇA (#13573,
 * review da PR #13583): pular a linha seria esquecer em silêncio um pedido
 * de exclusão, e o rebuild regravaria o dado pessoal dele.
 */
export function readForgetLedger(path: string): LedgerRead {
  if (!existsSync(path)) return { exists: false, entries: [] };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const entries: ForgetRequest[] = [];
  const invalid: number[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const o = JSON.parse(line) as Partial<ForgetRequest>;
      if (typeof o.email !== "string" || !o.email.includes("@") || typeof o.requested_at !== "string") {
        invalid.push(i + 1);
        return;
      }
      entries.push({
        email: o.email.trim().toLowerCase(),
        requested_at: o.requested_at,
        source: typeof o.source === "string" ? o.source : null,
        note: typeof o.note === "string" ? o.note : null,
      });
    } catch {
      invalid.push(i + 1);
    }
  });
  if (invalid.length > 0) {
    throw new Error(
      `linha(s) inválida(s) no ledger da lista de esquecimento ${path}: ${invalid.join(", ")} — ` +
        `corrija o arquivo (1 pedido JSON por linha, com email e requested_at); nada foi feito`,
    );
  }
  return { exists: true, entries };
}

/** Acrescenta o pedido ao ledger se o e-mail ainda não está lá. Devolve `true` se escreveu. */
export function appendForgetLedger(path: string, req: ForgetRequest): boolean {
  const email = req.email.trim().toLowerCase();
  if (readForgetLedger(path).entries.some((e) => e.email === email)) return false;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...req, email }) + "\n", "utf8");
  return true;
}

/**
 * Ledger → tabela `forget_requests` (idempotente). Chamado pelo rebuild antes
 * de ingerir o Stripe. Devolve quantos pedidos eram novos na tabela.
 *
 * Falha FECHADA (#13573, review da PR #13583): se a tabela já tem pedido que o
 * ledger não traz — ledger ausente (Drive ainda sem sincronizar) ou defasado —
 * LANÇA antes de importar qualquer coisa. Seguir assim tornaria o ledger
 * incompleto a fonte da verdade no próximo store recriado, e quem ficou de
 * fora voltaria a ter nome e ids regravados pelo Stripe. Para reconstruir o
 * ledger a partir da tabela (depois de conferir que o Drive sincronizou):
 * `clarice-forget.ts sync-ledger`.
 */
export function importForgetLedger(
  db: DatabaseSync,
  path: string,
): { imported: number; total: number; ledger_exists: boolean } {
  const { exists, entries } = readForgetLedger(path);
  const inLedger = new Set(entries.map((e) => e.email));
  const missing = listForgetRequests(db)
    .map((r) => r.email)
    .filter((e) => !inLedger.has(e));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} pedido(s) de exclusão no store não estão no ledger ` +
        `${exists ? "" : "(ARQUIVO AUSENTE) "}${path}: ${missing.join(", ")}. ` +
        `Confira se o Drive terminou de sincronizar; se o ledger está mesmo defasado, ` +
        `reconstrua-o com \`npx tsx scripts/clarice-forget.ts sync-ledger\``,
    );
  }
  let imported = 0;
  for (const e of entries) {
    if (recordForgetRequest(db, { email: e.email, requestedAt: e.requested_at, source: e.source, note: e.note })) {
      imported++;
    }
  }
  return { imported, total: entries.length, ledger_exists: exists };
}

/**
 * Tabela → ledger: acrescenta ao ledger todo pedido da tabela que falta nele
 * (nunca remove nem reescreve linha existente). Devolve os e-mails acrescentados.
 */
export function syncLedgerFromStore(db: DatabaseSync, path: string): string[] {
  const added: string[] = [];
  for (const r of listForgetRequests(db)) {
    if (appendForgetLedger(path, r)) added.push(r.email);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ForgetInStoreResult {
  email: string;
  new_request: boolean;
  ledger_written: boolean;
  minimized: number;
  inserted: number;
  optin_removed: number;
}

/**
 * Registra o pedido (tabela + ledger) e minimiza o store NA HORA. Não
 * recomputa os derivados: a linha já sai com `send_eligible=0`, e o chamador
 * roda `recomputeDerived` no fim do lote (que minimiza de novo, idempotente).
 * `ledgerPath: null` desliga o ledger (teste).
 */
export function forgetInStore(
  db: DatabaseSync,
  req: { email: string; requestedAt: string; source?: string | null; note?: string | null },
  ledgerPath: string | null = DEFAULT_FORGET_LEDGER_PATH,
): ForgetInStoreResult {
  const email = req.email.trim().toLowerCase();
  // Ledger ANTES da tabela (#13573, review da PR #13583): se a escrita no ledger falhar, a tabela não
  // fica com um pedido que o ledger não tem (o rebuild abortaria até o `sync-ledger`).
  const ledgerWritten =
    ledgerPath == null
      ? false
      : appendForgetLedger(ledgerPath, {
          email,
          requested_at: req.requestedAt,
          source: req.source ?? null,
          note: req.note ?? null,
        });
  const newRequest = recordForgetRequest(db, req);
  const m = minimizeForgottenRows(db);
  return { email, new_request: newRequest, ledger_written: ledgerWritten, ...m };
}

// ---------------------------------------------------------------------------
// Brevo
// ---------------------------------------------------------------------------

export interface BrevoMinimizeIo {
  /** GET que devolve status + corpo (404 não lança), como `brevoGet`. */
  get: (path: string) => Promise<{ status: number; body: unknown }>;
  put: (path: string, body: unknown) => Promise<unknown>;
}

export type BrevoMinimizeResult =
  | { status: "not_found" }
  | {
      status: "ok";
      lists_unlinked: number[];
      attributes_cleared: string[];
      /** Atributos não-texto, deixados como estão (zerar com "" pode ser recusado pela Brevo): revisar à mão. */
      attributes_kept: string[];
      /**
       * Atributos de texto que a Brevo recusou zerar (2º PUT falhou). A blacklist e a saída das
       * listas já valeram (1º PUT); estes ficam para revisão à mão.
       */
      attributes_failed?: string[];
      attributes_error?: string;
    };

/**
 * Corpos dos dois `PUT /contacts/{email}` que minimizam o contato (puro, testável):
 *   - `suppress`: blacklist ligada + sai de todas as listas em que está;
 *   - `attributes`: todo atributo de texto vai pra "" (`null` se não há nenhum).
 * Separados (#13573, review da PR #13583): num PUT só, um atributo recusado pela
 * Brevo derrubava também a blacklist e a saída das listas. Atributo
 * numérico/booleano/data fica (listado em `kept`). PREMISSA não verificada ao
 * vivo nesta PR: a Brevo aceita "" para limpar atributo de texto — o mesmo
 * efeito que a limpeza do nome à mão em 18/11 (#13534) produziu.
 */
export function buildBrevoMinimizeBody(contact: unknown): {
  suppress: { emailBlacklisted: true; unlinkListIds?: number[] };
  attributes: { attributes: Record<string, string> } | null;
  lists: number[];
  cleared: string[];
  kept: string[];
} {
  const c = (contact ?? {}) as { listIds?: unknown; attributes?: unknown };
  const lists = Array.isArray(c.listIds) ? c.listIds.filter((x): x is number => typeof x === "number") : [];
  const attrs = c.attributes && typeof c.attributes === "object" ? (c.attributes as Record<string, unknown>) : {};
  const cleared: string[] = [];
  const kept: string[] = [];
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string") {
      if (v !== "") {
        attributes[k] = "";
        cleared.push(k);
      }
    } else if (v != null) {
      kept.push(k);
    }
  }
  const suppress: { emailBlacklisted: true; unlinkListIds?: number[] } = { emailBlacklisted: true };
  if (lists.length > 0) suppress.unlinkListIds = lists;
  return {
    suppress,
    attributes: cleared.length > 0 ? { attributes } : null,
    lists,
    cleared: cleared.sort(),
    kept: kept.sort(),
  };
}

/**
 * Minimiza o contato na Brevo da Clarice (nunca apaga). 404 no GET →
 * `"not_found"` (o contato não existe lá; nada a minimizar). Erro do GET ou do
 * PUT de supressão LANÇA; erro do PUT de atributos NÃO lança — a supressão já
 * valeu, e o resultado lista os atributos que ficaram (`attributes_failed`).
 */
export function brevoMinimizerFromIo(io: BrevoMinimizeIo): (email: string) => Promise<BrevoMinimizeResult> {
  return async (email) => {
    const path = `/contacts/${encodeURIComponent(email)}`;
    const got = await io.get(path);
    if (got.status === 404) return { status: "not_found" };
    if (got.status < 200 || got.status >= 300) throw new Error(`Brevo GET ${path}: HTTP ${got.status}`);
    const { suppress, attributes, lists, cleared, kept } = buildBrevoMinimizeBody(got.body);
    await io.put(path, suppress);
    if (attributes) {
      try {
        await io.put(path, attributes);
      } catch (e) {
        return {
          status: "ok",
          lists_unlinked: lists,
          attributes_cleared: [],
          attributes_kept: kept,
          attributes_failed: cleared,
          attributes_error: (e as Error).message,
        };
      }
    }
    return { status: "ok", lists_unlinked: lists, attributes_cleared: cleared, attributes_kept: kept };
  };
}

export async function makeBrevoMinimizer(apiKey: string): Promise<(email: string) => Promise<BrevoMinimizeResult>> {
  const { brevoGet, brevoPut } = await import("./brevo-client.ts");
  return brevoMinimizerFromIo({
    get: (path) => brevoGet(apiKey, path),
    put: (path, body) => brevoPut(apiKey, path, body),
  });
}

/**
 * Endereços a minimizar na Brevo para um pedido (#13573, review da PR #13583):
 * toda linha do store que bate com o pedido pela caixa canônica — as variantes
 * do mesmo Gmail que `minimizeForgottenRows` minimizou no store também existem,
 * cada uma, como contato na Brevo. Sem linha no store: o próprio e-mail.
 */
export function forgetBrevoTargets(db: DatabaseSync, email: string): string[] {
  const key = email.trim().toLowerCase();
  const matches = makeForgetMatcherFor(new Set([key]));
  const rows = (db.prepare("SELECT email FROM clarice_users").all() as Array<{ email: string }>)
    .map((r) => r.email)
    .filter(matches);
  return rows.length > 0 ? [...new Set(rows)].sort() : [key];
}

function makeForgetMatcherFor(emails: ReadonlySet<string>): (email: string) => boolean {
  const keys = new Set([...emails].map((e) => canonicalizeGmail(e)));
  return (email) => {
    const e = email.trim().toLowerCase();
    return !!e && keys.has(canonicalizeGmail(e));
  };
}

export interface BrevoForgetOutcome {
  /** Endereços tentados (todas as variantes do store). */
  targets: string[];
  results: Record<string, BrevoMinimizeResult>;
  /** Algum endereço existia na Brevo? `false` = todos `not_found`. */
  found: boolean;
}

/**
 * Minimiza na Brevo cada endereço de `targets`. Tenta todos antes de falhar:
 * se algum lançar, LANÇA no fim com os endereços que falharam (os outros já
 * ficaram minimizados; repetir é idempotente).
 */
export async function minimizeBrevoTargets(
  minimize: (email: string) => Promise<BrevoMinimizeResult>,
  targets: string[],
): Promise<BrevoForgetOutcome> {
  const results: Record<string, BrevoMinimizeResult> = {};
  const errors: string[] = [];
  for (const t of targets) {
    try {
      results[t] = await minimize(t);
    } catch (e) {
      errors.push(`${t}: ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return { targets, results, found: Object.values(results).some((r) => r.status === "ok") };
}
