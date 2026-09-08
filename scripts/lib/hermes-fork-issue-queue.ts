/**
 * scripts/lib/hermes-fork-issue-queue.ts (#6817 item 7)
 *
 * ## Por que existe
 *
 * O fork `vjpixel/hermes` (checkout `~/hermes-agent`, allowlist item 1) tem
 * tracker próprio — issues abertas que só fazem sentido resolver de dentro
 * dele. `classifyExecTrack` (scripts/lib/issue-exec-track.ts) continua a
 * ÚNICA fonte pras issues DESTE repo (diaria-studio) — não é tocado, nem
 * estendido pra ler o fork. Sem uma regra explícita, o contínuo ou ignora o
 * fork ou duplica esforço; a issue #6817 propõe o mínimo: ler o fork como
 * **segunda** fila, sempre prefixada `vjpixel/hermes#N` em qualquer relatório
 * — o padrão de `#N` cru já significa "issue deste repo" em todo lugar, e
 * misturar as duas numerações silenciosamente é confusão garantida no
 * relatório do Telegram.
 *
 * ## Por que "segunda fila" resolve a ordem sem uma decisão nova do editor
 *
 * A sessão anterior (05/09/2026, ver comentário residual na issue) deixou
 * o item 7 de fora citando "exige decisão de design (ordem de prioridade
 * entre filas) que a issue não especifica". Mas o corpo da issue especifica
 * a ordem no próprio nome da proposta — "**segunda** fila" —, e não pede
 * uma política de intercalação. `shouldConsultForkQueue` codifica
 * literalmente isso: a fila do fork só é consultada quando a fila primária
 * (issues deste repo, via `classifyExecTrack`) não tem mais trabalho
 * elegível no ciclo. Zero decisão nova — só faltava escrever a função.
 *
 * ## Contrato
 *
 * `parseForkIssuesJson`/`formatForkIssueRef`/`shouldConsultForkQueue`/
 * `buildDualQueueReportLines` são PUROS — nunca tocam rede/disco/processo.
 * O CLI (`scripts/list-fork-issues.ts`) é quem chama `gh issue list --repo
 * vjpixel/hermes` e passa o JSON bruto pra `parseForkIssuesJson`.
 */

export const FORK_REPO = "vjpixel/hermes";

export interface ForkIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly url: string;
}

/** Formata a referência que TODO relatório deve usar pra uma issue do fork
 * — nunca `#N` cru, que em todo lugar deste repo significa "issue do
 * diaria-studio". */
export function formatForkIssueRef(number: number): string {
  return `${FORK_REPO}#${number}`;
}

/** Lançado por `parseForkIssuesJson` quando `raw` não é o formato esperado
 * de `gh issue list --json number,title,labels,url` (não-array no topo, ou
 * item sem `number` numérico) — fail loud em vez de silenciosamente
 * devolver uma fila vazia/parcial que o caller leria como "fork sem
 * issues" quando na verdade é "não consegui interpretar a resposta". */
export class InvalidForkIssuesJsonError extends Error {
  constructor(reason: string) {
    super(`resposta de 'gh issue list --repo ${FORK_REPO}' não é o formato esperado: ${reason}`);
    this.name = "InvalidForkIssuesJsonError";
  }
}

/**
 * Parseia o JSON bruto de `gh issue list --repo vjpixel/hermes --state open
 * --json number,title,labels,url` pra `ForkIssueSummary[]`. `labels` do
 * `gh` vem como `Array<{ name: string }>` — normaliza pra `string[]` (nome
 * só); um item cujo `labels` não seja array vira `[]` (nunca lança por
 * causa de um campo secundário ausente/malformado — só `number` ausente ou
 * não-numérico, e "não é array no topo", são erros fatais).
 */
export function parseForkIssuesJson(raw: string): ForkIssueSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new InvalidForkIssuesJsonError(`JSON inválido — ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidForkIssuesJsonError(`esperava um array no topo, recebeu ${typeof parsed}`);
  }
  return parsed.map((item, idx) => {
    if (item === null || typeof item !== "object") {
      throw new InvalidForkIssuesJsonError(`item[${idx}] não é um objeto`);
    }
    const record = item as Record<string, unknown>;
    const number = record.number;
    if (typeof number !== "number" || !Number.isInteger(number)) {
      throw new InvalidForkIssuesJsonError(`item[${idx}].number ausente ou não-inteiro`);
    }
    const title = typeof record.title === "string" ? record.title : "";
    const url = typeof record.url === "string" ? record.url : "";
    const rawLabels = record.labels;
    const labels = Array.isArray(rawLabels)
      ? rawLabels
          .map((l) => (l !== null && typeof l === "object" && typeof (l as Record<string, unknown>).name === "string" ? ((l as Record<string, unknown>).name as string) : typeof l === "string" ? l : undefined))
          .filter((l): l is string => l !== undefined)
      : [];
    return { number, title, labels, url };
  });
}

/**
 * Decide se o ciclo corrente deve consultar a fila do fork — `true` sse a
 * fila primária (issues deste repo) NÃO tem mais trabalho elegível no
 * ciclo. Pura: recebe o veredito já calculado (o caller decide "elegível"
 * pelo mesmo `classifyExecTrack` de sempre), nunca re-deriva nada sobre o
 * repo primário.
 */
export function shouldConsultForkQueue(primaryQueueHasEligibleWork: boolean): boolean {
  return !primaryQueueHasEligibleWork;
}

/**
 * Monta as linhas de relatório pras 2 filas — usado tanto no resumo do
 * ciclo (Telegram) quanto em qualquer log. Toda referência a issue do fork
 * passa por `formatForkIssueRef` (nunca `#N` cru).
 */
export function buildDualQueueReportLines(primaryOpenEligibleCount: number, forkIssues: readonly ForkIssueSummary[]): string[] {
  const lines: string[] = [];
  lines.push(`Fila primária (diaria-studio): ${primaryOpenEligibleCount} issue(s) elegível(is) via classifyExecTrack.`);
  if (forkIssues.length === 0) {
    lines.push(`Fila secundária (${FORK_REPO}): nenhuma issue aberta.`);
  } else {
    lines.push(`Fila secundária (${FORK_REPO}): ${forkIssues.length} issue(s) aberta(s) — consultada só quando a fila primária estiver vazia:`);
    for (const issue of forkIssues) {
      const labelSuffix = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      lines.push(`  - ${formatForkIssueRef(issue.number)}: ${issue.title}${labelSuffix}`);
    }
  }
  return lines;
}
