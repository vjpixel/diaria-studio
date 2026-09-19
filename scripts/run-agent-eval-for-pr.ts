#!/usr/bin/env npx tsx
/**
 * scripts/run-agent-eval-for-pr.ts (#8144)
 *
 * Metade "esteira" do gatilho de eval de regressão de prompt descrito na
 * issue #8144 — o companion do lado "barato, roda no Actions"
 * (`scripts/check-agent-eval-required.ts` + `.github/workflows/agent-eval-required.yml`,
 * que só DECIDE se um eval é necessário, nunca dispara o agent de verdade).
 * Este script RODA o harness da #8143 (`scripts/eval-prompt-regression.ts`)
 * pros agents que uma PR específica tocou, registra o resultado em
 * `data/reports/index.jsonl` (kind `"agent-eval"`, mesmo mecanismo de
 * `generate-calibration-evidence-report.ts`/#7978), posta o delta no corpo
 * da PR como comentário, e aplica a label `agent-eval:passed` — liberando o
 * gate do Actions.
 *
 * ## Por que este script, e não o Actions, dispara o agent
 *
 * Toda sessão de Claude Code deste projeto autentica pela assinatura
 * claude.ai (#5608) — o runner do GitHub Actions NUNCA tem essa sessão, e
 * rodar o eval lá significaria autenticar pela API, exatamente a proibição
 * que o #5608 existe pra evitar. Este script só faz sentido invocado de
 * DENTRO de uma sessão overnight/develop autenticada — nunca de um workflow
 * do Actions.
 *
 * **Pré-condição não-verificável mecanicamente pelo script:** o `cwd`
 * (`rootDir`) precisa ser um checkout com a branch HEAD da PR já
 * checked-out — `runPromptRegressionEval`/`readAgentBodyFromDisk` lê o
 * corpo CANDIDATO do agent do DISCO, não da API do GitHub (só o passo de
 * DETECÇÃO de gatilho abaixo usa a API — ver "Detecção do gatilho" logo
 * adiante). O script faz uma checagem best-effort (compara `git rev-parse
 * HEAD` local contra o `headRefOid` da PR) e AVISA se não bater, mas não
 * aborta — pode haver motivo legítimo (testar mudança local ainda não
 * pusheada).
 *
 * ## Compatibilidade com o `gh` 2.46.0 (#8403)
 *
 * O SHA base da PR vem de `gh api repos/{owner}/{repo}/pulls/{n}`
 * (`.base.sha`), não de `gh pr view --json baseRefOid`: o `gh` do servidor
 * `300` é 2.46.0 e não conhece esse campo. Ver `fetchPrBaseSha` para o
 * porquê de `.base.sha` (e não o merge-base) preservar a semântica.
 *
 * ## Detecção do gatilho — via API do GitHub, não via disco local
 *
 * Ao contrário do corpo candidato (lido do disco, ver acima), a detecção
 * "isso dispara o eval" usa `gh api repos/{owner}/{repo}/contents/{path}?ref={sha}`
 * pra buscar o conteúdo ANTIGO (base) e NOVO (head) de cada
 * `.claude/agents/*.md` tocado — deliberado: a esteira que chama este
 * script pode estar rodando de um worktree que nunca fetchou os commits
 * exatos da PR (`git show {sha}:{path}` local falharia), então buscar via
 * API é a via robusta. Mesma lógica pura de
 * `scripts/lib/agent-eval-trigger-allowlist.ts` que `check-agent-eval-required.ts`
 * usa (via `git show` local, porque o runner do Actions SEMPRE tem os 2
 * SHAs fetchados com `fetch-depth: 0`) — só a FONTE do conteúdo difere
 * entre os dois chamadores, a decisão em si é a mesma função.
 *
 * ## Grader anti-fabricação de MCP (#8144 escopo) — TODO, não aplicável hoje
 *
 * Nenhum dos 2 agents cobertos pelo harness (`writer-destaque`,
 * `social-writer`) declara ferramenta MCP no frontmatter `tools:` hoje —
 * `agentDeclaresMcpTools` confirma isso lendo o frontmatter de verdade (não
 * uma suposição hardcoded). Enquanto isso for verdade, não há chamada de
 * MCP pra verificar fabricação sobre — o comentário da PR relata essa
 * checagem explicitamente como "não aplicável", nunca inventa um grader sem
 * o que checar. Se um dos 2 agents ganhar uma tool MCP no futuro, este é o
 * ponto certo pra adicionar o grader real (issue de follow-up, fora do
 * escopo da #8144).
 *
 * ## Delta de custo (#8144 escopo) — best-effort via cost.json existente
 *
 * `eval-prompt-regression.ts` já grava `_internal/cost.json` por lado
 * (baseline/candidato) de cada fixture quando `--live` (`writeCostArtifact`,
 * `scripts/lib/edition-cost.ts`) — este script só LÊ os dois
 * (`readCostArtifactFromDisk`) e soma `aggregate.overall.subagent_tokens`,
 * nunca reimplementa medição de custo. Reportado sempre que `--live` e os 2
 * artefatos existem; destacado explicitamente no comentário quando `model:`
 * mudou (é o caso em que o delta de custo é mais informativo — troca de
 * modelo tem preço por token diferente).
 *
 * ## Uso
 *
 *   # dry-run (default) — mostra o plano (agents/edições/repetições),
 *   # NUNCA spawna `claude`, não posta comentário nem aplica label:
 *   npx tsx scripts/run-agent-eval-for-pr.ts --pr 8200
 *
 *   # rodada real — gasta token de verdade (assinatura claude.ai), posta
 *   # comentário e aplica a label `agent-eval:passed`:
 *   npx tsx scripts/run-agent-eval-for-pr.ts --pr 8200 --live \
 *     --reference-editions 260901,260902,260903
 *
 * Sem `--reference-editions`, deriva as `--num-editions` (default 3) mais
 * recentes sob `--editions-dir` (default `data/editions`) que já têm
 * `_internal/01-approved.json` em disco — mesmo espírito de
 * `find-current-edition.ts`, decisão automática com log explícito em vez de
 * exigir o operador digitar a lista toda vez (#5321, "perguntar é exceção").
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { extractFrontmatter } from "./validate-agent-frontmatter.ts";
import { classifyAgentEvalEligibility, evaluateAgentEvalTrigger, AGENT_FILE_RE, type AgentEvalTriggerVerdict, type PromptEvalAgent } from "./lib/agent-eval-trigger-allowlist.ts";
import { runPromptRegressionEval, DEFAULT_REPETITIONS, DEFAULT_BASELINE_REF, type PromptRegressionEvalReport } from "./eval-prompt-regression.ts";
import { readCostArtifactFromDisk } from "./lib/edition-cost.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import { AGENT_EVAL_LABEL } from "./check-agent-eval-required.ts";
import { ClaudeCliError } from "./lib/claude-cli-subprocess.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_NUM_EDITIONS = 3;

// ---------------------------------------------------------------------------
// gh CLI — runner injetável (mesmo padrão de scripts/lib/gh-open-pr-fetch.ts,
// #7788: testável sem bater na API real).
// ---------------------------------------------------------------------------

export interface CommandRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[]) => CommandRunnerResult;

export const defaultRunner: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").toString() };
};

export interface PrMeta {
  number: number;
  url: string;
  title: string;
  baseRefOid: string;
  headRefOid: string;
  files: string[];
}

const SHA40_RE = /^[0-9a-f]{40}$/;

/**
 * SHA base da PR via API REST (`repos/{owner}/{repo}/pulls/{n}` → `.base.sha`)
 * em vez de `gh pr view --json baseRefOid` (#8403).
 *
 * **Por que não `--json baseRefOid`:** o `gh` do servidor `300` é 2.46.0 e
 * não expõe esse campo — `gh pr view ... --json ...,baseRefOid` aborta com
 * `Unknown JSON field: "baseRefOid"`, matando o script inteiro antes de
 * qualquer eval (e deixando o check `Check agent-eval gate` impossível de
 * satisfazer nessa máquina). Mesma classe do #6225 (`gh pr checks --json`
 * inexistente no 2.46.0, ver `scripts/lib/pr-checks-gate.ts`): a correção é
 * adaptar o script à versão que a distro entrega, nunca exigir um `gh` mais
 * novo.
 *
 * **Por que `.base.sha` e não o merge-base:** `.base.sha` do REST é
 * exatamente o mesmo valor que o `baseRefOid` do GraphQL — ambos leem o
 * `base_sha` gravado no registro da PR (verificado ao vivo na PR #8401 em
 * 19/09/2026: REST `.base.sha` e GraphQL `baseRefOid` devolveram o mesmo
 * `0e758609…`). O **merge-base** (`compare/{base}...{head}` →
 * `.merge_base_commit.sha`) é OUTRO commit sempre que o base ref andou entre
 * o fork da branch e a abertura da PR (na mesma #8401 deu `8c02a79a…`, 1
 * commit antes) — trocar por ele mudaria a semântica do conteúdo "antigo"
 * comparado por `fetchFileContentAtRef`, então não é a substituição certa.
 *
 * Falha ALTO (lança) em qualquer erro do `gh` ou se a saída não for um SHA
 * de 40 hex — nunca degrada pra string vazia, que faria
 * `fetchFileContentAtRef` buscar um ref inválido e (via 404) concluir
 * "arquivo ausente na base", ou seja, um trigger de eval fabricado.
 */
export function fetchPrBaseSha(prNumber: string, runner: CommandRunner): string {
  const r = runner("gh", ["api", `repos/{owner}/{repo}/pulls/${prNumber}`, "--jq", ".base.sha"]);
  if (r.status !== 0) {
    throw new Error(`[#8403] gh api repos/{owner}/{repo}/pulls/${prNumber} (.base.sha) falhou: ${r.stderr || `exit ${r.status}`}`);
  }
  const sha = r.stdout.trim();
  if (!SHA40_RE.test(sha)) {
    throw new Error(`[#8403] base.sha da PR ${prNumber} não é um SHA de 40 hex (recebido: ${JSON.stringify(sha)}) — abortando em vez de seguir com ref inválido.`);
  }
  return sha;
}

export function fetchPrMeta(prNumber: string, runner: CommandRunner): PrMeta {
  // `number,url,title,headRefOid,files` são todos suportados no gh 2.46.0
  // (conferido ao vivo); só `baseRefOid` não é — ele vem do REST, acima.
  const r = runner("gh", ["pr", "view", prNumber, "--json", "number,url,title,headRefOid,files"]);
  if (r.status !== 0) {
    throw new Error(`[#8144] gh pr view ${prNumber} falhou: ${r.stderr || `exit ${r.status}`}`);
  }
  let parsed: { number: number; url: string; title: string; headRefOid: string; files: Array<{ path: string }> };
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(`[#8144] gh pr view ${prNumber} devolveu JSON inválido: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    number: parsed.number,
    url: parsed.url,
    title: parsed.title,
    baseRefOid: fetchPrBaseSha(prNumber, runner),
    headRefOid: parsed.headRefOid,
    files: (parsed.files ?? []).map((f) => f.path),
  };
}

/**
 * Busca o conteúdo de 1 arquivo num ref específico via API REST do GitHub —
 * `{owner}`/`{repo}` resolvidos automaticamente pelo `gh api` a partir do
 * repositório do `cwd` (nenhum owner/repo hardcoded). `null` **só** quando o
 * arquivo genuinamente NÃO EXISTE naquele ref (404 confirmado no `stderr`) —
 * mesma convenção de `gitShowFileAtSha` (diff-touched-lines.ts).
 *
 * **Qualquer outra falha (rate limit 403, token expirado 401, 5xx, timeout
 * de rede) LANÇA em vez de devolver `null`** (#8144 fix — achados
 * independentes de `pr-test-analyzer` e `silent-failure-hunter` no fleet
 * review da PR #8173). Antes desta correção, `r.status !== 0` colapsava
 * "arquivo ausente" e "falha de infra" no mesmo `null` — se as DUAS
 * chamadas (`getOldContent`/`getNewContent` pro mesmo agent) falhassem por
 * motivo de infra, `evaluateAgentEvalTrigger` recebia `(null, null)` e
 * concluía `triggers: false`, tornando uma mudança REAL de prompt
 * indistinguível de "nada mudou" — exatamente o modo de falha que este gate
 * de CI existe pra prevenir. `main()` (nível superior) já é `async` e
 * envolvido em `.catch(() => process.exit(1))`, então esta exceção vira
 * `exit` não-zero sem precisar de try/catch adicional nos chamadores.
 */
export function fetchFileContentAtRef(path: string, ref: string, runner: CommandRunner): string | null {
  const r = runner("gh", ["api", `repos/{owner}/{repo}/contents/${path}?ref=${ref}`, "--jq", ".content"]);
  if (r.status !== 0) {
    if (/HTTP 404|Not Found/i.test(r.stderr)) return null; // arquivo genuinamente ausente naquele ref
    throw new Error(`[#8144] falha ao buscar ${path}@${ref} via gh api (não é 404 — provável falha de infra, ex: rate limit/token expirado/5xx): ${r.stderr || `exit ${r.status}`}`);
  }
  const b64 = r.stdout.trim();
  if (!b64 || b64 === "null") return null;
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
}

export function addLabel(prNumber: string, label: string, runner: CommandRunner): void {
  const r = runner("gh", ["pr", "edit", prNumber, "--add-label", label]);
  if (r.status !== 0) {
    throw new Error(`[#8144] gh pr edit ${prNumber} --add-label ${label} falhou: ${r.stderr || `exit ${r.status}`}`);
  }
}

export function postComment(prNumber: string, bodyFilePath: string, runner: CommandRunner): void {
  const r = runner("gh", ["pr", "comment", prNumber, "--body-file", bodyFilePath]);
  if (r.status !== 0) {
    throw new Error(`[#8144] gh pr comment ${prNumber} falhou: ${r.stderr || `exit ${r.status}`}`);
  }
}

// ---------------------------------------------------------------------------
// Lógica pura — testável sem gh/disco real.
// ---------------------------------------------------------------------------

export interface TriggeringAgent {
  agent: PromptEvalAgent;
  verdict: AgentEvalTriggerVerdict;
}

/**
 * Filtra `changedFiles` pros `.claude/agents/{agent}.md` MAPEADOS
 * (`classifyAgentEvalEligibility`) cuja mudança dispara o eval
 * (`evaluateAgentEvalTrigger`). Agents excluídos/não-classificados nunca
 * entram aqui — mesma decisão de `check-agent-eval-required.ts`, reusando a
 * MESMA lib (`scripts/lib/agent-eval-trigger-allowlist.ts`), nunca uma 2ª
 * implementação da regra.
 */
export function findTriggeringAgents(changedFiles: string[], getOldContent: (path: string) => string | null, getNewContent: (path: string) => string | null): TriggeringAgent[] {
  const out: TriggeringAgent[] = [];
  for (const path of changedFiles) {
    const m = AGENT_FILE_RE.exec(path);
    if (!m) continue;
    const eligibility = classifyAgentEvalEligibility(m[1]);
    if (eligibility.status !== "mapped") continue;
    const verdict = evaluateAgentEvalTrigger(eligibility.agent, getOldContent(path), getNewContent(path));
    if (verdict.triggers) out.push({ agent: eligibility.agent, verdict });
  }
  return out;
}

/** `true` se o valor do campo `tools:` do frontmatter cita alguma ferramenta `mcp__*`. Deriva do arquivo real (nunca hardcoded) — ver docstring do módulo, seção "Grader anti-fabricação de MCP". `content === null` (arquivo ausente) devolve `false` — sem tools declaradas, sem MCP. */
export function agentDeclaresMcpTools(content: string | null): boolean {
  if (content === null) return false;
  const fm = extractFrontmatter(content);
  if (fm === null) return false;
  const m = fm.match(/^tools:\s*(.+)$/m);
  if (!m) return false;
  return /mcp__/.test(m[1]);
}

/** Dado os nomes de subdiretório sob `editionsRootDir` (ex: `readdirSync` já filtrado por `withFileTypes`), devolve as `limit` edições AAMMDD mais recentes que `hasApprovedJson` confirma terem fixture utilizável — ordenado ASCENDENTE (mesma convenção de `candidates[candidates.length - 1]` usada em outras skills deste repo pra "a mais recente"). `hasApprovedJson` é injetável pra testar sem disco real. */
export function pickDefaultReferenceEditions(dirNames: string[], hasApprovedJson: (dirName: string) => boolean, limit: number = DEFAULT_NUM_EDITIONS): string[] {
  const candidates = dirNames.filter((d) => /^\d{6}$/.test(d) && hasApprovedJson(d)).sort();
  return candidates.slice(Math.max(0, candidates.length - limit));
}

export interface CostDelta {
  agent: PromptEvalAgent;
  edition: string;
  baselineTokens: number | null;
  candidateTokens: number | null;
  deltaTokens: number | null;
}

/** `null` em qualquer lado quando o `cost.json` correspondente não existe (dry-run, ou falha de parse — `readCostArtifactFromDisk` já devolve `null` nesse caso) — nunca um delta fabricado sobre dado ausente. */
export function computeCostDelta(agent: PromptEvalAgent, edition: string, baselineTotal: number | null, candidateTotal: number | null): CostDelta {
  return {
    agent,
    edition,
    baselineTokens: baselineTotal,
    candidateTokens: candidateTotal,
    deltaTokens: baselineTotal !== null && candidateTotal !== null ? candidateTotal - baselineTotal : null,
  };
}

export interface AgentEvalPrReportInput {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  triggering: TriggeringAgent[];
  reports: Partial<Record<PromptEvalAgent, PromptRegressionEvalReport>>;
  costDeltas: CostDelta[];
  mcpApplicable: boolean;
  live: boolean;
}

/**
 * Agrega os vereditos (`regressed`/`improved`/`unchanged`/`inconclusive`,
 * `GraderRegressionVerdict` de `scripts/lib/prompt-regression-eval.ts`) de
 * TODOS os agents/edições/graders já presentes em `input.reports` — sem
 * recalcular nada, só soma o que a função já recebe estruturado. `null`
 * quando não há nenhum delta disponível (dry-run, ou nenhum report
 * registrado) — nunca um "0/0/0" fabricado sobre dado ausente.
 */
function summarizeAgentEvalVerdicts(input: AgentEvalPrReportInput): { regressed: number; improved: number; unchangedOrInconclusive: number } | null {
  let regressed = 0;
  let improved = 0;
  let unchangedOrInconclusive = 0;
  let any = false;
  for (const t of input.triggering) {
    const report = input.reports[t.agent];
    if (!report || report.dry_run) continue;
    for (const e of report.editions) {
      for (const d of e.deltas) {
        any = true;
        if (d.verdict === "regressed") regressed++;
        else if (d.verdict === "improved") improved++;
        else unchangedOrInconclusive++; // "unchanged" | "inconclusive"
      }
    }
  }
  return any ? { regressed, improved, unchangedOrInconclusive } : null;
}

/** Renderização pura (markdown) — usada tanto pro arquivo persistido em `data/reports/agent-eval/` quanto (versão resumida) pro comentário da PR. Nunca toca disco/rede. */
export function renderAgentEvalPrReport(input: AgentEvalPrReportInput): string {
  const lines: string[] = [];
  lines.push(`# Eval de regressão de prompt — PR #${input.prNumber}`);
  lines.push("");
  lines.push(`PR: ${input.prUrl}`);
  lines.push(`Título: ${input.prTitle}`);
  lines.push(`Modo: ${input.live ? "LIVE (agent real rodou, custo real)" : "DRY-RUN (nenhum agent rodou)"}`);
  lines.push("");
  // Resumo agregado NO TOPO (#8144 fix, achado silent-failure-hunter na PR
  // #8173): a label `agent-eval:passed` significa "o eval rodou e está
  // registrado", NUNCA "passou sem regressão" — é warning-only por desenho
  // (ver rodapé). Sem este aviso explícito logo no início, o veredito real
  // fica enterrado por grader/edição, e quem só olha a label/check da PR
  // pode ler "passed" como "sem problema".
  lines.push(`**Este selo NÃO significa "sem regressão" — significa "o eval rodou e foi registrado". Ver vereditos por grader abaixo.**`);
  const verdictSummary = summarizeAgentEvalVerdicts(input);
  if (verdictSummary) {
    lines.push(
      `${verdictSummary.regressed} regressão(ões) / ${verdictSummary.improved} melhoria(s) / ${verdictSummary.unchangedOrInconclusive} inconclusive/unchanged encontrada(s).`,
    );
  }
  lines.push("");
  lines.push("## Agents que dispararam o eval");
  lines.push("");
  for (const t of input.triggering) {
    lines.push(`- **${t.agent}** — ${t.verdict.reason}`);
  }
  lines.push("");

  for (const t of input.triggering) {
    const report = input.reports[t.agent];
    lines.push(`## ${t.agent}`);
    lines.push("");
    if (!report) {
      lines.push("_eval não rodou pra este agent (ver log de execução)._");
      lines.push("");
      continue;
    }
    lines.push(`baseline_ref=${report.baseline_ref} repetitions=${report.repetitions} dry_run=${report.dry_run}`);
    lines.push("");
    for (const e of report.editions) {
      lines.push(`### edição ${e.edition}`);
      lines.push("");
      if (report.dry_run) {
        lines.push("_dry-run — sem veredito de grader._");
      } else {
        for (const d of e.deltas) {
          lines.push(`- ${d.name}: **${d.verdict}**`);
        }
      }
      const costRows = input.costDeltas.filter((c) => c.agent === t.agent && c.edition === e.edition);
      for (const c of costRows) {
        if (c.baselineTokens === null && c.candidateTokens === null) continue;
        const deltaStr = c.deltaTokens === null ? "indisponível" : c.deltaTokens > 0 ? `+${c.deltaTokens}` : String(c.deltaTokens);
        const highlight = t.verdict.modelChanged ? " (model: mudou — delta relevante)" : "";
        lines.push(`- custo: baseline=${c.baselineTokens ?? "?"} candidato=${c.candidateTokens ?? "?"} delta=${deltaStr} tokens${highlight}`);
      }
      lines.push("");
    }
  }

  lines.push("## Grader anti-fabricação de MCP");
  lines.push("");
  lines.push(
    input.mcpApplicable
      ? "_pelo menos 1 agent triado declara ferramenta MCP — grader anti-fabricação NÃO implementado nesta versão (#8144 escopo), TODO de follow-up._"
      : "não aplicável hoje — nenhum dos agents triados (`writer-destaque`, `social-writer`) declara ferramenta `mcp__*` no frontmatter `tools:` (conferido no conteúdo real, não hardcoded). Sem chamada de MCP, não há o que um grader anti-fabricação verificasse. TODO se isso mudar.",
  );
  lines.push("");
  lines.push(`_Warning-only (#8144) — este relatório não bloqueia merge sozinho. Registrado em data/reports/index.jsonl (kind "agent-eval")._`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const prNumber = values["pr"];
  const live = flags.has("live");
  const repetitions = values["repetitions"] ? Number(values["repetitions"]) : DEFAULT_REPETITIONS;
  const baselineRef = values["baseline-ref"] ?? DEFAULT_BASELINE_REF;
  const numEditions = values["num-editions"] ? Number(values["num-editions"]) : DEFAULT_NUM_EDITIONS;
  const editionsRootDir = resolve(ROOT, values["editions-dir"] ?? "data/editions");

  if (!prNumber) {
    console.error("Uso: run-agent-eval-for-pr.ts --pr <N> [--repetitions N] [--reference-editions AAMMDD,...] [--baseline-ref REF] [--editions-dir path] [--num-editions N] [--live]");
    process.exit(2);
    return;
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    console.error(`[error] --repetitions deve ser um inteiro ≥ 1, recebido "${values["repetitions"]}"`);
    process.exit(2);
    return;
  }
  if (!Number.isInteger(numEditions) || numEditions < 1) {
    // Self-review (#2038): sem este guard, "--num-editions abc" vira NaN,
    // que `pickDefaultReferenceEditions`/`Array.prototype.slice` trata como
    // 0 em silêncio — TODAS as edições candidatas entrariam na rodada em vez
    // de um erro claro, mesma classe de falha silenciosa que motivou
    // `getIntArg` (scripts/lib/cli-args.ts, #4497).
    console.error(`[error] --num-editions deve ser um inteiro ≥ 1, recebido "${values["num-editions"]}"`);
    process.exit(2);
    return;
  }

  const runner = defaultRunner;

  let prMeta: PrMeta;
  try {
    prMeta = fetchPrMeta(prNumber, runner);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  // Checagem best-effort (#8144 docstring) — NUNCA aborta, só avisa: pode
  // haver motivo legítimo pro cwd não estar exatamente no head da PR.
  const localHead = runner("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (localHead && localHead !== prMeta.headRefOid) {
    console.warn(
      `[#8144] AVISO: HEAD local (${localHead.slice(0, 8)}) difere do headRefOid da PR #${prNumber} (${prMeta.headRefOid.slice(0, 8)}) — ` +
        `o corpo CANDIDATO do agent é lido do DISCO (rootDir=${ROOT}), então este comando precisa rodar com a branch da PR já checked-out pra refletir o diff real.`,
    );
  }

  const agentFiles = prMeta.files.filter((f) => AGENT_FILE_RE.test(f));
  const triggering = findTriggeringAgents(
    agentFiles,
    (path) => fetchFileContentAtRef(path, prMeta.baseRefOid, runner),
    (path) => fetchFileContentAtRef(path, prMeta.headRefOid, runner),
  );

  if (triggering.length === 0) {
    console.log(`[#8144] PR #${prNumber}: nenhum agent elegível (corpo/model: de writer-destaque ou social-writer) dispara o eval — nada a rodar.`);
    process.exit(0);
    return;
  }

  console.log(`[#8144] PR #${prNumber}: eval disparado pra ${triggering.map((t) => t.agent).join(", ")}.`);
  for (const t of triggering) console.log(`  - ${t.agent}: ${t.verdict.reason}`);

  const mcpApplicable = triggering.some((t) => {
    const content = fetchFileContentAtRef(`.claude/agents/${t.agent}.md`, prMeta.headRefOid, runner);
    return agentDeclaresMcpTools(content);
  });

  let referenceEditions: string[];
  if (values["reference-editions"]) {
    referenceEditions = values["reference-editions"].split(",").map((s) => s.trim()).filter(Boolean);
  } else if (existsSync(editionsRootDir)) {
    const dirNames = readdirSync(editionsRootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    referenceEditions = pickDefaultReferenceEditions(dirNames, (d) => existsSync(join(editionsRootDir, d, "_internal", "01-approved.json")), numEditions);
    console.log(`[#8144] --reference-editions omitido — derivadas automaticamente: ${referenceEditions.join(",") || "(nenhuma)"} (#5321, default declarado em vez de perguntar).`);
  } else {
    referenceEditions = [];
  }

  if (referenceEditions.length === 0) {
    console.error(
      `[#8144] Nenhuma edição de referência disponível sob ${editionsRootDir} (junction data/ ausente neste checkout, ou nenhuma edição com _internal/01-approved.json) — ` +
        `passe --reference-editions AAMMDD,... explicitamente, ou rode numa máquina com a junction data/ (CLAUDE.md §2b).`,
    );
    process.exit(1);
    return;
  }

  const reports: Partial<Record<PromptEvalAgent, PromptRegressionEvalReport>> = {};
  for (const t of triggering) {
    reports[t.agent] = runPromptRegressionEval({
      agent: t.agent,
      referenceEditions,
      editionsRootDir,
      baselineRef,
      repetitions,
      dryRun: !live,
      rootDir: ROOT,
    });
  }

  const costDeltas: CostDelta[] = [];
  if (live) {
    for (const t of triggering) {
      const report = reports[t.agent];
      if (!report) continue;
      for (const e of report.editions) {
        const baselineArtifact = readCostArtifactFromDisk(join(editionsRootDir, e.baseline.testDirName));
        const candidateArtifact = readCostArtifactFromDisk(join(editionsRootDir, e.candidate.testDirName));
        costDeltas.push(computeCostDelta(t.agent, e.edition, baselineArtifact?.aggregate.overall.subagent_tokens ?? null, candidateArtifact?.aggregate.overall.subagent_tokens ?? null));
      }
    }
  }

  const reportInput: AgentEvalPrReportInput = {
    prNumber: prMeta.number,
    prUrl: prMeta.url,
    prTitle: prMeta.title,
    triggering,
    reports,
    costDeltas,
    mcpApplicable,
    live,
  };
  const markdown = renderAgentEvalPrReport(reportInput);
  console.log("");
  console.log(markdown);

  if (!live) {
    console.log("");
    console.log("[#8144] DRY-RUN — nenhum comentário postado, nenhuma label aplicada, nada registrado. Rode com --live pra executar de verdade e liberar o gate.");
    process.exit(0);
    return;
  }

  const outDir = resolve(ROOT, "data", "reports", "agent-eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `pr-${prMeta.number}.md`);
  writeFileSync(outPath, markdown, "utf8");
  const relOutPath = `data/reports/agent-eval/pr-${prMeta.number}.md`;

  const registerResult = registerReport(
    ROOT,
    { kind: "agent-eval", sessionId: String(prMeta.number), title: `Eval de agent — PR #${prMeta.number} (${triggering.map((t) => t.agent).join(", ")})`, htmlPath: relOutPath },
    undefined,
    false, // #8144: sem e-mail automático — o sinal certo é a label + comentário na própria PR, mesma decisão de "calibration" (#7978)
  );
  if (!registerResult.ok) {
    console.error(`[#8144] registro em data/reports/index.jsonl falhou (fail-soft, relatório já foi escrito em disco): ${registerResult.error}`);
  }

  // Self-review (#2038): label ANTES do comentário, deliberado — `gh pr edit
  // --add-label` num label já presente é um no-op idempotente, então um
  // retry após falha de rede aqui nunca duplica nada. Se a ORDEM fosse
  // invertida (comentário primeiro), um retry depois de um `addLabel` que
  // falhasse re-postaria um 2º comentário idêntico antes de tentar a label
  // de novo — a ordem atual evita essa classe de duplicação sem precisar de
  // um mecanismo de dedup dedicado.
  try {
    addLabel(prNumber, AGENT_EVAL_LABEL, runner);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  // Reusa o mesmo arquivo persistido em disco (outPath) como --body-file do
  // comentário — nunca um 2º arquivo temporário duplicado, e nunca monta o
  // corpo via printf/echo -e (rule #6004, CLAUDE.md/overnight-dispatch-rules
  // item 19: `%` em taxa/CTR corromperia o corpo em silêncio).
  try {
    postComment(prNumber, outPath, runner);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  console.log(`[#8144] Eval registrado (${outPath}), comentário postado e label "${AGENT_EVAL_LABEL}" aplicada na PR #${prMeta.number}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    // #8405: quando o erro vem do subprocesso `claude` (ClaudeCliError),
    // imprimimos status/stdout/stderr — que é onde está a causa real
    // (ex: `--max-turns` esgotado, `maxBuffer` estourado, cwd sem
    // permissão). Antes, só `error.message` era impresso, ecoando ~30KB
    // de prompt e deixando o stderr invisível — a única saída visível era
    // o eco do prompt, sem nenhuma pista.
    if (err instanceof ClaudeCliError) {
      const s = (err.stderr || "(vazio)").length > 1200 ? err.stderr!.slice(0, 1200) + "\n… [truncado — leia err.stderr completo]" : (err.stderr || "(vazio)");
      const o = (err.stdout || "(vazio)").length > 1200 ? err.stdout!.slice(0, 1200) + "\n… [truncado — leia err.stdout completo]" : (err.stdout || "(vazio)");
      console.error(
        `[#8144] claude CLI falhou (status ${err.status ?? "sinal"}):\n` +
          `  stderr (próx. ${s.length} chars): ${s}\n` +
          `  stdout (próx. ${o.length} chars): ${o}\n` +
          `  command (prompt truncado): ${err.command}`,
      );
    }
    console.error("[#8144] erro inesperado:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
