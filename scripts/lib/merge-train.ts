/**
 * merge-train.ts (#6300)
 *
 * Miolo PURO da proposta "trem de merge": em vez de "1 PR verde → 1 run de
 * CI completo → 1 squash-merge" repetido em série por issue, agrupar K PRs
 * que já passaram no Gate 2 (CI verde no próprio PR + threads resolvidas) e
 * que NÃO colidem em arquivo entre si, validar a combinação com **1** run de
 * CI, e mergear os K em sequência sob o mesmo merge lock. Decidido pelo
 * editor (comentário `decisao-editor` da issue, 26/08/2026): trem PRÓPRIO
 * dentro das skills — não o merge queue nativo do GitHub (exigiria
 * proteção de branch com required checks, o que travaria PRs docs-only sob
 * `paths-ignore` de `ci.yml`).
 *
 * ESCOPO DESTE ARQUIVO: só a lógica DECIDÍVEL sem tocar `git`/`gh` — quais
 * PRs entram em qual lote (nunca 2 colidentes juntos, nunca mais que K),
 * como bissectar um lote que voltou vermelho, e a formatação PURA de
 * título/corpo do PR-trem e do commit squash (texto, sem I/O). A
 * ORQUESTRAÇÃO viva (merge em cadeia num worktree isolado, `gh pr create`, polling de CI, merge sob
 * lock) mora em `scripts/lib/merge-train-live.ts` — separado de propósito,
 * pra manter este arquivo 100% testável sem `git`/`gh`/rede.
 *
 * **Execução viva AUTORIZADA (2ª decisão do editor, comentário
 * `decisao-editor` de 26/08/2026, mesmo dia — responde às 4 perguntas que
 * o parágrafo anterior desta issue deixou em aberto):** rollout nas três
 * skills de uma vez (overnight/develop/contínuo); default ATIVO sem flag
 * de opt-in (degrada sozinho pro caminho de hoje se algo falhar — mesma
 * garantia que a bissecção já dá); 1 commit squash por lote com
 * `Closes #N1, #N2, #N3` (mesma convenção da fusão de cluster colidente no
 * develop, #4319 — revert é tudo-ou-nada pro lote); testar ao vivo contra
 * PRs reais é autorizado, com cautela (lote pequeno, abortar pro
 * 1-a-1 se colidir com outra sessão). Ver `scripts/lib/merge-train-live.ts`
 * e `scripts/run-merge-train.ts` (CLI executável) pra implementação.
 */

export interface TrainCandidate {
  /** Número do PR — só usado como identidade/ordem, nunca interpretado. Único dentro de um mesmo `candidates[]` (ver guard em `composeTrainBatches`). */
  pr: number;
  /**
   * Arquivos tocados pelo PR (ex: `gh pr diff {N} --name-only`). Path
   * relativo ao repo, mesma normalização em todos os candidatos — o
   * critério de colisão é igualdade de string, não overlap de diretório.
   * `readonly` (achado do fleet review, PR #6361): impede mutação
   * pós-construção que invalidaria silenciosamente um lote já composto.
   */
  readonly files: readonly string[];
}

export interface TrainBatch {
  /**
   * Números dos PRs deste lote, na MESMA ordem de entrada em `candidates`.
   * `readonly` pelo mesmo motivo de `TrainCandidate.files` acima.
   */
  readonly prs: readonly number[];
}

/** Verdadeiro se os dois conjuntos de arquivos têm pelo menos 1 elemento em comum. */
export function filesCollide(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  return a.some((f) => setB.has(f));
}

/**
 * Composição de lotes não-colidentes (critério de aceite: "dois PRs
 * colidentes nunca entram no mesmo trem").
 *
 * Estratégia: first-fit greedy, respeitando a ORDEM de `candidates` — o
 * chamador decide essa ordem (tipicamente ordem de Gate 2 verde, #6300
 * propõe "acumular K PRs que passaram no Gate 2"). Para cada candidato,
 * tenta o primeiro lote aberto (nesta chamada) que (a) ainda não atingiu
 * `maxBatchSize` e (b) não colide em arquivo com NENHUM PR já no lote; sem
 * lote assim, abre um lote novo. Determinístico dado a mesma entrada — sem
 * aleatoriedade, sem heurística de otimalidade (não é bin-packing ótimo;
 * é o suficiente pro objetivo real: nunca juntar colidentes, nunca estourar
 * K, entrada processada uma vez).
 *
 * `maxBatchSize` deve ser ≥ 1. A issue recomenda K=3 pra começar
 * ("K não deve ser grande") — não hardcoded aqui, decisão de quem chama.
 */
export function composeTrainBatches(
  candidates: readonly TrainCandidate[],
  maxBatchSize: number,
): TrainBatch[] {
  // Defesa em profundidade (achado do fleet review, PR #6361): `maxBatchSize
  // < 1` sozinho NÃO pega `NaN` — `NaN < 1` é `false` em JS, e um `NaN`
  // passando batia `batch.prs.length >= NaN` (sempre `false`) e desligava o
  // teto inteiro em silêncio, sem lançar. `!Number.isInteger` cobre `NaN`,
  // `Infinity` e frações (K=2.5 não faz sentido, é contagem de PR). Esta é
  // a função PURA — a CLI (`plan-merge-train.ts`) já valida antes de
  // chegar aqui via `getIntArg`, mas quem chamar esta função direto (sem
  // passar pela CLI) precisa da mesma garantia.
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new Error(`composeTrainBatches: maxBatchSize precisa ser um inteiro >= 1, recebeu ${maxBatchSize}`);
  }

  // Achado do fleet review (PR #6361): `pr` duplicado em `candidates` (ex:
  // input malformado de quem chama) não colide por ARQUIVO consigo mesmo
  // na estratégia atual sempre — dependendo de quando o 1º lote já
  // atingiu o teto, o 2º candidato com o MESMO `pr` podia acabar num lote
  // DIFERENTE, e o plano resultante listava o mesmo PR pertencendo a 2
  // lotes simultaneamente. Falha alto em vez de deixar essa contradição
  // passar pro chamador.
  const seenPrs = new Set<number>();
  for (const c of candidates) {
    if (seenPrs.has(c.pr)) {
      throw new Error(`composeTrainBatches: PR #${c.pr} aparece mais de uma vez em candidates`);
    }
    seenPrs.add(c.pr);
  }

  const batches: { prs: number[]; filesUnion: Set<string> }[] = [];

  for (const candidate of candidates) {
    let placed = false;
    for (const batch of batches) {
      if (batch.prs.length >= maxBatchSize) continue;
      if (filesCollide(candidate.files, [...batch.filesUnion])) continue;
      batch.prs.push(candidate.pr);
      for (const f of candidate.files) batch.filesUnion.add(f);
      placed = true;
      break;
    }
    if (!placed) {
      batches.push({ prs: [candidate.pr], filesUnion: new Set(candidate.files) });
    }
  }

  return batches.map((b) => ({ prs: b.prs }));
}

/**
 * Bissecção de um lote que voltou vermelho no run único de CI (critério de
 * aceite: "lote vermelho degrada para o caminho atual (1 a 1) ou bissecta —
 * nunca deixa PR verde preso indefinidamente"). Divide ao meio; cada metade
 * é revalidada com seu PRÓPRIO run de CI antes de mergear ou bissectar de
 * novo — a orquestração viva desse loop fica fora deste módulo (ver
 * cabeçalho do arquivo).
 *
 * Lote de tamanho 1 não bisecciona — já é o caminho de hoje (1 PR, 1 CI, 1
 * merge), o piso da recursão. Lançar em vez de devolver um par degenerado:
 * quem chama precisa checar `batch.prs.length > 1` antes de bissectar, e um
 * throw aqui torna esse erro de uso barato de achar em teste, em vez de
 * devolver `[{prs:[x]}, {prs:[]}]` silenciosamente (lote vazio nunca deveria
 * existir na árvore de bissecção).
 */
export function bisectBatch(batch: TrainBatch): [TrainBatch, TrainBatch] {
  if (batch.prs.length <= 1) {
    throw new Error(
      `bisectBatch: lote de tamanho ${batch.prs.length} não bisecciona — já é o piso da recursão (1 PR = caminho de hoje)`,
    );
  }
  const mid = Math.ceil(batch.prs.length / 2);
  return [{ prs: batch.prs.slice(0, mid) }, { prs: batch.prs.slice(mid) }];
}

/**
 * Pior caso de runs de CI pra validar um lote de tamanho N até o nível de
 * folha (todos os sub-lotes reduzidos a tamanho 1), assumindo que TODO
 * lote intermediário vem vermelho (pior caso absoluto — a issue nomeia
 * isso: "o pior caso de um lote de K é K + log K runs, pior que os K de
 * hoje"). Função pura de apoio à decisão de K — não usada em runtime, só
 * pra quem for calibrar K comparar contra a medição real de "taxa de
 * CI-verde-de-primeira" já registrada na issue (83,3% no corte overnight).
 */
export function worstCaseCiRuns(batchSize: number): number {
  if (batchSize <= 1) return 1;
  // 1 run pro lote inteiro (vermelho, senão não bissectaria) + o pior caso
  // recursivo das duas metades.
  const mid = Math.ceil(batchSize / 2);
  return 1 + worstCaseCiRuns(mid) + worstCaseCiRuns(batchSize - mid);
}

/** Uma unidade (PR) já com os metadados que a orquestração viva precisa —
 * ver `fetchTrainPrInfo` em `merge-train-live.ts` pro producer real (via
 * `gh pr view`). Tipo aqui porque as funções de formatação abaixo são
 * puras e não devem importar nada de `merge-train-live.ts` (que faz I/O). */
export interface TrainPrInfo {
  readonly pr: number;
  readonly headRefName: string;
  readonly title: string;
  /** Issues que este PR fecha, extraídas do corpo (ver `parseClosesIssues`). */
  readonly issueNumbers: readonly number[];
}

/**
 * Extrai números de issue de palavras-chave de fechamento do GitHub
 * (`close`/`closes`/`closed`/`fix`/`fixes`/`fixed`/`resolve`/`resolves`/
 * `resolved` + `#N`, case-insensitive — mesmo vocabulário que o GitHub
 * reconhece pra auto-close). Usado tanto pra ler o que cada PR do lote já
 * fecha (`fetchTrainPrInfo`) quanto, indiretamente, pra montar o commit
 * squash do trem (`buildTrainMergeCommitBody` abaixo — que NÃO reusa esta
 * função, e sim recebe os números já resolvidos por PR, porque cada PR
 * pode fechar >1 issue e a lista final é a UNIÃO ordenada de todas).
 */
export function parseClosesIssues(body: string): number[] {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const found = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** Título do PR-trem descartável (achado pelo `gh pr diff --name-only` de
 * cada PR do lote, aberto só pra disparar o run único de CI sobre a
 * combinação — nunca é o merge final, ver `mergeTrainBatch` em
 * `merge-train-live.ts`). */
export function buildTrainPrTitle(batch: TrainBatch): string {
  return `[trem] lote de ${batch.prs.length}: ${batch.prs.map((n) => `#${n}`).join(", ")}`;
}

/** Corpo do PR-trem — nunca contém `Closes`/`Fixes` (não é ele quem fecha
 * as issues; o commit squash final é, ver `buildTrainMergeCommitBody`) —
 * só `Refs`, pra não fechar nada antes da hora se alguém mergeasse este
 * PR descartável por engano. */
export function buildTrainPrBody(batch: TrainBatch, prInfos: readonly TrainPrInfo[]): string {
  const byNumber = new Map(prInfos.map((p) => [p.pr, p]));
  const lines = batch.prs.map((n) => {
    const info = byNumber.get(n);
    const issues = info?.issueNumbers.length ? ` (${info.issueNumbers.map((i) => `#${i}`).join(", ")})` : "";
    return `- #${n}${info ? `: ${info.title}` : ""}${issues}`;
  });
  return (
    `PR-trem descartável (#6300) — valida a COMBINAÇÃO destes ${batch.prs.length} PRs com 1 run de CI só.\n\n` +
    `${lines.join("\n")}\n\n` +
    `Refs ${batch.prs.map((n) => `#${n}`).join(", ")} — NÃO CLOSES (fechamento acontece no squash-merge deste PR-trem, não aqui).\n\n` +
    `Nunca mergear este PR isoladamente por engano — ele É o merge, mas o commit squash usa uma mensagem própria com \`Closes\` pras issues.`
  );
}

/** Título do commit squash final — o merge de verdade (`mergeTrainBatch`
 * em `merge-train-live.ts` usa isto como `--subject` do `gh pr merge
 * --squash`). */
export function buildTrainMergeCommitTitle(batch: TrainBatch): string {
  return `trem(#6300): lote de ${batch.prs.length} unidades — ${batch.prs.map((n) => `#${n}`).join(", ")}`;
}

/**
 * Corpo do commit squash final — a UNIÃO ordenada de `issueNumbers` de
 * TODOS os PRs do lote, uma linha `Closes #A, #B, #C` (decisão do editor,
 * 26/08/2026: 1 commit squash só por lote, mesma convenção de fusão de
 * cluster colidente do develop, #4319 — revert é tudo-ou-nada pro lote
 * inteiro). PR sem nenhuma issue detectada (`issueNumbers` vazio) não
 * quebra nada — só não contribui número nenhum pra linha `Closes`.
 */
export function buildTrainMergeCommitBody(batch: TrainBatch, prInfos: readonly TrainPrInfo[]): string {
  const byNumber = new Map(prInfos.map((p) => [p.pr, p]));
  const allIssues = new Set<number>();
  for (const n of batch.prs) {
    for (const i of byNumber.get(n)?.issueNumbers ?? []) allIssues.add(i);
  }
  const closesLine = allIssues.size > 0 ? `Closes ${[...allIssues].sort((a, b) => a - b).map((i) => `#${i}`).join(", ")}` : "";
  const prList = batch.prs.map((n) => `#${n}`).join(", ");
  return [
    `Trem de merge (#6300) — ${batch.prs.length} PRs validados juntos com 1 run de CI: ${prList}.`,
    "",
    closesLine,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Resumo de runs de CI de fato disparados pelo mecanismo do trem, contra o
 * que teria sido consumido no caminho de hoje (1 PR = 1 CI) — o "antes/
 * depois" que fecha o último critério de aceite da issue #6300 ("medição
 * antes/depois: runs de CI por issue mergeada").
 *
 * Deriva o número inteiramente do array `outcomes` que `runMergeTrain` já
 * devolve (`scripts/lib/merge-train-live.ts`) — sem precisar reconstruir
 * histórico via `gh api actions/runs` (branch de integração é descartada
 * ao final de cada lote, então não haveria como reconsultar depois). A
 * leitura mecânica do laço em `runMergeTrain`:
 *
 * - `batch.prs.length === 1` → `mergeSoloPr`: o PR já estava verde ANTES de
 *   entrar no trem (Gate 2) — merge direto, ZERO run de CI novo disparado
 *   por este mecanismo. Não entra no "antes/depois" (não foi afetado).
 * - `batch.prs.length >= 2` → exatamente 1 `pollTrainCi` por outcome,
 *   disparando exatamente 1 run de CI real sobre o PR-trem descartável —
 *   verdadeiro tanto pro terminal `"merged"` quanto pro `"abandoned"`
 *   (vermelho, vai bissectar: o run aconteceu, só não passou) e pro
 *   `"lock-blocked"` (passou no CI, não conseguiu a janela de merge — o
 *   run de CI já foi consumido de qualquer forma). Cada bissecção gera
 *   NOVAS entradas na fila, cada uma contribuindo seu próprio run — por
 *   isso `ciRunsUsed` soma TODAS as entradas ≥2, não só as que terminam
 *   `"merged"` (o pior caso documentado em `worstCaseCiRuns` acima: um
 *   lote vermelho custa mais runs que o caminho de hoje, não menos).
 *
 * `prsInvolvedInBatches`/`issuesInvolvedInBatches` são a UNIÃO distinta de
 * PRs/issues que passaram por pelo menos 1 lote ≥2 em algum ponto da
 * árvore de bissecção — nunca soma duplicada entre a entrada abandonada e
 * as sub-entradas que a bissecção gera pro mesmo PR. É o denominador do
 * "sem o trem": no caminho de hoje, cada um desses PRs teria contribuído
 * exatamente 1 run próprio (o que já usou pra chegar em Gate 2 verde) —
 * `prsInvolvedInBatches` é literalmente esse número de runs "antes".
 */
export interface TrainCiRunsSummary {
  /** PRs distintos que passaram por ≥1 lote de tamanho ≥2 — o "antes" (1 run de CI cada, caminho de hoje). */
  readonly prsInvolvedInBatches: number;
  /** Issues distintas fechadas por esses PRs (via `TrainPrInfo.issueNumbers`) — denominador de "runs de CI por issue". */
  readonly issuesInvolvedInBatches: number;
  /** Runs de CI reais disparados pelo mecanismo do trem — o "depois" (1 por outcome com `batch.prs.length >= 2`, INCLUINDO bissecção). */
  readonly ciRunsUsed: number;
  /** PRs que nunca entraram em lote (`batch.prs.length === 1`) — não afetados pelo trem, só contexto. */
  readonly soloPrs: number;
}

/** Forma mínima de `TrainBatchOutcome` que esta função precisa — evitar
 * importar `merge-train-live.ts` aqui (que faz I/O) só pelo tipo. */
export interface TrainCiRunsOutcomeLike {
  readonly batch: { readonly prs: readonly number[] };
}

export function summarizeTrainCiRuns(
  outcomes: readonly TrainCiRunsOutcomeLike[],
  prInfos: readonly TrainPrInfo[],
): TrainCiRunsSummary {
  const byPr = new Map(prInfos.map((p) => [p.pr, p]));
  const involvedPrs = new Set<number>();
  const involvedIssues = new Set<number>();
  let ciRunsUsed = 0;
  let soloPrs = 0;

  for (const o of outcomes) {
    if (o.batch.prs.length >= 2) {
      ciRunsUsed++;
      for (const pr of o.batch.prs) {
        involvedPrs.add(pr);
        for (const issue of byPr.get(pr)?.issueNumbers ?? []) involvedIssues.add(issue);
      }
    } else if (o.batch.prs.length === 1) {
      soloPrs++;
    }
  }

  return {
    prsInvolvedInBatches: involvedPrs.size,
    issuesInvolvedInBatches: involvedIssues.size,
    ciRunsUsed,
    soloPrs,
  };
}
