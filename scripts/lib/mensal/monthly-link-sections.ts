/**
 * monthly-link-sections.ts (#4184)
 *
 * Parser de `data/monthly/{ciclo}/prioritized.md` pra extrair, por seção
 * editorial, quais URLs apareceram nela — fonte que alimenta a coluna
 * "Seção" nas tabelas de link do dashboard Clarice
 * (`workers/brevo-dashboard/src/render-links.ts`).
 *
 * Formato real (conferido nos 4 ciclos existentes em `data/monthly/` —
 * correção feita na 2ª rodada da #4184 depois de generalizar errado a partir
 * de 1 arquivo só):
 *
 *   2603-04: Destaques, Lançamentos, Pesquisas, Outras Notícias
 *   2604-05: Destaques, Outras Notícias
 *   2605-06: Destaques, Use Melhor, Radar
 *   2606-07: Destaques, Use Melhor, Radar
 *
 * `## Use Melhor`/`## Radar` foram introduzidas junto com o pool ranqueado
 * por cliques (#1901/#1902) — ciclos anteriores usavam o pool de
 * standalones antigo (`## Lançamentos`/`## Pesquisas`/`## Outras
 * Notícias`/`## Warnings`). As 3 primeiras são seções LEGÍTIMAS com links
 * próprios (reconhecidas abaixo com rótulo próprio, nunca fundidas em Use
 * Melhor/Radar); `## Warnings` é nota do analista em prosa, sem lista de
 * link estruturada — não é uma seção reconhecida por este parser.
 * `parsePrioritizedSections` trata seção ausente como "zero URLs daquela
 * seção" — nunca erro; retroatividade PARCIAL (cada ciclo só emite as
 * seções que de fato tinha) é o comportamento correto, não um bug do parser.
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
 *
 * #4198: `parsePrioritizedUrlTitles`/`buildLinkTitleMap` espelham a camada
 * acima (mesmo `splitRecognizedSectionBodies`), mas para o TÍTULO editorial
 * de cada item (o texto entre o prefixo `[tag]`/data opcional e a URL, ex:
 * "Como ter acesso à Alexa+" na linha `- 260630 — Como ter acesso à Alexa+
 * — https://link.amazon/B0249coGp (5 cliques)`). Motivação: URLs opacas
 * (encurtadores, links de produto sem slug) caem no fallback de
 * `classifyLinkContent` (regra 4) e produzem rótulos ilegíveis (ex:
 * "B0249coGp (link.amazon)") nas tabelas "Links mais clicados" do dashboard
 * — o título editorial já existe em `prioritized.md` e é mais legível.
 * `buildLinkTitleMap` usa `classifyLinkContent(url)` SEM título pra computar
 * a CHAVE (mesmo cálculo independente que `render-links.ts` faz sobre as
 * URLs de clique da Brevo) — preserva a MESMA chave de agrupamento/seção já
 * em uso, o título é só um valor adicional consultado pela camada de render
 * na hora de EXIBIR o conteúdo (nunca na hora de agrupar). Sem loader de I/O
 * próprio ainda — um `loadLinkTitleMapForCycle` (espelhando
 * `loadLinkSectionMapForCycle`) foi cogitado e removido antes do merge
 * (nota inline logo após `buildLinkTitleMap` abaixo): sem consumidor real
 * até o wiring KV/Studio (fora do escopo do #4198 nesta rodada), um wrapper
 * de I/O sem chamador é só um export morto pro knip.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monthlyDir } from "./monthly-paths.ts";
import { classifyLinkContent } from "../../../workers/brevo-dashboard/src/link-content.ts";
import type { LinkSectionName, LinkSectionMap } from "../dashboard-kv-types.ts";

/** As 6 seções reconhecidas + o texto (normalizado: minúsculas, sem sufixo
 * parentético) do cabeçalho `##` correspondente no `prioritized.md`. Inclui
 * as 3 seções do pool ATUAL (ranqueado por cliques, #1901/#1902) e as 3 do
 * pool LEGADO (`2603-04`/`2604-05`, standalones sem ranking) — nomes
 * distintos, nunca fundidos entre si (cada um vira seu próprio rótulo na
 * coluna "Seção", refletindo o que a edição de fato tinha). */
const SECTION_HEADER_NAMES: Record<LinkSectionName, string> = {
  destaques: "destaques",
  "use-melhor": "use melhor",
  radar: "radar",
  lancamentos: "lançamentos",
  pesquisas: "pesquisas",
  "outras-noticias": "outras notícias",
};

/**
 * Normaliza um texto de cabeçalho `##` pra comparação: remove um sufixo
 * parentético final (ex: `2604-05` tem literalmente `## Outras Notícias (8
 * destaques standalone)` — o "(8 destaques standalone)" não faz parte do
 * NOME da seção, só uma contagem incidental daquele mês), trim, minúsculas.
 * Sem isso, essa seção inteira seria perdida (o parser não reconheceria o
 * cabeçalho e todos os links de "Outras Notícias" daquele ciclo cairiam
 * silenciosamente fora do mapa).
 */
function normalizeHeaderText(headerText: string): string {
  return headerText.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

function matchSectionName(headerText: string): LinkSectionName | null {
  const norm = normalizeHeaderText(headerText);
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
 * #4198: extrai `{url, title}` de UMA linha de item. Convenção do
 * `prioritized.md` (ver exemplos no header do módulo): `- [tag opcional]
 * AAMMDD-opcional — TÍTULO — URL [(N cliques)]` — tag/data são cada um
 * opcional (o pool Use Melhor não tem nenhum dos dois). `title` só é
 * populado quando a linha de fato separa TÍTULO de URL por ` — ` (em dash);
 * caso contrário (linha de prosa, sem esse padrão) retorna `title:
 * undefined` — nunca lança, nunca inventa título.
 */
function extractUrlTitleFromLine(line: string): { url: string; title: string | undefined } | null {
  const m = /https?:\/\/[^\s)]+/.exec(line);
  if (!m) return null;
  const url = m[0].replace(/[.,;]+$/, "");
  const before = line.slice(0, m.index);
  const dashBeforeUrl = /—\s*$/.exec(before);
  if (!dashBeforeUrl) return { url, title: undefined };

  let prefixAndTitle = before.slice(0, dashBeforeUrl.index).trim();
  prefixAndTitle = prefixAndTitle.replace(/^-\s+/, ""); // marcador de lista "- "
  prefixAndTitle = prefixAndTitle.replace(/^\[[^\]]*\]\s*/, ""); // tag "[algo] "
  prefixAndTitle = prefixAndTitle.replace(/^\d{6}\s*/, ""); // data "AAMMDD "
  prefixAndTitle = prefixAndTitle.replace(/^—\s*/, "").trim(); // separador remanescente

  return { url, title: prefixAndTitle || undefined };
}

/** Mesmo par {url, title} de `extractUrlTitleFromLine`, aplicado a cada
 * linha de um bloco de texto (corpo de uma seção). Linhas sem URL são
 * ignoradas silenciosamente (prosa, cabeçalhos internos, linhas em branco). */
function extractUrlTitlesFromBody(body: string): Array<{ url: string; title: string | undefined }> {
  const out: Array<{ url: string; title: string | undefined }> = [];
  for (const line of body.split("\n")) {
    const pair = extractUrlTitleFromLine(line);
    if (pair) out.push(pair);
  }
  return out;
}

/**
 * Localiza os cabeçalhos `## Nome` de nível 2 RECONHECIDOS (ver
 * `SECTION_HEADER_NAMES`) e devolve, na ordem em que aparecem, o corpo de
 * cada um — do fim do cabeçalho até o próximo `## ` (qualquer nome) ou fim
 * do arquivo. Compartilhado por `parsePrioritizedSections` (só-URLs) e
 * `parsePrioritizedUrlTitles` (#4198, URL+título) — mesma fatia de texto,
 * dois extratores diferentes sobre ela.
 */
function splitRecognizedSectionBodies(markdown: string): Array<{ section: LinkSectionName; body: string }> {
  const headerRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headers: Array<{ name: string; bodyStart: number; headerStart: number }> = [];
  for (let m = headerRe.exec(markdown); m; m = headerRe.exec(markdown)) {
    headers.push({ name: m[1].trim(), headerStart: m.index, bodyStart: m.index + m[0].length });
  }

  const out: Array<{ section: LinkSectionName; body: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const sectionName = matchSectionName(h.name);
    if (!sectionName) continue;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].headerStart : markdown.length;
    out.push({ section: sectionName, body: markdown.slice(h.bodyStart, bodyEnd) });
  }
  return out;
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
    lancamentos: [],
    pesquisas: [],
    "outras-noticias": [],
  };

  for (const { section, body } of splitRecognizedSectionBodies(markdown)) {
    result[section].push(...extractUrls(body));
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

// ─── #4198: título editorial por conteúdo (rótulo legível pra URLs opacas) ──

/**
 * Extrai `{url, title}` de TODAS as seções reconhecidas do `prioritized.md`,
 * na ordem em que aparecem — mesma fatia de texto de `parsePrioritizedSections`
 * (via `splitRecognizedSectionBodies`), extrator diferente (URL+título em vez
 * de só URL). `title` é `undefined` quando a linha não separa título de URL
 * por ` — ` (nunca lança). Pura, não faz I/O.
 */
export function parsePrioritizedUrlTitles(markdown: string): Array<{ url: string; title: string | undefined }> {
  const out: Array<{ url: string; title: string | undefined }> = [];
  for (const { body } of splitRecognizedSectionBodies(markdown)) {
    out.push(...extractUrlTitlesFromBody(body));
  }
  return out;
}

/**
 * Resolve cada `{url, title}` (saída de `parsePrioritizedUrlTitles`) pro
 * mapa CONTEÚDO→TÍTULO. A chave é `classifyLinkContent(url).content` SEM
 * título (#4198) — o mesmo cálculo independente que `render-links.ts` faz
 * sobre as URLs de clique da Brevo, preservando a chave de
 * agrupamento/seção já em uso por `buildLinkSectionMap`/`lookupLinkSectionCell`
 * (#4184) — o título é só um valor adicional, nunca entra na chave. Itens
 * sem título extraído não entram no mapa (ausência de chave == "sem título
 * conhecido", o sinal pra `classifyLinkContent` cair no rótulo atual). Pura
 * — não faz I/O, não conhece `prioritized.md` diretamente (recebe já
 * parseado). Quando o mesmo conteúdo base aparece mais de uma vez com
 * títulos diferentes (raro — ex: o mesmo link citado 2x com fiação de texto
 * diferente), o PRIMEIRO título encontrado (ordem de leitura do markdown)
 * vence — determinístico.
 */
export function buildLinkTitleMap(
  urlTitles: Array<{ url: string; title: string | undefined }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { url, title } of urlTitles) {
    if (!title) continue;
    const { content } = classifyLinkContent(url);
    if (!(content in out)) out[content] = title;
  }
  return out;
}

// NOTA (#4198, achado de CI/knip 260728): um `loadLinkTitleMapForCycle`
// (I/O, espelhando `loadLinkSectionMapForCycle` acima) foi cogitado aqui mas
// REMOVIDO antes do merge — sem nenhum consumidor ainda (nem produção nem
// teste), knip acusa "unused export" corretamente. `buildLinkTitleMap` +
// `parsePrioritizedUrlTitles` (ambos usados, ver testes) já compõem o
// carregamento fim-a-fim (`buildLinkTitleMap(parsePrioritizedUrlTitles(fs.readFileSync(...)))`)
// pra quando o wiring KV/Studio (escopo explicitamente fora deste PR — ver
// PR body) precisar dele; reintroduzir o wrapper nesse momento é trivial.
