#!/usr/bin/env node
/**
 * clarice-stripe-delta.ts (#4347 Etapa 1)
 *
 * Fecha o G1 da issue #4347: até aqui o delta de cadastros novos do Stripe
 * entrava por EXPORT MANUAL do Dashboard, largado à mão em
 * `data/clarice-subscribers/stripe-customers-{YYYY-MM}-delta-{MMDD}.csv`
 * (ex: `-0727.csv`, `-0728.csv`). Este script busca o mesmo delta direto na
 * API Stripe e emite um CSV **no schema exato do export do Dashboard** — o
 * downstream (`merge-clarice-subscribers.ts` → `buildUniverse()` →
 * `clarice-build-db.ts`) ingere sem NENHUMA mudança, porque `buildUniverse`
 * já lê "qualquer CSV no diretório que não comece com um prefixo de output
 * conhecido" (ver `merge-clarice-subscribers.ts`).
 *
 * Header alvo (verbatim do export atual, #4347):
 *   id,Description,Email,Name,Created (UTC),Delinquent,Plan,Status,
 *   Total Spend,Payment Count,Refunded Volume,Dispute Losses,tag (metadata)
 *
 * Estratégia de fetch — TRÊS varreduras paginadas (`starting_after`), join em
 * memória por `customer`, NÃO um GET por cliente (O(páginas), não
 * O(clientes)):
 *   GET /v1/customers?created[gte]={since}       → id, email, name, created, delinquent, description, metadata
 *   GET /v1/subscriptions?created[gte]={since}&status=all → Plan, Status (por customer, prefere status mais "ativo")
 *   GET /v1/charges?created[gte]={since}         → Total Spend, Payment Count, Refunded Volume
 *
 * Invariante que torna a janela suficiente: um customer criado depois de
 * `since` NÃO PODE ter subscription/charge anterior a `since` — não precisa
 * de um 2º fetch mais largo pra "pegar contexto anterior".
 *
 * `Dispute Losses` → sempre `0`: a key restrita (`STRIPE_API_KEY`, escopo
 * Customers/Subscriptions/Charges = Read) NÃO cobre `/disputes` — documentado
 * aqui explicitamente (não silenciado). `dispute_losses > 0` é o único
 * critério que EXCLUI um contato do store (`buildUniverse`/`cohortOf` em
 * merge-clarice-subscribers.ts) — cadastros novos vindos por este caminho
 * nunca são auto-excluídos por disputa (o export manual do Dashboard segue
 * sendo o único jeito de capturar disputas até a key ganhar esse escopo).
 *
 * `--since YYYY-MM-DD` — default: `MAX(created)` do store (SQLite local)
 * MENOS 2 dias de folga. A janela é DELIBERADAMENTE sobreposta entre
 * rodadas — isso é inofensivo: o ingest é upsert por email
 * (`merge-clarice-subscribers.ts`/`clarice-build-db.ts`), e o dedup real de
 * ENVIO vem de `sends_count=0` + guard queued/sent
 * (`excludeCommittedToQueuedCampaigns`), não da janela do delta. Este script
 * não introduz high-water mark próprio.
 *
 * `--from-csv PATH` — fallback pro export manual (garante que a skill roda
 * mesmo se a key perder escopo, como aconteceu em #2971 com `/invoices`):
 * copia o arquivo dado, verbatim, pro path de saída canônico — não refaz o
 * parsing/join, já está no schema do Dashboard.
 *
 * `--dry-run` é o DEFAULT deste script (convenção invertida — a maioria dos
 * scripts do repo tem `--dry-run` opt-in; aqui o oposto: `--execute` é que
 * liga a escrita real). Sem `--execute`, só imprime o plano/resumo — a skill
 * `/diaria-clarice-novos` passa `--execute` explicitamente.
 *
 * Saída: data/clarice-subscribers/stripe-customers-{YYYY-MM}-delta-{MMDD}.csv
 * (YYYY-MM/MMDD = data desta EXECUÇÃO, mesma convenção do export manual — não
 * a data de `--since`) + resumo JSON no stdout.
 *
 * Uso:
 *   npx tsx scripts/clarice-stripe-delta.ts --execute                       # since = auto (store - 2d)
 *   npx tsx scripts/clarice-stripe-delta.ts --since 2026-07-01 --execute
 *   npx tsx scripts/clarice-stripe-delta.ts --from-csv path/to/export.csv --execute
 *   npx tsx scripts/clarice-stripe-delta.ts                                  # dry-run — só imprime o plano
 *   [--out-dir DIR]   OPCIONAL, uso interno de teste — substitui `CLARICE_BASE`
 *                      na resolução do path de saída (mesmo padrão de
 *                      `--data-root` em clarice-build-segment.ts).
 *
 * Env:
 *   STRIPE_API_KEY   obrigatório (fetch real) — chave restrita read-only
 *                     (Customers/Subscriptions/Charges = Read, já configurada
 *                     pro projeto). Ver scripts/lib/stripe-coupons.ts como
 *                     referência de cliente Stripe REST já existente no repo.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { clariceBaseFile } from "./lib/clarice-paths.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";

loadProjectEnv();

const STRIPE_BASE = "https://api.stripe.com/v1";

// ---------------------------------------------------------------------------
// Schema do CSV alvo — verbatim do export do Dashboard (#4347)
// ---------------------------------------------------------------------------

export const STRIPE_DELTA_CSV_HEADER = [
  "id",
  "Description",
  "Email",
  "Name",
  "Created (UTC)",
  "Delinquent",
  "Plan",
  "Status",
  "Total Spend",
  "Payment Count",
  "Refunded Volume",
  "Dispute Losses",
  "tag (metadata)",
] as const;

export type DeltaRow = Record<(typeof STRIPE_DELTA_CSV_HEADER)[number], string>;

// ---------------------------------------------------------------------------
// Tipos brutos Stripe (só os campos usados)
// ---------------------------------------------------------------------------

export interface StripeCustomerRaw {
  id: string;
  email: string | null;
  name: string | null;
  description?: string | null;
  created: number; // epoch seconds
  delinquent: boolean | null;
  metadata?: Record<string, string>;
}

export interface StripeSubscriptionRaw {
  id: string;
  customer: string;
  status: string;
  created: number;
  items: {
    data: Array<{
      price: {
        id: string;
        nickname?: string | null;
      };
    }>;
  };
}

export interface StripeChargeRaw {
  id: string;
  customer: string | null;
  amount: number;
  amount_captured?: number;
  amount_refunded?: number;
  status: string;
  paid: boolean;
  created: number;
}

// Mesmo ranking de STATUS_RANK em merge-clarice-subscribers.ts (preferStatus)
// — quando um customer tem >1 subscription na janela, a MAIS "ativa" vence.
const STATUS_RANK: Record<string, number> = {
  active: 5,
  past_due: 4,
  trialing: 3,
  canceled: 2,
  "": 1,
};

function bestSubscription(subs: StripeSubscriptionRaw[]): StripeSubscriptionRaw | undefined {
  if (subs.length === 0) return undefined;
  return subs
    .slice()
    .sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 1;
      const rb = STATUS_RANK[b.status] ?? 1;
      if (ra !== rb) return rb - ra;
      return a.created - b.created; // desempate: mais antiga primeiro (determinístico)
    })[0];
}

function planLabel(sub: StripeSubscriptionRaw | undefined): string {
  const price = sub?.items?.data?.[0]?.price;
  if (!price) return "";
  return price.nickname || price.id || "";
}

/** Charges válidas (succeeded+paid) de um customer — mesmo filtro de `computePaidCents` (stripe-coupons.ts). */
function chargesFor(customerId: string, charges: StripeChargeRaw[]): StripeChargeRaw[] {
  return charges.filter((c) => c.customer === customerId && c.status === "succeeded" && c.paid);
}

function chargeNetDollars(c: StripeChargeRaw): number {
  const captured = c.amount_captured != null && c.amount_captured > 0 ? c.amount_captured : c.amount;
  return captured / 100;
}

function refundedDollars(c: StripeChargeRaw): number {
  return (c.amount_refunded ?? 0) / 100;
}

/**
 * Join PURO (sem I/O) — customers × subscriptions × charges → linhas no
 * schema alvo. Testável sem rede.
 */
export function buildDeltaRows(
  customers: StripeCustomerRaw[],
  subscriptions: StripeSubscriptionRaw[],
  charges: StripeChargeRaw[],
): DeltaRow[] {
  const subsByCustomer = new Map<string, StripeSubscriptionRaw[]>();
  for (const s of subscriptions) {
    if (!subsByCustomer.has(s.customer)) subsByCustomer.set(s.customer, []);
    subsByCustomer.get(s.customer)!.push(s);
  }

  return customers.map((cust): DeltaRow => {
    const sub = bestSubscription(subsByCustomer.get(cust.id) ?? []);
    const custCharges = chargesFor(cust.id, charges);
    const totalSpend = custCharges.reduce((sum, c) => sum + chargeNetDollars(c), 0);
    const refundedVolume = custCharges.reduce((sum, c) => sum + refundedDollars(c), 0);

    return {
      id: cust.id,
      Description: cust.description ?? "",
      Email: cust.email ?? "",
      Name: cust.name ?? "",
      "Created (UTC)": new Date(cust.created * 1000).toISOString(),
      Delinquent: cust.delinquent == null ? "" : cust.delinquent ? "true" : "false",
      Plan: planLabel(sub),
      Status: sub?.status ?? "",
      "Total Spend": totalSpend.toFixed(2),
      "Payment Count": String(custCharges.length),
      "Refunded Volume": refundedVolume.toFixed(2),
      // #4347: fora do escopo da key restrita (Customers/Subscriptions/Charges
      // = Read; NÃO inclui Disputes) — sempre "0", documentado no topo do
      // arquivo, nunca silenciado.
      "Dispute Losses": "0",
      "tag (metadata)": cust.metadata?.tag ?? "",
    };
  });
}

export function rowsToCsv(rows: DeltaRow[]): string {
  return Papa.unparse({ fields: [...STRIPE_DELTA_CSV_HEADER], data: rows });
}

// ---------------------------------------------------------------------------
// Fetch paginado — injetável (fetchImpl) pra teste, sem network real
// ---------------------------------------------------------------------------

export class StripeDeltaApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number, body: string) {
    super(`Stripe GET ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "StripeDeltaApiError";
    this.status = status;
  }
}

async function stripeGetPage<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ data: T[]; has_more: boolean }> {
  const res = await fetchImpl(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new StripeDeltaApiError(path, res.status, body);
  }
  return res.json() as Promise<{ data: T[]; has_more: boolean }>;
}

/** Paginação por `starting_after` — O(páginas), nunca N+1 por cliente. */
export async function stripeListAllSince<T extends { id: string }>(
  resourcePath: string,
  extraQuery: string,
  sinceEpochSec: number,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const cursor = startingAfter ? `&starting_after=${startingAfter}` : "";
    const path = `/${resourcePath}?created[gte]=${sinceEpochSec}${extraQuery}&limit=100${cursor}`;
    const page = await stripeGetPage<T>(path, apiKey, fetchImpl);
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return items;
}

export async function fetchStripeDelta(
  apiKey: string,
  sinceEpochSec: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customers: StripeCustomerRaw[]; subscriptions: StripeSubscriptionRaw[]; charges: StripeChargeRaw[] }> {
  const [customers, subscriptions, charges] = await Promise.all([
    stripeListAllSince<StripeCustomerRaw>("customers", "", sinceEpochSec, apiKey, fetchImpl),
    stripeListAllSince<StripeSubscriptionRaw>("subscriptions", "&status=all", sinceEpochSec, apiKey, fetchImpl),
    stripeListAllSince<StripeChargeRaw>("charges", "", sinceEpochSec, apiKey, fetchImpl),
  ]);
  return { customers, subscriptions, charges };
}

// ---------------------------------------------------------------------------
// --since default: MAX(created) do store - 2 dias de folga
// ---------------------------------------------------------------------------

const SINCE_OVERLAP_DAYS = 2;

/**
 * Resolve o `--since` default a partir do store local: `MAX(created)` menos
 * `SINCE_OVERLAP_DAYS` dias — a folga só faz sentido em cima de um high-water
 * mark REAL (protege contra o intervalo entre a última ingestão e agora).
 * Store vazio/sem `created` nenhum → fallback pra EXATAMENTE 30 dias atrás
 * (1ª rodada, sem histórico local ainda) — SEM aplicar a folga de novo em
 * cima do fallback (um fallback arbitrário já não tem "borda" pra proteger;
 * dobrar a folga ali só confundia o operador, que via "30 dias" documentado
 * mas "32 dias" na prática).
 */
export function resolveDefaultSince(db: { prepare: (sql: string) => { get: () => unknown } }, now: Date = new Date()): string {
  const row = db.prepare("SELECT MAX(created) as maxCreated FROM clarice_users").get() as
    | { maxCreated: string | null }
    | undefined;
  const maxCreated = row?.maxCreated ? new Date(row.maxCreated) : null;
  if (maxCreated && !Number.isNaN(maxCreated.getTime())) {
    const withOverlap = new Date(maxCreated.getTime() - SINCE_OVERLAP_DAYS * 86_400_000);
    return withOverlap.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  return new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Path canônico de saída — data DA EXECUÇÃO (não de `--since`), mesma
 * convenção do export manual. `baseDir` OPCIONAL (uso interno de teste,
 * mesmo padrão de `--data-root` em clarice-build-segment.ts) — sem a flag,
 * resolve sob `CLARICE_BASE` (raiz fixa de produção, `data/clarice-subscribers`).
 */
export function deltaOutputPath(now: Date = new Date(), baseDir?: string): string {
  const yyyyMM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  const filename = `stripe-customers-${yyyyMM}-delta-${mmdd}.csv`;
  return baseDir ? resolve(baseDir, filename) : clariceBaseFile(filename);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const execute = hasFlag(argv, "execute"); // #4347: --dry-run é o DEFAULT, --execute liga a escrita real
  const outDirArg = getArg(argv, "out-dir"); // uso interno de teste — ver deltaOutputPath
  const outPath = deltaOutputPath(new Date(), outDirArg || undefined);

  const fromCsv = getArg(argv, "from-csv");
  if (fromCsv) {
    if (!existsSync(fromCsv)) {
      console.error(`❌ --from-csv: arquivo não encontrado: ${fromCsv}`);
      process.exit(1);
    }
    const raw = readFileSync(fromCsv, "utf8");
    const parsed = Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true });
    const count = parsed.data.length;
    console.error(`📋 --from-csv ${fromCsv} — ${count} linha(s), fallback pro export manual (sem chamada Stripe).`);
    if (!execute) {
      console.error(`ℹ️  dry-run — nada escrito. Re-rode com --execute pra copiar pro destino canônico.`);
      console.log(JSON.stringify({ mode: "dry-run", source: "from-csv", from: fromCsv, out: outPath, rows: count }, null, 2));
      return;
    }
    copyFileSync(fromCsv, outPath);
    console.error(`✅ copiado pra ${outPath}`);
    console.log(JSON.stringify({ mode: "execute", source: "from-csv", from: fromCsv, out: outPath, rows: count }, null, 2));
    return;
  }

  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    console.error("❌ STRIPE_API_KEY não definida (chave restrita read-only Customers/Subscriptions/Charges). Ver .env.example.");
    process.exit(1);
  }

  let sinceArg = getArg(argv, "since");
  if (sinceArg && (!/^\d{4}-\d{2}-\d{2}$/.test(sinceArg) || Number.isNaN(Date.parse(sinceArg)))) {
    console.error(`❌ --since inválido: "${sinceArg}" (esperado YYYY-MM-DD).`);
    process.exit(1);
  }
  if (!sinceArg) {
    const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
    if (existsSync(dbPath)) {
      const db = openClariceDb(dbPath);
      try {
        sinceArg = resolveDefaultSince(db);
      } finally {
        db.close();
      }
    } else {
      sinceArg = resolveDefaultSince({ prepare: () => ({ get: () => undefined }) });
    }
    console.error(`ℹ️  --since não informado — default calculado: ${sinceArg} (MAX(created) do store - ${SINCE_OVERLAP_DAYS}d, ou 30d atrás sem histórico).`);
  }
  const sinceEpochSec = Math.floor(Date.parse(`${sinceArg}T00:00:00Z`) / 1000);

  console.error(`📡 buscando delta Stripe desde ${sinceArg} (customers+subscriptions+charges, paginado)…`);
  const { customers, subscriptions, charges } = await fetchStripeDelta(apiKey, sinceEpochSec);
  const rows = buildDeltaRows(customers, subscriptions, charges);

  const summary = {
    mode: execute ? "execute" : "dry-run",
    source: "stripe-api",
    since: sinceArg,
    out: outPath,
    customers: customers.length,
    subscriptions: subscriptions.length,
    charges: charges.length,
    rows: rows.length,
  };

  if (!execute) {
    console.error(`ℹ️  dry-run — nada escrito. ${rows.length} cliente(s) no delta. Re-rode com --execute pra gravar o CSV.`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  writeFileSync(outPath, rowsToCsv(rows), "utf8");
  console.error(`✅ ${rows.length} cliente(s) → ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  });
}
