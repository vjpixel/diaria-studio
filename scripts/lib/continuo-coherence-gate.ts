/**
 * scripts/lib/continuo-coherence-gate.ts (#6752)
 *
 * Responde, de forma DETERMINÍSTICA, a pergunta que a auditoria do #6752
 * mediu: "esta issue é do tipo onde o contínuo (modelo grátis, sem memória
 * entre PRs) costuma falhar?" — mudança de BAIXA coerência (fix pontual,
 * causa óbvia, 1 arquivo isolado) passa; mudança de ALTA coerência (depende
 * de contexto de outra PR, cria/mexe em abstração compartilhada, é fatia de
 * um épico) é barrada ANTES do claim, nunca depois de implementar.
 *
 * ## Por que existe (a medição, não a tese)
 *
 * Auditoria de 29/08/2026 (#6752): 12 PRs `continuo/` linha a linha contra
 * 12 PRs `overnight/`+`develop/` da MESMA janela. O diff isolado não é o
 * problema — nota média de correção/teste/convenções fica só ~0,5 abaixo do
 * grupo de controle. O que falha é COERÊNCIA ENTRE PRs: retrabalho 2,4×
 * maior (23,3% vs 9,8%), e o caso canônico (#6699) é literal —
 *
 *   PR #6679 criou `scripts/lib/shared/brevo-diaria-origin.ts`
 *   (`parseOrigin`/`buildOrigin`) EXATAMENTE pra acabar com prefixos `kit:`
 *   inline. PR #6680, dois commits depois, MESMA sessão, escreveu
 *   `c.beehiiv_subscription_id.startsWith("kit:")` hardcoded em
 *   `scripts/lib/brevo-diaria-store.ts` — a abstração foi criada e
 *   imediatamente contornada pelo próprio autor. Resultado: 3 definições
 *   independentes do mesmo prefixo, `parseOrigin` sem nenhum consumidor em
 *   produção, comentário afirmando um guard de compile-time que não existe.
 *
 * Padrão repetido nos outros achados do mesmo `daily-review` (#6694, #6696,
 * #6700): dois commits do MESMO range tocando o mesmo módulo/config com
 * objetivos que se pisam, sem o segundo saber do primeiro.
 *
 * ## Decisão do editor sobre ONDE isto vive (#6752, comentário 30/08/2026)
 *
 * Opção (2) explícita — checagem no passo de seleção de fila da skill
 * `hermes-diaria-continuo` (SKILL.md §4, antes do claim), NÃO um eixo novo
 * em `classifyExecTrack`, NÃO uma label dedicada. `classifyExecTrack`
 * responde "que SESSÃO pega esta issue" (overnight/develop/etc, #5462);
 * "coerência entre mudanças de um lote" é outra pergunta — sobre AGRUPAR
 * dentro da fila do contínuo, não sobre rotear entre sessões. Rejeitar aqui
 * não persiste NADA na issue (sem label, sem comentário `route-issue`) — a
 * issue simplesmente não é reivindicada NESTE tick, continua `track=overnight`
 * normal, elegível pro overnight/develop pegarem do jeito de sempre.
 *
 * ## Por que é mecânico e não julgamento de LLM
 *
 * O pedido explícito era "critério MECÂNICO, não prosa que envelhece em
 * silêncio" — mesma lição do `claude-openrouter.sh` (paráfrase de regra
 * divergiu do código real). Isto não é um classificador perfeito: os 4
 * critérios da issue original (abstração compartilhada / refactor-dedup /
 * dependência de outra PR / fatia de épico) não são 100% decidíveis SÓ pelo
 * texto da issue ANTES de implementar — o diff final ainda não existe.
 * Onde a proposta original pede julgamento ("a implementação vai exigir ler
 * outra PR?"), este módulo usa dois proxies mecânicos e VERIFICÁVEIS:
 *
 *   1. **Overlap de arquivo**: a issue MENCIONA (regex sobre paths no
 *      corpo) um arquivo que também aparece tocado por uma PR aberta AGORA
 *      ou por um merge recente em master (janela configurável) — mas só
 *      quando o arquivo é tocado POUCAS vezes (< `HOT_FILE_TOUCH_THRESHOLD`
 *      abaixo). Isto é exatamente o padrão medido em #6699/#6694/#6696/#6700
 *      — dois commits no mesmo arquivo/módulo perto um do outro no tempo,
 *      não um playbook em iteração ativa tocado o tempo todo (achado da
 *      review da PR #6848: sem o filtro de "hotness", `SKILL.md`/
 *      `claude-openrouter.sh` — tocados 4-6× em 48h em rodadas ativas —
 *      disparavam pra qualquer issue que só os MENCIONASSE, mesmo issues já
 *      resolvidas e sem relação nenhuma com o padrão real).
 *   2. **Sinal textual explícito**: palavras-chave PT-BR de baixa
 *      ambiguidade (refactor/refatoração, "abstração compartilhada"/"módulo
 *      canônico"/path `scripts/lib/shared/`, "fatia N de M"/"parte N/M" de
 *      épico, "depende de #N"/"após #N"/"bloqueado por #N"/"baseado em
 *      #N"). "Consolidar"/"unificar"/"duplicação" FORAM removidas da lista
 *      (review da PR #6848, P2 confiança alta, demonstrado ao vivo) — são
 *      vocabulário comum do próprio domínio deste repo (dedup de URL,
 *      "duplicação de linha no CSV") e disparavam em bugs pontuais comuns,
 *      sem relação com o padrão medido.
 *
 * Falso negativo é possível (issue de alta coerência sem nenhum desses
 * sinais no texto) — inerente a decidir ANTES do diff existir, não um
 * defeito deste desenho especificamente. Falso positivo (barrar issue boa)
 * custa pouco: ela só espera o overnight/develop, não é perdida. A
 * assimetria de custo (2,4× retrabalho + 3 quebras de master medidas)
 * justifica errar pro lado de barrar mais.
 *
 * ## Contrato
 *
 * `evaluateContinuoCoherence` é PURO — recebe o texto da issue e as listas
 * de paths já coletadas, não consulta `git`/`gh`. O CLI
 * (`scripts/check-continuo-coherence.ts`) é quem busca esses dados.
 */

/** Um path "parece" um arquivo do repo: tem extensão de código/config
 *  conhecida e não é só uma palavra solta. Restrito de propósito — melhor
 *  perder um path mencionado de forma incomum do que casar texto comum. */
const PATH_RE = /\b[\w][\w./-]*\.(ts|tsx|js|mjs|cjs|md|mdx|json|toml|yml|yaml|sh|ps1)\b/g;

/** Extrai paths mencionados no texto (título + corpo da issue). Puro,
 *  determinístico, sem acesso a filesystem — não confirma que o path
 *  existe de fato, só que foi citado no formato de um. */
export function extractMentionedPaths(text: string): string[] {
  const matches = text.match(PATH_RE) ?? [];
  // normaliza: remove ./  inicial, dedup preservando ordem de 1ª ocorrência
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const p = raw.replace(/^\.\//, "");
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Diretórios/prefixos onde uma mudança é, por construção, abstração
 *  compartilhada (consumida por 2+ call sites por convenção do repo — ver
 *  `scripts/lib/README`/CLAUDE.md "Estrutura"). Mantida CURTA e alinhada ao
 *  caso medido — `scripts/lib/shared/` é literalmente onde o #6679 criou o
 *  módulo que o #6680 contornou. */
const SHARED_PATH_PREFIXES = ["scripts/lib/shared/"];

/** Review da PR #6848 (code-reviewer, P2, confiança alta, demonstrado ao
 *  vivo): a versão original incluía "consolidar"/"unificar"/"duplicação"
 *  como gatilho — palavras comuns no vocabulário do PRÓPRIO domínio deste
 *  repo (dedup de URL, "duplicação de linha no CSV", "unificar formato de
 *  data") que disparavam em issues de bug pontual comuns, sem nenhuma
 *  relação com o padrão medido (abstração criada e contornada). Restrito a
 *  "refactor"/"refatoração" — inequívoco, nenhum caso de bug pontual usa
 *  essa palavra pra outra coisa. */
const REFACTOR_RE = /\brefactor|refatora[çc][ãa]o/i;
const SHARED_ABSTRACTION_TEXT_RE = /abstra[çc][ãa]o compartilhada|m[óo]dulo can[ôo]nico|tipo canônico/i;
const EPIC_SLICE_RE = /\b(fatia|parte|slice)\s+\d+\s*(de|\/)\s*\d+|depende d[ae] (fatia|parte) anterior/i;
/** Review da PR #6848 (comment-analyzer, P3): a docstring do módulo
 *  prometia "após #N" bare, mas o regex original exigia "mergear"/"o merge
 *  de/do" entre "após" e o número — "só fazer isso após #500 mergear"
 *  passava batido. Ajustado pra aceitar a forma bare também (erra pro lado
 *  de barrar mais, consistente com o resto do desenho). */
const CROSS_PR_DEP_RE =
  /\bdepende(\s+d[eo])?\s+#\d+|\bap[óo]s\s+(o\s+merge\s+d[eo]\s+|mergear\s+)?#\d+|\bbloqueado\s+por\s+#\d+|\bbaseado\s+(n[oa]|em)\s+#\d+/i;

/** Review da PR #6848 (code-reviewer, P2, demonstrado ao vivo contra a
 *  issue #6820 já mergeada): um arquivo tocado MUITAS vezes na janela
 *  recente (ex: `hermes/skills/hermes-diaria-continuo/SKILL.md`,
 *  `hermes/scripts/claude-openrouter.sh` — playbooks em iteração ativa,
 *  6+ toques em 48h) não é sinal útil de "duas PRs pisando uma na outra"
 *  — é só um arquivo popular. O padrão real medido (#6699) é o OPOSTO:
 *  um arquivo tocado 1-2 vezes, criado numa PR e contornado na seguinte.
 *  Path tocado `>= HOT_FILE_TOUCH_THRESHOLD` vezes na janela é excluído do
 *  gatilho de overlap (mas ainda conta pro sinal de `scripts/lib/shared/`,
 *  que é independente). */
const HOT_FILE_TOUCH_THRESHOLD = 3;

export interface CoherenceGateInput {
  readonly issueTitle: string;
  readonly issueBody: string;
  /** Paths tocados por qualquer PR aberta agora (todas as branches). */
  readonly activeFiles: readonly string[];
  /** Paths tocados por commits recentes em master (janela do CLI) — RAW,
   *  com repetição (1 entrada por commit que toca o path), não
   *  deduplicado: é a frequência que alimenta o filtro de
   *  `HOT_FILE_TOUCH_THRESHOLD` acima (dedup aqui destruiria o sinal). */
  readonly recentMasterFiles: readonly string[];
}

export interface CoherenceGateResult {
  /** `true` = baixa coerência medida, contínuo pode reivindicar. `false` =
   *  sinal de alta coerência, NÃO reivindicar neste tick. DERIVADO de
   *  `reasons.length === 0` — nunca setar este campo à mão em outro lugar
   *  (mesma disciplina de `SensitiveClassification.sensitive` em
   *  `sensitive-path-guard.ts`). */
  readonly admit: boolean;
  /** Vazio quando `admit: true`. Cada string é um motivo independente —
   *  pode haver mais de um sinal disparando ao mesmo tempo. */
  readonly reasons: readonly string[];
  /** Paths mencionados na issue que colidem com trabalho ativo/recente —
   *  só populado quando esse motivo dispara, útil pro relatório do tick. */
  readonly overlappingPaths: readonly string[];
}

/**
 * Avalia os sinais mecânicos. Puro — nenhuma chamada externa.
 */
export function evaluateContinuoCoherence(input: CoherenceGateInput): CoherenceGateResult {
  const text = `${input.issueTitle}\n${input.issueBody}`;
  const reasons: string[] = [];

  const mentionedPaths = extractMentionedPaths(text);
  const activeSet = new Set(input.activeFiles);
  const recentCounts = new Map<string, number>();
  for (const p of input.recentMasterFiles) recentCounts.set(p, (recentCounts.get(p) ?? 0) + 1);

  const overlappingPaths = mentionedPaths.filter((p) => {
    if (activeSet.has(p)) return true;
    const recentTouches = recentCounts.get(p) ?? 0;
    return recentTouches > 0 && recentTouches < HOT_FILE_TOUCH_THRESHOLD;
  });
  if (overlappingPaths.length > 0) {
    reasons.push(
      `issue menciona path(s) que também aparecem em PR aberta ou merge recente de master: ${overlappingPaths.join(", ")} — mesmo padrão medido no #6699 (dois commits no mesmo módulo, sem coordenação)`,
    );
  }

  const sharedPathMentioned = mentionedPaths.some((p) => SHARED_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)));
  if (sharedPathMentioned || SHARED_ABSTRACTION_TEXT_RE.test(text)) {
    reasons.push("issue menciona módulo/path de abstração compartilhada (scripts/lib/shared/ ou texto explícito de módulo canônico)");
  }

  if (REFACTOR_RE.test(text)) {
    reasons.push("issue é refactor/consolidação/unificação de duplicação — classe onde a auditoria mediu falta de memória entre PRs");
  }

  if (EPIC_SLICE_RE.test(text)) {
    reasons.push("issue se descreve como fatia/parte de um épico (dependência N+1 sobre N)");
  }

  if (CROSS_PR_DEP_RE.test(text)) {
    reasons.push("issue referencia dependência explícita de outra PR (depende de/após/bloqueado por/baseado em #N)");
  }

  return { admit: reasons.length === 0, reasons, overlappingPaths };
}
