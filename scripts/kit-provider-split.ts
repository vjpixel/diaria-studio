#!/usr/bin/env node
/**
 * scripts/kit-provider-split.ts — entrega, abertura e clique de um broadcast do
 * Kit, cortados por provedor de e-mail.
 *
 * Nasceu do incidente de 28/08/2026 (#6504): a edição 260827 saiu pelo Kit com
 * 13,97% de abertura contra 34,8% de média na Beehiiv, e o número agregado não
 * dizia por quê. O corte disse em uma linha — o Gmail (433 dos 594 enviados)
 * **entregou 122**, 28,2%; Microsoft, Yahoo, Apple, UOL e Proton entregaram
 * 100%. Quem recebeu abriu 30,3%, normal. A falha era entrega, não abertura, e
 * a primeira versão deste script não conseguia mostrar isso porque media
 * abertura sobre a lista de assinantes ativos (#6505).
 *
 * É também o painel que governa a rampa de migração — ver
 * `kit_diaria.audience_tag` em `platform.config.json` (o NOME da tag muda a
 * cada onda do rollout, por isso não é citado aqui). O veredito vem de
 * `avaliarRampa`, que exige entrega Gmail acima do piso ANTES de olhar
 * abertura.
 *
 * ## O que este script NÃO faz
 *
 * Não escreve nada — nem no Kit, nem na Beehiiv, nem em disco. É leitura pura
 * (2 endpoints do Kit, 5 chamadas: `/subscribers/filter` uma vez por eixo mais
 * `/broadcasts/{id}/stats`) e o cruzamento puro de `lib/provider-split.ts`.
 *
 * ## Denominador: `sent`, não a lista de ativos
 *
 * `POST /v4/subscribers/filter` com `type: "sent"` (corpo completo em
 * {@link buildAudienceFilterBody}) devolve o snapshot real do envio, e
 * `type: "delivered"` devolve quem aceitou. A versão anterior usava `listAllKitSubscribers` como proxy de
 * destinatários e precisava documentar uma ressalva permanente (quem entrou ou
 * saiu depois do envio deslocava todas as taxas). Com `sent` a ressalva some —
 * e a divergência contra `stats.recipients` do próprio Kit vira um guard de
 * coleta truncada, que é o que ela sempre deveria ter sido.
 *
 * Uso:
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689
 *   npx tsx scripts/kit-provider-split.ts --broadcast 25622689 --json
 */
import { getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { kitFetch, getBroadcastStats, type KitBroadcastStats } from "./lib/kit-client.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  computeProviderSplit,
  avaliarRampa,
  verificarIntegridade,
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
 * e ela alimenta o denominador de todas as taxas e o veredito da rampa, que é
 * gate de uma decisão de envio real.
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

/** Os quatro eixos do envio que o filtro de assinantes do Kit expõe. */
export type BroadcastAudience = "sent" | "delivered" | "opens" | "clicks";

const ROTULO: Record<BroadcastAudience, string> = {
  sent: "enviados",
  delivered: "entregues",
  opens: "aberturas",
  clicks: "cliques",
};

/**
 * Quem foi enviado / entregue / abriu / clicou num broadcast.
 *
 * `POST /v4/subscribers/filter` é o único endpoint do Kit que devolve a
 * IDENTIDADE por trás de cada eixo — `/broadcasts/{id}/stats` agrega e não
 * serve pra cruzar com domínio, e nem sequer expõe bounces.
 *
 * **Confirmado ao vivo em 28/08/2026** contra o broadcast 25622689: `sent`
 * devolveu 594, `delivered` 251 (594 − 251 = 343, exatamente o número de
 * bounces do painel do Kit), `opens` 83 e `clicks` 24 — batendo com
 * `stats.recipients`/`open_rate`/`click_rate` do próprio Kit. A anotação
 * existe porque `kit-client.ts` documenta que 2xx do Kit não implica
 * efeito/shape esperado, e o resto do módulo registra essa confirmação por
 * função.
 */
export function fetchAudience(broadcastId: number, type: BroadcastAudience): Promise<DrainResult> {
  return drainPages(
    (after) =>
      kitFetch<KitEngagedPage>("/subscribers/filter", {
        method: "POST",
        body: buildAudienceFilterBody(broadcastId, type, after),
      }),
    ROTULO[type],
  );
}

/**
 * Corpo de `POST /v4/subscribers/filter` para um eixo do broadcast.
 *
 * Separado de {@link fetchAudience} para ser testável sem rede (achado do
 * review da PR #6513, P1): o fake de `drainPages` ignora o corpo, então nada
 * garantia que `fetchAudience(id, "sent")` de fato pedisse `type: "sent"`. Uma
 * troca entre `"sent"` e `"delivered"` — copy-paste, refactor — inverteria o
 * numerador e o denominador da taxa de entrega e produziria uma tabela
 * plausível com o gate de cabeça pra baixo, sem nenhum teste falhando.
 *
 * `count_greater_than: 0` vale para os quatro eixos: o Kit trata todos como
 * contagem de eventos por assinante, e é isso que faz `sent`/`delivered`
 * baterem com o painel (594/251 no broadcast 25622689).
 */
export function buildAudienceFilterBody(
  broadcastId: number,
  type: BroadcastAudience,
  after?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    all: [{ type, any: [{ type: "broadcasts", ids: [broadcastId] }], count_greater_than: 0 }],
    per_page: 100,
  };
  if (after) body.after = after;
  return body;
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

/**
 * `Promise.all` das quatro coletas + stats, mas reportando TODAS as falhas.
 *
 * `Promise.all` rejeita na primeira falha e descarta as demais — com 5
 * chamadas concorrentes contra a mesma conta do Kit (rate limit, hiccup de
 * rede), é comum mais de uma cair junto, e saber que só "entregues" quebrou
 * quando na verdade "enviados" também quebrou manda o diagnóstico pro lado
 * errado (achado do review da PR #6513, P3). `allSettled` + erro agregado
 * nomeia todas.
 */
export async function todasOuNenhuma<T extends readonly unknown[]>(
  tarefas: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const resultados = await Promise.allSettled(tarefas as readonly Promise<unknown>[]);
  const falhas = resultados
    .map((r, i) => (r.status === "rejected" ? { i, r } : null))
    .filter((x): x is { i: number; r: PromiseRejectedResult } => x !== null);

  if (falhas.length > 0) {
    const detalhe = falhas
      .map(({ i, r }) => `[${i}] ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      .join("; ");
    throw new Error(`${falhas.length} de ${resultados.length} coleta(s) falharam: ${detalhe}`);
  }
  return resultados.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

export function formatTable(rows: ProviderRow[]): string {
  const header = ["provedor", "enviados", "entregues", "entrega", "abriu", "abertura", "clicou", "clique"];
  const body = rows.map((r) => [
    r.provider,
    String(r.sent),
    String(r.delivered),
    `${r.deliveryRatePct.toFixed(1)}%`,
    String(r.openers),
    `${r.openRatePct.toFixed(1)}%`,
    String(r.clickers),
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

  const [sent, delivered, opens, clicks, stats] = await todasOuNenhuma<
    [DrainResult, DrainResult, DrainResult, DrainResult, KitBroadcastStats]
  >([
    fetchAudience(broadcastId, "sent"),
    fetchAudience(broadcastId, "delivered"),
    fetchAudience(broadcastId, "opens"),
    fetchAudience(broadcastId, "clicks"),
    getBroadcastStats(broadcastId),
  ]);

  // `opens`/`clicks` viram `openers`/`clickers`: o vocabulário da API do Kit
  // (evento) e o do módulo de corte (pessoa) diferem de propósito.
  const split = computeProviderSplit({
    sent: sent.emails,
    delivered: delivered.emails,
    openers: opens.emails,
    clickers: clicks.emails,
  });

  // Integridade ANTES do branch de saída: em `--json` (o modo que automação
  // consome) os avisos não existiam de forma alguma antes do #6513, e em modo
  // texto eram linhas impressas acima de um veredito que os ignorava.
  const avisos = verificarIntegridade({
    split,
    destinatariosReportados: stats.recipients,
    registrosDescartados:
      sent.descartadas + delivered.descartadas + opens.descartadas + clicks.descartadas,
  });
  const veredito = avaliarRampa(split, avisos);

  if (json) {
    console.log(
      JSON.stringify(
        {
          broadcastId,
          kitStats: stats,
          split,
          integridade: { ok: avisos.length === 0, avisos },
          rampa: veredito,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nBroadcast ${broadcastId} — entrega e engajamento por provedor\n`);
  console.log(formatTable([...split.rows, split.gmail, split.naoGmail, split.total]));

  const naoEntregues = split.total.sent - split.total.delivered;
  console.log(
    `\nNão entregues: ${naoEntregues} de ${split.total.sent} enviados ` +
      `(${(100 - split.total.deliveryRatePct).toFixed(1)}%).`,
  );
  console.log(
    `Agregado do Kit: ${stats.recipients} destinatários, ${stats.open_rate.toFixed(2)}% abertura, ${stats.click_rate.toFixed(2)}% clique — ` +
      `note que as taxas do Kit são sobre ENVIADOS, as da tabela acima sobre ENTREGUES.`,
  );

  for (const aviso of avisos) {
    console.log(`Aviso [${aviso.codigo}]: ${aviso.mensagem}`);
  }

  console.log(`\nRampa: ${veredito.motivo}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[kit-provider-split] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
