// #4184: resolução da seção editorial (Destaques/Use Melhor/Radar — pool
// atual — e Lançamentos/Pesquisas/Outras Notícias — pool legado, ciclos
// 2603-04/2604-05) de um CONTEÚDO (não URL crua, ver link-content.ts/#4053)
// para exibição nas tabelas de link do dashboard — módulo puro e sem I/O,
// mesmo espírito de link-content.ts.
//
// O mapa (`LinkSectionMap`, tipo em scripts/lib/dashboard-kv-types.ts,
// re-exportado por ./types.ts) é montado FORA deste módulo:
//   - Worker: lido do KV (`secao:{ciclo}`, brevo-api.ts::readLinkSectionsByCycle),
//     gravado por scripts/push-link-sections-kv.ts (script explícito).
//   - Studio: montado em memória a partir de `data/monthly/{ciclo}/prioritized.md`
//     local (scripts/lib/mensal/monthly-link-sections.ts + dashboard-clarice.ts).
//
// Este módulo só resolve/formata/mescla o mapa já pronto — nunca faz parsing
// de markdown nem toca disco/rede.

import type { LinkSectionName, LinkSectionMap } from "./types.ts";
import { classifyNonEditorialLinkSection, type NonEditorialLinkCategory } from "./link-content.ts";
export type { LinkSectionName, LinkSectionMap };

/** #4405: rótulo de exibição de cada categoria não-editorial (ver link-content.ts). */
export const NON_EDITORIAL_LINK_SECTION_LABELS: Record<NonEditorialLinkCategory, string> = {
  "eia-poll": "Enquete É IA?",
  "clarice-parceiro": "Clarice (parceiro)",
  "produtos-diaria": "Produtos diar.ia.br",
  apoio: "Apoio",
  "redes-sociais": "Redes sociais",
};

/** Rótulo de exibição de cada seção. */
export const LINK_SECTION_LABELS: Record<LinkSectionName, string> = {
  destaques: "Destaques",
  "use-melhor": "Use Melhor",
  radar: "Radar",
  lancamentos: "Lançamentos",
  pesquisas: "Pesquisas",
  "outras-noticias": "Outras Notícias",
};

/**
 * #4184: precedência de exibição quando o MESMO conteúdo aparece em mais de
 * uma seção da mesma edição (acontece — ex: um link do Radar também citado
 * num destaque). Regra escolhida: **Destaques > Use Melhor > Radar >
 * Lançamentos > Pesquisas > Outras Notícias**. Destaques no topo (seção de
 * maior peso editorial, tipicamente mais clicada) — isso não muda entre
 * pool atual e legado. As 3 do pool ATUAL (Use Melhor/Radar, ranqueado por
 * cliques, #1901/#1902) vêm antes das 3 do pool LEGADO (Lançamentos/
 * Pesquisas/Outras Notícias, standalones sem ranking, `2603-04`/`2604-05`)
 * — na prática os dois pools nunca coexistem no MESMO ciclo (cada
 * `prioritized.md` tem só um dos dois formatos), então esse trecho da ordem
 * só importa pro merge cross-ciclo da tabela agregada
 * (`mergeLinkSectionMaps`), e Lançamentos > Pesquisas > Outras Notícias
 * segue a ordem em que essas seções apareciam no próprio documento (mais
 * editorial/"oficial" primeiro, "Outras Notícias" — o catch-all do nome —
 * por último). Qualquer seção nunca é descartada silenciosamente — as
 * demais aparecem como detalhe secundário no tooltip da célula (ver
 * `formatLinkSectionCell`), mesmo padrão já usado pro split A/B da enquete
 * "É IA?" em render-links.ts (`variants`/tooltip).
 */
export const LINK_SECTION_PRECEDENCE: readonly LinkSectionName[] = [
  "destaques",
  "use-melhor",
  "radar",
  "lancamentos",
  "pesquisas",
  "outras-noticias",
];

export interface ResolvedLinkSection {
  /** Seção vencedora pela precedência — o que a célula EXIBE. */
  primary: LinkSectionName;
  /** Demais seções onde o mesmo conteúdo apareceu, em ordem de precedência (nunca inclui `primary`). */
  also: LinkSectionName[];
}

/**
 * Resolve a lista de seções (como veio do `LinkSectionMap`, ordem de
 * inserção arbitrária) pra `{primary, also}` pela precedência declarada.
 * `undefined`/vazio → `null` (conteúdo sem seção conhecida — ver
 * `formatLinkSectionCell` pro fallback).
 */
export function resolveLinkSection(
  sections: readonly LinkSectionName[] | undefined | null,
): ResolvedLinkSection | null {
  if (!sections || sections.length === 0) return null;
  const present = new Set(sections);
  const ordered = LINK_SECTION_PRECEDENCE.filter((s) => present.has(s));
  if (ordered.length === 0) return null;
  const [primary, ...also] = ordered;
  return { primary, also };
}

export interface LinkSectionCell {
  /** Texto exibido na célula. */
  label: string;
  /** Texto do `title=` (tooltip) — igual ao label quando não há seção secundária. */
  tooltip: string;
}

/**
 * #4405: catch-all determinístico — nunca mais "—" (pedido explícito do
 * editor: a coluna Seção NUNCA pode exibir traço). "Outros" é o piso de
 * `lookupLinkSectionCell` abaixo, só alcançado depois de tentar o mapa
 * editorial E a taxonomia não-editorial (`classifyNonEditorialLinkSection`)
 * — se esta linha crescer numa edição, é termômetro de que uma das duas
 * camadas não cobriu um caso real (ver CLAUDE.md/#4405).
 */
export const LINK_SECTION_FALLBACK_LABEL = "Outros";
export const LINK_SECTION_FALLBACK_TOOLTIP =
  "Fora das seções editoriais e da taxonomia de serviço conhecida — link anterior ao mapa de seções deste ciclo, ou de um tipo ainda não catalogado.";

/**
 * Formata o resultado de `resolveLinkSection` pra exibição — nunca retorna
 * célula vazia sem significado (#4184, pedido explícito da issue): conteúdo
 * sem seção conhecida cai no fallback declarado acima, com tooltip
 * explicando o motivo (nunca um branco silencioso).
 */
export function formatLinkSectionCell(resolved: ResolvedLinkSection | null): LinkSectionCell {
  if (!resolved) return { label: LINK_SECTION_FALLBACK_LABEL, tooltip: LINK_SECTION_FALLBACK_TOOLTIP };
  const label = LINK_SECTION_LABELS[resolved.primary];
  if (resolved.also.length === 0) return { label, tooltip: label };
  const alsoLabels = resolved.also.map((s) => LINK_SECTION_LABELS[s]).join(", ");
  return { label, tooltip: `${label} (também em: ${alsoLabels})` };
}

/** #4405: formata uma categoria não-editorial (`classifyNonEditorialLinkSection`)
 * pra exibição — mesma forma de `LinkSectionCell` que o mapa editorial usa. */
export function formatNonEditorialLinkSectionCell(category: NonEditorialLinkCategory): LinkSectionCell {
  const label = NON_EDITORIAL_LINK_SECTION_LABELS[category];
  return {
    label,
    tooltip: `${label} — link de serviço/CTA do e-mail, fora das seções editoriais do digest (Destaques/Use Melhor/Radar).`,
  };
}

/**
 * Atalho: lookup direto no mapa + resolve + format, num só passo — usado
 * pelos construtores de linha em render-links.ts (`parseLinksStats`/
 * `aggregateLinksAcrossCampaigns`). Resolução em 3 camadas (#4405, pedido do
 * editor — a coluna Seção nunca exibe "—"): (1) mapa editorial (Destaques/
 * Use Melhor/Radar, `map`); (2) taxonomia não-editorial derivada da própria
 * URL (`url`, opcional — enquete/Clarice/produtos/apoio/redes); (3) catch-all
 * "Outros". `map`/`url` ausentes → cai direto na camada determinística.
 */
export function lookupLinkSectionCell(
  content: string,
  map: LinkSectionMap | null | undefined,
  url?: string,
): LinkSectionCell {
  const resolved = resolveLinkSection(map?.[content]);
  if (resolved) return formatLinkSectionCell(resolved);
  const nonEditorial = url ? classifyNonEditorialLinkSection(url) : null;
  if (nonEditorial) return formatNonEditorialLinkSectionCell(nonEditorial);
  return formatLinkSectionCell(null);
}

/**
 * Mescla N mapas (tipicamente 1 por ciclo mensal presente na janela de
 * campanhas agregada) num único `LinkSectionMap` — união das seções por
 * conteúdo (nunca perde uma seção presente em qualquer um dos mapas).
 *
 * Limitação conhecida e aceita (#4184): se o MESMO rótulo de conteúdo
 * existir em 2 ciclos diferentes com seções DIFERENTES (raro — a maioria do
 * conteúdo é artigo específico do mês, não deveria repetir entre ciclos),
 * o merge trata como "apareceu nas duas", não distingue por ciclo. Aceitável
 * pra a tabela AGREGADA (que já soma cliques cross-ciclo por natureza); o
 * drill-down por campanha não usa este merge — usa o mapa do ciclo exato
 * daquela campanha (ver `renderLinksSection`/`sections-core.ts`).
 */
export function mergeLinkSectionMaps(
  maps: ReadonlyArray<LinkSectionMap | null | undefined>,
): LinkSectionMap {
  const merged = new Map<string, Set<LinkSectionName>>();
  for (const map of maps) {
    if (!map) continue;
    for (const [content, sections] of Object.entries(map)) {
      let set = merged.get(content);
      if (!set) {
        set = new Set();
        merged.set(content, set);
      }
      for (const s of sections) set.add(s);
    }
  }
  const out: LinkSectionMap = {};
  for (const [content, set] of merged) out[content] = [...set];
  return out;
}

/**
 * #4198: mescla N mapas TÍTULO (tipicamente 1 por ciclo mensal presente na
 * janela agregada) num único `Record<string,string>` — mesmo espírito de
 * `mergeLinkSectionMaps` acima, mas união de STRING (título), não de array.
 * Quando o MESMO conteúdo base tem título em mais de um mapa (raro — títulos
 * de ciclos diferentes pro mesmo conteúdo), o PRIMEIRO mapa da lista vence
 * (nunca o último sobrescreve silenciosamente) — consistente com a regra
 * "primeiro título encontrado vence" de `buildLinkTitleMap`, e com a ordem
 * natural em que `Object.values(linkTitlesByCycle)` tende a listar os ciclos
 * (mais antigo → mais recente, mesmo `for...of` de `mergeLinkSectionMaps`).
 */
export function mergeLinkTitleMaps(
  maps: ReadonlyArray<Record<string, string> | null | undefined>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [content, title] of Object.entries(map)) {
      if (!(content in merged)) merged[content] = title;
    }
  }
  return merged;
}

/**
 * #4198: normaliza um payload cru lido do KV (`titulo:{ciclo}`) — mesmo
 * padrão defensivo de `normalizeLinkSectionMap` acima, mas os valores são
 * STRINGS (título editorial), não arrays de seção. `null` = payload que nem
 * é um objeto (KV vazio, JSON corrompido, formato alheio). Um objeto válido
 * com ALGUNS valores inválidos (não-string) filtra só as entradas ruins e
 * mantém o resto — nunca descarta o mapa inteiro por causa de 1 entrada
 * malformada.
 */
export function normalizeLinkTitleMap(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [content, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out[content] = value;
  }
  return out;
}

const VALID_SECTIONS = new Set<LinkSectionName>([
  "destaques",
  "use-melhor",
  "radar",
  "lancamentos",
  "pesquisas",
  "outras-noticias",
]);

/**
 * Normaliza um payload cru lido do KV (`secao:{ciclo}`) — defende contra JSON
 * corrompido/parcial sem nunca lançar, mesmo padrão dos normalizadores de
 * `brevo-api.ts` (#2875/#3077, choke point único de leitura do KV). `null` =
 * payload que nem é um objeto (KV vazio, JSON corrompido, formato alheio).
 * Um objeto válido com ALGUNS valores inválidos filtra só as entradas ruins
 * e mantém o resto — nunca descarta o mapa inteiro por causa de 1 entrada
 * malformada.
 */
export function normalizeLinkSectionMap(raw: unknown): LinkSectionMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: LinkSectionMap = {};
  for (const [content, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const sections = value.filter(
      (s): s is LinkSectionName => typeof s === "string" && VALID_SECTIONS.has(s as LinkSectionName),
    );
    if (sections.length > 0) out[content] = sections;
  }
  return out;
}

/** #4184: label/tooltip da coluna "Seção" — fonte única reusada tanto pelo
 * `AGGREGATED_LINKS_COLUMNS` (glossário + `<th>` da tabela agregada,
 * render-links.ts) quanto pelo `<th>` inline da tabela de drill-down por
 * campanha (`renderLinksSection`) — evita duas cópias do mesmo texto. */
export const LINK_SECTION_COLUMN_LABEL = "Seção";
export const LINK_SECTION_COLUMN_TOOLTIP =
  "Seção editorial do digest MENSAL onde este conteúdo apareceu (Destaques/Use Melhor/Radar nos ciclos atuais; Lançamentos/Pesquisas/Outras Notícias nos ciclos legados 2603-04/2604-05), a partir do prioritized.md do ciclo de envio (#4184). Links de serviço/CTA do e-mail (enquete É IA?, Clarice, produtos diar.ia.br, apoio, redes sociais) recebem uma categoria própria (#4405); qualquer outro cai em \"Outros\" — a coluna nunca fica em branco.";
