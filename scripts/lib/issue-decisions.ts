/**
 * scripts/lib/issue-decisions.ts (#5373)
 *
 * Fecha o loop entre "resposta do editor gravada como comentário" e
 * "classificação de issue bloqueada só lê o corpo" — as sessões de backlog
 * (`/diaria-overnight`, `/diaria-develop`, `/diaria-continuo`) perguntavam a
 * MESMA decisão repetidamente (medido: 4x em 36h pras issues #5125/#5248/
 * #5140) porque a resposta do editor nunca entrava no input da próxima
 * varredura.
 *
 * Formato do marcador (item 1 da issue): bloco HTML-comment estruturado,
 * PREFIXO do comentário de decisão (a prosa legível por humano continua
 * existindo depois — o marcador é machine-readable, não substitui):
 *
 *   <!-- decisao-editor: {"decided_at":"2026-08-15T16:00:00Z",
 *        "pergunta":"...","resposta":"...","sessao":"continuo"} -->
 *
 * Parsing tolerante a marcador malformado (JSON inválido, campo faltando)
 * — nunca lança, ignora e segue pro próximo candidato. Comentário de decisão
 * "Decisão do editor: ..." em prosa sem o marcador (issues antigas, pré-#5373)
 * simplesmente não é reconhecido por este parser — é o gap que a issue #5373
 * documenta como "convenção acidental, não contrato"; não há tentativa de
 * inferir marcador retroativamente a partir de prosa.
 *
 * Determinístico, sem rede — `formatDecisionMarker`/`parseDecisionMarkers`/
 * `latestDecisionFor` recebem dados já buscados (array de bodies de
 * comentário) e são 100% testáveis via fixture. O CLI no fim do arquivo é
 * só um wrapper fino que busca via `gh` e imprime o resultado.
 */
import { spawnSync } from "node:child_process";

export type SessionKind = "continuo" | "overnight" | "develop";

/** Payload estruturado de uma decisão do editor registrada num comentário. */
export interface IssueDecision {
  /** ISO 8601 — timestamp de quando a decisão foi gravada. */
  decided_at: string;
  /** A pergunta que foi feita (curta, o suficiente pra identificar o que foi decidido). */
  pergunta: string;
  /** A resposta do editor. */
  resposta: string;
  /** Qual sessão gravou a decisão. */
  sessao: SessionKind;
}

const MARKER_PREFIX = "<!-- decisao-editor: ";
const MARKER_SUFFIX = " -->";

/** Gera o bloco HTML-comment estruturado que prefixa um comentário de
 * decisão. Determinístico — mesmo input sempre produz o mesmo marcador
 * (JSON.stringify com chaves na ordem de inserção do objeto literal abaixo,
 * estável entre chamadas). */
export function formatDecisionMarker(opts: IssueDecision): string {
  const payload = {
    decided_at: opts.decided_at,
    pergunta: opts.pergunta,
    resposta: opts.resposta,
    sessao: opts.sessao,
  };
  return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}`;
}

function isValidDecision(value: unknown): value is IssueDecision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.decided_at === "string" &&
    v.decided_at.length > 0 &&
    typeof v.pergunta === "string" &&
    typeof v.resposta === "string" &&
    (v.sessao === "continuo" || v.sessao === "overnight" || v.sessao === "develop")
  );
}

/** Extrai TODOS os marcadores válidos de uma lista de corpos de comentário.
 * Tolerante a marcador ausente ou malformado (JSON inválido, tipo errado,
 * campo faltando) — nunca lança, simplesmente ignora a entrada inválida e
 * segue pra próxima. Um body pode conter no máximo 1 marcador (o marcador é
 * sempre o prefixo do comentário); bodies sem marcador são ignorados. */
export function parseDecisionMarkers(commentsBodies: readonly string[]): IssueDecision[] {
  const decisions: IssueDecision[] = [];
  for (const body of commentsBodies) {
    if (typeof body !== "string") continue;
    const start = body.indexOf(MARKER_PREFIX);
    if (start === -1) continue;
    const jsonStart = start + MARKER_PREFIX.length;
    const end = body.indexOf(MARKER_SUFFIX, jsonStart);
    if (end === -1) continue;
    const rawJson = body.slice(jsonStart, end).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue; // marcador malformado — ignora, não lança
    }
    if (isValidDecision(parsed)) decisions.push(parsed);
  }
  return decisions;
}

/** Devolve a decisão MAIS RECENTE (por `decided_at`, comparação ISO 8601
 * lexicográfica — funciona porque `decided_at` é sempre UTC com o mesmo
 * formato) dentre os marcadores válidos encontrados nos bodies, ou `null`
 * se nenhum marcador válido existir. */
export function latestDecisionFor(commentsBodies: readonly string[]): IssueDecision | null {
  const decisions = parseDecisionMarkers(commentsBodies);
  if (decisions.length === 0) return null;
  return decisions.reduce((latest, current) =>
    current.decided_at > latest.decided_at ? current : latest,
  );
}

// ─── CLI wrapper (busca via gh, imprime a decisão mais recente ou nada) ────

interface GhComment {
  body?: string;
}

function fetchCommentBodies(issueNumber: number, cwd: string): string[] {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "comments"],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const comments = (parsed as { comments?: GhComment[] }).comments;
  if (!Array.isArray(comments)) return [];
  return comments
    .map((c) => c.body)
    .filter((b): b is string => typeof b === "string");
}

async function main() {
  const args = process.argv.slice(2);
  const issueFlagIdx = args.indexOf("--issue");
  if (issueFlagIdx === -1 || !args[issueFlagIdx + 1]) {
    process.stderr.write("uso: npx tsx scripts/lib/issue-decisions.ts --issue N\n");
    process.exitCode = 1;
    return;
  }
  const issueNumber = Number(args[issueFlagIdx + 1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    process.stderr.write(`--issue inválido: ${args[issueFlagIdx + 1]}\n`);
    process.exitCode = 1;
    return;
  }
  const bodies = fetchCommentBodies(issueNumber, process.cwd());
  const decision = latestDecisionFor(bodies);
  if (!decision) {
    process.stdout.write("");
    return;
  }
  process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
}

const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
