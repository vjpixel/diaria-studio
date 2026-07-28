// #4184: resolução da seção editorial (Destaques/Use Melhor/Radar) de um
// CONTEÚDO (não URL crua, ver link-content.ts/#4053) para exibição nas
// tabelas de link do dashboard — módulo puro e sem I/O, mesmo espírito de
// link-content.ts.
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
export type { LinkSectionName, LinkSectionMap };

/** Rótulo de exibição de cada seção. */
export const LINK_SECTION_LABELS: Record<LinkSectionName, string> = {
  destaques: "Destaques",
  "use-melhor": "Use Melhor",
  radar: "Radar",
};

/**
 * #4184: precedência de exibição quando o MESMO conteúdo aparece em mais de
 * uma seção da mesma edição (acontece — ex: um link do Radar também citado
 * num destaque). Regra escolhida: Destaques > Use Melhor > Radar — a seção
 * de maior peso editorial (mais alto no funil de curadoria, tipicamente mais
 * clicada) vence a exibição PRIMÁRIA; as demais nunca são descartadas
 * silenciosamente — aparecem como detalhe secundário no tooltip da célula
 * (ver `formatLinkSectionCell`), mesmo padrão já usado pro split A/B da
 * enquete "É IA?" em render-links.ts (`variants`/tooltip).
 */
export const LINK_SECTION_PRECEDENCE: readonly LinkSectionName[] = ["destaques", "use-melhor", "radar"];

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

export const LINK_SECTION_FALLBACK_LABEL = "—";
export const LINK_SECTION_FALLBACK_TOOLTIP =
  "Seção não identificada — link anterior ao mapa de seções deste ciclo, link de sistema/CTA/rodapé, ou fora do prioritized.md do mês.";

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

/** Atalho: lookup direto no mapa + resolve + format, num só passo — usado
 * pelos construtores de linha em render-links.ts (`parseLinksStats`/
 * `aggregateLinksAcrossCampaigns`). `map` ausente/null → fallback (nunca lança). */
export function lookupLinkSectionCell(
  content: string,
  map: LinkSectionMap | null | undefined,
): LinkSectionCell {
  return formatLinkSectionCell(resolveLinkSection(map?.[content]));
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

const VALID_SECTIONS = new Set<LinkSectionName>(["destaques", "use-melhor", "radar"]);

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
  "Seção editorial do digest MENSAL onde este conteúdo apareceu (Destaques/Use Melhor/Radar), a partir do prioritized.md do ciclo de envio (#4184). Só cobre envios do digest mensal via Clarice — links de edições diárias, CTA e rodapé caem no fallback \"—\" (sem seção mapeada).";
