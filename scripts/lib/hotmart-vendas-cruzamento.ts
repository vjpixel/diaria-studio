/**
 * scripts/lib/hotmart-vendas-cruzamento.ts (#10734, item 4a)
 *
 * Cruza as vendas da Hotmart (espelho `data/hotmart/vendas.jsonl`, e-mail só
 * como hash) com o store unificado de assinantes
 * (`data/diaria-subscribers/diaria-subscribers.db`, e-mail em claro), para
 * responder "o comprador já era assinante, e de onde ele veio?".
 *
 * O sentido do cruzamento é um só: os e-mails do STORE são hasheados com a
 * MESMA função do Worker (`normalizeBuyerEmail` + `sha256Hex`, a mesma cadeia
 * de `buildVendaRecord`) e comparados com o `email_hash` da venda. Nunca o
 * inverso, e nenhum e-mail em claro sai deste módulo: o índice é chaveado por
 * hash e o relatório só leva contagens, `subscriber_id` e dados da venda.
 *
 * Limite conhecido: o Worker hasheia o e-mail como a Hotmart o mandou (trim +
 * minúsculas), sem `canonicalizeGmail`. Quem comprou com `fu.lano@gmail.com`
 * e assinou com `fulano@gmail.com` não casa. Os aliases do store entram todos
 * no índice, então basta UMA das formas que a pessoa usou bater.
 *
 * Miolo PURO, exceto o hash (Web Crypto, assíncrono). O CLI é
 * `scripts/hotmart-vendas-cruzamento.ts`.
 */

import { normalizeBuyerEmail, type VendaEvento, type VendaRecord } from "./shared/hotmart-vendas.ts";
import { sha256Hex } from "./shared/subscriber-verify.ts";

/** O hash que o Worker grava em `email_hash` para este e-mail, ou `null` se
 * ele não tem forma de e-mail (o Worker também grava `null` nesse caso). */
export async function hashEmailComoWorker(email: unknown): Promise<string | null> {
  const norm = normalizeBuyerEmail(email);
  return norm ? sha256Hex(norm) : null;
}

/** Um assinante do store, já resumido pelo CLI. Os e-mails só alimentam o
 * hash e não são guardados no índice. */
export interface AssinanteStore {
  readonly subscriberId: number;
  readonly emails: readonly (string | null)[];
  /** `status = "active"` em alguma plataforma. */
  readonly ativo: boolean;
  /** `utm_source` resolvido (`resolveSubscriberAttribution`), ou `null`. */
  readonly origem: string | null;
}

export interface AssinanteIndexado {
  readonly subscriberId: number;
  readonly ativo: boolean;
  readonly origem: string | null;
}

/** Índice hash do e-mail → assinantes com aquele e-mail. Mais de um
 * `subscriber_id` no mesmo hash acontece quando o store ainda não fundiu a
 * identidade entre plataformas; o cruzamento trata os dois como a mesma
 * pessoa. */
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
      lista.push({ subscriberId: a.subscriberId, ativo: a.ativo, origem: a.origem });
      indice.set(h, lista);
    }
  }
  for (const lista of indice.values()) lista.sort((x, y) => x.subscriberId - y.subscriberId);
  return indice;
}

export type SituacaoComprador = "assinante-ativo" | "ex-assinante" | "fora-da-base" | "sem-email";

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
  /** Menor `subscriber_id` que casou; `null` fora da base. */
  readonly subscriber_id: number | null;
  /** Origem do assinante no store (primeira não nula entre os que casaram). */
  readonly origem_assinante: string | null;
}

export interface ResumoSituacao {
  readonly eventos: number;
  /** Compradores distintos (por hash) nesta situação. */
  readonly compradores: number;
}

export interface RelatorioCruzamento {
  readonly totalEventos: number;
  /** Só eventos `aprovada`: é a pergunta de aquisição (quem comprou). */
  readonly aprovadas: Readonly<Record<SituacaoComprador, ResumoSituacao>>;
  /** Todos os eventos, por situação. */
  readonly todos: Readonly<Record<SituacaoComprador, ResumoSituacao>>;
  /** Aprovadas de assinantes (ativos ou não), por origem no store. */
  readonly aprovadasPorOrigem: ReadonlyArray<{ origem: string; eventos: number }>;
  readonly vendas: readonly VendaCruzada[];
}

const SITUACOES: readonly SituacaoComprador[] = ["assinante-ativo", "ex-assinante", "fora-da-base", "sem-email"];

function situacaoDe(email_hash: string | null, casados: readonly AssinanteIndexado[] | undefined): SituacaoComprador {
  if (!email_hash) return "sem-email";
  if (!casados || casados.length === 0) return "fora-da-base";
  return casados.some((c) => c.ativo) ? "assinante-ativo" : "ex-assinante";
}

function resumir(vendas: readonly VendaCruzada[], hashes: readonly (string | null)[]): Record<SituacaoComprador, ResumoSituacao> {
  const out = {} as Record<SituacaoComprador, ResumoSituacao>;
  for (const s of SITUACOES) {
    let eventos = 0;
    const compradores = new Set<string>();
    vendas.forEach((v, i) => {
      if (v.situacao !== s) return;
      eventos++;
      compradores.add(hashes[i] ?? `sem-email:${v.transacao}`);
    });
    out[s] = { eventos, compradores: compradores.size };
  }
  return out;
}

/** Cruza cada evento de venda com o índice do store. Puro. */
export function cruzarVendas(registros: readonly VendaRecord[], indice: IndiceHash): RelatorioCruzamento {
  const vendas: VendaCruzada[] = [];
  const hashes: (string | null)[] = [];
  for (const r of registros) {
    const casados = r.email_hash ? indice.get(r.email_hash) : undefined;
    const situacao = situacaoDe(r.email_hash, casados);
    vendas.push({
      transacao: r.transacao,
      evento: r.evento,
      dia: r.dia,
      produto_id: r.produto_id,
      valor_liquido: r.valor_liquido,
      moeda_liquido: r.moeda_liquido,
      src: r.src,
      sck: r.sck,
      situacao,
      subscriber_id: casados?.[0]?.subscriberId ?? null,
      origem_assinante: casados?.find((c) => c.origem !== null)?.origem ?? null,
    });
    hashes.push(r.email_hash);
  }
  const isAprovada = vendas.map((v) => v.evento === "aprovada");
  const aprovadasVendas = vendas.filter((_, i) => isAprovada[i]);
  const aprovadasHashes = hashes.filter((_, i) => isAprovada[i]);

  const porOrigem = new Map<string, number>();
  for (const v of aprovadasVendas) {
    if (v.situacao !== "assinante-ativo" && v.situacao !== "ex-assinante") continue;
    const k = v.origem_assinante ?? "(sem origem no store)";
    porOrigem.set(k, (porOrigem.get(k) ?? 0) + 1);
  }

  return {
    totalEventos: vendas.length,
    aprovadas: resumir(aprovadasVendas, aprovadasHashes),
    todos: resumir(vendas, hashes),
    aprovadasPorOrigem: [...porOrigem.entries()]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([origem, eventos]) => ({ origem, eventos })),
    vendas,
  };
}
