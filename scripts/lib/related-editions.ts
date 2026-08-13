/**
 * scripts/lib/related-editions.ts (#5122 item 3, redesenhado #5181)
 *
 * Aresta edição → edição: bloco "Edições relacionadas" inserido no fim do
 * corpo (dentro de PARA ENCERRAR, via `buildParaEncerrar` em
 * `stitch-newsletter.ts`) linkando o hub temático de hoje + 2 edições
 * passadas do MESMO hub.
 *
 * **#5181 redesenhou o formato do #5122.** Medição ao vivo (28 edições
 * reais, ver issue #5181) mostrou que o modo original (só edições, sem
 * memória entre chamadas) repetia os MESMOS 8 links sem parar — 1 título
 * saía em 24 das 28 edições (86%). Um contrafactual só-hubs tampouco
 * resolvia: cada item ainda repetia (o hub mais comum saía em 64% das
 * edições) e sem nenhuma narrativa amarrando os 3 links, que vinham de hubs
 * diferentes. O formato atual — **1 hub + 2 edições daquele MESMO hub**,
 * com rótulo nomeando o tema ("Mais sobre X:") — resolve os dois problemas
 * ao mesmo tempo: o hub é o destino perene que carrega autoridade (link
 * interno pra `/temas/`, monitorado por `Diaria-Geo-Citation-Monitor`), as
 * 2 edições são a isca clicável, e o rótulo explica por que os 3 links
 * pertencem juntos. Ver a issue #5181 pro racional completo e a medição.
 *
 * **Por que existe (#5122):** medição ao vivo mostrou 19/19 edições
 * publicadas sem NENHUM link pra outra edição nem pro hub /temas/ — o único
 * mecanismo que já existia (`scripts/lib/hub-match.ts`, #4907, "Saiba
 * mais:") exige um match ÚNICO e sem ambiguidade em TODA a edição (guard
 * deliberado, ver docstring de `hub-match.ts`) — e como `mercado-trabalho`
 * casa vocabulário extremamente comum (`\btrabalho\b`, `\bemprego\b`,
 * `\bcarreira\b`...) e cada edição cobre 2-3 temas/empresas diferentes na
 * prática, a ambiguidade dispara na maioria das edições reais. Este módulo
 * é uma aresta INDEPENDENTE — não herda a exigência de unicidade de
 * `matchEditionHub` — porque o objetivo aqui é recircular o leitor pra mais
 * conteúdo relacionado, não apontar "o" tema canônico da edição. A exclusão
 * mútua com `matchEditionHub` (quando os dois escolhem o MESMO hub) é
 * aplicada pelo CALLER (`stitch-newsletter.ts`), não aqui — ver
 * `renderRelatedEditionsMarkdown`'s `omitHubLink`.
 *
 * **Fonte dos candidatos:** `HUB_LOADERS` (`scripts/build-hub-page.ts`) — o
 * mesmo dataset committed (`*-sources.generated.json`) que já alimenta os 6
 * hubs publicados, via `hub.sourceEditions` (garantido ordenado
 * mais-recente-primeiro por `validateHubContent`). Zero rede, zero I/O além
 * do require estático dos `.generated.json` — não depende de nenhuma
 * alavanca no apex Beehiiv.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HUB_KEYWORD_PATTERNS, stripAccents } from "../generate-hub-sources.ts";
import { HUB_LOADERS } from "../build-hub-page.ts";
import { buildHubContextualUrl } from "./hub-match.ts";
import { HUB_META } from "../../workers/arquivo/src/hubs/meta.ts";
import { formatDateShort } from "./shared/hub-page.ts";
import { enumerateEditionDirs } from "./find-current-edition.ts";

export interface RelatedEdition {
  /** Título da edição relacionada (edição real quando disponível — ver
   * `sourceEditionLabel`/`HubSourceEdition.editionTitle` — senão a manchete
   * que casou a palavra-chave do hub). */
  title: string;
  url: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Slug do hub de onde este candidato veio — sempre igual a
   * `RelatedEditionsGroup.hubSlug` (redundante de propósito, mantido pra
   * back-compat com quem já lia `hubSlug` por item individual). */
  hubSlug: string;
}

/**
 * Resultado de `selectRelatedEditions` (#5181) — 1 hub + até `maxEditions`
 * edições daquele hub. `null` quando nenhuma manchete de hoje casa hub
 * nenhum.
 */
export interface RelatedEditionsGroup {
  hubSlug: string;
  /** `HUB_META[].label` — ex: "OpenAI e ChatGPT". */
  hubLabel: string;
  /** URL do hub com UTM contextual (mesma `buildHubContextualUrl` que
   * `matchEditionHub`/#4907 usa pro "Saiba mais:" — não existe motivo pra
   * um 2º registro de UTM só pra esta 2ª posição, e reusar deixa explícito
   * que, quando os dois blocos citam o MESMO hub, é o MESMO link — daí a
   * exclusão mútua existir). */
  hubUrl: string;
  /** Até `maxEditions` edições passadas do hub, mais recente primeiro. */
  editions: RelatedEdition[];
}

/**
 * Quais hubs as manchetes de hoje casam `HUB_KEYWORD_PATTERNS` — SEM exigir
 * unicidade edição-wide (diferente de `matchEditionHub`/#4907). Pode
 * retornar 0, 1 ou vários slugs; `selectRelatedEditions` reduz a 1 via
 * `pickPrimaryHubSlug`.
 * @pure
 */
function matchedHubSlugs(destaqueHeadlines: readonly (readonly string[])[]): string[] {
  const matched: string[] = [];
  for (const [slug, pattern] of Object.entries(HUB_KEYWORD_PATTERNS)) {
    const hit = destaqueHeadlines.some((headlines) =>
      headlines.some((h) => pattern.test(stripAccents(h))),
    );
    if (hit) matched.push(slug);
  }
  return matched;
}

/**
 * Rank de especificidade de um hub, MENOR = mais específico (vence o
 * desempate). Baseado no Nº de alternativas (`|`) do regex do hub em
 * `HUB_KEYWORD_PATTERNS` — não no comprimento do texto casado nem em
 * qualquer coisa que dependa da manchete específica, e crucialmente NÃO na
 * ordem de declaração do `Record` (exigência explícita da issue #5181,
 * mesmo cuidado que `matchEditionHub`/`hub-match.ts` já toma pro caso
 * ambíguo — aqui o requisito é diferente: não suprimir o resultado quando
 * ambíguo, ESCOLHER um).
 *
 * **Por que Nº de alternativas mede "genérico" o suficiente pra este
 * conjunto de 6 hubs (medido ao vivo, #5181):** os 4 hubs de EMPRESA
 * (`anthropic-claude`, `openai-chatgpt`, `google-gemini`, `meta-ai`) têm
 * entre 3 e 6 alternativas cada — cada uma nomeando uma marca ou produto
 * específico (Claude, ChatGPT, Gemini...). Os 2 hubs TEMÁTICOS
 * (`mercado-trabalho`, `brasil-regulacao`) têm 19-26 — precisam de mais
 * vocabulário justamente porque cobrem um CONCEITO, não uma entidade
 * nomeada, e por isso casam palavras comuns do português
 * (`\btrabalho\b`/`\bemprego\b`/`\bcarreira\b`). Essa é exatamente a causa
 * raiz que a issue #5181 mediu: `mercado-trabalho` dominava o desempate
 * (14/28 edições) por ser o vocabulário mais genérico do conjunto — este
 * rank penaliza isso diretamente, sem hardcodar o slug. Desempate final (2º
 * elemento da tupla): comprimento total do source do regex, mais fino que
 * a contagem de alternativas; 3º elemento: slug alfabético — determinístico
 * e independente de QUALQUER ordem declarada em código, garante que o
 * desempate nunca seja arbitrário mesmo no caso (hoje inexistente) de 2
 * hubs com rank idêntico nos 2 primeiros critérios.
 * @pure
 */
function hubSpecificityRank(slug: string): readonly [number, number, string] {
  const pattern = HUB_KEYWORD_PATTERNS[slug];
  if (!pattern) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, slug]; // defensivo: drift entre matchedHubSlugs e HUB_KEYWORD_PATTERNS não deveria acontecer
  return [pattern.source.split("|").length, pattern.source.length, slug];
}

/**
 * Escolhe 1 hub entre os casados — o mais específico por `hubSpecificityRank`.
 * @pure
 */
function pickPrimaryHubSlug(matchedSlugs: readonly string[]): string {
  return [...matchedSlugs].sort((a, b) => {
    const ra = hubSpecificityRank(a);
    const rb = hubSpecificityRank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return ra[2].localeCompare(rb[2]);
  })[0];
}

/**
 * Decide, a partir das opções de título de cada destaque de hoje, o grupo
 * "Mais sobre {tema}" (#5181): 1 hub (o mais específico entre os casados,
 * ver `pickPrimaryHubSlug`) + até `maxEditions` edições passadas DAQUELE
 * MESMO hub — nunca de hubs diferentes (diferente do comportamento pré-#5181,
 * que diversificava entre hubs casados).
 *
 * `excludeUrls` (#5181 item 4) — URLs de edição a pular mesmo que sejam o
 * candidato mais recente do hub; produção alimenta isto com
 * `loadRecentRelatedEditionUrls(editionDir)`, as URLs já citadas nas
 * últimas ~10 edições — evita recomendar a MESMA edição-filha
 * indefinidamente enquanto o pool do hub não for regenerado.
 *
 * `null` quando nenhuma manchete de hoje casa hub nenhum, OU (defensivo)
 * quando o hub escolhido não tem loader/meta registrado.
 *
 * @pure
 */
export function selectRelatedEditions(
  destaqueHeadlines: readonly (readonly string[])[],
  opts: { maxEditions?: number; excludeUrls?: readonly string[] } = {},
): RelatedEditionsGroup | null {
  const maxEditions = opts.maxEditions ?? 2;

  const matched = matchedHubSlugs(destaqueHeadlines);
  if (matched.length === 0) return null;

  const primarySlug = pickPrimaryHubSlug(matched);
  const loader = HUB_LOADERS[primarySlug];
  const meta = HUB_META.find((h) => h.slug === primarySlug);
  if (!loader || !meta) return null; // defensivo: drift entre HUB_KEYWORD_PATTERNS e HUB_LOADERS/HUB_META

  const hub = loader();
  const seenUrls = new Set<string>(opts.excludeUrls ?? []);
  const editions: RelatedEdition[] = [];
  for (const src of hub.sourceEditions) {
    if (editions.length >= maxEditions) break;
    if (seenUrls.has(src.url)) continue;
    seenUrls.add(src.url);
    editions.push({
      title: src.editionTitle ?? src.title,
      url: src.url,
      date: src.date,
      hubSlug: primarySlug,
    });
  }

  return {
    hubSlug: primarySlug,
    hubLabel: meta.label,
    hubUrl: buildHubContextualUrl(primarySlug),
    editions,
  };
}

/**
 * Renderiza o grupo "Mais sobre {tema}:" no MESMO formato que
 * `CURADORIA_PILLS` (`scripts/lib/shared/encerramento-snippet.ts`) usa pros
 * outros grupos de PARA ENCERRAR — parágrafo-label terminado em `:`
 * IMEDIATAMENTE seguido (sem blank line) pelos itens `- [Título](URL)`.
 * `renderEncerrar` (`newsletter-render-html.ts`) reconhece esse padrão e
 * transforma o grupo inteiro em pills automaticamente — zero renderer novo
 * necessário.
 *
 * Cada edição carrega a data entre parênteses no formato `DD/MM/AAAA`
 * (`formatDateShort`, mesmo formato que os hubs já usam em prosa — #5181
 * item 5): sem isso, o 2º/3º candidato de um hub magro (ex: `brasil-regulacao`,
 * 11 edições no acervo) pode ser de meses atrás sem nenhum sinal pro leitor.
 * A data fica DENTRO dos colchetes, como parte do texto visível do link
 * (`- [Título (DD/MM/AAAA)](URL)`) — NUNCA depois do `)` de fechamento
 * (hotfix, achado no review consolidado): a regex de parse de pill em
 * `newsletter-render-html.ts` (`/^\[([^\]]+)\]\((.+)\)$/`) é gulosa e
 * ancorada no fim da string, então qualquer conteúdo após o `)` do link
 * (como `(DD/MM/AAAA)`) ficaria capturado dentro do PRÓPRIO `href` — link
 * quebrado no HTML final, data vazando pro atributo em vez de aparecer no
 * texto. Manter a linha estritamente `[label](url)`, sem sufixo.
 *
 * `omitHubLink` (#5181 item 3) — quando `true`, omite a linha do hub (mas
 * preserva o rótulo + as edições) porque o MESMO hub já foi linkado no
 * "Saiba mais:" do #4907 (`matchEditionHub`) em algum destaque desta mesma
 * edição — caller (`stitch-newsletter.ts`) decide isso comparando
 * `hubMatch.slug` com `group.hubSlug`. Evita o mesmo `<a href>` aparecer 2x
 * na mesma edição.
 *
 * `null` quando `group` é `null`, OU quando (após aplicar `omitHubLink`)
 * não sobra nenhuma linha pra renderizar (hub omitido E zero edições —
 * hub novíssimo sem outra edição no acervo ainda) — caller
 * (`buildParaEncerrar`) omite o grupo inteiro nesse caso.
 *
 * @pure
 */
export function renderRelatedEditionsMarkdown(
  group: RelatedEditionsGroup | null,
  opts: { omitHubLink?: boolean } = {},
): string | null {
  if (!group) return null;
  const lines: string[] = [];
  if (!opts.omitHubLink) {
    lines.push(`- [Tudo sobre ${group.hubLabel}](${group.hubUrl})`);
  }
  for (const ed of group.editions) {
    lines.push(`- [${ed.title} (${formatDateShort(ed.date)})](${ed.url})`);
  }
  if (lines.length === 0) return null;
  return `Mais sobre ${group.hubLabel}:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// #5181 item 4 — janela de dedup entre edições
// ---------------------------------------------------------------------------

/** Default de quantas edições passadas considerar pra montar `excludeUrls`
 * (mesmo espírito de `DEFAULT_PAST_WINDOW` em `past-editions-extract.ts`,
 * mas um número PRÓPRIO — não reaproveita a constante de lá porque aquela
 * janela (3 edições) rege dedup de ARTIGOS-FONTE, um problema de escala bem
 * diferente: qualquer artigo-fonte já apareceu numa das ~3 edições mais
 * recentes ou nunca mais aparece; edição-filha de hub tem pool muito menor
 * — um hub magro como `brasil-regulacao` (11 no acervo) esgotaria a janela
 * de 3 rapidamente e voltaria a repetir. 10 dá fôlego sem esvaziar hubs
 * pequenos por completo). */
export const DEFAULT_RELATED_EDITIONS_WINDOW = 10;

const AAMMDD_RE = /^\d{6}$/;
const AAMM_RE = /^\d{4}$/;

/**
 * Infere `{ root, aammdd }` a partir de um `editionDir` concreto — cobre os
 * dois layouts que `enumerateEditionDirs` já entende (flat
 * `data/editions/{AAMMDD}/` e nested `data/editions/{AAMM}/{AAMMDD}/`).
 * `null` quando `editionDir` não segue nenhum dos dois formatos (ex: dir de
 * teste com nome arbitrário, `mkdtempSync`) — nesse caso
 * `loadRecentRelatedEditionUrls` não tenta ler NADA do disco, mesmo
 * comportamento de "sem histórico" (nunca lança, nunca lê um diretório que
 * não seja claramente uma raiz de edições).
 * @pure (só examina o PATH — nunca toca o filesystem)
 */
export function inferEditionsRoot(editionDir: string): { root: string; aammdd: string } | null {
  const normalized = editionDir.replace(/[\\/]+$/, "");
  const base = basename(normalized);
  if (!AAMMDD_RE.test(base)) return null;
  const parent = dirname(normalized);
  const parentBase = basename(parent);
  if (AAMM_RE.test(parentBase)) return { root: dirname(parent), aammdd: base }; // nested
  return { root: parent, aammdd: base }; // flat
}

const RELATED_BLOCK_HEADER_RE = /^Mais sobre .+:$/m;
const BULLET_URL_RE = /^-\s+\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/;

/**
 * Extrai as URLs do grupo "Mais sobre {tema}:" de um `02-reviewed.md` já
 * stitchado (#5181 item 4/5). Edições anteriores ao #5181 (formato antigo
 * "Edições relacionadas:", sem hub) simplesmente não casam o header e
 * contribuem 0 URLs — degrada pra "sem histórico" nessas edições, não
 * quebra nada.
 * @pure
 */
export function extractRelatedEditionsUrlsFromMarkdown(text: string): string[] {
  const headerMatch = RELATED_BLOCK_HEADER_RE.exec(text);
  if (!headerMatch) return [];
  const rest = text.slice(headerMatch.index + headerMatch[0].length);
  const urls: string[] = [];
  for (const rawLine of rest.split("\n").slice(1)) {
    const line = rawLine.trim();
    if (line === "") break; // bloco termina na 1ª linha em branco (mesmo padrão de CURADORIA_PILLS)
    const m = BULLET_URL_RE.exec(line);
    if (!m) break; // linha não-bullet encerra o bloco
    urls.push(m[1]);
  }
  return urls;
}

/**
 * Varre as últimas `window` edições irmãs de `editionDir` (via
 * `inferEditionsRoot` + `enumerateEditionDirs`, cobre flat+nested) e extrai
 * as URLs já usadas no grupo "Mais sobre {tema}" de cada uma — lidas do
 * `02-reviewed.md` (gate-facing, já com o bloco embutido pelo stitch).
 * Fail-soft em toda camada: `editionDir` que não segue a convenção
 * AAMMDD/AAMM (dir de teste) → `[]` sem tocar o disco; edição sem
 * `02-reviewed.md` (em progresso, ou anterior ao #5181) → 0 URLs dessa
 * edição, sem lançar.
 *
 * Chamado de dentro de `stitchNewsletter()` (não requer opt-in do caller —
 * mesmo padrão de `readEiaBlock(input.editionDir)`, que também lê do disco
 * incondicionalmente a partir do `editionDir` recebido).
 */
export function loadRecentRelatedEditionUrls(
  editionDir: string,
  window: number = DEFAULT_RELATED_EDITIONS_WINDOW,
): string[] {
  const inferred = inferEditionsRoot(editionDir);
  if (!inferred) return [];
  const dirs = enumerateEditionDirs(inferred.root);
  const aammdds = [...dirs.keys()]
    .filter((a) => a !== inferred.aammdd)
    .sort((a, b) => b.localeCompare(a)) // mais recente primeiro (AAMMDD ordena lexicograficamente = cronológico)
    .slice(0, window);

  const urls = new Set<string>();
  for (const aammdd of aammdds) {
    const dir = dirs.get(aammdd);
    if (!dir) continue;
    const path = join(dir, "02-reviewed.md");
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // edição com 02-reviewed.md ilegível — não deveria acontecer, mas não é motivo pra derrubar a edição de hoje
    }
    for (const url of extractRelatedEditionsUrlsFromMarkdown(text)) urls.add(url);
  }
  return [...urls];
}
