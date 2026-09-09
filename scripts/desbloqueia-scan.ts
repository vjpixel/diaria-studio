#!/usr/bin/env -S npx tsx
/**
 * scripts/desbloqueia-scan.ts (#6628)
 *
 * Wrapper de I/O de `/diaria-desbloqueia`. Varre issues abertas candidatas
 * (`bloqueada`/`develop`, mais o bucket `overnight ·sem sinal` desde a
 * #7694 — ver abaixo), lê o CORPO E TODOS OS COMENTÁRIOS de cada uma, e
 * classifica em `ja-destravada` / `bloqueio-confirmado` / `precisa-pergunta` /
 * `sem-sinal-nao-triada` / `erro-leitura` via `scripts/lib/desbloqueia-scan.ts`.
 * O playbook (`.claude/skills/diaria-desbloqueia/SKILL.md`) só faz
 * `AskUserQuestion` para o grupo `precisaPergunta` — os outros quatro
 * (`jaDestravadas`, `bloqueioConfirmado`, `semSinalNaoTriadas`,
 * `erroLeitura`) nunca geram pergunta.
 *
 * ## `--skip-sem-sinal` e o custo da passada 2 (#7694)
 *
 * Incluir o bucket `·sem sinal` (`matched: "default"`) no escopo triplica o
 * número de `gh issue view` da passada 2 — na medição de 08/09/2026, de 9
 * candidatas pra 35 (26 sem-sinal + 9 do escopo antigo, sobre 68 abertas).
 * O default é INCLUIR mesmo assim: o bucket é o motivo de a #7694 existir, e
 * uma flag de opt-in que ninguém lembra de passar não corrige nada. Quando o
 * que se quer é só a varredura barata do escopo antigo, `--skip-sem-sinal`
 * (ou `--track bloqueada`/`--track develop`, que já restringem) desliga.
 *
 * ## Duas passadas de verdade, de propósito (custo de contexto)
 *
 * Passada 1: `gh issue list --json number,title,labels,body,state,updatedAt`
 * — barata, 1 chamada, sem comentários. O resultado é classificado por
 * `classifyExecTrack` (mesmo módulo que `scripts/lib/desbloqueia-scan.ts`
 * usa depois) usando só corpo+labels+state — SEM buscar comentário nenhum
 * ainda — e filtrado a `bloqueada`/`develop` (mais `--track` se pedido).
 * **Só essa lista filtrada** segue pra passada 2: busca de comentário
 * completo via `fetchCommentsChecked` (abaixo), 1 chamada `gh issue view`
 * por candidata real. Ler a thread inteira de TODO o backlog aberto não
 * cabe numa sessão — filtrar ANTES de buscar comentário é o que evita esse
 * desperdício (achado do fleet review do PR #6632: uma versão anterior
 * deste arquivo buscava comentário de TODO issue aberto antes de
 * classificar, o oposto do que a docstring afirmava).
 *
 * ## Falha de leitura nunca vira "sem comentário" (#6632 review)
 *
 * `fetchCommentsChecked` distingue "a issue genuinamente não tem
 * comentário" de "não deu pra buscar" (gh falhou, JSON malformado, timeout)
 * — os dois produziam o mesmo `[]` antes, o que fazia uma falha de rede
 * virar silenciosamente `precisa-pergunta` (a garantia central da skill —
 * nunca perguntar o que a thread já resolveu — furada exatamente pela
 * classe de bug que ela existe pra evitar). Em erro, o candidate carrega
 * `commentsFetchError` e `scanDesbloqueioCandidates` roteia pra
 * `erroLeitura`, nunca pra `precisaPergunta`.
 *
 * ## Uso
 *
 *   npx tsx scripts/desbloqueia-scan.ts                       # varre todo o backlog aberto
 *   npx tsx scripts/desbloqueia-scan.ts --issues 123,456        # só essas issues
 *   npx tsx scripts/desbloqueia-scan.ts --track bloqueada       # só bloqueada (ou develop / sem-sinal)
 *   npx tsx scripts/desbloqueia-scan.ts --skip-sem-sinal         # escopo antigo (bloqueada+develop)
 *   npx tsx scripts/desbloqueia-scan.ts --limit 50               # teto de issues na passada 1 (default 500)
 *
 * `--issues` com qualquer token que não seja um número válido LANÇA
 * (nunca filtra em silêncio pra lista vazia — achado do #6632 review: um
 * typo produzia relatório vazio, indistinguível de "nada pra desbloquear").
 *
 * Imprime `DesbloqueioScanReport` (JSON) em stdout. Puramente leitura —
 * nunca comenta, nunca aplica label, nunca chama `route-issue.ts`. Isso é
 * responsabilidade do playbook, depois que o editor responder.
 */
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { classifyExecTrackWithRule } from "./lib/issue-exec-track.ts";
import {
  scanDesbloqueioCandidates,
  type DesbloqueioIssueInput,
  type DesbloqueioScanReport,
} from "./lib/desbloqueia-scan.ts";

/**
 * Valores de `--track`. `sem-sinal` NÃO é um `ExecTrack` — é o subconjunto de
 * `overnight` com `matched: "default"` (#7694), que só existe como escopo
 * desta varredura. Nomeado assim, e não `overnight`, justamente pra não
 * sugerir que `--track overnight` traria todo issue overnight (não traz: os
 * já triados estão fora do escopo por construção).
 */
const SCOPED_TRACKS = ["bloqueada", "develop", "sem-sinal"] as const;
type ScopedTrack = (typeof SCOPED_TRACKS)[number];

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
  let parsed: GhIssueListEntry[];
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `gh issue list retornou JSON inválido (${err instanceof Error ? err.message : String(err)}). ` +
        `stdout (primeiros 500 chars): ${result.stdout.slice(0, 500)}`,
    );
  }
  if (!only) return parsed;
  const wanted = new Set(only);
  return parsed.filter((i) => wanted.has(i.number));
}

/**
 * Busca os comentários de UMA issue, distinguindo "leitura OK" de "falhou"
 * — nunca colapsa os dois em `[]` indistinguível (ver docstring do módulo).
 * Não reusa `fetchCommentBodies` de `scripts/lib/issue-decisions.ts` de
 * propósito: aquele helper é fail-soft por contrato (outros consumidores
 * dependem disso), e mudar sua assinatura quebraria todo mundo que já usa
 * `[]` como "sem comentário, sem erro". Este wrapper é local e pequeno.
 */
function fetchCommentsChecked(issueNumber: number, cwd: string): { comments: string[]; error: string | null } {
  const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "comments"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    const reason = result.stderr?.trim() || `gh issue view #${issueNumber} falhou (status ${result.status ?? "null"})`;
    console.error(`[desbloqueia-scan] ${reason}`);
    return { comments: [], error: reason };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    const reason = `gh issue view #${issueNumber} — JSON de comentários inválido: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[desbloqueia-scan] ${reason}`);
    return { comments: [], error: reason };
  }
  const comments = (parsed as { comments?: Array<{ body?: string }> } | null)?.comments;
  if (!Array.isArray(comments)) {
    const reason = `gh issue view #${issueNumber} — resposta sem array "comments"`;
    console.error(`[desbloqueia-scan] ${reason}`);
    return { comments: [], error: reason };
  }
  return {
    comments: comments.map((c) => c.body).filter((b): b is string => typeof b === "string"),
    error: null,
  };
}

export function runDesbloqueioScan(
  cwd: string,
  opts: { limit?: number; issues?: number[]; track?: ScopedTrack; skipSemSinal?: boolean } = {},
): DesbloqueioScanReport {
  const limit = opts.limit ?? 500;
  const issues = fetchOpenIssues(cwd, limit, opts.issues ?? null);
  // `--track sem-sinal` pedindo explicitamente o bucket vence um
  // `--skip-sem-sinal` que tenha vindo junto (pedido explícito > desligamento
  // genérico); fora isso, a flag desliga o bucket.
  const includeSemSinal = opts.track === "sem-sinal" || !opts.skipSemSinal;

  // Passada 1 (barata, sem gh issue view): filtra pra quem é candidata real
  // ANTES de gastar uma chamada de comentário. Ver docstring do módulo.
  const candidates = issues.filter((issue) => {
    const { track, matched } = classifyExecTrackWithRule({
      labels: issue.labels.map((l) => l.name),
      body: issue.body,
      state: issue.state,
    });
    // #7694 — `overnight` só entra pelo bucket `·sem sinal` (`matched`
    // default). `overnight` com sinal positivo (trade-off-real, alarm-evento,
    // triada-overnight) já foi triado: não há o que desbloquear.
    const semSinal = track === "overnight" && matched === "default";
    const scope: ScopedTrack | null =
      track === "bloqueada" || track === "develop" ? track : semSinal ? "sem-sinal" : null;
    if (scope === null) return false;
    if (scope === "sem-sinal" && !includeSemSinal) return false;
    if (opts.track && scope !== opts.track) return false;
    return true;
  });

  // Passada 2: só pras candidatas reais, busca a thread completa.
  const inputs: DesbloqueioIssueInput[] = candidates.map((issue) => {
    const { comments, error } = fetchCommentsChecked(issue.number, cwd);
    return {
      number: issue.number,
      title: issue.title,
      labels: issue.labels.map((l) => l.name),
      body: issue.body,
      state: issue.state,
      updatedAt: issue.updatedAt,
      comments,
      commentsFetchError: error,
    };
  });

  return scanDesbloqueioCandidates(inputs);
}

function parseIssuesArg(raw: string): number[] {
  return raw.split(",").map((token) => {
    const trimmed = token.trim();
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new Error(`--issues: "${trimmed}" não é um número de issue válido (esperado lista separada por vírgula, ex: 123,456)`);
    }
    return n;
  });
}

function parseTrackArg(raw: string): ScopedTrack {
  if ((SCOPED_TRACKS as readonly string[]).includes(raw)) return raw as ScopedTrack;
  throw new Error(`--track deve ser um de: ${SCOPED_TRACKS.join(", ")} (recebido "${raw}")`);
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const limit = values.limit ? Number(values.limit) : undefined;
  const issues = values.issues ? parseIssuesArg(values.issues) : undefined;
  const track = values.track ? parseTrackArg(values.track) : undefined;
  // `parseArgs` põe flag booleana em `flags` e `--k=v` em `values` — aceitar
  // as duas formas (`--skip-sem-sinal` e `--skip-sem-sinal=true`) evita o
  // silêncio de uma flag digitada com `=` e simplesmente ignorada.
  const skipSemSinal = flags.has("skip-sem-sinal") || values["skip-sem-sinal"] === "true";

  const report = runDesbloqueioScan(process.cwd(), { limit, issues, track, skipSemSinal });
  console.log(JSON.stringify(report, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
