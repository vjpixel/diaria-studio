/**
 * hub-divulgacao-box.ts (#5263)
 *
 * Box de divulgação ROTATIVO dos hubs temáticos (`arquivo.diar.ia.br/temas/{slug}`)
 * pra newsletter diária — mesmo formato/família estrutural dos boxes de
 * `data/snippets/` (bold-line/mid-callout, ver `context/snippets/README.md`
 * — a spec do formato continua no git, só o conteúdo migrou, #5227),
 * mas com conteúdo GERADO por edição em vez de texto estático editado à mão.
 *
 * **Distinto de `HUB_CONTEXTUAL_UTM`/`matchEditionHub` (#4907,
 * `scripts/lib/hub-match.ts`)** — aquele mecanismo já existente é
 * OPORTUNISTA: só injeta um link pro hub quando as manchetes do DIA casam o
 * `HUB_KEYWORD_PATTERNS` de algum hub (ex: edição sobre Claude ganha link
 * pro hub Anthropic/Claude dentro do próprio destaque). Este módulo é
 * GARANTIDO: 1 hub em rotação aparece todo dia, independente do conteúdo da
 * edição — mesma garantia que `apoio-divulgacao.md`/`livros-divulgacao.md`
 * já dão pros slots 1/2/3. Os dois são complementares, nunca duplicam
 * propósito: um é "aconteceu de bater", o outro é "descoberta contínua do
 * arquivo" (rationale da issue #5263, análise "Raio-X de /temas/" de
 * 14/08/2026).
 *
 * **Zero prosa nova, tudo derivado** — mesma disciplina de `hubCoverageWindow`
 * em `hub-page.ts`: `label`/`since`/`totalEditions` vêm de `HUB_META` +
 * `HubContent.sourceEditions` de cada `scripts/lib/hubs/{slug}.ts` (via
 * `scripts/build-hub-divulgacao-box.ts`, Node-side — este módulo é pure, sem
 * I/O, e não conhece `HUB_LOADERS`).
 *
 * **Wiring (#5263):** `scripts/stitch-newsletter.ts` chama
 * `regenerateHubDivulgacaoBoxForEdition()` — que reusa este módulo via
 * `resolveHubDivulgacaoBoxSource`/`renderGeneratedSnippet` de
 * `scripts/build-hub-divulgacao-box.ts` — ANTES de `resolveBoxesForEdition()`,
 * escrevendo `data/snippets/hub-divulgacao-rotativo.md` pra edição corrente
 * a cada rodada do Stage 2 (idempotente, fail-soft — box opcional, nunca
 * aborta o stitch). Não há mais slot pinado pra ele: `boxes_divulgacao_auto`
 * já roda por cliques sobre TODO `.md` de `data/snippets/`, então basta o
 * arquivo existir com dado fresco pra competir no ranking.
 */
import { HUB_DIVULGACAO_BOX_UTM } from "./utm-registry.ts";
import { DIARIA_ARQUIVO_URL } from "../canonical-urls.ts";

/** Converte `AAMMDD` (convenção de data de edição do repo) em dias corridos
 * desde a época Unix — só a PARTE INTEIRA importa (usada como contador
 * monotônico pra rotação, nunca como data de calendário de verdade). Lança
 * em formato inválido — mesma disciplina de `calendarDaysBetween`/
 * `hubCoverageWindow` em `hub-page.ts` (nunca falha silenciosamente num
 * `NaN` que produziria rotação incorreta sem aviso). */
function daysSinceEpochFromAammdd(editionDate: string): number {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(editionDate);
  if (!m) throw new Error(`daysSinceEpochFromAammdd: AAMMDD inválido: "${editionDate}"`);
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/**
 * Índice (0-based) do hub em rotação nesta edição, DENTRO da lista de
 * `hubCount` hubs — determinístico: dia corrido desde a época Unix, módulo
 * `hubCount`. Mesmo `editionDate` sempre devolve o mesmo índice (idempotente
 * — regenerar a mesma edição 2x não muda o hub escolhido).
 *
 * **Por que dias corridos, e não dia-da-semana mod hubCount (a outra opção
 * que a issue #5263 sugere):** a diária publica só dias ÚTEIS (seg-sex, 5
 * valores possíveis de dia-da-semana) contra `HUB_META.length` hoje = 6 —
 * `(diaDaSemana - 1) % 6` NUNCA atinge o índice 5 em nenhuma segunda-feira a
 * sexta-feira, deixando o 6º hub (`mercado-trabalho`, o mais recente da
 * lista) estruturalmente fora da rotação pra sempre. Dias corridos desde a
 * época não tem esse problema: como `mdc(7, 6) = 1` (a semana avança 7 dias
 * corridos, o ciclo de rotação tem 6), o índice de toda segunda-feira avança
 * 1 posição a cada semana e completa o ciclo dos 6 hubs em 6 semanas —
 * nenhum hub fica de fora estruturalmente, qualquer que seja `hubCount`.
 *
 * @pure
 */
export function selectHubIndexForRotation(editionDate: string, hubCount: number): number {
  if (!Number.isInteger(hubCount) || hubCount <= 0) {
    throw new Error(`selectHubIndexForRotation: hubCount precisa ser inteiro > 0, veio ${hubCount}`);
  }
  const days = daysSinceEpochFromAammdd(editionDate);
  return ((days % hubCount) + hubCount) % hubCount;
}

/** Insumo de `buildHubDivulgacaoBoxMarkdown` — subconjunto derivado de
 * `HubContent`/`HUB_META` (nada digitado à mão, ver docstring do módulo). */
export interface HubDivulgacaoBoxSource {
  readonly slug: string;
  /** `HUB_META[].label` — mesmo rótulo da nav "Por tema"/do índice `/temas/`. */
  readonly label: string;
  /** `hubCoverageWindow(hub.sourceEditions).since` — "mês de ANO". */
  readonly since: string;
  /** `hub.sourceEditions.length` (== `hubTotals(sources).totalEditions`). */
  readonly totalEditions: number;
}

/** URL do hub com o UTM do box de divulgação (#5263) — `campaign` é o
 * próprio slug (varia por edição, conforme a rotação; ver nota de
 * `HUB_DIVULGACAO_BOX_UTM` em `utm-registry.ts` sobre por que não é um
 * literal fixo). @pure */
export function buildHubDivulgacaoBoxUrl(slug: string): string {
  return `${DIARIA_ARQUIVO_URL}/temas/${slug}?utm_source=${HUB_DIVULGACAO_BOX_UTM.source}&utm_medium=${HUB_DIVULGACAO_BOX_UTM.medium}&utm_campaign=${slug}`;
}

/**
 * Markdown do box — formato bold-line/mid-callout (mesma família estrutural
 * de `clarice-divulgacao.md`/`livros-divulgacao.md`, ver
 * `context/snippets/README.md`): 1 bloco `**...**`, 1 link. Texto segue a
 * frase literal da issue #5263: "A cobertura completa de {tema} desde
 * {mês/ano}: {N} edições, cronologia e fontes → arquivo.diar.ia.br/temas/{slug}".
 * @pure
 */
export function buildHubDivulgacaoBoxMarkdown(source: HubDivulgacaoBoxSource): string {
  const url = buildHubDivulgacaoBoxUrl(source.slug);
  return `**A cobertura completa de ${source.label} desde ${source.since}: ${source.totalEditions} edições, cronologia e fontes → [arquivo.diar.ia.br/temas/${source.slug}](${url})**`;
}
