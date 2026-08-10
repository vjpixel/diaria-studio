/**
 * scripts/lib/hub-match.ts (#4907)
 *
 * Decide, deterministicamente, se as manchetes de uma edição diária casam
 * `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts` — o mesmo
 * matcher que decide se uma edição PUBLICADA entra na lista de fontes de um
 * hub, `generate-hub-sources.ts`) — e, se sim, monta o link contextual do
 * hub pra injetar no corpo do destaque que casou (`scripts/stitch-newsletter.ts`).
 *
 * **Por que existe (issue #4907):** nenhuma edição da newsletter linkava um
 * hub temático — o único caminho de entrada em `arquivo.diar.ia.br/temas/*`
 * era o índice do próprio arquivo. Reusar `HUB_KEYWORD_PATTERNS` na hora da
 * escrita fecha esse buraco sem precisar de um mecanismo de matching novo:
 * é a MESMA regex por slug que já gerou as `*-sources.generated.json` de
 * cada hub.
 *
 * **Fica na RAIZ de `scripts/lib/`, não em `lib/shared/` (#2747).** Depende
 * de `../generate-hub-sources.ts`, um script na raiz de `scripts/` — importar
 * isso de dentro de `lib/shared/` introduziria uma dependência de shared/ em
 * cima da raiz de scripts/ sem precedente no repo (checado antes de escrever
 * este arquivo). A raiz de `scripts/lib/` está fora do lint de fronteira
 * (`test/lib-boundary.test.ts`) — "legado não-classificado", mesma categoria
 * de `scripts/lib/hubs/*.ts`, que já importa TIPOS de `generate-hub-sources.ts`
 * pelo mesmo caminho relativo.
 *
 * **Regra explícita pro caso de múltiplos hubs casados (#4907, exigência da
 * issue: "não de escolha implícita pela ordem do Record"):** se as manchetes
 * do dia casarem o keyword pattern de MAIS DE UM hub, `matchEditionHub`
 * devolve `null` — nenhum link é inserido. Decisão deliberada, não omissão:
 * uma edição que cobre 2+ empresas ao mesmo tempo não tem um hub "principal"
 * óbvio, e adivinhar (por ordem de declaração do Record, ou por posição do
 * destaque) seria arbitrário. Ambíguo → sem link, comportamento idêntico ao
 * de hoje (só o link fixo pra raiz do arquivo).
 */
import { HUB_KEYWORD_PATTERNS, stripAccents } from "../generate-hub-sources.ts";
import { HUB_META } from "../../workers/arquivo/src/hubs/meta.ts";
import { DIARIA_ARQUIVO_URL } from "./canonical-urls.ts";
import { HUB_CONTEXTUAL_UTM } from "./shared/utm-registry.ts";

/** Resultado de `matchEditionHub` — o hub casado + QUAL destaque (índice
 * 0-based na ordem D1/D2/D3) carregou a manchete que bateu. */
export interface EditionHubMatch {
  /** Slug do hub casado — chave de `HUB_KEYWORD_PATTERNS`/`HUB_META`. */
  slug: string;
  /** Rótulo humano do hub (`HUB_META[].label`, ex: "Anthropic e Claude"). */
  label: string;
  /** URL completa do hub, já com UTM contextual (#4907, direção
   * newsletter -> hub — distinta tanto do `HUB_*_FOOTER_NAV_UTM` (hub ->
   * diar.ia.br) quanto de `ARQUIVO_RODAPE_UTM` (newsletter -> raiz do
   * arquivo, pill fixa do PARA ENCERRAR). */
  url: string;
  /** Índice 0-based (0=D1, 1=D2, 2=D3) do destaque cujas manchetes bateram
   * o pattern do hub — é ali que `stitch-newsletter.ts` injeta o link. */
  destaqueIndex: number;
}

/**
 * Monta a URL do hub com o UTM contextual (#4907). `campaign` segue o
 * `campaignPattern` registrado (`hub-{slug}-contextual`) — mesma convenção
 * de placeholder já usada por `WHATSAPP_SHARE_UTM`/`LINKEDIN_WEEKLY_UTM`
 * (`utm-registry.ts`).
 *
 * @pure
 */
export function buildHubContextualUrl(slug: string): string {
  const campaign = `hub-${slug}-contextual`;
  return `${DIARIA_ARQUIVO_URL}/temas/${slug}?utm_source=${HUB_CONTEXTUAL_UTM.source}&utm_medium=${HUB_CONTEXTUAL_UTM.medium}&utm_campaign=${campaign}`;
}

/**
 * Decide qual hub (se algum) as manchetes do dia casam.
 *
 * @param destaqueHeadlines Array por destaque (índice 0=D1, 1=D2, 2=D3 — mas
 *   aceita qualquer contagem, 2 ou 3 destaques), cada elemento é a lista de
 *   candidatos de título daquele destaque (as 3 opções do draft, ou só 1 já
 *   podada pós-gate — funciona nos dois casos).
 * @returns `null` se nenhuma manchete casar nenhum hub, OU se manchetes
 *   casarem MAIS DE UM hub (ambíguo — ver docstring do módulo). Caso
 *   contrário, o match único: hub + índice do destaque cuja manchete bateu
 *   primeiro (ordem D1 -> D2 -> D3).
 * @pure
 */
export function matchEditionHub(destaqueHeadlines: string[][]): EditionHubMatch | null {
  // slug -> índice do 1º destaque cujas manchetes bateram o pattern desse hub.
  const matchedSlugs = new Map<string, number>();
  for (const [slug, pattern] of Object.entries(HUB_KEYWORD_PATTERNS)) {
    for (let i = 0; i < destaqueHeadlines.length; i++) {
      const headlines = destaqueHeadlines[i] ?? [];
      const hit = headlines.some((h) => pattern.test(stripAccents(h)));
      if (hit) {
        matchedSlugs.set(slug, i);
        break;
      }
    }
  }
  if (matchedSlugs.size !== 1) return null; // 0 ou >1 hub casado -> sem link (regra explícita, ver docstring)
  const [[slug, destaqueIndex]] = matchedSlugs;
  const meta = HUB_META.find((h) => h.slug === slug);
  if (!meta) return null; // defensivo: HUB_KEYWORD_PATTERNS e HUB_META podem, em teoria, driftar entre si
  return {
    slug,
    label: meta.label,
    url: buildHubContextualUrl(slug),
    destaqueIndex,
  };
}

/**
 * Extrai as opções de título de um draft de destaque bruto (`02-d{n}-draft.md`,
 * formato de `writer-destaque.md`: 3 linhas `**[Título opção N](URL)**`
 * consecutivas logo após o header) — ou o título único já podado pós-gate
 * (`02-reviewed.md`, `[Título](URL)`). Casa QUALQUER linha do bloco que seja
 * SÓ um link markdown (bold opcional), em qualquer posição — não precisa
 * saber se é pré ou pós-gate.
 *
 * Não casa itens do bloco "Aprofunde:" (formato `* [Título](URL) - Fonte`,
 * bullet + texto extra) nem o link "Saiba mais:" que este próprio módulo
 * injeta (mesmo motivo: tem bullet OU o header não é um link) — só a linha
 * PURA `**[texto](url)**`, sem nada antes ou depois.
 *
 * @pure
 */
export function extractBoldLinkTitles(draftText: string): string[] {
  const re = /^\*{0,2}\[([^\]]+)\]\([^)]+\)\*{0,2}\s*$/gm;
  const out: string[] = [];
  for (const m of draftText.matchAll(re)) out.push(m[1]);
  return out;
}
