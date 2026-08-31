/**
 * scripts/lib/branch-issue-consistency.ts (#6804)
 *
 * Responde, de forma DETERMINÍSTICA, a pergunta "o nome desta branch do
 * contínuo corresponde ao que ela de fato contém?" — achado ao limpar 61
 * branches `continuo/` (30/08/2026): branch nomeada pra uma issue carregando
 * commits de OUTRA issue inteiramente. Caso mais grave medido:
 * `continuo/fix-6043-onboarding` (nome referencia a #6043, P0 de mass-send
 * indevido) continha só trabalho do #6005 (carrossel do Instagram) — quem
 * fosse investigar o P0 pelo nome da branch encontrava outra coisa.
 *
 * ## Escopo deliberado (o que isto NÃO tenta resolver)
 *
 * A issue #6804 documentou 4 casos; só 2 são o bug real (nome referencia
 * uma issue e NENHUM commit a menciona — `fix-6043-onboarding` e
 * `fix-6005-benchmarks-instagram`). Os outros 2 (`fix-5894-...`,
 * `fix-5895-...`) são branch que acumulou commits de issues EXTRAS além da
 * que dá nome a ela — problema de "batch não refletido no nome", distinto e
 * mais brando (a issue que dá nome à branch ESTÁ entre os commits, só não é
 * a única). Esse segundo caso já tem mitigação substancial na regra "uma
 * issue por vez" do §4 passo 1 desta skill (#6443) — branches novas não
 * deviam mais acumular várias issues por construção. Este módulo verifica
 * só o caso severo (zero overlap), que é o que o título da #6804 descreve
 * ("carrega nome de uma issue e CONTEÚDO DE OUTRA", não "conteúdo de mais
 * de uma").
 *
 * ## Por que mecânico
 *
 * `watch-continuo-health.sh` item 5 já existe e não cobre isto — só checa
 * PREFIXO de trilha (`continuo/`/`overnight/`/`develop/`), nunca se o
 * número da issue no nome bate com os commits. E é alarme PÓS-fato: medido
 * na auditoria do #6798, produziu 4 issues e 0 correções (dedup falhando —
 * a mesma condição virou #6468/#6470/#6709). A #6804 pede o oposto: checar
 * na hora do commit/PR, não depois.
 *
 * ## Contrato
 *
 * Puro — recebe strings já extraídas (nome da branch, mensagens de commit),
 * não chama `git`/`gh`. O CLI (`scripts/check-branch-issue-consistency.ts`)
 * é quem coleta.
 */

/** Convenção de nome versionada desta skill (#6446): `{trilha}/fix-{N}-slug`
 *  ou `{trilha}/batch-{N}-slug` (1º número após o prefixo de ação). Branch
 *  que não segue esse formato (ex: `continuo/batch-cluster-thing`, sem
 *  número) não tem issue extraível — não é um mismatch, é "não aplicável",
 *  tratado como consistente (nada pra checar, não é o bug desta issue). */
const BRANCH_ISSUE_RE = /^(?:continuo|overnight|develop)\/(?:fix|batch)-(\d+)/;

/** Extrai o número da issue do NOME da branch, ou `null` se a branch não
 *  segue a convenção numerada (não é erro — só não dá pra checar). */
export function extractIssueNumberFromBranch(branchName: string): number | null {
  const m = branchName.match(BRANCH_ISSUE_RE);
  return m ? Number(m[1]) : null;
}

/** Extrai TODOS os números `#N` mencionados no conjunto de mensagens de
 *  commit (título + corpo, uma string por commit ou já concatenadas — não
 *  importa, o regex roda sobre o texto completo). Dedup, ordem de 1ª
 *  ocorrência. */
export function extractIssueNumbersFromCommitMessages(messages: readonly string[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const msg of messages) {
    const matches = msg.matchAll(/#(\d+)/g);
    for (const m of matches) {
      const n = Number(m[1]);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

export interface BranchIssueConsistencyResult {
  /** `true` quando não há bug a reportar: branch não-numerada (nada a
   *  checar), OU a issue do nome aparece em pelo menos 1 commit. DERIVADO
   *  de `commitIssues.includes(branchIssue)` — nunca setar à mão em outro
   *  lugar (review da PR #6848, mesma disciplina de
   *  `SensitiveClassification.sensitive` em `sensitive-path-guard.ts`). */
  readonly consistent: boolean;
  readonly branchIssue: number | null;
  readonly commitIssues: readonly number[];
}

/**
 * Verifica o caso severo: a issue que dá nome à branch (`branchIssue`)
 * aparece em pelo menos UM commit? Branch sem número extraível é sempre
 * `consistent: true` (fora de escopo, não é o bug medido). Não avalia
 * acumulação de issues extras (ver docstring do módulo).
 */
export function checkBranchIssueConsistency(
  branchName: string,
  commitMessages: readonly string[],
): BranchIssueConsistencyResult {
  const branchIssue = extractIssueNumberFromBranch(branchName);
  const commitIssues = extractIssueNumbersFromCommitMessages(commitMessages);
  if (branchIssue === null) {
    return { consistent: true, branchIssue: null, commitIssues };
  }
  return { consistent: commitIssues.includes(branchIssue), branchIssue, commitIssues };
}
