/**
 * glm-lane-gate.ts (#6930)
 *
 * Lógica PURA/testável dos critérios de morte e do teto do piloto
 * `z-ai/glm-5.3-flash` (`docs/lane-glm.md`, normativo — leia lá as
 * condições (a)-(d) antes de mexer aqui). Este módulo só decide, a partir
 * do histórico de unidades já registrado, se o PRÓXIMO despacho pode
 * acontecer — todo I/O (ler `data/glm-lane/units.jsonl`, comparar contra
 * config) fica em `scripts/dispatch-glm-lane-unit.sh`.
 *
 * ## Critérios de morte
 *
 * O critério 1 (teto de 10 unidades) é normativo em `docs/lane-glm.md`
 * § "Teto e reversão". Os critérios 2-4 foram especificados pelo
 * coordenador durante a construção deste harness (#6930/#6941) e AINDA
 * não estão escritos naquela seção — emendar `docs/lane-glm.md` antes do
 * 1º despacho real, não deixar a única fonte de verdade viver só aqui.
 *
 * 1. **Teto de 10 unidades.** Esgotadas, o piloto acaba — continuar exige
 *    decisão nova e escrita (não é este módulo que decide "mais 10").
 * 2. **Zero PRs MERGEADAS nos 3 primeiros despachos.** Sinal medido em
 *    #6922 (10 ticks do primário mais barato → zero claims, zero PRs,
 *    relatório coerente) — o modo de falha do modelo barato em trabalho
 *    autônomo não é "erra", é "para cedo e relata bem". Só avaliável com
 *    >= 3 unidades já despachadas; com menos, `firstThreeHadAnyMergedPr`
 *    é `null` (ainda não dá pra saber) e este critério não decide nada.
 *    **Corrigido no #6954 (achado ao vivo, unidade 2 do piloto):** a
 *    versão original media "abriu PR", não "PR mergeou" — a unidade 2
 *    abriu a #6950, que não podia mergear (3 findings de review, um P1),
 *    e o critério contava isso como sucesso. "Abriu PR" mede atividade;
 *    "PR mergeou" mede entrega. `computeGlmLaneState` recebe
 *    `mergedPrNumbers` (fetch AO VIVO via `gh`, feito no CLI wrapper —
 *    o merge pode acontecer bem depois do despacho que abriu a PR, então
 *    não dá pra gravar isso no momento do registro em `units.jsonl`).
 * 3. **Média de rodadas de review > 2.** Precisa de `avgReviewRounds`
 *    calculado sobre unidades cujo PR já foi revisado ao menos uma vez —
 *    `null` (sem dado ainda) nunca bloqueia.
 * 4. **`$/issue` acima do equivalente no lane Sonnet.** `null` em
 *    QUALQUER um dos dois lados (custo do GLM ainda não medido, ou
 *    baseline do Sonnet não configurada) nunca bloqueia — este critério é
 *    o único que depende de um número que o repo não coleta ainda
 *    (`docs/lane-glm.md` não define uma fonte pronta pra "$/issue do lane
 *    Sonnet"); enquanto `sonnetLaneCostPerIssueUsd` for `null`, o piloto
 *    roda sem essa comparação — decisão explícita de não INVENTAR um
 *    número de referência, ver docstring de `GlmLaneState.
 *    sonnetLaneCostPerIssueUsd` abaixo.
 *
 * Primeira condição que decide vence (mesmo padrão de
 * `continuo-merge-gate.ts`) — teto de unidades checado antes de qualquer
 * critério de morte, porque é o mais barato de avaliar e o mais
 * definitivo.
 */

export interface GlmLaneState {
  /** Quantas unidades já foram despachadas (linhas em `units.jsonl`). */
  unitsDispatched: number;
  /** Teto do piloto — `docs/lane-glm.md` diz 10; parametrizado aqui só
   *  pra não hardcodar um mágico dentro da função pura. */
  unitsCap: number;
  /** `true` = ao menos 1 PR das 3 primeiras unidades está MERGEADA
   *  (`#6954` — não basta ter aberto, precisa ter sido aceita); `false` =
   *  nenhuma das 3 primeiras tem PR mergeada; `null` = ainda não há 3
   *  unidades despachadas, critério não avaliável ainda. */
  firstThreeHadAnyMergedPr: boolean | null;
  /** Média de rodadas de review entre as unidades com PR revisado pelo
   *  menos uma vez. `null` = sem dado (nenhuma unidade revisada ainda). */
  avgReviewRounds: number | null;
  /** `$/issue` medido do lane GLM até agora — média SÓ sobre unidades
   *  que abriram PR (custo de tentativas sem PR nenhum é excluído; ver
   *  `computeGlmLaneState`, que também exclui unidades `status:
   *  "infra-error"`). Pode SUBESTIMAR o custo real por resultado: uma
   *  sequência de tentativas caras sem PR não eleva este número — quem
   *  cobre esse modo de falha complementar é o critério 2
   *  (`firstThreeHadAnyMergedPr`), não este campo. `null` = sem unidade com
   *  custo medido (e com PR) ainda. */
  costPerIssueUsd: number | null;
  /** Baseline de `$/issue` do lane Sonnet, pra comparação. `null` =
   *  baseline não configurada — o repo não tem hoje uma fonte única de
   *  "$/issue do lane Sonnet" (overnight/develop não emitem esse número
   *  agregado); até existir, este critério fica inerte de propósito, não
   *  aproximado por um chute. */
  sonnetLaneCostPerIssueUsd: number | null;
}

export interface GlmLaneGateVerdict {
  allow: boolean;
  reason: string;
}

export function evaluateGlmLaneGate(state: GlmLaneState): GlmLaneGateVerdict {
  if (state.unitsDispatched >= state.unitsCap) {
    return {
      allow: false,
      reason: `teto de ${state.unitsCap} unidades atingido (${state.unitsDispatched} já despachadas) — continuar exige decisão nova e escrita, não este gate`,
    };
  }

  if (state.firstThreeHadAnyMergedPr === false) {
    return {
      allow: false,
      reason: "critério de morte: zero PRs MERGEADAS nos 3 primeiros despachos (mesmo modo de falha medido no #6922 — para cedo e relata bem; #6954 — abrir PR que não mergeia não conta)",
    };
  }

  if (state.avgReviewRounds !== null && state.avgReviewRounds > 2) {
    return {
      allow: false,
      reason: `critério de morte: média de rodadas de review = ${state.avgReviewRounds} (> 2)`,
    };
  }

  if (state.costPerIssueUsd !== null && state.sonnetLaneCostPerIssueUsd !== null) {
    if (state.costPerIssueUsd > state.sonnetLaneCostPerIssueUsd) {
      return {
        allow: false,
        reason: `critério de morte: $/issue do GLM (${state.costPerIssueUsd}) acima do lane Sonnet (${state.sonnetLaneCostPerIssueUsd})`,
      };
    }
  }

  return { allow: true, reason: "nenhum critério de morte disparou, teto não atingido" };
}

/**
 * Um registro de unidade já despachada, lido de `data/glm-lane/units.jsonl`.
 *
 * `status` (#6941, achado de review P0/P1): distingue "o modelo terminou
 * e não abriu PR" (`"completed"`, sinal real sobre o MODELO) de "a
 * invocação nem chegou a terminar direito" (`"infra-error"` — timeout,
 * falha de rede, crash do wrapper). Sem essa distinção, uma falha de
 * infraestrutura contaminava a estatística "zero PRs nos 3 primeiros
 * despachos" (#6922) com um sintoma que não é sobre o modelo nenhum.
 */
export interface GlmLaneUnitRecord {
  issue: number;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  /** `null` = snapshot de crédito falhou (fail-soft, nunca vira "custo
   *  zero" — ver `scripts/glm-lane-credits.ts`). */
  costUsd: number | null;
  /** número da PR aberta por esta unidade, ou `null` se nenhuma. */
  prNumber: number | null;
  /** Rodadas de review que a PR desta unidade recebeu — capturado UMA
   *  VEZ, no momento em que um reconciliador (ainda não construído nesta
   *  PR — fora de escopo) anexaria/computaria esse dado; `units.jsonl` é
   *  append-only, nunca reescrito em cima de uma linha já gravada.
   *  **Sempre `null` no estado atual do repo** — nenhum código escreve
   *  outro valor aqui ainda, então o critério 3 (`avgReviewRounds > 2`)
   *  está INERTE na prática, não só "sem dado por enquanto", mesma
   *  honestidade já aplicada a `sonnetLaneCostPerIssueUsd` acima. Um
   *  reconciliador que leia comentários de review (mesmo padrão de
   *  `extractIndependentReviewVerdict`, #6926) precisa existir antes
   *  deste critério valer de fato. */
  reviewRounds: number | null;
  /** `"completed"` = a invocação do claude-openrouter.sh terminou (rc=0);
   *  `"infra-error"` = ela falhou/deu timeout — a unidade ainda CONTA pro
   *  teto de 10 (consumiu um despacho, possivelmente custou dinheiro),
   *  mas é EXCLUÍDA das estatísticas que julgam o comportamento do
   *  modelo (firstThreeHadAnyMergedPr, avgReviewRounds, costPerIssueUsd) —
   *  ver `computeGlmLaneState`. */
  status: "completed" | "infra-error";
}

/**
 * Deriva `GlmLaneState` a partir dos registros já persistidos — pura,
 * sem tocar `gh`/rede. `sonnetLaneCostPerIssueUsd` é sempre repassado
 * como veio (não calculado aqui: não há fonte no repo, ver docstring do
 * campo em `GlmLaneState`). `mergedPrNumbers` (#6954) também é sempre
 * repassado como veio — o fetch AO VIVO do estado de merge de cada PR
 * roda no CLI wrapper (`check-glm-lane-gate.ts`), nunca aqui: esta função
 * fica pura por construção, e o momento em que uma PR mergeia é
 * necessariamente POSTERIOR ao despacho que a abriu, então não dá pra
 * gravar isso em `units.jsonl` no momento do registro (append-only) —
 * tem que ser reconsultado a cada avaliação do gate.
 */
/**
 * Pura — seleciona as PRIMEIRAS 3 unidades de MODELO (`status !==
 * "infra-error"`) do histórico e devolve só os `prNumber` não-nulos delas.
 * Extraída (#6954 review — achado convergente de type-design-analyzer E
 * pr-test-analyzer) porque `computeGlmLaneState` e o CLI wrapper
 * (`check-glm-lane-gate.ts`, que precisa saber QUAIS PRs consultar no
 * `gh` antes de montar `mergedPrNumbers`) reescreviam essa mesma seleção
 * de forma independente — duas cópias do critério "quais são as 3
 * primeiras" que podiam divergir silenciosamente numa edição futura de
 * só um dos dois lados. Agora é uma única fonte, testável isoladamente,
 * e o CLI wrapper vira consumidor burro dela.
 */
export function selectFirstThreeModelPrNumbers(records: readonly GlmLaneUnitRecord[]): number[] {
  return records
    .filter((r) => r.status !== "infra-error")
    .slice(0, 3)
    .map((r) => r.prNumber)
    .filter((pr): pr is number => pr !== null);
}

export function computeGlmLaneState(
  records: readonly GlmLaneUnitRecord[],
  opts: { unitsCap: number; sonnetLaneCostPerIssueUsd: number | null; mergedPrNumbers: ReadonlySet<number> },
): GlmLaneState {
  // O TETO conta toda unidade despachada, infra-error incluído — ela
  // consumiu um dos 10 slots do piloto de qualquer jeito. Os critérios
  // de morte QUE JULGAM O MODELO (abaixo) olham só pras unidades que de
  // fato completaram, senão uma falha de rede/timeout pareceria "o
  // modelo não produziu nada" (#6941).
  const unitsDispatched = records.length;
  const modelRecords = records.filter((r) => r.status !== "infra-error");

  let firstThreeHadAnyMergedPr: boolean | null = null;
  if (modelRecords.length >= 3) {
    const firstThreePrNumbers = selectFirstThreeModelPrNumbers(records);
    firstThreeHadAnyMergedPr = firstThreePrNumbers.some((pr) => opts.mergedPrNumbers.has(pr));
  }

  const roundsKnown = modelRecords.map((r) => r.reviewRounds).filter((r): r is number => r !== null);
  const avgReviewRounds = roundsKnown.length > 0 ? roundsKnown.reduce((a, b) => a + b, 0) / roundsKnown.length : null;

  // `costPerIssueUsd` é a média SÓ sobre unidades que abriram PR — uma
  // sequência de tentativas caras sem PR nenhum não eleva este número
  // (fica fora da média), então ela por si só NÃO detecta "gastando
  // muito e não produzindo nada"; é o critério 2 (firstThreeHadAnyMergedPr)
  // que cobre esse modo de falha complementar.
  const costsWithPr = modelRecords
    .filter((r) => r.prNumber !== null && r.costUsd !== null)
    .map((r) => r.costUsd as number);
  const costPerIssueUsd =
    costsWithPr.length > 0 ? costsWithPr.reduce((a, b) => a + b, 0) / costsWithPr.length : null;

  return {
    unitsDispatched,
    unitsCap: opts.unitsCap,
    firstThreeHadAnyMergedPr,
    avgReviewRounds,
    costPerIssueUsd,
    sonnetLaneCostPerIssueUsd: opts.sonnetLaneCostPerIssueUsd,
  };
}
