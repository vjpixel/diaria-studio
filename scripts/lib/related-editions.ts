/**
 * scripts/lib/related-editions.ts (#5122 item 3)
 *
 * Aresta edição → edição: bloco "Edições relacionadas" inserido no fim do
 * corpo (dentro de PARA ENCERRAR, via `buildParaEncerrar` em
 * `stitch-newsletter.ts`) linkando 2-3 edições passadas do MESMO tema/hub de
 * algum destaque de hoje.
 *
 * **Por que existe (#5122):** medição ao vivo mostrou 19/19 edições
 * publicadas sem NENHUM link pra outra edição nem pro hub /temas/ — o único
 * mecanismo que já existia (`scripts/lib/hub-match.ts`, #4907, "Saiba
 * mais:") exige um match ÚNICO e sem ambiguidade em TODA a edição (guard
 * deliberado, ver docstring de `hub-match.ts`) — e como `mercado-trabalho`
 * casa vocabulário extremamente comum (`\btrabalho\b`, `\bemprego\b`,
 * `\bcarreira\b`...) e cada edição cobre 2-3 temas/empresas diferentes na
 * prática, a ambiguidade dispara na maioria das edições reais (achado
 * registrado em comentário no #4907, re-medido contra 54 edições locais:
 * 38/54 ambíguas, 14/54 dariam link, 2/54 sem match nenhum). Este módulo é
 * uma aresta INDEPENDENTE — não herda essa exigência de unicidade — porque
 * o objetivo aqui é só recircular o leitor pra mais conteúdo relacionado, não
 * apontar "o" tema canônico da edição.
 *
 * **Fonte dos candidatos:** `HUB_LOADERS` (`scripts/build-hub-page.ts`) — o
 * mesmo dataset committed (`*-sources.generated.json`) que já alimenta os 6
 * hubs publicados, via `hub.sourceEditions` (garantido ordenado
 * mais-recente-primeiro por `validateHubContent`). Zero rede, zero I/O além
 * do require estático dos `.generated.json` — não depende de nenhuma
 * alavanca no apex Beehiiv.
 */
import { HUB_KEYWORD_PATTERNS, stripAccents } from "../generate-hub-sources.ts";
import { HUB_LOADERS } from "../build-hub-page.ts";

export interface RelatedEdition {
  /** Título da edição relacionada (edição real quando disponível — ver
   * `sourceEditionLabel`/`HubSourceEdition.editionTitle` — senão a manchete
   * que casou a palavra-chave do hub). */
  title: string;
  url: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Slug do hub de onde este candidato veio — só pra depuração/teste. */
  hubSlug: string;
}

/**
 * Decide, a partir das opções de título de cada destaque de hoje, quais
 * hubs temáticos casam `HUB_KEYWORD_PATTERNS` — SEM exigir unicidade
 * edição-wide (diferente de `matchEditionHub`/#4907, ver docstring do
 * módulo acima) — e seleciona até `maxCount` edições passadas desses hubs
 * pra recircular no fim do corpo.
 *
 * Preenche 1 candidato por hub casado primeiro (edição mais recente de
 * cada), depois completa round-robin com a 2ª/3ª mais recente de cada hub
 * até atingir `maxCount` ou esgotar os candidatos disponíveis — garante
 * diversidade de hub quando >1 casou, em vez de esgotar `maxCount` inteiro
 * num único hub.
 *
 * `excludeUrls` existe pra callers de teste — em produção nunca é
 * necessário: a edição de hoje ainda não foi publicada, então nunca aparece
 * em `sourceEditions` (que só lista edições JÁ publicadas e já processadas
 * por `generate-hub-sources.ts`).
 *
 * @pure
 */
export function selectRelatedEditions(
  destaqueHeadlines: readonly (readonly string[])[],
  opts: { maxCount?: number; excludeUrls?: readonly string[] } = {},
): RelatedEdition[] {
  const maxCount = opts.maxCount ?? 3;

  const matchedSlugs: string[] = [];
  for (const [slug, pattern] of Object.entries(HUB_KEYWORD_PATTERNS)) {
    const hit = destaqueHeadlines.some((headlines) =>
      headlines.some((h) => pattern.test(stripAccents(h))),
    );
    if (hit) matchedSlugs.push(slug);
  }
  if (matchedSlugs.length === 0) return [];

  const seenUrls = new Set<string>(opts.excludeUrls ?? []);
  const candidates: RelatedEdition[] = [];

  const pickNext = (slug: string): RelatedEdition | null => {
    const loader = HUB_LOADERS[slug];
    if (!loader) return null; // defensivo: drift entre HUB_KEYWORD_PATTERNS e HUB_LOADERS
    const hub = loader();
    for (const src of hub.sourceEditions) {
      if (seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      return { title: src.editionTitle ?? src.title, url: src.url, date: src.date, hubSlug: slug };
    }
    return null;
  };

  // 1ª rodada: 1 candidato (o mais recente ainda não visto) por hub casado.
  for (const slug of matchedSlugs) {
    if (candidates.length >= maxCount) break;
    const picked = pickNext(slug);
    if (picked) candidates.push(picked);
  }

  // Rodadas seguintes: completa até `maxCount` reciclando os mesmos hubs
  // casados (2ª/3ª edição mais recente de cada) — só se algum hub tiver
  // mais candidatos disponíveis. Guard de 10 rodadas: puramente defensivo
  // (nunca deveria chegar perto disso com maxCount=3), evita loop infinito
  // se um bug futuro fizer `pickNext` retornar sempre não-null sem avançar.
  for (let round = 0; round < 10 && candidates.length < maxCount; round++) {
    let addedThisRound = false;
    for (const slug of matchedSlugs) {
      if (candidates.length >= maxCount) break;
      const picked = pickNext(slug);
      if (picked) {
        candidates.push(picked);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break; // esgotou os candidatos de todos os hubs casados
  }

  return candidates.slice(0, maxCount);
}

/**
 * Renderiza o grupo markdown "Edições relacionadas:" no MESMO formato que
 * `CURADORIA_PILLS` (`scripts/lib/shared/encerramento-snippet.ts`) usa pros
 * outros grupos de PARA ENCERRAR — parágrafo-label terminado em `:`
 * IMEDIATAMENTE seguido (sem blank line) pelos itens `- [Título](URL)`.
 * `renderEncerrar` (`newsletter-render-html.ts`) reconhece esse padrão e
 * transforma o grupo inteiro em pills automaticamente — zero renderer novo
 * necessário.
 *
 * `null` quando `related` está vazio — caller (`buildParaEncerrar`) omite o
 * grupo inteiro nesse caso, comportamento idêntico a antes do #5122 pra
 * edições sem nenhum hub casado.
 *
 * @pure
 */
export function renderRelatedEditionsMarkdown(related: readonly RelatedEdition[]): string | null {
  if (related.length === 0) return null;
  const lines = related.map((r) => `- [${r.title}](${r.url})`);
  return `Edições relacionadas:\n${lines.join("\n")}`;
}
