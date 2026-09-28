/**
 * scripts/lib/hubs-weekly-regen.ts (#8906)
 *
 * Lógica PURA do regen semanal automático dos hubs temáticos — separada do
 * orquestrador `scripts/hubs-weekly-regen.ts` (que faz I/O: `data/`,
 * `git`/`gh`, filesystem) pelo mesmo padrão do resto do repo
 * (`hub-drift-check.ts`/`hub-staleness-check.ts`: decisão pura + I/O
 * injetável). Nenhuma função aqui toca disco/rede.
 *
 * **Decisões do editor (#8906, 28/09/2026) que este módulo implementa:**
 *
 * (a) **`UPDATED_DATE` automático = "dados atualizados em", NUNCA "prosa
 * revisada em".** O job semanal NUNCA toca a prosa (`sections`/FAQ escritos
 * à mão) — só bumpa `UPDATED_DATE` quando o dataset de fontes
 * (`{slug}-sources.generated.json`) muda. Pra não perder o sinal de "a
 * prosa pode estar defasada" que o `UPDATED_DATE` hand-written costumava
 * carregar implicitamente, este módulo rastreia separadamente, por hub,
 * quantas edições novas entraram desde a última revisão de prosa
 * (`ProseReviewState`, persistido em `data/hubs/prose-review-state.json`
 * pelo orquestrador) — quando esse contador cruza
 * `HUB_PROSE_REVIEW_THRESHOLD_EDITIONS`, abre 1 issue de revisão de prosa
 * por hub (o orquestrador chama `alarm-issues.ts` com esse achado).
 *
 * **Critério do limiar (documentado aqui por pedido explícito do editor —
 * "documentar o critério na docstring"):** `HUB_PROSE_REVIEW_THRESHOLD_EDITIONS
 * = 5` — volume de edições novas desde a última revisão de prosa acima
 * desse número é o sinal de que o tema provavelmente acumulou desenvolvimento
 * suficiente pra merecer uma seção nova ou uma reescrita, sem alarmar a cada
 * edição aditiva isolada (ruído). É heurística de VOLUME, não de
 * SEMÂNTICA — não tenta decidir se o tema do hub "mudou de verdade"
 * (isso exigiria julgamento holístico/LLM, fora do escopo de um script
 * determinístico rodando desassistido). Reavaliar o número se a cadência de
 * abertura de issues de prosa se mostrar ruidosa demais ou tarde demais na
 * prática.
 *
 * (b) **Publicação: merge + deploy automáticos.** Este módulo não decide
 * merge/deploy (isso é I/O do orquestrador) — só sinaliza,  via
 * `planHubRegen`, se um hub teve mudança de DADOS que justifica commitar
 * (`hasDataChange`). O deploy do Worker `arquivo` em si já é automático
 * desde #4105 (`.github/workflows/deploy-arquivo.yml` dispara em todo push
 * a `master` que toque `workers/arquivo/**`) — o orquestrador só precisa
 * chegar até o merge em `master`; o deploy é responsabilidade do CI, não
 * deste job.
 *
 * (c) **Fact-check: só quando a prosa muda.** Como este módulo NUNCA
 * decide mudar prosa, `planHubRegen` nunca sinaliza necessidade de
 * fact-check — o orquestrador sempre roda `build-hub-page.ts` com
 * `--skip-fact-check` no caminho semanal (o gate `--check-facts` continua
 * existindo e valendo pra qualquer edição de prosa MANUAL).
 */

export interface HubSourcesDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: number;
}

/** Um hub teve mudança de DADOS quando o diff não é totalmente vazio —
 * `removed`/`changed` contam tanto quanto `added` (#8906: uma edição
 * removida do cache, ou um `matchedHeadlines` recalculado, também é
 * "dados mudaram" mesmo sem edição nova). */
export function hasHubDataChange(diff: HubSourcesDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

export interface HubRegenPlan {
  readonly slug: string;
  readonly hasDataChange: boolean;
  /** `null` quando `hasDataChange` é `false` — nada a bumpar. Quando
   * presente, é sempre `todayISO` (#8906: o novo UPDATED_DATE automático é
   * sempre a data da EXECUÇÃO do job, nunca derivado de uma edição
   * individual — `todayISO >= sourceEditions[0].date` por construção, já
   * que a execução roda depois de qualquer edição publicada). */
  readonly newUpdatedDate: string | null;
}

/** Decide o plano por hub — pura, sem tocar disco. `todayISO` é injetado
 * (não `new Date()`) pra determinismo em teste. */
export function planHubRegen(slug: string, diff: HubSourcesDiff, todayISO: string): HubRegenPlan {
  const hasDataChange = hasHubDataChange(diff);
  return { slug, hasDataChange, newUpdatedDate: hasDataChange ? todayISO : null };
}

// ─── Bump de UPDATED_DATE (edição de texto, não de disco) ──────────────────

const UPDATED_DATE_LINE_RE = /^const UPDATED_DATE = "(\d{4}-\d{2}-\d{2})";$/m;

/** Substitui a linha `const UPDATED_DATE = "...";` de `scripts/lib/hubs/{slug}.ts`
 * pelo `newDate` — string in, string out, sem I/O (o orquestrador lê/escreve
 * o arquivo). Lança se o padrão não for encontrado (#8906: falhar alto é
 * melhor que silenciosamente não bumpar nada — mesma disciplina do resto do
 * repo pra guard de conteúdo, #5124). */
export function bumpUpdatedDateLine(fileContent: string, newDate: string): string {
  if (!UPDATED_DATE_LINE_RE.test(fileContent)) {
    throw new Error(
      `bumpUpdatedDateLine: padrão "const UPDATED_DATE = \\"YYYY-MM-DD\\";" não encontrado — ` +
        "arquivo pode ter sido reformatado; ajustar UPDATED_DATE_LINE_RE.",
    );
  }
  return fileContent.replace(UPDATED_DATE_LINE_RE, `const UPDATED_DATE = "${newDate}";`);
}

// ─── Rastreamento de revisão de prosa (#8906 decisão a) ─────────────────────

export const HUB_PROSE_REVIEW_THRESHOLD_EDITIONS = 5;

export interface ProseReviewEntry {
  /** Data (YYYY-MM-DD) da última revisão de prosa conhecida pro hub — na
   * ausência de uma entrada persistida, o orquestrador semeia com o
   * `UPDATED_DATE` hand-written já commitado no momento da adoção deste
   * mecanismo (#8906: dia-0 não alarma retroativamente sobre backlog que
   * já existia antes do job existir). */
  readonly proseReviewedDate: string;
}

export type ProseReviewState = Readonly<Record<string, ProseReviewEntry>>;

export function emptyProseReviewState(): ProseReviewState {
  return {};
}

/** Conta quantas datas de `sourceEditionDates` são estritamente posteriores
 * a `sinceDateExclusive` — puro, comparação lexicográfica (seguro pra
 * YYYY-MM-DD). */
export function countEditionsSince(sourceEditionDates: readonly string[], sinceDateExclusive: string): number {
  return sourceEditionDates.filter((d) => d > sinceDateExclusive).length;
}

export interface ProseAlarmDecision {
  readonly alarm: boolean;
  readonly newEditionsCount: number;
  readonly baselineDate: string;
}

/** Decide se o hub acumulou edições novas o suficiente desde a última
 * revisão de prosa pra justificar abrir uma issue de revisão (#8906
 * decisão a). `fallbackBaselineDate` é o `UPDATED_DATE` hand-written atual
 * do hub — usado só quando não existe entrada em `state` ainda (dia-0). */
export function decideProseAlarm(
  state: ProseReviewState,
  slug: string,
  sourceEditionDates: readonly string[],
  fallbackBaselineDate: string,
): ProseAlarmDecision {
  const baselineDate = state[slug]?.proseReviewedDate ?? fallbackBaselineDate;
  const newEditionsCount = countEditionsSince(sourceEditionDates, baselineDate);
  return { alarm: newEditionsCount >= HUB_PROSE_REVIEW_THRESHOLD_EDITIONS, baselineDate, newEditionsCount };
}

/** Garante uma entrada em `state` pro hub — não sobrescreve uma entrada já
 * existente (dia-0 apenas). Pura. */
export function ensureProseReviewBaseline(
  state: ProseReviewState,
  slug: string,
  fallbackBaselineDate: string,
): ProseReviewState {
  if (state[slug]) return state;
  return { ...state, [slug]: { proseReviewedDate: fallbackBaselineDate } };
}
