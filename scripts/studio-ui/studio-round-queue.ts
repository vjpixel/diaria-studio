/**
 * studio-round-queue.ts (#3561, fatia 7 do epic "Studio UI" #3554)
 *
 * Funções PURAS que classificam as issues de um `plan.json` de rodada
 * (overnight OU develop — `data/{overnight|develop}/{AAMMDD}/plan.json`) em
 * 3 baldes, espelhando a tabela que o TERMINAL já imprime hoje (passo 4.5 do
 * `/diaria-overnight`, `.claude/skills/diaria-overnight/SKILL.md` —
 * "Entram na rodada" / "Ficam de fora, com motivo explícito por issue"):
 *
 *   - `entram`   — `elegivel` / `precisa-resposta` / `desbloqueada-validada` /
 *                  `mergeada` / `draft-ci-vermelho`: issues que genuinamente
 *                  entraram no escopo de trabalho da rodada. Overnight grava
 *                  `in_round` explicitamente (#3131) — quando presente, tem
 *                  precedência sobre o status.
 *   - `pendente` — develop-only: `status: "pendente"`, aguardando o Gate 1 de
 *                  desbloqueio (cat. A-E, ver `.claude/skills/diaria-develop/SKILL.md`)
 *                  — nem "entrou" (ainda não trabalhada) nem "ficou de fora"
 *                  (não foi descartada).
 *   - `fora`     — `pulada` (com `motivo`), `elegivel_especial` (EPIC
 *                  deferido, #3072), `fechada` (fechada externamente), ou
 *                  `in_round === false` explícito.
 *
 * Este módulo NÃO dispara nenhuma varredura nova (`gh issue list`, etc.) —
 * é visualização pura de um `plan.json` já gravado por uma rodada em
 * andamento/resumível (#3561 escopo: "não inventar mecanismo de disparo do
 * zero — o disparo real continua sendo /diaria-overnight`/`/diaria-develop`
 * no terminal").
 *
 * Schema-tolerant: overnight e develop compartilham `number`/`priority`/
 * `status`/`batch`/`pr`, mas develop adiciona campos próprios de desbloqueio
 * (`block_category` A-E, `what_unblocks`, `block_label`) que este módulo usa
 * pra enriquecer o motivo quando presentes (ver `.claude/skills/diaria-develop/SKILL.md`
 * §"Reusa o schema do overnight + campos próprios de desbloqueio").
 *
 * Segurança (#3561 critério de aceite "cat. A com campo mascarado que NUNCA
 * ecoa"): este módulo nunca lê nem expõe valor de secret — `plan.json` já
 * não armazena isso por invariante do próprio SKILL.md ("Segurança: o
 * plan.json nunca armazena o valor de um token" / `editor_input_received`
 * é bool, nunca o secret) — este módulo só repassa o que já está lá.
 */

export type QueueBucket = "entram" | "pendente" | "fora";

/** Shape cru de uma entry de `plan.json.issues[]` — schema-tolerant
 * (overnight ou develop), só os campos que este módulo lê. */
export interface RawPlanIssue {
  number: number;
  priority?: string | null;
  status?: string | null;
  motivo?: string | null;
  in_round?: boolean;
  batch?: string | null;
  pr?: number | null;
  block_category?: string | null;
  block_label?: string | null;
  what_unblocks?: string | null;
  unblock_status?: string | null;
  [key: string]: unknown;
}

/** Shape cru mínimo de `plan.json` — só os campos que este módulo lê. */
export interface RawPlan {
  started_at?: string | null;
  issues?: RawPlanIssue[];
  [key: string]: unknown;
}

export interface QueueRow {
  number: number;
  priority: string; // "P0".."P3" ou "?" quando ausente/desconhecida
  status: string;
  bucket: QueueBucket;
  /** Motivo legível — `null` só pra `bucket === "entram"` sem observação. */
  reason: string | null;
  batch: string | null;
  pr: number | null;
}

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function priorityRank(p: string): number {
  return PRIORITY_ORDER[p] ?? 99;
}

const FORA_STATUSES = new Set(["pulada", "elegivel_especial", "fechada"]);

/** Motivo legível pro bucket "fora" — prioriza `motivo` explícito (o campo
 * que o coordenador já grava pra `pulada`); cai pra rótulos fixos por status
 * quando ausente. */
function reasonForFora(issue: RawPlanIssue): string {
  if (issue.motivo) return issue.motivo;
  if (issue.status === "elegivel_especial") return "EPIC deferido (fecha quando issues-filhas mergearem)";
  if (issue.status === "fechada") return "fechada externamente";
  if (issue.in_round === false) return "fora do escopo da rodada";
  return "pulada";
}

/** Motivo legível pro bucket "pendente" (develop, Gate 1 de desbloqueio
 * cat. A-E) — NUNCA inclui valor de secret, só metadados já presentes no
 * plan.json (`block_category`, `what_unblocks`/`block_label`). */
function reasonForPendente(issue: RawPlanIssue): string {
  const cat = issue.block_category ? `cat. ${issue.block_category}` : null;
  const detail = issue.what_unblocks ?? issue.block_label ?? null;
  if (cat && detail) return `${cat}: ${detail}`;
  if (cat) return cat;
  if (detail) return detail;
  return "aguardando desbloqueio (Gate 1)";
}

/** Classifica UMA issue do plan.json em bucket + motivo legível. Pura. */
export function classifyQueueRow(issue: RawPlanIssue): QueueRow {
  const status = issue.status ?? "unknown";
  const priority = issue.priority ?? "?";
  let bucket: QueueBucket;
  let reason: string | null;

  if (issue.in_round === false || FORA_STATUSES.has(status)) {
    bucket = "fora";
    reason = reasonForFora(issue);
  } else if (status === "pendente") {
    bucket = "pendente";
    reason = reasonForPendente(issue);
  } else {
    bucket = "entram";
    reason = null;
  }

  return {
    number: issue.number,
    priority,
    status,
    bucket,
    reason,
    batch: issue.batch ?? null,
    pr: issue.pr ?? null,
  };
}

export interface RoundQueue {
  entram: QueueRow[];
  pendente: QueueRow[];
  fora: QueueRow[];
}

/** Ordena por prioridade P0 > P1 > P2 > P3 > "?" (não-classificada por
 * último); empate → número menor primeiro (issue mais antiga), mesmo
 * critério de desempate do `/diaria-overnight` Fase 1. */
function sortRows(rows: QueueRow[]): QueueRow[] {
  return [...rows].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return a.number - b.number;
  });
}

/** Monta a fila classificada completa a partir de um `plan.json` já
 * parseado. Fail-soft: `issues` ausente/malformado vira 3 arrays vazios —
 * nunca lança. */
export function buildRoundQueue(plan: RawPlan): RoundQueue {
  const issues = Array.isArray(plan.issues) ? plan.issues : [];
  const rows = issues.map(classifyQueueRow);
  return {
    entram: sortRows(rows.filter((r) => r.bucket === "entram")),
    pendente: sortRows(rows.filter((r) => r.bucket === "pendente")),
    fora: sortRows(rows.filter((r) => r.bucket === "fora")),
  };
}

// ─── filtros por "label" sintética (#3561 critério de aceite) ─────────────

/**
 * Deriva "labels" sintéticas de uma `QueueRow` a partir da prioridade + texto
 * do motivo/status — `plan.json` não grava labels do GitHub diretamente (só
 * o que a classificação da Fase 0 já resolveu em `motivo`/`block_category`),
 * então este é o mapeamento determinístico que alimenta os filtros da UI
 * (`local`, `external-blocker`, `P0`-`P3`, pedidos explicitamente no
 * critério de aceite do #3561). Pura, best-effort — não é um espelho de
 * label real do GitHub, é derivado do texto que a própria rodada já gravou.
 */
export function deriveQueueLabels(row: QueueRow): string[] {
  const labels: string[] = [];
  if (PRIORITY_ORDER[row.priority] !== undefined) labels.push(row.priority);
  const haystack = `${row.reason ?? ""} ${row.status}`;
  if (/requer-sessao-local|sess[aã]o local/i.test(haystack)) labels.push("local");
  if (/bloqueio-externo|external-blocker|block_category|cat\.\s*[A-E]\b/i.test(haystack)) {
    labels.push("external-blocker");
  }
  return labels;
}
