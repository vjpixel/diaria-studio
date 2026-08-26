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
 * PRs entram em qual lote (nunca 2 colidentes juntos, nunca mais que K) e
 * como bissectar um lote que voltou vermelho. Isso é o que os 2 critérios
 * de aceite testáveis sem infra viva cobrem:
 *   - "Dois PRs colidentes nunca entram no mesmo trem" → composeTrainBatches
 *   - "Lote vermelho... bissecta — nunca deixa PR verde preso indefinidamente"
 *     → bisectBatch (a METADE da bisecção; a execução real — rebase em
 *     cadeia, disparo de CI, merge sob lock — é orquestração viva, fora
 *     deste módulo puro, ver nota de blast-radius abaixo)
 *
 * FORA DESTE ARQUIVO, DE PROPÓSITO (#6300 segue com resíduo depois desta
 * unidade — ver comentário registrado na issue): a execução real —
 * `git rebase`/push de uma branch de integração, disparo e polling de UM
 * run de CI sobre essa branch, merge de cada PR do lote em sequência sob
 * `session-registry.ts merge-lock-acquire`/`release` — muda o comportamento
 * de merge que TODA sessão autônoma (overnight/develop/contínuo) depende
 * agora mesmo. Testar essa parte ao vivo, com sessões concorrentes já
 * mergeando PRs reais nesta mesma janela (medido na própria issue: "rajada
 * de merges com 4 sessões ativas"), é exatamente o cenário de blast-radius
 * cat. D que esta skill (`.claude/skills/diaria-develop/SKILL.md`, Gate B)
 * exige confirmação explícita ANTES de aplicar em escala — não fabricar
 * essa confirmação numa sessão sem o editor revisando o diff-walkthrough
 * ao vivo. A wiring fica para quando isso rodar sob Gate B.
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
