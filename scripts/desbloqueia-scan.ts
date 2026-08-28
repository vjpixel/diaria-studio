#!/usr/bin/env -S npx tsx
/**
 * scripts/desbloqueia-scan.ts (#6628)
 *
 * Wrapper de I/O de `/diaria-desbloqueia`. Varre issues abertas candidatas
 * (`bloqueada`/`develop` via `classifyExecTrack`), lê o CORPO E TODOS OS
 * COMENTÁRIOS de cada uma, e classifica em `ja-destravada` /
 * `bloqueio-confirmado` / `precisa-pergunta` via
 * `scripts/lib/desbloqueia-scan.ts`. O playbook (`.claude/skills/diaria-desbloqueia/SKILL.md`)
 * só faz `AskUserQuestion` para o grupo `precisaPergunta` — as outras duas
 * já têm a resposta na thread.
 *
 * ## Duas passadas, de propósito (custo de contexto)
 *
 * Passada 1: `gh issue list --json number,title,labels,body,state,updatedAt`
 * — barata, 1 chamada, sem comentários. Passada 2: só pras issues que a
 * passada 1 já classificou como candidatas reais (`bloqueada`/`develop`),
 * busca os comentários via `fetchCommentBodies` (`scripts/lib/issue-decisions.ts`,
 * já usado pelo mesmo propósito noutros pontos do repo). Ler a thread
 * inteira de TODO o backlog aberto não cabe numa sessão — só ler a thread
 * de quem já é candidato real evita o desperdício óbvio sem abrir mão do
 * requisito central (thread completa de quem entra na bateria de perguntas).
 *
 * ## Uso
 *
 *   npx tsx scripts/desbloqueia-scan.ts                  # varre todo o backlog aberto
 *   npx tsx scripts/desbloqueia-scan.ts --issues 123,456  # só essas issues
 *   npx tsx scripts/desbloqueia-scan.ts --limit 50        # teto de issues na passada 1 (default 500)
 *
 * Imprime `DesbloqueioScanReport` (JSON) em stdout. Puramente leitura —
 * nunca comenta, nunca aplica label, nunca chama `route-issue.ts`. Isso é
 * responsabilidade do playbook, depois que o editor responder.
 */
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { fetchCommentBodies } from "./lib/issue-decisions.ts";
import {
  scanDesbloqueioCandidates,
  type DesbloqueioIssueInput,
  type DesbloqueioScanReport,
} from "./lib/desbloqueia-scan.ts";

interface GhIssueListEntry {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  body: string | null;
  state: string;
  updatedAt: string;
}

function fetchOpenIssues(cwd: string, limit: number, only: number[] | null): GhIssueListEntry[] {
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,labels,body,state,updatedAt",
  ];
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`gh issue list falhou (status ${result.status ?? "null"}): ${result.stderr.trim()}`);
  }
  const parsed: GhIssueListEntry[] = JSON.parse(result.stdout);
  if (!only) return parsed;
  const wanted = new Set(only);
  return parsed.filter((i) => wanted.has(i.number));
}

export function runDesbloqueioScan(cwd: string, opts: { limit?: number; issues?: number[] } = {}): DesbloqueioScanReport {
  const limit = opts.limit ?? 500;
  const issues = fetchOpenIssues(cwd, limit, opts.issues ?? null);

  const inputs: DesbloqueioIssueInput[] = issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    body: issue.body,
    state: issue.state,
    updatedAt: issue.updatedAt,
    // #6628 requisito central: TODOS os comentários, não uma amostra.
    comments: fetchCommentBodies(issue.number, cwd),
  }));

  return scanDesbloqueioCandidates(inputs);
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const limit = values.limit ? Number(values.limit) : undefined;
  const issues = values.issues
    ? values.issues
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : undefined;

  const report = runDesbloqueioScan(process.cwd(), { limit, issues });
  console.log(JSON.stringify(report, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
