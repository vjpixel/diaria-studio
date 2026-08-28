#!/usr/bin/env node
/**
 * scripts/kit-provider-split.ts — abertura e clique de um broadcast do Kit,
 * cortados por provedor de e-mail.
 *
 * Nasceu do incidente de 28/08/2026: a edição 260827 saiu pelo Kit com 13,97%
 * de abertura contra 34,8% de média na Beehiiv, e o número agregado não dizia
 * por quê. O corte por provedor disse em uma linha — Gmail (72,8% da lista)
 * abriu 8,5% e clicou 0,46%, enquanto todo o resto abriu 28,4% e clicou 13,6%.
 * Abertura e clique caindo juntos num provedor só é entrega, não medição.
 *
 * É também o painel que governa a rampa de migração (`kit_diaria.audience_tag`
 * = `rampa-gmail`): a onda só cresce enquanto a abertura do lote Gmail ficar
 * em pelo menos {@link RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.
 *
 * ## O que este script NÃO faz
 *
 * Não escreve nada — nem no Kit, nem na Beehiiv, nem em disco. É leitura pura
 * (3 endpoints do Kit) mais o cruzamento puro de `lib/provider-split.ts`.
 *
 * ## Ressalva de denominador (por que o total pode não bater com o Kit)
 *
 * A lista de destinatários é a de assinantes ATIVOS AGORA, não o snapshot do
 * envio — o Kit não expõe o snapshot. Quem descadastrou entre o envio e a
 * leitura sai da lista e continua contando como abridor no relatório do Kit.
 * O script imprime `stats.recipients` do próprio Kit ao lado do total
 * calculado justamente pra essa divergência ficar visível em vez de virar
 * desconfiança da conta. `foraDaLista` mede o mesmo fenômeno pelo outro lado.
 *
 * Uso:
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689 --json
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { kitFetch, getBroadcastStats } from "./lib/kit-client.ts";
import { computeProviderSplit, rampaPodeCrescer, RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT, type ProviderRow } from "./lib/provider-split.ts";

interface KitSubscriberRow {
  id: string;
  email_address: string;
}

interface KitPaginatedSubscribers {
  subscribers?: KitSubscriberRow[];
  pagination?: { has_next_page?: boolean; end_cursor?: string | null };
}

/** Teto de páginas — guarda contra `has_next_page` que nunca vira `false`. */
const MAX_PAGES = 200;

async function drainPages(
  fetchPage: (after: string | undefined) => Promise<KitPaginatedSubscribers>,
  label: string,
): Promise<string[]> {
  const emails: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchPage(after);
    for (const s of data.subscribers ?? []) {
      if (s.email_address) emails.push(s.email_address);
    }
    const next = data.pagination?.end_cursor;
    if (!data.pagination?.has_next_page || !next) return emails;
    after = next;
  }
  throw new Error(`[kit-provider-split] ${label}: paginação passou de ${MAX_PAGES} páginas — abortando pra não girar em falso.`);
}

/** Assinantes ativos da conta. É o denominador de todas as taxas. */
function fetchActiveSubscribers(): Promise<string[]> {
  return drainPages((after) => {
    const params = new URLSearchParams({ per_page: "500", status: "active" });
    if (after) params.set("after", after);
    return kitFetch<KitPaginatedSubscribers>(`/subscribers?${params}`);
  }, "assinantes ativos");
}

/**
 * Quem abriu (`opens`) ou clicou (`clicks`) o broadcast.
 *
 * `POST /v4/subscribers/filter` é o único endpoint do Kit que devolve a
 * IDENTIDADE de quem engajou — `/broadcasts/{id}/clicks` agrega por link e
 * não serve pra cruzar com domínio.
 */
function fetchEngaged(broadcastId: number, type: "opens" | "clicks"): Promise<string[]> {
  return drainPages((after) => {
    const body: Record<string, unknown> = {
      all: [{ type, any: [{ type: "broadcasts", ids: [broadcastId] }], count_greater_than: 0 }],
      per_page: 100,
    };
    if (after) body.after = after;
    return kitFetch<KitPaginatedSubscribers>("/subscribers/filter", { method: "POST", body });
  }, type === "opens" ? "aberturas" : "cliques");
}

function parseArgs(argv: string[]): { broadcastId: number; json: boolean } {
  const json = argv.includes("--json");
  const i = argv.indexOf("--broadcast");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  const broadcastId = Number(raw);
  if (!raw || !Number.isInteger(broadcastId) || broadcastId <= 0) {
    throw new Error("uso: npx tsx scripts/kit-provider-split.ts --broadcast <id> [--json]");
  }
  return { broadcastId, json };
}

function formatTable(rows: ProviderRow[]): string {
  const header = ["provedor", "destin.", "abriu", "clicou", "abertura", "clique"];
  const body = rows.map((r) => [
    r.provider,
    String(r.recipients),
    String(r.openers),
    String(r.clickers),
    `${r.openRatePct.toFixed(1)}%`,
    `${r.clickRatePct.toFixed(1)}%`,
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((row) => row[c].length)));
  const line = (cells: string[]) =>
    cells.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

async function main(): Promise<void> {
  loadProjectEnv();
  const { broadcastId, json } = parseArgs(process.argv.slice(2));

  const [recipients, openers, clickers, stats] = await Promise.all([
    fetchActiveSubscribers(),
    fetchEngaged(broadcastId, "opens"),
    fetchEngaged(broadcastId, "clicks"),
    getBroadcastStats(broadcastId),
  ]);

  const split = computeProviderSplit({ recipients, openers, clickers });

  if (json) {
    console.log(JSON.stringify({ broadcastId, kitStats: stats, split, rampaPodeCrescer: rampaPodeCrescer(split) }, null, 2));
    return;
  }

  console.log(`\nBroadcast ${broadcastId} — corte por provedor\n`);
  console.log(formatTable([...split.rows, split.gmail, split.naoGmail, split.total]));

  console.log(`\nAgregado do Kit: ${stats.recipients} destinatários, ${stats.open_rate.toFixed(2)}% abertura, ${stats.click_rate.toFixed(2)}% clique.`);
  if (stats.recipients !== split.total.recipients) {
    console.log(
      `Aviso: o Kit reporta ${stats.recipients} destinatários e a lista de ativos tem ${split.total.recipients}. ` +
        `A lista é lida agora, não no envio — a diferença é quem entrou ou saiu no meio.`,
    );
  }
  if (split.foraDaLista.openers > 0 || split.foraDaLista.clickers > 0) {
    console.log(
      `Aviso: ${split.foraDaLista.openers} abridor(es) e ${split.foraDaLista.clickers} clicador(es) não estão mais na lista de ativos — ignorados no corte.`,
    );
  }

  const veredito = rampaPodeCrescer(split)
    ? `PODE CRESCER — Gmail em ${split.gmail.openRatePct.toFixed(1)}%, acima do piso de ${RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.`
    : `SEGURAR — Gmail em ${split.gmail.openRatePct.toFixed(1)}%, abaixo do piso de ${RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.`;
  console.log(`\nRampa: ${veredito}\n`);
}

main().catch((err) => {
  console.error(`[kit-provider-split] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
