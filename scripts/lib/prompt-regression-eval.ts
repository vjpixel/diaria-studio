/**
 * scripts/lib/prompt-regression-eval.ts (#8143)
 *
 * Camada de EXECUÇÃO que faltava na dupla `replay-stage-input.ts`
 * (congela fixture de input, #3833) + `distillation-backtest.ts`
 * (mede taxa histórica de violação, read-only, #7981). Nenhum dos dois
 * dispara o agent de verdade sobre o fixture e compara prompt-candidato ×
 * prompt-master no MESMO input — é essa metade que este módulo cobre,
 * pros dois agents com mais correção capturada em `_internal/
 * editor-requests.jsonl` (`writer-destaque`, `social-writer`).
 *
 * ## Escopo desta 1ª versão (issue #8143)
 *
 * - Só graders MECÂNICOS, reusando o que `distillation-backtest.ts` já
 *   importa (`checkCarouselTextOverflow`, `checkBannedLexicon`,
 *   `runStage2LintReport`) + `checkTitleLengths` (`lint-checks/
 *   title-length.ts`) pro título ≤52 chars. **Zero checagem nova.**
 * - **Desvio deliberado do texto da issue**: a issue cita
 *   `title_char_count` de `ScoringFeatureRow` (`scoring-features.ts`) como
 *   a fonte do grader de título. Esse campo é `title.length` do artigo de
 *   ORIGEM (`01-approved.json`/`01-categorized.json`) — um INPUT que não
 *   muda entre prompt-master e prompt-candidato, porque nenhum dos dois
 *   reescreve o artigo de origem. Usá-lo produziria o MESMO valor nos dois
 *   lados da comparação pareada, sempre — grader sem poder de
 *   discriminação nenhum, o oposto do que a comparação pareada precisa.
 *   `checkTitleLengths` (já existente, zero lógica nova — só a escolha de
 *   QUAL checker mecânico já existente reusar) mede o título que o
 *   `writer-destaque` de fato ESCREVEU (extraído do `**DESTAQUE N | ...**`
 *   que ele produz), então É sensível à mudança de prompt. Mesmo
 *   constante `MAX_TITLE_LENGTH = 52`.
 * - Juiz LLM de tom (`runHolisticCritique`/`social-critic.md`),
 *   CTR como métrica, e qualquer coisa que toque Stage 5/6 (publicadores)
 *   ficam explicitamente FORA — ver corpo da issue #8143.
 *
 * ## Repetição com maioria (#8143 item 4, mesma mitigação C-6 da #7972)
 *
 * `checkRepetitionConsistency` roda o MESMO prompt (mesma versão, mesmo
 * fixture) N vezes e só produz um veredito por grader se TODAS as N
 * repetições concordarem — divergência entre repetições NUNCA decide por
 * maioria simples (mesmo desenho de `runHolisticCritique`,
 * `holistic-critique.ts`), ela INVALIDA o ponto de dado
 * (`consistent: false`, `agreedOk: null`).
 *
 * ## Comparação pareada (#8143 item 3)
 *
 * `compareBaselineVsCandidate` nunca reporta nota absoluta isolada — só
 * delta baseline×candidato sobre o MESMO fixture. Se qualquer um dos dois
 * lados não convergiu na repetição, o grader inteiro vira `inconclusive`
 * pra aquele caso, nunca um "regrediu"/"melhorou" fabricado sobre dado
 * ruim.
 *
 * ## Execução real (#8143 item 1)
 *
 * `runAgentRepetitions` chama `callClaudeCli` (`claude-cli-subprocess.ts`)
 * — reusa o wrapper, nunca reimplementa spawn nem filtragem de ambiente
 * (#5608/#6714, restrição não-negociável já documentada naquele módulo).
 * Sempre `outputFormat: "json"` nas chamadas reais, pra medir custo real
 * (`parseClaudeCliJsonResult`) em vez de estimar — mesmo requisito do
 * `record-agent-costs.ts` de "gasto medido, não estimado".
 *
 * ## Default dry-run (#8143 item 6)
 *
 * Este módulo nunca decide sozinho se roda ao vivo — `runAgentRepetitions`
 * recebe `dryRun` explícito do chamador (CLI: `scripts/eval-prompt-
 * regression.ts`, default `true`, só `false` com `--live`), mesmo padrão
 * de `distill-prompt-corrections.ts`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { checkCarouselTextOverflow } from "./invariant-checks/stage-4.ts";
import { checkBannedLexicon } from "./lint-checks/banned-lexicon.ts";
import { checkTitleLengths, MAX_TITLE_LENGTH } from "./lint-checks/title-length.ts";
import { runStage2LintReport } from "../lint-newsletter-md.ts";
import { callClaudeCli, type ClaudeCliCallOptions } from "./claude-cli-subprocess.ts";

export const PROMPT_EVAL_AGENTS = ["writer-destaque", "social-writer"] as const;
export type PromptEvalAgent = (typeof PROMPT_EVAL_AGENTS)[number];

export function isPromptEvalAgent(value: string): value is PromptEvalAgent {
  return (PROMPT_EVAL_AGENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Graders mecânicos — uniformizados numa única interface.
// ---------------------------------------------------------------------------

export interface GraderVerdict {
  name: string;
  /** `false` quando o grader não pôde rodar (input ausente/malformado) — NUNCA conta como sucesso nem falha (mesmo princípio de "não avaliável" de `distillation-backtest.ts`). */
  evaluable: boolean;
  /** `null` quando `!evaluable`. */
  ok: boolean | null;
  detail?: unknown;
}

function evaluableVerdict(name: string, ok: boolean, detail?: unknown): GraderVerdict {
  return { name, evaluable: true, ok, detail };
}

function notEvaluableVerdict(name: string, reason: string): GraderVerdict {
  return { name, evaluable: false, ok: null, detail: { reason } };
}

/**
 * `checkBannedLexicon` (#7260) — aplica-se a qualquer texto PT-BR publicado
 * por qualquer um dos 2 agents, sem diferença de forma.
 */
function gradeBannedLexicon(rawText: string): GraderVerdict {
  try {
    const report = checkBannedLexicon(rawText);
    return evaluableVerdict("banned-lexicon", report.ok, report.errors);
  } catch (err) {
    return evaluableVerdict("banned-lexicon", false, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `checkTitleLengths` (`lint-checks/title-length.ts`) — só faz sentido pra
 * `writer-destaque`, que emite o header `**DESTAQUE N | ...**` seguido das
 * 3 opções de título que este checker extrai. `social-writer` não escreve
 * título de destaque (escreve corpo de post social) — grader marcado
 * não-avaliável nesse caso, nunca fabricado como "ok".
 */
function gradeTitleLength(agent: PromptEvalAgent, rawText: string): GraderVerdict {
  if (agent !== "writer-destaque") {
    return notEvaluableVerdict("title-length-52-chars", `agent "${agent}" não escreve título de destaque — grader aplicável só a writer-destaque.`);
  }
  try {
    const report = checkTitleLengths(rawText);
    return evaluableVerdict("title-length-52-chars", report.ok, report.errors);
  } catch (err) {
    return evaluableVerdict("title-length-52-chars", false, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `checkCarouselTextOverflow` (#6078) — lê `{editionDir}/03-social.md` do
 * DISCO (não recebe texto por parâmetro). Só faz sentido pra
 * `social-writer` (é quem escreve o corpo `## d{N}` que vira slide de
 * carrossel). O CHAMADOR é responsável por já ter escrito
 * `03-social.md` (envelopado em `# Social\n...`, ver
 * `wrapSocialWriterOutputForGrading`) em `editionDir` antes de chamar este
 * grader.
 */
function gradeCarouselOverflow(agent: PromptEvalAgent, editionDir: string): GraderVerdict {
  if (agent !== "social-writer") {
    return notEvaluableVerdict("carousel-text-overflow", `agent "${agent}" não escreve o corpo do carrossel — grader aplicável só a social-writer.`);
  }
  if (!existsSync(join(editionDir, "03-social.md"))) {
    return notEvaluableVerdict("carousel-text-overflow", "03-social.md ausente no diretório de fixture — grader não avaliável.");
  }
  try {
    const violations = checkCarouselTextOverflow(editionDir);
    return evaluableVerdict("carousel-text-overflow", violations.length === 0, violations);
  } catch (err) {
    return evaluableVerdict("carousel-text-overflow", false, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `runStage2LintReport` (`lint-newsletter-md.ts`) — lê arquivos FIXOS
 * (`_internal/02-draft.md` + `_internal/01-approved-capped.json`) de
 * `editionDir`. Este agregado cobre MÚLTIPLOS checks de uma vez (url-bucket,
 * section-counts, destaque-min/max-chars, why-matters-length,
 * aprofunde-format) — todos gate-blocking do Stage 2 real. Só avaliável
 * quando o chamador montou esse par de arquivos no fixture (best-effort:
 * `runAgentRepetitions` faz isso pro `writer-destaque`, escrevendo o
 * fragmento produzido como se fosse o `02-draft.md` inteiro — aproximação
 * aceitável pra 1 destaque isolado, já que os checks operam por destaque
 * dentro do documento).
 */
function gradeStage2LintReport(editionDir: string, rootDir: string): GraderVerdict {
  const draftPath = join(editionDir, "_internal", "02-draft.md");
  if (!existsSync(draftPath)) {
    return notEvaluableVerdict("newsletter-lint-gate-blocking", "_internal/02-draft.md ausente no diretório de fixture — grader não avaliável.");
  }
  try {
    const report = runStage2LintReport(editionDir, rootDir);
    return evaluableVerdict("newsletter-lint-gate-blocking", report.passed, report.checks);
  } catch (err) {
    return evaluableVerdict("newsletter-lint-gate-blocking", false, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Roda os 4 graders reusados (#8143 escopo) sobre 1 execução do agent.
 * `rawText` é o texto que o agent gravou no `out_path` pedido;
 * `editionDir` é o diretório de fixture ABSOLUTO usado como `cwd` da
 * execução (onde `03-social.md`/`_internal/02-draft.md` já devem ter sido
 * escritos pelo chamador quando aplicável — ver `runAgentRepetitions`).
 */
export function runMechanicalGraders(agent: PromptEvalAgent, rawText: string, editionDir: string, rootDir: string): GraderVerdict[] {
  return [
    gradeBannedLexicon(rawText),
    gradeTitleLength(agent, rawText),
    gradeCarouselOverflow(agent, editionDir),
    gradeStage2LintReport(editionDir, rootDir),
  ];
}

/** Envelopa a saída crua do `social-writer` (`## d1`/`## d2`/`## d3`, sem wrapper) no formato que `extractSection(md, "Social")` (`extract-section.ts`) exige, pra `checkCarouselTextOverflow` conseguir ler. Puro — não toca disco. */
export function wrapSocialWriterOutputForGrading(rawText: string): string {
  return `# Social\n\n${rawText.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Repetição com checagem de maioria (#8143 item 4).
// ---------------------------------------------------------------------------

export interface GraderConsistency {
  name: string;
  /** `true` só se TODAS as repetições forem `evaluable` E concordarem no MESMO `ok`. */
  consistent: boolean;
  /** `null` sempre que `!consistent` — divergência bloqueia, nunca decide por maioria simples (mesmo padrão de `holistic-critique.ts`). */
  agreedOk: boolean | null;
  /** `ok`/`null` de cada repetição, na ordem em que rodaram. */
  runs: ReadonlyArray<boolean | null>;
}

/**
 * `repetitions[i]` é o array de `GraderVerdict` da i-ésima execução do MESMO
 * prompt sobre o MESMO fixture. Agrupa por nome de grader e checa
 * consistência — nunca decide "2 de 3" (mesma disciplina de
 * `runHolisticCritique`).
 */
export function checkRepetitionConsistency(repetitions: ReadonlyArray<ReadonlyArray<GraderVerdict>>): GraderConsistency[] {
  if (repetitions.length === 0) return [];
  const names = new Set<string>();
  for (const run of repetitions) for (const v of run) names.add(v.name);

  const result: GraderConsistency[] = [];
  for (const name of [...names].sort()) {
    const perRun = repetitions.map((run) => run.find((v) => v.name === name));
    const allPresent = perRun.every((v): v is GraderVerdict => v !== undefined);
    const allEvaluable = allPresent && perRun.every((v) => v!.evaluable);
    const oks: Array<boolean | null> = perRun.map((v) => (v && v.evaluable ? (v.ok as boolean) : null));
    const consistent = allEvaluable && oks.every((ok) => ok === oks[0]);
    result.push({
      name,
      consistent,
      agreedOk: consistent ? (oks[0] as boolean) : null,
      runs: oks,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Comparação pareada baseline × candidato (#8143 item 3).
// ---------------------------------------------------------------------------

export type GraderRegressionVerdict = "regressed" | "improved" | "unchanged" | "inconclusive";

export interface GraderDelta {
  name: string;
  baseline: GraderConsistency | null;
  candidate: GraderConsistency | null;
  verdict: GraderRegressionVerdict;
}

/**
 * Nunca produz nota absoluta isolada — só delta sobre o MESMO fixture.
 * `inconclusive` sempre que qualquer um dos dois lados não convergiu nas
 * repetições (`!consistent`) ou o grader simplesmente não apareceu de um
 * dos dois lados.
 */
export function compareBaselineVsCandidate(
  baseline: ReadonlyArray<GraderConsistency>,
  candidate: ReadonlyArray<GraderConsistency>,
): GraderDelta[] {
  const names = new Set<string>([...baseline.map((b) => b.name), ...candidate.map((c) => c.name)]);
  const deltas: GraderDelta[] = [];
  for (const name of [...names].sort()) {
    const b = baseline.find((x) => x.name === name) ?? null;
    const c = candidate.find((x) => x.name === name) ?? null;
    let verdict: GraderRegressionVerdict;
    if (!b?.consistent || !c?.consistent) {
      verdict = "inconclusive";
    } else if (b.agreedOk === true && c.agreedOk === false) {
      verdict = "regressed";
    } else if (b.agreedOk === false && c.agreedOk === true) {
      verdict = "improved";
    } else {
      verdict = "unchanged";
    }
    deltas.push({ name, baseline: b, candidate: c, verdict });
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Corpo do agent — disco (candidato) e git ref (baseline/master).
// ---------------------------------------------------------------------------

/** Mesmo padrão de `distill-prompt-corrections.ts` (leitura de `social-critic.md`) — strip do frontmatter YAML, nunca reimplementado com parser próprio. */
export function stripAgentFrontmatter(md: string): string {
  return md.replace(/^---[\s\S]*?---\n/, "");
}

export function agentFileRelPath(agent: PromptEvalAgent): string {
  return `.claude/agents/${agent}.md`;
}

export function readAgentBodyFromDisk(rootDir: string, agent: PromptEvalAgent): string {
  const p = resolve(rootDir, agentFileRelPath(agent));
  return stripAgentFrontmatter(readFileSync(p, "utf8"));
}

export type GitShowFn = (args: string[], opts: { cwd: string; encoding: "utf8" }) => string;

/**
 * Lê `.claude/agents/{agent}.md` em `ref` (ex: `origin/master`) via
 * `git show ref:path` — nunca assume que o checkout local está em `ref`.
 * Lança se o `git` falhar (ref inexistente, arquivo não existia naquele
 * ref) — sem fallback silencioso pra "candidato == baseline".
 */
export function readAgentBodyAtGitRef(
  rootDir: string,
  agent: PromptEvalAgent,
  ref: string,
  execFn: GitShowFn = ((args, opts) => execFileSync("git", args, { cwd: opts.cwd, encoding: opts.encoding }) as unknown as string),
): string {
  const relPath = agentFileRelPath(agent);
  const raw = execFn(["show", `${ref}:${relPath}`], { cwd: rootDir, encoding: "utf8" });
  return stripAgentFrontmatter(raw);
}

// ---------------------------------------------------------------------------
// Payload de input — o que o coordenador passaria em produção.
// ---------------------------------------------------------------------------

export interface ApprovedHighlightArticle {
  url: string;
  title: string;
  category?: string | null;
  summary?: string;
  score?: number | null;
  cluster_sources?: Array<{ url: string; title: string; source?: string }>;
}

interface ApprovedHighlightEntry extends Partial<ApprovedHighlightArticle> {
  article?: ApprovedHighlightArticle;
}

interface ApprovedJsonShape {
  highlights?: ApprovedHighlightEntry[];
}

/** `01-approved.json`/`01-approved-capped.json` guardam o artigo do highlight direto OU sob `.article` (mesma indireção que `scoring-features.ts::extractScoringFeatures` já trata) — nunca duas leituras divergentes do mesmo shape. */
export function readApprovedHighlight(approvedJsonPath: string, destaqueIndex: 1 | 2 | 3): ApprovedHighlightArticle {
  const parsed = JSON.parse(readFileSync(approvedJsonPath, "utf8")) as ApprovedJsonShape;
  const entry = parsed.highlights?.[destaqueIndex - 1];
  if (!entry) {
    throw new Error(`prompt-regression-eval: highlights[${destaqueIndex - 1}] ausente em ${approvedJsonPath} (destaqueIndex=${destaqueIndex})`);
  }
  const article = entry.article ?? (entry as ApprovedHighlightArticle);
  if (!article.url || !article.title) {
    throw new Error(`prompt-regression-eval: highlights[${destaqueIndex - 1}] sem url/title utilizável em ${approvedJsonPath}`);
  }
  return article;
}

export function readApprovedHighlightTitles(approvedJsonPath: string): string[] {
  const parsed = JSON.parse(readFileSync(approvedJsonPath, "utf8")) as ApprovedJsonShape;
  const entries = parsed.highlights ?? [];
  return entries.map((entry) => {
    const article = entry.article ?? (entry as ApprovedHighlightArticle);
    return article.title ?? "";
  });
}

/** Monta o payload EXATO que o coordenador (writer/orchestrator-stage-2) passaria ao `writer-destaque` — ver `## Input` de `.claude/agents/writer-destaque.md`. */
export function buildWriterDestaqueInput(params: {
  destaqueN: 1 | 2 | 3;
  article: ApprovedHighlightArticle;
  categoryLabel: string;
  peerTitles: [string, string];
  editionDateIso: string;
  outPathRel: string;
  imagePromptOutPathRel: string;
}): Record<string, unknown> {
  return {
    destaque_n: params.destaqueN,
    destaque: {
      url: params.article.url,
      title: params.article.title,
      category: params.article.category ?? null,
      summary: params.article.summary ?? "",
      score: params.article.score ?? null,
      ...(params.article.cluster_sources ? { cluster_sources: params.article.cluster_sources } : {}),
    },
    category_label: params.categoryLabel,
    peer_titles: params.peerTitles,
    edition_date: params.editionDateIso,
    out_path: params.outPathRel,
    image_prompt_out_path: params.imagePromptOutPathRel,
  };
}

/** Monta o payload EXATO que o coordenador passaria ao `social-writer` — ver `## Input` de `.claude/agents/social-writer.md` (só 2 paths, sem objeto inline). */
export function buildSocialWriterInput(params: { approvedJsonPathRel: string; outDirRel: string }): Record<string, unknown> {
  return {
    approved_json_path: params.approvedJsonPathRel,
    out_dir: params.outDirRel,
  };
}

/**
 * Monta o prompt single-turn (`claude --print`) que reproduz o dispatch via
 * `Agent`/`Task` de dentro de uma sessão orquestradora comum: corpo do
 * agent (sem frontmatter) + o input exato que o coordenador passaria +
 * instrução de gravar nos paths indicados. `agentBody` já vem strippado
 * (`readAgentBodyFromDisk`/`readAgentBodyAtGitRef`).
 */
export function buildAgentReplayPrompt(agentBody: string, agent: PromptEvalAgent, input: Record<string, unknown>): string {
  return [
    agentBody.trim(),
    "",
    "---",
    "",
    `Acima está sua instrução completa (corpo de .claude/agents/${agent}.md, sem frontmatter). Você está sendo executado FORA da sessão orquestradora normal, num replay de avaliação de regressão de prompt (#8143) sobre um fixture de edição CONGELADO — o input abaixo é exatamente o payload que o coordenador te passaria em produção.`,
    "",
    "Input (JSON):",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
    "Execute o processo descrito acima e grave o(s) arquivo(s) indicados pelos campos de path do input, relativos ao diretório de trabalho atual. Ao final, responda só com o JSON de output pedido pela sua instrução — sem texto antes ou depois.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Custo medido (#8143 — "gasto medido, não estimado", mesmo requisito do
// record-agent-costs.ts).
// ---------------------------------------------------------------------------

export interface ParsedCliUsage {
  subagent_tokens: number;
  tool_uses: number;
  duration_ms: number;
  resultText: string | null;
}

/**
 * Parseia a resposta de `callClaudeCli(..., { outputFormat: "json" })`.
 * Schema do `claude --print --output-format json` (campos best-effort,
 * tolerante a nomes ausentes — nunca fabrica número, sempre 0/null
 * explícito quando o campo não vem): `usage.{input,output,
 * cache_creation_input,cache_read_input}_tokens`, `num_turns`,
 * `duration_ms`, `result` (texto final). `null` só quando o JSON não
 * parseia — resposta malformada não vira "usage zero" silencioso, vira
 * "sem dado" explícito pro chamador decidir.
 */
export function parseClaudeCliJsonResult(raw: string): ParsedCliUsage | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const usage = (parsed.usage as Record<string, unknown> | undefined) ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? 0) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
  const toolUses = Number(parsed.num_turns ?? 0) || 0;
  const durationMs = Number(parsed.duration_ms ?? 0) || 0;
  const resultText = typeof parsed.result === "string" ? parsed.result : null;
  return {
    subagent_tokens: inputTokens + outputTokens + cacheCreate + cacheRead,
    tool_uses: toolUses,
    duration_ms: durationMs,
    resultText,
  };
}

// ---------------------------------------------------------------------------
// Execução (#8143 item 1) — impura, sempre injetável pra teste.
// ---------------------------------------------------------------------------

export interface RunAgentRepetitionsOptions {
  agent: PromptEvalAgent;
  agentBody: string;
  input: Record<string, unknown>;
  /** `cwd` da execução real — o agent grava arquivos relativos a este diretório. */
  cwd: string;
  /** Path ABSOLUTO onde o agent grava o output principal (destaque/social) — lido de volta após cada repetição. */
  producedFileAbsPath: string;
  /** Diretório de fixture ABSOLUTO usado pelos graders (`03-social.md`/`_internal/02-draft.md`) — normalmente igual a `cwd`. */
  editionDirForGrading: string;
  rootDir: string;
  repetitions: number;
  /** `true` (default no CLI): nunca chama `claude` de verdade — cada repetição vira uma entrada `dryRun: true` sem veredito de grader. */
  dryRun: boolean;
  model?: string;
  callClaudeCliFn?: (prompt: string, opts: ClaudeCliCallOptions) => string;
}

export interface AgentRunOutcome {
  repetitionIndex: number;
  dryRun: boolean;
  rawText: string | null;
  verdicts: GraderVerdict[];
  usage: ParsedCliUsage | null;
}

/**
 * Roda `opts.repetitions` execuções do MESMO prompt (agent + input) sobre o
 * MESMO fixture. Em modo dry-run, nunca chama `callClaudeCliFn` — só monta
 * `opts.repetitions` entradas vazias, pra o chamador poder demonstrar/testar
 * o fluxo completo (contagem de repetições, shape do resultado) sem gastar
 * token nenhum (#8143 item 6).
 */
export function runAgentRepetitions(opts: RunAgentRepetitionsOptions): AgentRunOutcome[] {
  const callFn = opts.callClaudeCliFn ?? callClaudeCli;
  const outcomes: AgentRunOutcome[] = [];

  for (let i = 0; i < opts.repetitions; i++) {
    if (opts.dryRun) {
      outcomes.push({ repetitionIndex: i, dryRun: true, rawText: null, verdicts: [], usage: null });
      continue;
    }

    const prompt = buildAgentReplayPrompt(opts.agentBody, opts.agent, opts.input);
    const raw = callFn(prompt, { cwd: opts.cwd, model: opts.model ?? "sonnet", outputFormat: "json" });
    const usage = parseClaudeCliJsonResult(raw);

    const rawText = existsSync(opts.producedFileAbsPath) ? readFileSync(opts.producedFileAbsPath, "utf8") : "";
    if (opts.agent === "social-writer") {
      writeFileSync(join(opts.editionDirForGrading, "03-social.md"), wrapSocialWriterOutputForGrading(rawText), "utf8");
    }
    const verdicts = runMechanicalGraders(opts.agent, rawText, opts.editionDirForGrading, opts.rootDir);
    outcomes.push({ repetitionIndex: i, dryRun: false, rawText, verdicts, usage });
  }

  return outcomes;
}

/** Extrai só os `GraderVerdict[]` de execuções não-dry-run — dry-run não produz veredito (não é "0 divergências", é "não rodou"). */
export function verdictsFromOutcomes(outcomes: ReadonlyArray<AgentRunOutcome>): GraderVerdict[][] {
  return outcomes.filter((o) => !o.dryRun).map((o) => o.verdicts);
}

export const TITLE_MAX_CHARS_FOR_GRADER = MAX_TITLE_LENGTH;
