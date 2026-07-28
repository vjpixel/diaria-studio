/**
 * monthly-link-sections.ts (#4184)
 *
 * Parser de `data/monthly/{ciclo}/prioritized.md` pra extrair, por seção
 * editorial (`## Destaques` / `## Use Melhor` / `## Radar`), quais URLs
 * apareceram nela — fonte que alimenta a coluna "Seção" nas tabelas de link
 * do dashboard Clarice (`workers/brevo-dashboard/src/render-links.ts`).
 *
 * Formato real (conferido nos 4 ciclos existentes em `data/monthly/` na
 * sessão #4184): só `2605-06` e `2606-07` têm as 3 seções — introduzidas
 * junto com o pool "Use Melhor"/"Radar" ranqueado por cliques (#1901/#1902).
 * Ciclos mais antigos (`2603-04`, `2604-05`) só têm `## Destaques` — o pool
 * de standalones daquela época usava outras seções (`## Lançamentos`/
 * `## Pesquisas`/`## Outras Notícias`/`## Warnings`), sem equivalente a Use
 * Melhor/Radar. `parsePrioritizedSections` trata seção ausente como "zero
 * URLs daquela seção" — nunca erro; retroatividade PARCIAL nos ciclos
 * antigos é o comportamento correto (não um bug do parser).
 *
 * Duas camadas deliberadas:
 *   - `parsePrioritizedSections` — PURA, recebe o markdown já lido (texto),
 *     nunca toca disco. Testável direto com fixture embutida no teste.
 *   - `buildLinkSectionMap` — PURA, resolve cada URL bruta pro rótulo de
 *     CONTEÚDO via `classifyLinkContent` (#4053) e agrupa content→seções[].
 *     Não é dever de `link-content.ts` (que fica livre de parsing de
 *     markdown/I/O, ver header daquele módulo) nem de `link-section.ts`
 *     (que só resolve/formata um mapa JÁ pronto) — mora aqui porque é
 *     específico do artefato mensal `prioritized.md`.
 *   - `loadLinkSectionMapForCycle` — único ponto de I/O (lê o arquivo via
 *     `monthlyDir`). Fail-soft: arquivo ausente, ciclo sem `prioritized.md`,
 *     ou `data/` inacessível (sessão cloud sem o junction OneDrive, #2643)
 *     retornam `null`, nunca lançam.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monthlyDir } from "./monthly-paths.ts";
import { classifyLinkContent } from "../../../workers/brevo-dashboard/src/link-content.ts";
import type { LinkSectionName, LinkSectionMap } from "../dashboard-kv-types.ts";

/** As 3 seções reconhecidas + o texto EXATO do cabeçalho `##` no `prioritized.md`. */
const SECTION_HEADER_NAMES: Record<LinkSectionName, string> = {
  destaques: "destaques",
  "use-melhor": "use melhor",
  radar: "radar",
};

function matchSectionName(headerText: string): LinkSectionName | null {
  const norm = headerText.trim().toLowerCase();
  for (const [section, name] of Object.entries(SECTION_HEADER_NAMES) as Array<[LinkSectionName, string]>) {
    if (norm === name) return section;
  }
  return null;
}

/** Extrai todas as URLs http(s) cruas de um bloco de texto, na ordem em que
 * aparecem. Convenção do `prioritized.md`: cada linha de item termina em
 * `— https://...` ou `— https://... (N cliques)` — a URL é sempre o último
 * token não-parêntese da linha. `[^\s)]+` já exclui o `(N cliques)` final;
 * pontuação de trailing residual (`.`, `,`, `;`) é removida por segurança. */
function extractUrls(body: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s)]+/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    urls.push(m[0].replace(/[.,;]+$/, ""));
  }
  return urls;
}

/**
 * Extrai, por seção reconhecida, as URLs cruas encontradas no corpo daquela
 * seção — do `## Header` até o próximo `## ` (qualquer nome) ou fim do
 * arquivo. Uma mesma URL pode aparecer em mais de uma seção (ex: mesmo link
 * citado no Radar E num destaque, #4184) — merge/precedência ficam a cargo
 * do caller (`buildLinkSectionMap` abaixo, ou a resolução de exibição em
 * `workers/brevo-dashboard/src/link-section.ts`).
 *
 * Pura, nunca lança — markdown malformado/seção ausente só resulta em menos
 * entradas (array vazio para a seção não encontrada).
 */
export function parsePrioritizedSections(markdown: string): Record<LinkSectionName, string[]> {
  const result: Record<LinkSectionName, string[]> = {
    destaques: [],
    "use-melhor": [],
    radar: [],
  };

  // Localiza todos os cabeçalhos `## Nome` de nível 2, na ordem em que aparecem.
  const headerRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headers: Array<{ name: string; bodyStart: number; headerStart: number }> = [];
  for (let m = headerRe.exec(markdown); m; m = headerRe.exec(markdown)) {
    headers.push({ name: m[1].trim(), headerStart: m.index, bodyStart: m.index + m[0].length });
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const sectionName = matchSectionName(h.name);
    if (!sectionName) continue;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].headerStart : markdown.length;
    const body = markdown.slice(h.bodyStart, bodyEnd);
    result[sectionName].push(...extractUrls(body));
  }

  return result;
}

/**
 * Resolve cada URL bruta (agrupada por seção, saída de `parsePrioritizedSections`)
 * pro rótulo de CONTEÚDO via `classifyLinkContent` (#4053) e monta o
 * `LinkSectionMap` final (content → seções onde apareceu). Pura — não faz
 * I/O, não conhece `prioritized.md` diretamente (recebe já parseado).
 */
export function buildLinkSectionMap(
  rawSections: Record<LinkSectionName, string[]>,
): LinkSectionMap {
  const merged = new Map<string, Set<LinkSectionName>>();
  for (const [section, urls] of Object.entries(rawSections) as Array<[LinkSectionName, string[]]>) {
    for (const url of urls) {
      const { content } = classifyLinkContent(url);
      let set = merged.get(content);
      if (!set) {
        set = new Set();
        merged.set(content, set);
      }
      set.add(section);
    }
  }
  const out: LinkSectionMap = {};
  for (const [content, set] of merged) out[content] = [...set];
  return out;
}

/**
 * Carrega e parseia `data/monthly/{ciclo}/prioritized.md`, já resolvido pro
 * `LinkSectionMap` final (content → seções). Fail-soft: ciclo sem
 * `prioritized.md` (ex: edição em andamento, ou `data/` inacessível —
 * sessão cloud sem o junction OneDrive, #2643) retorna `null`, nunca lança.
 *
 * `allowLegacyFallback: false` — o ciclo aqui SEMPRE vem no formato novo
 * `{conteúdo}-{envio}` (extraído de `parseClariceCampaignKey().cycle` pro
 * naming `monthly: true`, ver `sections-core.ts::collectMonthlyLinkCycles`),
 * então não faz sentido cair pro diretório legado `YYMM`.
 */
export function loadLinkSectionMapForCycle(cycle: string): LinkSectionMap | null {
  try {
    const path = join(monthlyDir(cycle, { allowLegacyFallback: false }), "prioritized.md");
    if (!existsSync(path)) return null;
    const markdown = readFileSync(path, "utf-8");
    return buildLinkSectionMap(parsePrioritizedSections(markdown));
  } catch {
    return null;
  }
}
