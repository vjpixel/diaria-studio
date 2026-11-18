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
import { minimizeForgottenRows, recordForgetRequest, type ForgetRequest } from "./clarice-db.ts";

const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "..") : process.cwd();

export const DEFAULT_FORGET_LEDGER_PATH = resolve(ROOT, "data/clarice-subscribers/forget-requests.jsonl");

// ---------------------------------------------------------------------------
// Ledger (arquivo)
// ---------------------------------------------------------------------------

export interface LedgerRead {
  entries: ForgetRequest[];
  /** Linhas que não são um pedido válido (número da linha, 1-based). */
  invalid: number[];
}

/** Lê o ledger. Arquivo ausente = lista vazia (nenhum pedido ainda). Erro de leitura LANÇA. */
export function readForgetLedger(path: string): LedgerRead {
  if (!existsSync(path)) return { entries: [], invalid: [] };
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
  return { entries, invalid };
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
 */
export function importForgetLedger(db: DatabaseSync, path: string): { imported: number; total: number; invalid: number[] } {
  const { entries, invalid } = readForgetLedger(path);
  let imported = 0;
  for (const e of entries) {
    if (recordForgetRequest(db, { email: e.email, requestedAt: e.requested_at, source: e.source, note: e.note })) {
      imported++;
    }
  }
  return { imported, total: entries.length, invalid };
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
  const newRequest = recordForgetRequest(db, req);
  const ledgerWritten =
    ledgerPath == null
      ? false
      : appendForgetLedger(ledgerPath, {
          email,
          requested_at: req.requestedAt,
          source: req.source ?? null,
          note: req.note ?? null,
        });
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
    };

/**
 * Corpo do `PUT /contacts/{email}` que minimiza o contato (puro, testável):
 * blacklist ligada, sai de todas as listas em que está, e todo atributo de
 * texto vai pra "". Atributo numérico/booleano/data fica (listado em
 * `attributes_kept`). PREMISSA não verificada ao vivo nesta PR: a Brevo aceita
 * "" para limpar atributo de texto — o mesmo efeito que a limpeza do nome à mão
 * em 18/11 (#13534) produziu.
 */
export function buildBrevoMinimizeBody(contact: unknown): {
  body: { emailBlacklisted: true; unlinkListIds?: number[]; attributes?: Record<string, string> };
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
  const body: { emailBlacklisted: true; unlinkListIds?: number[]; attributes?: Record<string, string> } = {
    emailBlacklisted: true,
  };
  if (lists.length > 0) body.unlinkListIds = lists;
  if (cleared.length > 0) body.attributes = attributes;
  return { body, lists, cleared: cleared.sort(), kept: kept.sort() };
}

/**
 * Minimiza o contato na Brevo da Clarice (nunca apaga). 404 no GET →
 * `"not_found"` (o contato não existe lá; nada a minimizar). Erro de GET/PUT LANÇA.
 */
export function brevoMinimizerFromIo(io: BrevoMinimizeIo): (email: string) => Promise<BrevoMinimizeResult> {
  return async (email) => {
    const path = `/contacts/${encodeURIComponent(email)}`;
    const got = await io.get(path);
    if (got.status === 404) return { status: "not_found" };
    if (got.status < 200 || got.status >= 300) throw new Error(`Brevo GET ${path}: HTTP ${got.status}`);
    const { body, lists, cleared, kept } = buildBrevoMinimizeBody(got.body);
    await io.put(path, body);
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
