/**
 * scripts/lib/hotmart-vendas-cruzamento.ts (#10734, item 4a)
 *
 * Cruza as vendas da Hotmart (espelho `data/hotmart/vendas.jsonl`, e-mail só
 * como hash) com o store unificado de assinantes
 * (`data/diaria-subscribers/diaria-subscribers.db`, e-mail em claro), para
 * responder "o comprador já era assinante QUANDO comprou, e de onde ele veio?".
 *
 * O sentido do cruzamento é um só: os e-mails do STORE são hasheados com a
 * MESMA função do Worker (`normalizeBuyerEmail` + `sha256Hex`, a mesma cadeia
 * de `buildVendaRecord`) e comparados com o `email_hash` da venda. Nunca o
 * inverso, e nenhum e-mail em claro sai deste módulo: o índice é chaveado por
 * hash e o relatório só leva contagens, `subscriber_id` e dados da venda.
 *
 * Situação no momento da compra: cada `subscription` do store vira uma
 * janela [`entered_at`, `exited_at`). A venda (`criado_em`) é classificada
 * contra essas janelas, não contra o `status` atual — quem assinou depois de
 * comprar não conta como "já era assinante". Regras:
 * - fim da janela é `exited_at`; sem `exited_at`, só a assinatura com
 *   `status = "active"` fica aberta (as demais têm fim desconhecido e não
 *   cobrem a compra: quem nunca confirmou ou saiu sem data não é contado como
 *   assinante na compra);
 * - `entered_at` ausente ou ilegível: início desconhecido, a janela não cobre
 *   a compra (conservador).
 *
 * Limite conhecido: o Worker hasheia o e-mail como a Hotmart o mandou (trim +
 * minúsculas), sem `canonicalizeGmail`. Quem comprou com uma variante do
 * Gmail com ponto no usuário e assinou sem o ponto não casa. Os aliases do
 * store entram todos no índice, então basta UMA das formas que a pessoa usou
 * bater.
 *
 * Miolo PURO, exceto o hash (Web Crypto, assíncrono). O CLI é
 * `scripts/hotmart-vendas-cruzamento.ts`.
 */

import { resolveSubscriberAttribution, type SubscriptionRecord } from "./diaria-subscribers-db.ts";
import { isVendaDeTeste, normalizeBuyerEmail, type VendaEvento, type VendaRecord } from "./shared/hotmart-vendas.ts";
import { sha256Hex } from "./shared/subscriber-verify.ts";

/** O hash que o Worker grava em `email_hash` para este e-mail, ou `null` se
 * ele não tem forma de e-mail (o Worker também grava `null` nesse caso). */
export async function hashEmailComoWorker(email: unknown): Promise<string | null> {
  const norm = normalizeBuyerEmail(email);
  return norm ? sha256Hex(norm) : null;
}

/** Uma `subscription` do store, só o que a classificação temporal usa. */
export interface JanelaAssinatura {
  readonly status: string | null;
  readonly entered_at: string | null;
  readonly exited_at: string | null;
}

/** Um assinante do store, já resumido. Os e-mails só alimentam o hash e não
 * são guardados no índice. */
export interface AssinanteStore {
  readonly subscriberId: number;
  readonly emails: readonly (string | null)[];
  /** Todas as `subscription` do assinante, em qualquer plataforma. */
  readonly assinaturas: readonly JanelaAssinatura[];
  /** `utm_source` resolvido (`resolveSubscriberAttribution`), ou `null`. */
  readonly origem: string | null;
}

/**
 * Monta os `AssinanteStore` a partir das leituras em lote do store
 * (`getAllAliasesBySubscriber` + `getAllSubscriptionsBySubscriber`). Só entra
 * quem tem alias (sem alias não há e-mail para casar).
 */
export function assinantesDoStore(
  aliases: ReadonlyMap<number, readonly { readonly email: string | null }[]>,
  subs: ReadonlyMap<number, readonly SubscriptionRecord[]>,
): AssinanteStore[] {
  return [...aliases.entries()].map(([subscriberId, lista]) => {
    const s = subs.get(subscriberId) ?? [];
    return {
      subscriberId,
      emails: lista.map((a) => a.email),
      assinaturas: s.map(({ status, entered_at, exited_at }) => ({ status, entered_at, exited_at })),
      origem: resolveSubscriberAttribution(s).utmSource,
    };
  });
}

export interface AssinanteIndexado {
  readonly subscriberId: number;
  readonly assinaturas: readonly JanelaAssinatura[];
  readonly origem: string | null;
}

/** Índice hash do e-mail → assinantes com aquele e-mail. Mais de um
 * `subscriber_id` no mesmo hash acontece quando o store ainda não fundiu a
 * identidade entre plataformas; o cruzamento trata os dois como a mesma
 * pessoa (as janelas de todos valem). */
export type IndiceHash = ReadonlyMap<string, readonly AssinanteIndexado[]>;

export async function indexarAssinantesPorHash(assinantes: readonly AssinanteStore[]): Promise<IndiceHash> {
  const indice = new Map<string, AssinanteIndexado[]>();
  for (const a of assinantes) {
    const vistosDoAssinante = new Set<string>();
    for (const email of a.emails) {
      const h = await hashEmailComoWorker(email);
      if (!h || vistosDoAssinante.has(h)) continue;
      vistosDoAssinante.add(h);
      const lista = indice.get(h) ?? [];
      lista.push({ subscriberId: a.subscriberId, assinaturas: a.assinaturas, origem: a.origem });
      indice.set(h, lista);
    }
  }
  return indice;
}

export const SITUACOES = [
  /** Alguma assinatura cobria o instante da compra. */
  "assinante-na-compra",
  /** Nenhuma cobria, e alguma começou depois da compra. */
  "assinou-depois",
  /** Casou com o store, mas nenhuma assinatura ativa cobria a compra nem
   * começou depois (saiu antes, nunca foi ativo, ou datas desconhecidas). */
  "na-base-sem-assinatura-ativa",
  /** E-mail não casou com ninguém do store. */
  "fora-da-base",
  /** Venda sem e-mail utilizável. */
  "sem-email",
] as const;
export type SituacaoComprador = (typeof SITUACOES)[number];

/** Situações em que o comprador casou com alguém do store. */
const NA_BASE: ReadonlySet<SituacaoComprador> = new Set(["assinante-na-compra", "assinou-depois", "na-base-sem-assinatura-ativa"]);

export interface VendaCruzada {
  readonly transacao: string;
  readonly evento: VendaEvento;
  readonly dia: string;
  readonly produto_id: number | null;
  readonly valor_liquido: number | null;
  readonly moeda_liquido: string | null;
  readonly src: string | null;
  readonly sck: string | null;
  readonly situacao: SituacaoComprador;
  /** Menor `subscriber_id` que casou; `null` em `fora-da-base` e `sem-email`. */
  readonly subscriber_id: number | null;
  /** Origem do assinante no store (primeira não nula entre os que casaram,
   * em ordem de `subscriber_id`). */
  readonly origem_assinante: string | null;
}

export interface ResumoSituacao {
  readonly eventos: number;
  /** Compradores distintos (por hash) nesta situação. */
  readonly compradores: number;
}

export interface RelatorioCruzamento {
  /** Eventos cruzados (os de teste da Hotmart, `isVendaDeTeste`, já fora). */
  readonly totalEventos: number;
  /** Eventos de teste da Hotmart deixados fora do cruzamento (#10734 item 3). */
  readonly testesIgnorados: number;
  /** Só eventos `aprovada`: é a pergunta de aquisição (quem comprou). */
  readonly aprovadas: Readonly<Record<SituacaoComprador, ResumoSituacao>>;
  /** Todos os eventos, por situação. */
  readonly todos: Readonly<Record<SituacaoComprador, ResumoSituacao>>;
  /** Aprovadas de compradores que casaram com o store (qualquer situação
   * na base), por origem no store. */
  readonly aprovadasPorOrigem: ReadonlyArray<{ origem: string; eventos: number }>;
  readonly vendas: readonly VendaCruzada[];
}

/** Par interno venda + hash do comprador (o hash nunca sai no relatório). */
interface VendaComHash {
  readonly venda: VendaCruzada;
  readonly hash: string | null;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

function cobre(a: JanelaAssinatura, t: number): boolean {
  const inicio = ms(a.entered_at);
  if (inicio === null || inicio > t) return false;
  const fim = ms(a.exited_at);
  if (fim !== null) return t < fim;
  return a.status === "active";
}

/** Classifica um comprador que casou com o store no instante `t` (ms) da
 * compra. `t` ilegível (`NaN`) cai em `na-base-sem-assinatura-ativa`. */
export function situacaoNaCompra(assinaturas: readonly JanelaAssinatura[], t: number): SituacaoComprador {
  if (!Number.isFinite(t)) return "na-base-sem-assinatura-ativa";
  if (assinaturas.some((a) => cobre(a, t))) return "assinante-na-compra";
  if (assinaturas.some((a) => (ms(a.entered_at) ?? -Infinity) > t)) return "assinou-depois";
  return "na-base-sem-assinatura-ativa";
}

function situacaoDe(r: VendaRecord, casados: readonly AssinanteIndexado[] | undefined): SituacaoComprador {
  if (!r.email_hash) return "sem-email";
  if (!casados || casados.length === 0) return "fora-da-base";
  return situacaoNaCompra(
    casados.flatMap((c) => c.assinaturas),
    Date.parse(r.criado_em),
  );
}

/** Um `Record` com todas as situações, sem cast: o literal obriga o
 * compilador a conferir que nenhuma ficou de fora. */
function porSituacao<T>(f: (s: SituacaoComprador) => T): Record<SituacaoComprador, T> {
  return {
    "assinante-na-compra": f("assinante-na-compra"),
    "assinou-depois": f("assinou-depois"),
    "na-base-sem-assinatura-ativa": f("na-base-sem-assinatura-ativa"),
    "fora-da-base": f("fora-da-base"),
    "sem-email": f("sem-email"),
  };
}

function resumir(itens: readonly VendaComHash[]): Record<SituacaoComprador, ResumoSituacao> {
  return porSituacao((s) => {
    const daSituacao = itens.filter((i) => i.venda.situacao === s);
    const compradores = new Set(daSituacao.map((i) => i.hash ?? `sem-email:${i.venda.transacao}`));
    return { eventos: daSituacao.length, compradores: compradores.size };
  });
}

/** Cruza cada evento de venda com o índice do store. Puro. */
export function cruzarVendas(todos: readonly VendaRecord[], indice: IndiceHash): RelatorioCruzamento {
  const registros = todos.filter((r) => !isVendaDeTeste(r));
  const itens: VendaComHash[] = registros.map((r) => {
    const casados = r.email_hash ? indice.get(r.email_hash) : undefined;
    const ordenados = casados ? [...casados].sort((x, y) => x.subscriberId - y.subscriberId) : [];
    const venda: VendaCruzada = {
      transacao: r.transacao,
      evento: r.evento,
      dia: r.dia,
      produto_id: r.produto_id,
      valor_liquido: r.valor_liquido,
      moeda_liquido: r.moeda_liquido,
      src: r.src,
      sck: r.sck,
      situacao: situacaoDe(r, casados),
      subscriber_id: ordenados.length ? Math.min(...ordenados.map((c) => c.subscriberId)) : null,
      origem_assinante: ordenados.find((c) => c.origem !== null)?.origem ?? null,
    };
    return { venda, hash: r.email_hash };
  });
  const aprovadas = itens.filter((i) => i.venda.evento === "aprovada");

  const porOrigem = new Map<string, number>();
  for (const { venda } of aprovadas) {
    if (!NA_BASE.has(venda.situacao)) continue;
    const k = venda.origem_assinante ?? "(sem origem no store)";
    porOrigem.set(k, (porOrigem.get(k) ?? 0) + 1);
  }

  return {
    totalEventos: itens.length,
    testesIgnorados: todos.length - registros.length,
    aprovadas: resumir(aprovadas),
    todos: resumir(itens),
    aprovadasPorOrigem: [...porOrigem.entries()]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([origem, eventos]) => ({ origem, eventos })),
    vendas: itens.map((i) => i.venda),
  };
}

// ---------------------------------------------------------------------------
// Conferência da premissa do reembolso (#10734 item 3)
// ---------------------------------------------------------------------------

/** Como uma reversão (reembolso ou chargeback) se compara com a aprovação da
 * mesma transação, no valor LÍQUIDO (comissão do produtor). */
export type ReversaoConferida =
  | "liquido-igual-aprovada"
  | "liquido-difere-aprovada"
  | "sem-liquido"
  | "sem-aprovada-no-espelho";

export interface ConferenciaReembolso {
  /** `aguardando`: nenhuma reversão real no espelho ainda (as de teste não
   * contam). `confirmada`: toda reversão real traz a mesma comissão da
   * aprovação, e o saldo líquido subtrai o valor certo. `conferir`: alguma
   * veio sem comissão, com comissão diferente ou sem a aprovação no espelho. */
  readonly veredito: "aguardando" | "confirmada" | "conferir";
  readonly reversoes: number;
  readonly porSituacao: Readonly<Record<ReversaoConferida, number>>;
  readonly testesIgnorados: number;
}

/**
 * Item 3 da #10734: a Hotmart manda a comissão do produtor no evento de
 * reembolso/chargeback? O saldo LÍQUIDO (`saldoLiquido`, rota `GET
 * /hotmart/vendas`) subtrai o `valor_liquido` da reversão; se ele vier
 * diferente da comissão da aprovação, o líquido sai errado. O ARPU/LTV usa o
 * BRUTO (`computeHotmartMonthRevenue`) e não depende disto. Os eventos de
 * teste (`isVendaDeTeste`) ficam fora: o payload de exemplo da Hotmart traz
 * comissão em todo evento e "confirmaria" a premissa sem venda real nenhuma.
 * Puro; não expõe e-mail nem hash.
 */
export function conferirPremissaReembolso(todos: readonly VendaRecord[]): ConferenciaReembolso {
  const registros = todos.filter((r) => !isVendaDeTeste(r));
  const aprovadaPorTransacao = new Map<string, VendaRecord>();
  for (const r of registros) {
    if (r.evento === "aprovada" && !aprovadaPorTransacao.has(r.transacao)) aprovadaPorTransacao.set(r.transacao, r);
  }
  const porSituacao: Record<ReversaoConferida, number> = {
    "liquido-igual-aprovada": 0,
    "liquido-difere-aprovada": 0,
    "sem-liquido": 0,
    "sem-aprovada-no-espelho": 0,
  };
  let reversoes = 0;
  for (const r of registros) {
    if (r.evento !== "reembolsada" && r.evento !== "chargeback") continue;
    reversoes++;
    const aprovada = aprovadaPorTransacao.get(r.transacao);
    let s: ReversaoConferida;
    if (r.valor_liquido === null || r.moeda_liquido === null) s = "sem-liquido";
    else if (!aprovada || aprovada.valor_liquido === null) s = "sem-aprovada-no-espelho";
    else if (aprovada.valor_liquido === r.valor_liquido && aprovada.moeda_liquido === r.moeda_liquido) s = "liquido-igual-aprovada";
    else s = "liquido-difere-aprovada";
    porSituacao[s]++;
  }
  const veredito = reversoes === 0 ? "aguardando" : porSituacao["liquido-igual-aprovada"] === reversoes ? "confirmada" : "conferir";
  return { veredito, reversoes, porSituacao, testesIgnorados: todos.length - registros.length };
}
