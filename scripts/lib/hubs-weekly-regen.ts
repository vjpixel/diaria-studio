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
 *
 * (d) **Merge SÍNCRONO, nunca `--auto` (#8923, fix 28/09/2026).** Achado do
 * review da PR #8922: o orquestrador adquiria o merge-lock, rodava `gh pr
 * merge --squash --auto` (que só ARMA o auto-merge e retorna na hora — o
 * squash de verdade acontece depois, quando o CI terminar) e soltava o
 * lock no `finally` imediatamente em seguida — o lock não cobria o merge
 * real, só o comando que o agendou. `mergeHubsRegenPr` abaixo é a
 * correção: espera o CI de verdade via polling (`pollTrainCi`, mesma lib
 * do trem de merge vivo — `scripts/lib/merge-train-live.ts`), só faz `gh
 * pr merge --squash` SÍNCRONO (sem `--auto`) depois de um veredito `pass`
 * confirmado, confirma o merge via estado real (`confirmMerged`, #573 —
 * nunca só o exit code do comando) e só libera o lock depois disso, no
 * `finally`. CI `fail`/`timeout` nunca mergeia — devolve `ok:false` sem
 * tocar `gh pr merge`, deixando o PR aberto pro orquestrador alarmar.
 *
 * (e) **Poll ANTES do lock, nunca depois (#8926, fix 28/09/2026).** A
 * versão do item (d) acima adquiria o lock e SÓ DEPOIS chamava
 * `pollTrainCi` (até 30min de espera) — `MERGE_LOCK_TTL_MS` em
 * `session-registry.ts` é 2min, então o lock virava "abandonado" no meio
 * do polling e outra sessão o tomava (o polling em si não segura/renova o
 * lock). `mergeHubsRegenPr` espelha agora a mesma ordem de
 * `mergeSoloPr`/`mergeTrainBatch` (`merge-train-live.ts`): `pollTrainCi`
 * PRIMEIRO, sem lock nenhum detido; só com veredito `"pass"` é que
 * adquire o lock, mergeia (síncrono, sem `--auto`), confirma via
 * `confirmMerged` e libera no `finally` — a janela entre acquire e
 * release fica curta (só o `gh pr merge` + confirmação), nunca os até
 * 30min do polling.
 */

import { pollTrainCi, confirmMerged, type TrainRunner } from "./merge-train-live.ts";
import { calendarDaysBetween, HUB_UPDATED_DATE_CEILING_WARN_DAYS } from "./shared/hub-page.ts";

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
   * presente, é `todayISO` no caso comum (#8906: o novo UPDATED_DATE
   * automático é a data da EXECUÇÃO do job) — **exceto** quando isso
   * estouraria o teto de `checkUpdatedDateCeiling`
   * (`HUB_UPDATED_DATE_CEILING_WARN_DAYS`, #5124): mudança de dados que não
   * vem de uma edição RECENTE (ex: `changed` por recomputar
   * `matchedHeadlines` sobre uma edição antiga, sem fonte nova de verdade)
   * bumpar pra `todayISO` produziria um "dados atualizados em hoje" mentiroso
   * — a página declararia `Last-Modified`/`dateModified` de hoje citando uma
   * fonte de semanas atrás, o EXATO cenário que o #5124 documenta como
   * motivador do teto. Nesse caso, `newUpdatedDate` cai pra `coverageDate`
   * (a data da fonte mais recente do dataset) — sempre gap 0, nunca dispara
   * o warning, e ainda é "dados atualizados em" honesto (#8934, fix do
   * achado ao vivo 28/09/2026: o regen automático quebrou o guard de teto
   * pra `google-gemini` porque `hasDataChange` veio de `changed`, não de
   * `added`, sobre uma edição de 25 dias atrás). **Nunca regride (#8949
   * item 1, fix 28/09/2026):** o resultado final é sempre
   * `max(candidato, currentUpdatedDate)` — sem isso, um `UPDATED_DATE`
   * avançado manualmente por uma revisão de prosa (mais recente que a fonte
   * mais nova do dataset) seria pisado pra trás por um `changed` que caiu no
   * ramo `coverageDate` acima, regredindo `dateModified`/`Last-Modified`
   * publicamente. */
  readonly newUpdatedDate: string | null;
}

/** Decide o plano por hub — pura, sem tocar disco. `todayISO` é injetado
 * (não `new Date()`) pra determinismo em teste. `coverageDate` é a data da
 * fonte mais recente do dataset PÓS-merge (`hubCoverageDate(rows)`,
 * calculado pelo chamador) — usado só pra decidir entre `todayISO` e
 * `coverageDate` quando `hasDataChange`, nunca pra decidir `hasDataChange`
 * em si (isso continua vindo só do diff). `currentUpdatedDate` é o
 * `UPDATED_DATE` hand-written já commitado (#8949 item 1) — o resultado
 * nunca regride abaixo dele. */
export function planHubRegen(
  slug: string,
  diff: HubSourcesDiff,
  todayISO: string,
  coverageDate: string,
  currentUpdatedDate: string,
): HubRegenPlan {
  const hasDataChange = hasHubDataChange(diff);
  if (!hasDataChange) return { slug, hasDataChange, newUpdatedDate: null };
  const gapDays = calendarDaysBetween(coverageDate, todayISO);
  const candidate = gapDays < HUB_UPDATED_DATE_CEILING_WARN_DAYS ? todayISO : coverageDate;
  const newUpdatedDate = candidate > currentUpdatedDate ? candidate : currentUpdatedDate;
  return { slug, hasDataChange, newUpdatedDate };
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

// ─── Merge síncrono do PR de regen (#8923) ──────────────────────────────────

export interface HubsRegenMergeOptions {
  readonly sessionId: string;
  /** Default 30min — mesma convenção de timeout de CI já usada nas skills
   * (`context/overnight-dispatch-rules.md`). */
  readonly ciTimeoutMs?: number;
  /** Default 30s. */
  readonly ciPollIntervalMs?: number;
}

export interface HubsRegenMergeResult {
  readonly ok: boolean;
  readonly merged: boolean;
  readonly ciVerdict?: "pass" | "fail" | "timeout";
  readonly error?: string;
}

const DEFAULT_HUBS_MERGE_CI_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HUBS_MERGE_CI_POLL_INTERVAL_MS = 30_000;

/**
 * Sequência SÍNCRONA de merge pro PR de regen semanal de hubs (#8923,
 * reordenado em #8926): espera o CI de verdade via `pollTrainCi` (polling,
 * timeout embutido) SEM lock nenhum detido -> só com veredito `"pass"`
 * adquire o merge-lock (`--pr`, mesma convenção já usada por este
 * orquestrador desde #8906) -> roda `gh pr merge --squash` SÍNCRONO (nunca
 * `--auto`) -> confirma via estado real (`confirmMerged`, #573 — nunca só
 * o exit code de `gh pr merge`) -> libera o lock SEMPRE no `finally`
 * (sucesso ou erro no merge/confirmação). `runner` é injetável — mesmo
 * `TrainRunner` de `scripts/lib/merge-train-live.ts` — pra permitir teste
 * sem rede/gh real.
 *
 * **Ordem importa (#8926):** `MERGE_LOCK_TTL_MS` em `session-registry.ts`
 * é 2min — segurar o lock durante os até 30min de `pollTrainCi` deixava o
 * lock "abandonado" no meio da espera e outra sessão o tomava. Adquirir só
 * DEPOIS do veredito `pass` mantém a janela acquire->release curta (merge
 * + confirmação), dentro do TTL — mesmo padrão de `mergeSoloPr`/
 * `mergeTrainBatch` em `merge-train-live.ts`, onde `pollTrainCi` também
 * roda ANTES de qualquer acquire.
 *
 * CI `"fail"`/`"timeout"`: NUNCA adquire o lock nem chama `gh pr merge` —
 * devolve `ok:false` com o PR intacto e aberto, pro chamador
 * (`scripts/hubs-weekly-regen.ts`) decidir o alarme via `alarmFailure`.
 *
 * `merge-lock-acquire` negado (outra sessão mergeando agora): mesmo
 * comportamento de `mergeSoloPr` — falha direto, sem retry interno (retry
 * bounded, se algum dia for necessário, é responsabilidade do CHAMADOR,
 * nunca deste helper).
 */
export async function mergeHubsRegenPr(
  runner: TrainRunner,
  prNumber: string,
  opts: HubsRegenMergeOptions,
): Promise<HubsRegenMergeResult> {
  const prNum = Number(prNumber);

  const ciVerdict = await pollTrainCi(runner, prNum, {
    timeoutMs: opts.ciTimeoutMs ?? DEFAULT_HUBS_MERGE_CI_TIMEOUT_MS,
    intervalMs: opts.ciPollIntervalMs ?? DEFAULT_HUBS_MERGE_CI_POLL_INTERVAL_MS,
  });
  if (ciVerdict !== "pass") {
    return {
      ok: false,
      merged: false,
      ciVerdict,
      error: `CI não passou (veredito: ${ciVerdict}) — PR #${prNumber} deixado aberto, sem merge.`,
    };
  }

  const acquire = runner.exec("npx", [
    "tsx",
    "scripts/lib/session-registry.ts",
    "merge-lock-acquire",
    "--pr",
    prNumber,
    "--session-id",
    opts.sessionId,
  ]);
  if (!acquire.ok) {
    return {
      ok: false,
      merged: false,
      ciVerdict,
      error: `merge-lock-acquire falhou: ${acquire.stderr || acquire.stdout}`,
    };
  }
  try {
    const merge = runner.exec("gh", ["pr", "merge", prNumber, "--squash"]);
    const merged = merge.ok || confirmMerged(runner, prNum);
    if (!merged) {
      return {
        ok: false,
        merged: false,
        ciVerdict,
        error: `gh pr merge --squash falhou (confirmado via gh pr view --json state,mergedAt): ${merge.stderr}`,
      };
    }
    return { ok: true, merged: true, ciVerdict };
  } finally {
    runner.exec("npx", [
      "tsx",
      "scripts/lib/session-registry.ts",
      "merge-lock-release",
      "--pr",
      prNumber,
      "--session-id",
      opts.sessionId,
    ]);
  }
}
