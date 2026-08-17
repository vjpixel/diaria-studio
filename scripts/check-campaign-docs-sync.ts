/**
 * check-campaign-docs-sync.ts (#5559)
 *
 * Guard-rail contra o modo de falha do #5559: os 4 docs operacionais de
 * `data/aquisicao/campanhas-260816/*.md` (gitignored, OneDrive) foram
 * propagados a partir de uma decisão registrada na #5524 — e a #5524 foi
 * REVISADA depois da propagação, sem nada sinalizar que os docs ficaram
 * obsoletos. Descoberto manualmente 2× na mesma tarde (17/08/2026).
 *
 * Implementa a OPÇÃO 1 do corpo da #5559 (a mais contida das 3 propostas —
 * decisão do editor ao despachar esta unidade, não reaberta aqui):
 * marcador de sincronização no topo de cada doc,
 * `<!-- sincronizado-com: #NNNN (revisão de {ISO timestamp}) -->`, comparado
 * contra a decisão MAIS RECENTE da issue referenciada via
 * `latestDecisionFor` (`scripts/lib/issue-decisions.ts`, #5373 — mesmo
 * padrão "julgamento gravado uma vez, lido depois, nunca re-derivado por
 * heurística").
 *
 * **Escopo explícito — NÃO wired em nenhum playbook automático.** Este é um
 * script de bolso: o coordenador (overnight/develop) ou o próprio editor
 * roda manualmente ANTES de executar a campanha, não um gate de CI. Rodar
 * em CI exigiria `gh` autenticado + chamada de rede a cada execução da
 * suíte, e a superfície que este guard protege (`data/`, gitignored) não
 * existe em clone fresco/sessão cloud — um gate de CI travaria em todo PR
 * sem sinal nenhum sobre o problema real.
 *
 * **Fora de escopo, de propósito (registrado aqui pra quem ler depois, não
 * como issue nova — decisão do editor ao despachar #5559):** a OPÇÃO 2 do
 * corpo da issue — reduzir a superfície de propagação, fazendo os docs
 * referenciarem os parâmetros variáveis (orçamento/dia, janela, teto) por
 * UMA fonte única (ex: JSON/YAML gerado a partir da decisão, ou fetch da
 * issue via API no momento da execução) em vez de ~51 ocorrências
 * hardcoded em prosa espalhadas pelos 4 arquivos. A opção 2 ataca a causa
 * raiz (quase elimina a classe de bug); esta opção 1 é só um guard-rail que
 * ainda depende de alguém rodar o script e ler o aviso. Fica como
 * follow-up maior, não escopo desta unidade.
 *
 * Uso:
 *   npx tsx scripts/check-campaign-docs-sync.ts
 *
 * Exit codes:
 *   0 — nenhum doc detectado como desatualizado (inclui os casos fail-soft:
 *       marcador ausente, decisão sem marcador formal, ou `data/` ausente —
 *       todos avisos, nunca bloqueio)
 *   1 — 1+ doc com marcador mais antigo que a revisão mais recente da
 *       decisão referenciada (ALTO — repropagação necessária)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { latestDecisionFor, type IssueDecision } from "./lib/issue-decisions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Os 4 docs operacionais propagados do teste de 3 canais 2608 (#5524/#5526). */
export const CAMPAIGN_DOCS: readonly string[] = [
  "data/aquisicao/campanhas-260816/00-PROTOCOLO.md",
  "data/aquisicao/campanhas-260816/10-google.md",
  "data/aquisicao/campanhas-260816/20-microsoft.md",
  "data/aquisicao/campanhas-260816/30-meta.md",
];

const MARKER_RE = /<!--\s*sincronizado-com:\s*#(\d+)\s*\(revis[aã]o de ([^)]+)\)\s*-->/;

export interface SyncMarker {
  issue: number;
  /** Timestamp cru do marcador — normalmente ISO 8601, comparado
   * lexicograficamente contra `decided_at` (mesma convenção de
   * `issue-decisions.ts`: funciona porque ambos são sempre UTC no mesmo
   * formato). */
  revisedAt: string;
}

/** Extrai o marcador `sincronizado-com` do topo de um doc. Tolerante —
 * retorna `null` se ausente ou malformado (issue não-numérica, timestamp
 * vazio), nunca lança. */
export function parseSyncMarker(content: string): SyncMarker | null {
  const m = content.match(MARKER_RE);
  if (!m) return null;
  const issue = Number(m[1]);
  const revisedAt = m[2].trim();
  if (!Number.isInteger(issue) || issue <= 0 || revisedAt.length === 0) return null;
  return { issue, revisedAt };
}

export type DocSyncResult =
  | { status: "ok"; issue: number; markerRevisedAt: string; decidedAt: string }
  | { status: "stale"; issue: number; markerRevisedAt: string; decidedAt: string }
  | { status: "no-marker" }
  | { status: "no-formal-decision"; issue: number; markerRevisedAt: string };

/** Núcleo puro: compara o marcador extraído de `content` contra a decisão
 * mais recente já resolvida (ou `null` se a issue de decisão não tiver
 * marcador formal). Sem I/O — testável direto com fixtures. */
export function evaluateDocSync(
  content: string,
  decision: IssueDecision | null,
): DocSyncResult {
  const marker = parseSyncMarker(content);
  if (!marker) return { status: "no-marker" };
  if (!decision) {
    return { status: "no-formal-decision", issue: marker.issue, markerRevisedAt: marker.revisedAt };
  }
  const stale = marker.revisedAt < decision.decided_at;
  return stale
    ? { status: "stale", issue: marker.issue, markerRevisedAt: marker.revisedAt, decidedAt: decision.decided_at }
    : { status: "ok", issue: marker.issue, markerRevisedAt: marker.revisedAt, decidedAt: decision.decided_at };
}

export type SyncLevel = "ok" | "warn" | "error";

export interface DocSyncReport {
  path: string;
  result: DocSyncResult;
  level: SyncLevel;
  message: string;
}

/** Formata o resultado de um doc numa mensagem humana + nível de severidade.
 * Puro — não faz I/O, testável com o `DocSyncResult` já calculado. */
export function reportForDoc(path: string, result: DocSyncResult): DocSyncReport {
  switch (result.status) {
    case "ok":
      return {
        path,
        result,
        level: "ok",
        message:
          `OK: ${path} — sincronizado com #${result.issue} ` +
          `(marcador ${result.markerRevisedAt} >= decisão ${result.decidedAt}).`,
      };
    case "stale":
      return {
        path,
        result,
        level: "error",
        message:
          `ALTO: ${path} DESATUALIZADO — marcador aponta pra revisão de ${result.markerRevisedAt}, ` +
          `mas a decisão #${result.issue} foi revisada depois disso (${result.decidedAt}). ` +
          `Repropague os 4 docs a partir da decisão atual antes de executar a campanha.`,
      };
    case "no-formal-decision":
      return {
        path,
        result,
        level: "warn",
        message:
          `AVISO: ${path} referencia #${result.issue}, mas essa issue não tem marcador formal ` +
          `de decisão (issue-decisions.ts) — a decisão pode existir só em prosa. ` +
          `Não é possível verificar sincronismo automaticamente; confira manualmente.`,
      };
    case "no-marker":
      return {
        path,
        result,
        level: "warn",
        message:
          `AVISO: ${path} não tem marcador "sincronizado-com" — não é possível verificar ` +
          `sincronismo automaticamente.`,
      };
  }
}

/** Exit code agregado — 1 se QUALQUER report for `error` (stale), 0 caso
 * contrário (inclui todos os warnings — são fail-soft por design). Puro. */
export function exitCodeForReports(reports: readonly DocSyncReport[]): 0 | 1 {
  return reports.some((r) => r.level === "error") ? 1 : 0;
}

// ─── CLI wrapper (I/O: lê os docs em disco, busca decisão via gh) ──────────

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
  return comments.map((c) => c.body).filter((b): b is string => typeof b === "string");
}

function main(): void {
  const dataDir = resolve(ROOT, "data", "aquisicao", "campanhas-260816");
  if (!existsSync(dataDir)) {
    console.log(
      `data/aquisicao/campanhas-260816/ ausente nesta sessão (clone fresco ou sessão cloud sem ` +
        `a junction data/, ver CLAUDE.md) — nada a verificar. Fail-soft, exit 0.`,
    );
    process.exit(0);
  }

  const reports: DocSyncReport[] = [];
  // cache: mesma issue pode ser referenciada por múltiplos docs — busca uma vez.
  const decisionCache = new Map<number, IssueDecision | null>();

  for (const relPath of CAMPAIGN_DOCS) {
    const absPath = resolve(ROOT, relPath);
    if (!existsSync(absPath)) {
      console.log(`(pulado, arquivo ausente: ${relPath})`);
      continue;
    }
    const content = readFileSync(absPath, "utf8");
    const marker = parseSyncMarker(content);
    if (!marker) {
      reports.push(reportForDoc(relPath, { status: "no-marker" }));
      continue;
    }
    if (!decisionCache.has(marker.issue)) {
      const bodies = fetchCommentBodies(marker.issue, ROOT);
      decisionCache.set(marker.issue, latestDecisionFor(bodies));
    }
    const decision = decisionCache.get(marker.issue) ?? null;
    reports.push(reportForDoc(relPath, evaluateDocSync(content, decision)));
  }

  for (const r of reports) {
    if (r.level === "error") console.error(r.message);
    else if (r.level === "warn") console.warn(r.message);
    else console.log(r.message);
  }

  const exitCode = exitCodeForReports(reports);
  if (exitCode === 1) {
    console.error(
      "\nFAIL: 1+ doc de campanha desatualizado em relação à decisão mais recente. Ver mensagens ALTO acima.",
    );
  } else {
    console.log("\nOK: nenhum doc de campanha detectado como desatualizado.");
  }
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
