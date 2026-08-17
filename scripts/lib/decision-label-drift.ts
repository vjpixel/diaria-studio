/**
 * scripts/lib/decision-label-drift.ts (#5589)
 *
 * Guard mecânico de AUDITORIA (não bloqueia nada, não aplica label sozinho —
 * é detecção; correção fica com quem lê o alerta), decidido na sessão
 * `/diaria-develop` 260817b: reduz o padrão observado em #5586 (#5237/#5239/
 * #5125 na rodada overnight 260817c/d), onde um comentário de sessão
 * (overnight/develop/continuo) registra em PROSA que uma issue foi
 * deferida/decidida ("aguardando pré-requisito", "trade-off-real", etc.) mas
 * a LABEL estrutural correspondente (`not-this-week`, `trade-off-real`, ...)
 * nunca é aplicada — deixando `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
 * desatualizado: a issue continua aparecendo como `overnight` (elegível) na
 * Triagem, quando na prática já foi resolvida/adiada por decisão registrada.
 *
 * ## O que este módulo NÃO é
 *
 * Não é NLP. É casamento de substring/regex contra um catálogo pequeno e
 * documentado de frases-gatilho observadas ao vivo (#5586) — precisão baixa
 * de propósito: falso positivo aqui custa um alerta ignorado; falso negativo
 * custa a mesma lacuna que este guard existe pra reduzir. Não tenta separar
 * "menciona o padrão em prosa comum" de "está de fato deferindo a issue" —
 * quem lê o achado faz esse julgamento. Não reimplementa
 * `parseDecisionMarkers`/`latestDecisionFor` (`issue-decisions.ts`) — aquele
 * módulo lê o marcador ESTRUTURADO (`<!-- decisao-editor: ... -->`); este
 * lê a PROSA ao redor dele, que é exatamente o que não tem estrutura
 * nenhuma pra `classifyExecTrack` consumir.
 *
 * ## Por que os HTML comments (marcadores) são removidos antes do match
 *
 * O payload dos marcadores de `issue-decisions.ts` é base64 — teoricamente
 * poderia, por acaso, conter uma sequência de caracteres que colide com um
 * padrão de gatilho. `stripHtmlComments` remove qualquer bloco `<!-- ... -->`
 * antes do match, então só a prosa legível por humano (que é o sinal real
 * que este módulo quer capturar) participa da detecção.
 *
 * ## Dedup
 *
 * Um comentário pode casar o mesmo padrão mais de uma vez (múltiplas frases
 * gatilho do mesmo grupo), e vários comentários da mesma issue podem casar o
 * mesmo padrão. `detectLabelDrift` reporta no máximo 1 achado por
 * `(issueNumber, patternId)` — o do comentário mais RECENTE que casou (bodies
 * são varridos na ordem recebida, que é cronológica ascendente via `gh`), pra
 * não inflar a mesma pendência N vezes.
 *
 * A checagem usa o snapshot ATUAL das labels da issue (`labels`, passado uma
 * única vez pro `detectLabelDrift`), não um histórico de labels por momento
 * do comentário — `labelSet` não muda durante o loop. Ou seja: se as labels
 * atuais já satisfazem o padrão, NENHUM achado é registrado pra ele,
 * independente de quantos ou quais comentários bateram (nem "o comentário
 * mais antigo tinha gerado achado, o mais recente corrigiu" é um mecanismo
 * real — a satisfação é constante por `(issue, patternId)`, avaliada contra
 * o mesmo snapshot em toda iteração).
 *
 * Puro: sem I/O, sem rede, sem `gh` — recebe labels + bodies de comentário já
 * buscados. O CLI (`scripts/check-decision-label-drift.ts`) é o wrapper fino
 * que busca via `gh` e imprime.
 *
 * @see scripts/lib/issue-decisions.ts (marcador estruturado que este módulo complementa)
 * @see scripts/lib/issue-exec-track.ts (o classificador que fica desatualizado sem este guard)
 * @see scripts/check-decision-label-drift.ts (CLI)
 */

/** Um grupo de padrões de deferimento/decisão em prosa, e as labels
 * estruturais que QUALQUER UMA (relação any-of) satisfaz — presente
 * qualquer uma delas, o comentário está coerente com a label e não é
 * reportado como drift. */
export interface DriftPattern {
  /** Identificador estável — aparece no output do CLI e nos testes. */
  id: string;
  /** Explicação curta do que o padrão detecta, pro output do CLI. */
  description: string;
  /** Casamento é "qualquer regex do grupo bate" (OR), não todas. */
  textPatterns: RegExp[];
  /** Labels estruturais que resolvem o achado — basta uma presente. */
  expectedLabels: string[];
}

/**
 * Catálogo de padrões — extraído literalmente das frases-gatilho citadas na
 * decisão do editor (#5589) e dos dois casos reais do #5586 (#5239:
 * "não despachar agora, pré-requisito ainda não atendido"; #5125: trade-off
 * declarado desde a criação da issue). Vocabulário de `issue-exec-track.ts`
 * é a fonte das labels esperadas — mantém os dois módulos em sincronia
 * manual (nenhum import cruzado: este módulo é deliberadamente mais
 * permissivo/heurístico que aquele, que é a fonte de verdade sobre labels).
 */
export const DRIFT_PATTERNS: readonly DriftPattern[] = [
  {
    id: "deferred-vague",
    description:
      "Comentário sugere adiar/aguardar (aguardando, não despachar, pré-requisito não atendido) sem label de deferimento (not-this-week/next-month) aplicada.",
    textPatterns: [
      /aguardando/i,
      /n[ãa]o despachar/i,
      /pr[ée]-requisito(s)? (ainda )?n[ãa]o atendido/i,
      /ainda n[ãa]o (é|eh) a hora/i,
      /adiar (pra|para|essa|esta) issue/i,
    ],
    expectedLabels: ["not-this-week", "next-month"],
  },
  {
    id: "trade-off-real",
    description:
      "Comentário identifica trade-off editorial/produto real sem a label trade-off-real aplicada.",
    textPatterns: [/trade-?off[\s-]*real/i],
    expectedLabels: ["trade-off-real"],
  },
  {
    id: "external-blocker",
    description:
      "Comentário indica bloqueio externo (conta de terceiro, credencial, acesso a painel) sem label de bloqueio correspondente.",
    textPatterns: [
      /bloqueio externo/i,
      /falta acesso a (um |uma )?(painel|conta)/i,
      /conta de terceiro/i,
      /credencial (pendente|faltando|necess[áa]ria)/i,
    ],
    expectedLabels: ["external-blocker", "kit-migration", "beehiiv", "bloqueio-execucao"],
  },
  {
    id: "on-hold",
    description:
      "Comentário indica que o trabalho foi colocado em espera permanente ou não será feito, sem a label correspondente.",
    textPatterns: [/\bon-hold\b/i, /\bwontfix\b/i, /n[ãa]o (vamos|iremos) fazer (isso|essa|esta)/i],
    expectedLabels: ["on-hold", "wontfix"],
  },
];

/**
 * Label que satisfaz QUALQUER padrão, além das `expectedLabels` específicas
 * de cada grupo — `decisao-registrada` (vocabulário de `issue-exec-track.ts`,
 * `RESOLVED_BY_PROSE_LABELS`) já significa "decisão registrada em prosa que
 * fecha o assunto"; uma issue que já carrega essa label não precisa também
 * da label de deferimento mais específica pra este guard considerar
 * coerente. Reduz um falso-positivo real observado ao vivo: o próprio
 * comentário de decisão desta issue (#5589) CITA as frases-gatilho como
 * exemplo ("aguardando", "trade-off-real") sem estar de fato deferindo
 * nada — `decisao-registrada` sinaliza que o assunto já foi resolvido, então
 * a citação em prosa não é um sinal de drift real.
 */
const UNIVERSAL_SATISFYING_LABEL = "decisao-registrada";

/** Remove blocos `<!-- ... -->` (marcadores estruturados de `issue-decisions.ts`
 * e afins) antes do match — só a prosa legível por humano participa da
 * detecção. Non-greedy (`[\s\S]*?`) pra não engolir o comentário inteiro
 * quando houver mais de um bloco no mesmo body. */
export function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Um achado: um comentário recente da issue casa um padrão de deferimento/
 * decisão, mas nenhuma das labels estruturais esperadas está presente. */
export interface DriftFinding {
  issueNumber: number;
  patternId: string;
  description: string;
  expectedLabels: string[];
  actualLabels: string[];
  /** Trecho do comentário (prosa, marcadores já removidos) em torno do match,
   * pra dar contexto no output sem despejar o comentário inteiro. */
  commentExcerpt: string;
}

const EXCERPT_RADIUS = 60;

function buildExcerpt(prose: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - EXCERPT_RADIUS);
  const end = Math.min(prose.length, match.index + match[0].length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < prose.length ? "…" : "";
  return `${prefix}${prose.slice(start, end).trim().replace(/\s+/g, " ")}${suffix}`;
}

export interface DetectLabelDriftInput {
  issueNumber: number;
  /** Labels da issue já normalizadas (nomes, sem o objeto do `gh`). */
  labels: string[];
  /** Corpos de comentário, ordem cronológica ascendente (mais recente por
   * último) — é o formato que `fetchCommentBodies` (`issue-decisions.ts`)
   * devolve. */
  commentBodies: readonly string[];
}

/**
 * Varre os comentários em busca de padrões de deferimento/decisão em prosa
 * e reporta os que não têm a label estrutural esperada aplicada na issue.
 * Determinístico, sem I/O. Nunca lança — comentário malformado (não-string)
 * é ignorado, mesma postura tolerante de `parseDecisionMarkers`.
 */
export function detectLabelDrift(input: DetectLabelDriftInput): DriftFinding[] {
  const { issueNumber, labels, commentBodies } = input;
  const labelSet = new Set(labels);
  // Uma entrada por (patternId) — sobrescrita a cada match mais recente,
  // já que `commentBodies` chega em ordem cronológica ascendente.
  const byPattern = new Map<string, DriftFinding>();

  for (const raw of commentBodies) {
    if (typeof raw !== "string") continue;
    const prose = stripHtmlComments(raw);
    for (const pattern of DRIFT_PATTERNS) {
      let match: RegExpExecArray | null = null;
      for (const re of pattern.textPatterns) {
        const m = re.exec(prose);
        if (m) {
          match = m;
          break;
        }
      }
      if (!match) continue;
      const satisfied =
        labelSet.has(UNIVERSAL_SATISFYING_LABEL) ||
        pattern.expectedLabels.some((l) => labelSet.has(l));
      if (satisfied) {
        // Label já bate no snapshot atual — nenhum achado pra este padrão,
        // independente de comentário anterior ter casado sem a label (ver
        // docstring do módulo, seção "Dedup": `labelSet` é fixo pro loop
        // inteiro, então `satisfied` nunca alterna de false pra true dentro
        // de uma mesma varredura; não há achado pendente pra remover aqui).
        continue;
      }
      byPattern.set(pattern.id, {
        issueNumber,
        patternId: pattern.id,
        description: pattern.description,
        expectedLabels: pattern.expectedLabels,
        actualLabels: labels,
        commentExcerpt: buildExcerpt(prose, match),
      });
    }
  }

  return Array.from(byPattern.values());
}
