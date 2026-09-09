#!/usr/bin/env -S npx tsx
/**
 * scripts/desbloqueia-scan.ts (#6628)
 *
 * Wrapper de I/O de `/diaria-desbloqueia`. Varre issues abertas candidatas
 * (`bloqueada`/`develop`, mais o bucket `overnight ·sem sinal` desde a
 * #7694 — ver abaixo), lê o CORPO E TODOS OS COMENTÁRIOS de cada uma, e
 * classifica nos 8 status de `scripts/lib/desbloqueia-scan.ts`. Só dois
 * grupos viram `AskUserQuestion` no playbook
 * (`.claude/skills/diaria-desbloqueia/SKILL.md`): `precisaPergunta` (o que
 * falta pra destravar) e `acaoImediataCandidatas` (#7708 — "faça isto
 * agora"). Os outros seis nunca geram pergunta — `acaoAdiada` em especial
 * existe justamente pra NÃO gerar.
 *
 * ## `fora-de-rodada` no escopo, e o anti-fadiga que o torna viável (#7708)
 *
 * `fora-de-rodada` entrou no escopo porque um alarme de ESTADO só para de
 * reproduzir quando alguém conserta a coisa: uma unit `systemd` caída não se
 * levanta sozinha, e enquanto ninguém a levanta a issue fica
 * `fora-de-rodada` por construção — o oposto de "resolvida". Na medição de
 * 09/09/2026, 16 das 18 `fora-de-rodada` abertas eram `alarm`, várias delas
 * unit caída / sync parado / ingest sem execução.
 *
 * Isso levaria a bateria de perguntas de 6 pra ~22 por rodada, o que mataria
 * a skill em duas execuções. O que torna a extensão viável é o marcador
 * `acao-adiada` (`scripts/lib/issue-decisions.ts`): pedido feito + editor
 * adiou ⇒ a pergunta some por `ACAO_ADIADA_COOLDOWN_DAYS`, e volta antes do
 * prazo só se um sintoma NOVO aparecer (bloqueio mais recente que o
 * adiamento).
 *
 * `on-hold`/`wontfix` ficam fora por default (`--incluir-engavetadas` varre
 * tudo): é retirada deliberada de circulação pelo editor — "não é 'ainda
 * não', é 'não'" — e repergunta a cada rodada é a fricção que #5321 existe
 * pra eliminar.
 *
 * ## Dependência declarada que já fechou (#7707)
 *
 * Um `bloqueio-execucao` com `condicao.tipo === "depends_on"` aponta pra
 * outra issue. Se essa issue já FECHOU, a condição foi satisfeita e o
 * bloqueio é obsoleto — mas nada percebia isso: `reconcile-issue-dependencies.ts`
 * (#7137) auto-desarma pela LABEL `dependencia-aberta`, e um marcador
 * gravado sem a label (o caminho que a #5734 percorreu) ficava bloqueado
 * pra sempre. A passada 3 resolve o estado das dependências e o miolo
 * devolve `bloqueio-obsoleto`. Issue inexistente vira `missing`, que NUNCA
 * desbloqueia — marcador podre não é dependência satisfeita.
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
 * `resolveDesbloqueioEscopo` (o MESMO helper que o miolo aplica depois, não
 * uma cópia da regra) usando só corpo+labels+state — SEM buscar comentário
 * nenhum ainda — e filtrado aos buckets em escopo (mais `--track` se pedido).
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
 *   npx tsx scripts/desbloqueia-scan.ts --track bloqueada       # 1 bucket: bloqueada|develop|sem-sinal|fora-de-rodada
 *   npx tsx scripts/desbloqueia-scan.ts --skip-sem-sinal         # sem o bucket ·sem sinal
 *   npx tsx scripts/desbloqueia-scan.ts --incluir-engavetadas    # varre também on-hold/wontfix
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

import {
  resolveDesbloqueioEscopo,
  scanDesbloqueioCandidates,
  type DesbloqueioIssueInput,
  type DesbloqueioScanReport,
} from "./lib/desbloqueia-scan.ts";
import { latestExecutionBlockFor } from "./lib/issue-decisions.ts";

/**
 * Valores de `--track`. `sem-sinal` NÃO é um `ExecTrack` — é o subconjunto de
 * `overnight` com `matched: "default"` (#7694), que só existe como escopo
 * desta varredura. Nomeado assim, e não `overnight`, justamente pra não
 * sugerir que `--track overnight` traria todo issue overnight (não traz: os
 * já triados estão fora do escopo por construção).
 */
const SCOPED_TRACKS = ["bloqueada", "develop", "sem-sinal", "fora-de-rodada"] as const;
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

/**
 * #7707 — resolve o estado das issues apontadas por marcadores
 * `bloqueio-execucao` com `condicao.tipo === "depends_on"`.
 *
 * A lista de abertas da passada 1 já responde "está aberta?" de graça; só as
 * que NÃO estão nela precisam de uma chamada, e só pra distinguir `closed`
 * (dependência satisfeita → bloqueio obsoleto) de `missing` (marcador
 * apontando pra issue que não existe → dado corrompido, nunca desbloqueia).
 * Na prática são pouquíssimas chamadas: 1 candidata em 34 na medição de
 * 09/09/2026.
 */
export type DependencyState = "open" | "closed" | "missing";

/** Injetável só pra teste — em produção é sempre `spawnSync("gh", …)`. Sem
 * isso o único caminho de I/O da #7707 ficaria sem cobertura: um
 * `depends_on` aberto é raro no backlog (0 na medição de 09/09/2026), então
 * o smoke ao vivo não o exercita. */
export type IssueStateFetcher = (issueNumber: number, cwd: string) => { status: number; stdout: string; stderr: string };

const defaultIssueStateFetcher: IssueStateFetcher = (n, cwd) => {
  const r = spawnSync("gh", ["issue", "view", String(n), "--json", "state"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function resolveDependencyStates(
  wanted: readonly number[],
  openNumbers: ReadonlySet<number>,
  cwd: string,
  fetchState: IssueStateFetcher = defaultIssueStateFetcher,
): Map<number, DependencyState> {
  const out = new Map<number, DependencyState>();
  for (const n of new Set(wanted)) {
    if (openNumbers.has(n)) {
      out.set(n, "open");
      continue;
    }
    const result = fetchState(n, cwd);
    if (result.status !== 0) {
      // `gh` falha tanto pra issue inexistente quanto pra rede caída. Os dois
      // viram `missing`, que NUNCA desbloqueia — a direção segura: na dúvida,
      // o bloqueio continua de pé.
      console.error(`[desbloqueia-scan] não deu pra resolver a dependência #${n}: ${result.stderr.trim() || "erro"}`);
      out.set(n, "missing");
      continue;
    }
    try {
      const state = (JSON.parse(result.stdout) as { state?: unknown }).state;
      out.set(n, state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : "missing");
    } catch {
      out.set(n, "missing");
    }
  }
  return out;
}

export function runDesbloqueioScan(
  cwd: string,
  opts: {
    limit?: number;
    issues?: number[];
    track?: ScopedTrack;
    skipSemSinal?: boolean;
    incluirEngavetadas?: boolean;
  } = {},
): DesbloqueioScanReport {
  const limit = opts.limit ?? 500;
  const issues = fetchOpenIssues(cwd, limit, opts.issues ?? null);
  // `--track sem-sinal` pedindo explicitamente o bucket vence um
  // `--skip-sem-sinal` que tenha vindo junto (pedido explícito > desligamento
  // genérico); fora isso, a flag desliga o bucket.
  const includeSemSinal = opts.track === "sem-sinal" || !opts.skipSemSinal;

  // A lista de abertas é a fonte de "está aberta?" pra resolução de
  // dependência mais adiante — montada aqui, antes de qualquer filtro.
  const openNumbers = new Set(issues.map((i) => i.number));

  // Passada 1 (barata, sem gh issue view): filtra pra quem é candidata real
  // ANTES de gastar uma chamada de comentário. Ver docstring do módulo.
  const candidates = issues.filter((issue) => {
    const escopoInfo = resolveDesbloqueioEscopo({
      labels: issue.labels.map((l) => l.name),
      body: issue.body,
      state: issue.state,
      incluirEngavetadas: opts.incluirEngavetadas,
    });
    if (!escopoInfo) return false;
    if (escopoInfo.escopo === "sem-sinal" && !includeSemSinal) return false;
    if (opts.track && escopoInfo.escopo !== opts.track) return false;
    return true;
  });

  // Passada 2: só pras candidatas reais, busca a thread completa.
  const fetched = candidates.map((issue) => {
    const { comments, error } = fetchCommentsChecked(issue.number, cwd);
    return { issue, comments, error };
  });

  // Passada 3 (#7707): resolve as dependências declaradas nos bloqueios que
  // acabaram de ser lidos. Roda DEPOIS da 2 porque só a thread diz quais
  // issues são apontadas.
  const deps: number[] = [];
  for (const { comments, error } of fetched) {
    if (error) continue;
    const bloco = latestExecutionBlockFor(comments);
    if (bloco?.condicao.tipo === "depends_on") deps.push(bloco.condicao.issue);
  }
  const dependencyStates = resolveDependencyStates(deps, openNumbers, cwd);

  const inputs: DesbloqueioIssueInput[] = fetched.map(({ issue, comments, error }) => {
    const bloco = error ? null : latestExecutionBlockFor(comments);
    const depIssue = bloco?.condicao.tipo === "depends_on" ? bloco.condicao.issue : null;
    return {
      number: issue.number,
      title: issue.title,
      labels: issue.labels.map((l) => l.name),
      body: issue.body,
      state: issue.state,
      updatedAt: issue.updatedAt,
      comments,
      commentsFetchError: error,
      dependencyState: depIssue === null ? null : (dependencyStates.get(depIssue) ?? "missing"),
      incluirEngavetadas: opts.incluirEngavetadas,
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
  const incluirEngavetadas = flags.has("incluir-engavetadas") || values["incluir-engavetadas"] === "true";

  const report = runDesbloqueioScan(process.cwd(), {
    limit,
    issues,
    track,
    skipSemSinal,
    incluirEngavetadas,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
