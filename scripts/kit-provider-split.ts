#!/usr/bin/env node
/**
 * scripts/kit-provider-split.ts — abertura e clique de um broadcast do Kit,
 * cortados por provedor de e-mail.
 *
 * Nasceu do incidente de 28/08/2026: a edição 260827 saiu pelo Kit com 13,97%
 * de abertura contra 34,8% de média na Beehiiv, e o número agregado não dizia
 * por quê. O corte por provedor disse em uma linha — Gmail (434 dos 596
 * ativos) abriu 8,5% e clicou 0,46%, enquanto todo o resto abriu 28,4% e
 * clicou 13,6%. Abertura e clique caindo juntos num provedor só é entrega,
 * não medição.
 *
 * É também o painel que governa a rampa de migração — ver
 * `kit_diaria.audience_tag` em `platform.config.json` (o NOME da tag muda a
 * cada onda do rollout, por isso não é citado aqui). A onda só cresce enquanto
 * a abertura do lote Gmail ficar em pelo menos
 * {@link RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.
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
 * **A divergência tem mais de uma causa possível** — churn de assinante é a
 * benigna, paginação incompleta é a que importa. Por isso a mensagem impressa
 * lista as duas em vez de afirmar a primeira: achado do review da PR #6491,
 * onde a versão anterior cravava "a diferença é quem entrou ou saiu no meio" e
 * assim desarmava o único guard cruzado capaz de flagrar uma coleta truncada.
 *
 * Uso:
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689 --json
 */
import { getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { kitFetch, getBroadcastStats } from "./lib/kit-client.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  computeProviderSplit,
  rampaPodeCrescer,
  RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT,
  type ProviderRow,
} from "./lib/provider-split.ts";

/** Página de `POST /v4/subscribers/filter`. Campos opcionais porque é a API que decide. */
export interface KitEngagedPage {
  subscribers?: Array<{ email_address?: string }>;
  pagination?: { has_next_page?: boolean; end_cursor?: string | null };
}

/** Teto de páginas — guarda contra `has_next_page` que nunca vira `false`. */
export const MAX_PAGES = 200;

export interface DrainResult {
  emails: string[];
  /**
   * Linhas que vieram na página mas sem `email_address` utilizável.
   *
   * Reportado em vez de descartado em silêncio: some do numerador/denominador
   * sem deixar rastro, e "a API nunca manda isso" fica indistinguível de "a
   * API mandou e nós jogamos fora" (achado do review da PR #6491).
   */
  descartadas: number;
}

/**
 * Pagina um endpoint de assinantes do Kit até o fim.
 *
 * ## Envelope inesperado é ERRO, nunca "fim da lista"
 *
 * A armadilha que este código existe pra não repetir (achado do review da
 * PR #6491, P1): tratar `data.subscribers` ausente como `[]` e
 * `data.pagination?.has_next_page` ausente como `false` faz uma resposta 2xx
 * malformada — mudança de contrato da API, payload de erro disfarçado de
 * sucesso, JSON truncado que ainda dá parse — terminar a paginação em
 * silêncio. O resultado é uma lista parcial **indistinguível de uma completa**,
 * e ela alimenta o denominador de todas as taxas e o veredito de
 * `rampaPodeCrescer`, que é gate de uma decisão de envio real.
 *
 * Mesma disciplina de `getBroadcast`/`getBroadcastStats` em `kit-client.ts`,
 * que lançam quando o envelope 2xx esperado não vem. A distinção que importa:
 * `subscribers: []` (array vazio) é fim de lista legítimo; `subscribers`
 * AUSENTE é resposta que não entendemos.
 *
 * `fetchPage` é injetado — é o que torna esta função testável sem rede.
 */
export async function drainPages(
  fetchPage: (after: string | undefined) => Promise<KitEngagedPage>,
  label: string,
): Promise<DrainResult> {
  const emails: string[] = [];
  let descartadas = 0;
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchPage(after);

    if (!data || data.subscribers === undefined) {
      throw new Error(
        `[kit-provider-split] ${label}: página ${page + 1} veio sem a chave "subscribers" — ` +
          `resposta 2xx que não entendemos. Abortando em vez de tratar como fim de lista.`,
      );
    }
    if (data.pagination === undefined) {
      throw new Error(
        `[kit-provider-split] ${label}: página ${page + 1} veio sem a chave "pagination" — ` +
          `sem ela não dá pra saber se a lista terminou ou foi truncada. Abortando.`,
      );
    }

    for (const s of data.subscribers) {
      const email = s?.email_address?.trim();
      if (email) emails.push(email);
      else descartadas += 1;
    }

    const next = data.pagination.end_cursor;
    if (!data.pagination.has_next_page) return { emails, descartadas };
    if (!next) {
      throw new Error(
        `[kit-provider-split] ${label}: página ${page + 1} diz has_next_page=true mas não trouxe end_cursor — ` +
          `a lista está truncada e não há como continuar. Abortando.`,
      );
    }
    after = next;
  }

  throw new Error(
    `[kit-provider-split] ${label}: paginação passou de ${MAX_PAGES} páginas — abortando pra não girar em falso.`,
  );
}

/**
 * Quem abriu (`opens`) ou clicou (`clicks`) o broadcast.
 *
 * `POST /v4/subscribers/filter` é o único endpoint do Kit que devolve a
 * IDENTIDADE de quem engajou — `/broadcasts/{id}/clicks` agrega por link e não
 * serve pra cruzar com domínio.
 *
 * **Confirmado ao vivo em 28/08/2026** contra o broadcast 25622689: devolveu
 * 83 abridores e 24 clicadores, batendo com `stats.open_rate`/`click_rate` do
 * próprio Kit (13,97% e 4,04% sobre 594 destinatários). A anotação existe
 * porque `kit-client.ts` documenta que 2xx do Kit não implica efeito/shape
 * esperado, e o resto do módulo registra essa confirmação por função.
 */
export function fetchEngaged(broadcastId: number, type: "opens" | "clicks"): Promise<DrainResult> {
  return drainPages((after) => {
    const body: Record<string, unknown> = {
      all: [{ type, any: [{ type: "broadcasts", ids: [broadcastId] }], count_greater_than: 0 }],
      per_page: 100,
    };
    if (after) body.after = after;
    return kitFetch<KitEngagedPage>("/subscribers/filter", { method: "POST", body });
  }, type === "opens" ? "aberturas" : "cliques");
}

/**
 * Id do broadcast a partir do argv.
 *
 * `getIntArg` (`lib/cli-args.ts`) já lança em valor não-inteiro ou abaixo do
 * mínimo; aqui só se traduz a AUSÊNCIA da flag em mensagem de uso — o resto
 * reusa o parser testado do repo em vez de reimplementar (#6491).
 */
export function resolveBroadcastId(argv: string[]): number {
  const id = getIntArg(argv, "broadcast", { min: 1 });
  if (id === undefined) {
    throw new Error("uso: npx tsx scripts/kit-provider-split.ts --broadcast <id> [--json]");
  }
  return id;
}

export function formatTable(rows: ProviderRow[]): string {
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
  const argv = process.argv.slice(2);
  const broadcastId = resolveBroadcastId(argv);
  const json = hasFlag(argv, "json");

  const [ativos, opens, clicks, stats] = await Promise.all([
    listAllKitSubscribers(undefined, { status: "active" }),
    fetchEngaged(broadcastId, "opens"),
    fetchEngaged(broadcastId, "clicks"),
    getBroadcastStats(broadcastId),
  ]);

  const recipients = ativos.map((s) => s.email_address).filter(Boolean);
  const split = computeProviderSplit({ recipients, openers: opens.emails, clickers: clicks.emails });

  if (json) {
    console.log(
      JSON.stringify(
        { broadcastId, kitStats: stats, split, rampaPodeCrescer: rampaPodeCrescer(split) },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nBroadcast ${broadcastId} — corte por provedor\n`);
  console.log(formatTable([...split.rows, split.gmail, split.naoGmail, split.total]));

  console.log(
    `\nAgregado do Kit: ${stats.recipients} destinatários, ${stats.open_rate.toFixed(2)}% abertura, ${stats.click_rate.toFixed(2)}% clique.`,
  );
  if (stats.recipients !== split.total.recipients) {
    console.log(
      `Aviso: o Kit reporta ${stats.recipients} destinatários e a lista de ativos tem ${split.total.recipients}. ` +
        `Causas possíveis: quem entrou ou saiu da lista desde o envio (benigno), OU uma coleta que não completou. ` +
        `Se a diferença for grande, reconferir com --json antes de confiar nas taxas.`,
    );
  }
  if (split.foraDaLista.openers > 0 || split.foraDaLista.clickers > 0) {
    console.log(
      `Aviso: ${split.foraDaLista.openers} abridor(es) e ${split.foraDaLista.clickers} clicador(es) não estão mais na lista de ativos — ignorados no corte.`,
    );
  }
  const descartadas = opens.descartadas + clicks.descartadas;
  if (descartadas > 0) {
    console.log(`Aviso: ${descartadas} registro(s) de engajamento vieram sem e-mail utilizável e foram ignorados.`);
  }

  if (split.gmail.recipients === 0) {
    console.log(
      `\nRampa: SEGURAR — nenhum destinatário Gmail na lista de ativos. ` +
        `Isso NÃO é colapso de entrega: é sinal de consulta/filtro errado. Conferir antes de interpretar como dado.\n`,
    );
    return;
  }

  const veredito = rampaPodeCrescer(split)
    ? `PODE CRESCER — Gmail em ${split.gmail.openRatePct.toFixed(1)}%, acima do piso de ${RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.`
    : `SEGURAR — Gmail em ${split.gmail.openRatePct.toFixed(1)}%, abaixo do piso de ${RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%.`;
  console.log(`\nRampa: ${veredito}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[kit-provider-split] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
