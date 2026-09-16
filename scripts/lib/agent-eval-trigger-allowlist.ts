/**
 * scripts/lib/agent-eval-trigger-allowlist.ts (#8144)
 *
 * Decide se uma mudança num `.claude/agents/{agent}.md` deve disparar o eval
 * de regressão de prompt (#8143, `scripts/lib/prompt-regression-eval.ts`).
 * Companion do gate de CI (`scripts/check-agent-eval-required.ts` +
 * `.github/workflows/agent-eval-required.yml`) e do runner da esteira
 * (`scripts/run-agent-eval-for-pr.ts`) — os dois importam SÓ deste módulo
 * pra decidir "isso precisa de eval", nunca reimplementam a lógica.
 *
 * ## Duas perguntas, resolvidas separadamente
 *
 * 1. **Este agent tem harness de replay mapeado?** (`classifyAgentEvalEligibility`)
 *    Hoje só 2 têm: os cobertos pela #8143 (`PROMPT_EVAL_AGENTS`,
 *    `scripts/lib/prompt-regression-eval.ts` — fonte única, reusada aqui,
 *    nunca duplicada). Qualquer outro `.claude/agents/*.md` precisa constar
 *    em `AGENT_EVAL_EXCLUDED_AGENTS` abaixo COM motivo — nunca cair fora do
 *    gatilho por silêncio (mandato explícito da issue #8144). Um agent que
 *    não está em NENHUM dos dois (`"unclassified"`) é sinal de arquivo NOVO
 *    ainda não triado — `test/agent-eval-trigger-allowlist.test.ts` varre
 *    `.claude/agents/*.md` de verdade e falha se algum não estiver
 *    classificado, forçando a decisão no momento do PR que criou o agent
 *    (mesmo espírito de `KNOWN_MCP_PREFIXES` em `validate-agent-frontmatter.ts`
 *    — allowlist curada + teste que trava contra drift silencioso).
 *
 * 2. **Dado que o agent TEM harness, esta mudança específica dispara o
 *    eval?** (`evaluateAgentEvalTrigger`) Distingue mudança de CORPO
 *    (comportamento) de mudança de FRONTMATTER puro (`description`,
 *    `tools`) — só a 1ª, mais a troca do campo `model:` especificamente
 *    (mesmo dentro do frontmatter), conta.
 *
 * ## Por que comparação de CONTEÚDO INTEIRO, não diff de linha
 *
 * `scripts/lib/calibration-file-allowlist.ts` (#7978) precisa de precisão de
 * linha/hunk porque `scorer.md`/`scorer-chunk.md` são arquivos GRANDES com
 * blocos `CALIBRATED:*` delimitados MISTURADOS com prosa não-calibrável — um
 * diff em qualquer outro trecho do arquivo não deve disparar o gate.
 *
 * Os 2 agents cobertos aqui (`writer-destaque`, `social-writer`) não têm essa
 * mistura: o CORPO INTEIRO do arquivo é a instrução de comportamento (não há
 * "prosa incidental" separada de "prosa que importa" dentro do corpo) — então
 * comparar o corpo INTEIRO (antes × depois, string) é tão preciso quanto um
 * diff de linha aqui, e muito mais simples: não depende de calcular
 * `touchedLines` via `git diff --unified=0` (que por sua vez depende de ter
 * as duas SHAs disponíveis localmente via `git show`). Os dois chamadores
 * deste módulo têm fontes de conteúdo DIFERENTES — o gate de CI usa `git
 * show {sha}:{path}` (mesmo padrão de `check-editorial-signoff.ts`), a
 * esteira (`run-agent-eval-for-pr.ts`) usa a API REST do GitHub
 * (`contents/{path}?ref={sha}`), porque roda fora do runner do Actions e não
 * pode presumir que as SHAs da PR já estão fetchadas localmente — comparação
 * por STRING funciona idêntico nos dois casos, diff de linha exigiria
 * reimplementar `gitDiffTouchedLines` pra cada fonte.
 */

import { extractFrontmatter } from "../validate-agent-frontmatter.ts";
import { stripAgentFrontmatter, PROMPT_EVAL_AGENTS, isPromptEvalAgent, type PromptEvalAgent } from "./prompt-regression-eval.ts";

export { PROMPT_EVAL_AGENTS, isPromptEvalAgent, type PromptEvalAgent };

/**
 * Reconhece `.claude/agents/{agent}.md` — path relativo ao root do repo
 * (sem leading slash), nome do agent capturado no grupo 1. Fonte única
 * (#8144 self-review, item P3 do fleet review) — antes duplicada
 * literalmente em `scripts/check-agent-eval-required.ts` e
 * `scripts/run-agent-eval-for-pr.ts`, os 2 únicos consumidores.
 */
export const AGENT_FILE_RE = /^\.claude\/agents\/([^/]+)\.md$/;

// ---------------------------------------------------------------------------
// 1. Elegibilidade — este agent TEM harness de replay mapeado?
// ---------------------------------------------------------------------------

export interface AgentEvalExclusion {
  agent: string;
  reason: string;
}

/** Constrói várias entradas de exclusão que compartilham o mesmo motivo — evita repetir a string do motivo N vezes, sem perder a granularidade "1 nome, 1 motivo" que a issue #8144 pede (cada `agent` ainda aparece como entrada própria, grep-ável individualmente). */
function excludedGroup(agents: readonly string[], reason: string): AgentEvalExclusion[] {
  return agents.map((agent) => ({ agent, reason }));
}

/**
 * Todo `.claude/agents/*.md` que NÃO está em `PROMPT_EVAL_AGENTS` precisa
 * estar aqui, com motivo — mandato da issue #8144 ("agent sem fixture
 * mapeado sai do gatilho de forma DECLARADA, nunca por silêncio").
 * `test/agent-eval-trigger-allowlist.test.ts` varre `.claude/agents/*.md`
 * de verdade e falha se algum arquivo não aparecer nem aqui nem em
 * `PROMPT_EVAL_AGENTS` — é esse teste, não uma promessa em prosa, que
 * garante que este array não fica defasado quando um agent novo nasce.
 *
 * Snapshot dos agents excluídos hoje (#8144, conferido contra `.claude/agents/`
 * em 16/09/2026) — se um novo agent for criado depois, o teste acima aponta
 * o gap e força adicionar a entrada correspondente, com o motivo real.
 */
export const AGENT_EVAL_EXCLUDED_AGENTS: readonly AgentEvalExclusion[] = [
  ...excludedGroup(
    ["orchestrator", "orchestrator-stage-0-preflight", "orchestrator-stage-1-research", "orchestrator-stage-2", "orchestrator-stage-3", "orchestrator-stage-4", "orchestrator-stage-5", "orchestrator-stage-6"],
    "playbook lido pelo top-level Claude Code, não subagente dispatchado via Agent (#3710/#207) — não produz output de destaque/social sobre o qual os graders mecânicos da #8143 façam sentido.",
  ),
  ...excludedGroup(
    ["scorer", "scorer-chunk"],
    "já tem harness de calibração PRÓPRIO (#7978, blocos CALIBRATED:* em scripts/lib/calibration-file-allowlist.ts) — o gate de sign-off editorial cobre mudança de comportamento de pontuação; a #8143 nunca foi estendida a estes 2.",
  ),
  ...excludedGroup(
    ["scorer-select", "scorer-monthly"],
    "agents de pontuação/seleção sem fixture de replay — fora do escopo declarado da #8143 (só writer-destaque/social-writer, os 2 com mais correção capturada em _internal/editor-requests.jsonl).",
  ),
  ...excludedGroup(
    ["writer", "writer-anual", "writer-monthly"],
    "writers de outros pipelines (legado full-newsletter, anual, mensal) — a #8143 cobre só a escrita DIÁRIA paralela (writer-destaque); estender a estes é extensão natural, não implementada ainda.",
  ),
  ...excludedGroup(["analyst-anual", "analyst-monthly"], "analistas de seleção temática dos pipelines anual/mensal — julgamento holístico Opus, fora do escopo de graders mecânicos da #8143."),
  ...excludedGroup(["auto-reporter"], "agent de triagem de issue a partir de sinais da edição — não produz texto de destaque/social, nenhum grader mecânico dos 4 da #8143 se aplica."),
  ...excludedGroup(
    ["beehiiv-clicks-enricher", "beehiiv-engagement-backup", "beehiiv-exit-history-drain"],
    "agents de dreno de dado via MCP (paginação/persistência) — não geram texto editorial, fora do escopo de graders de prosa.",
  ),
  ...excludedGroup(["discovery-searcher", "source-researcher"], "agents de pesquisa (Haiku) — coletam candidatos, não escrevem o texto final; fora do escopo declarado da #8143."),
  ...excludedGroup(["fact-checker"], "verifica claims contra fonte primária — não é um agent de ESCRITA, os 4 graders mecânicos (lexicon banido, título, carrossel, lint Stage 2) não se aplicam à saída dele."),
  ...excludedGroup(["image-crop-reviewer"], "revisor de corte de imagem 2:1→1:1/4:5 — não produz texto, nenhum grader de prosa é aplicável."),
  ...excludedGroup(["research-reviewer"], "raciocínio estruturado sobre resultado de pesquisa (Haiku pinned) — não escreve destaque/social."),
  ...excludedGroup(["review-test-email"], "QA de e-mail de teste no loop verify→fix do Stage 5 — não gera texto editorial novo."),
  ...excludedGroup(["social-critic"], "juiz LLM de tom sobre 03-social.md — a #8143 exclui EXPLICITAMENTE juiz LLM de tom do seu escopo (ver docstring de prompt-regression-eval.ts); mesma exclusão vale aqui."),
  ...excludedGroup(["social-curto"], "escreve texto curto (X/Threads) a partir de 01-approved.json — candidato natural a uma extensão futura da #8143, mas não coberto hoje; nenhum preset de fixture mapeado."),
  ...excludedGroup(["title-picker"], "fallback de escolha entre títulos JÁ escritos por writer-destaque — não gera texto novo, os graders de texto não discriminam nada aqui."),
];

export type AgentEvalEligibility =
  | { status: "mapped"; agent: PromptEvalAgent }
  | { status: "excluded"; reason: string }
  | { status: "unclassified" };

/**
 * Classifica 1 nome de agent (basename de `.claude/agents/{agent}.md`, sem
 * extensão) em exatamente 1 dos 3 estados. `"unclassified"` é o estado que
 * NUNCA deveria sobreviver a um PR que cria um agent novo — é o gap que
 * `test/agent-eval-trigger-allowlist.test.ts` fecha.
 */
export function classifyAgentEvalEligibility(agent: string): AgentEvalEligibility {
  if (isPromptEvalAgent(agent)) return { status: "mapped", agent };
  const excluded = AGENT_EVAL_EXCLUDED_AGENTS.find((e) => e.agent === agent);
  if (excluded) return { status: "excluded", reason: excluded.reason };
  return { status: "unclassified" };
}

// ---------------------------------------------------------------------------
// 2. Gatilho — dado um agent MAPEADO, esta mudança específica dispara o eval?
// ---------------------------------------------------------------------------

/** Extrai o VALOR do campo `model:` do frontmatter (ou `null` se ausente/sem frontmatter/arquivo ausente). Comparação por VALOR, não por linha tocada — robusta a reordenação de campos do frontmatter (ex: `model:` mudando de posição não afeta a detecção, ao contrário de comparar por número de linha). */
export function extractAgentModelField(content: string | null): string | null {
  if (content === null) return null;
  const fm = extractFrontmatter(content);
  if (fm === null) return null;
  const m = fm.match(/^model:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}

/** Corpo do agent (sem frontmatter), pra comparação direta. `null` só quando `content` é `null` (arquivo ausente naquele ref — deletado ou ainda não existia). Reusa `stripAgentFrontmatter` de `prompt-regression-eval.ts` (#8143) — nunca reimplementado aqui. */
export function extractAgentBody(content: string | null): string | null {
  if (content === null) return null;
  return stripAgentFrontmatter(content);
}

export interface AgentEvalTriggerVerdict {
  agent: PromptEvalAgent;
  /** `true` quando o corpo (fora do frontmatter) mudou entre `oldContent` e `newContent`. Arquivo deletado (`newContent === null`) conta como mudança de corpo — perder o agent inteiro é claramente uma mudança de comportamento real. */
  bodyChanged: boolean;
  /** `true` quando o VALOR do campo `model:` do frontmatter mudou (inclusive ausente↔presente). */
  modelChanged: boolean;
  /** `bodyChanged || modelChanged` — a decisão final. */
  triggers: boolean;
  reason: string;
}

/**
 * Decide se a mudança de `oldContent` → `newContent` (conteúdo INTEIRO do
 * arquivo `.claude/agents/{agent}.md`, frontmatter incluído) dispara o eval
 * de regressão de prompt. `oldContent === null` (arquivo novo, sem histórico
 * no ref antigo) sempre dispara — um agent mapeado que acabou de nascer
 * ainda não tem baseline pra comparar, mas rodar o eval contra ele mesmo
 * (candidato == baseline) é barato e nunca incorreto.
 */
export function evaluateAgentEvalTrigger(agent: PromptEvalAgent, oldContent: string | null, newContent: string | null): AgentEvalTriggerVerdict {
  const oldBody = extractAgentBody(oldContent);
  const newBody = extractAgentBody(newContent);
  const bodyChanged = oldBody !== newBody;

  const oldModel = extractAgentModelField(oldContent);
  const newModel = extractAgentModelField(newContent);
  const modelChanged = oldModel !== newModel;

  const triggers = bodyChanged || modelChanged;
  const reasons: string[] = [];
  if (newContent === null) reasons.push("arquivo do agent foi removido");
  if (bodyChanged) reasons.push("corpo do agent mudou (fora do frontmatter)");
  if (modelChanged) reasons.push(`campo model: mudou ("${oldModel ?? "(ausente)"}" → "${newModel ?? "(ausente)"}")`);
  if (!triggers) reasons.push("só frontmatter não-model mudou (ex: description, tools) — não dispara");

  return { agent, bodyChanged, modelChanged, triggers, reason: reasons.join("; ") };
}
