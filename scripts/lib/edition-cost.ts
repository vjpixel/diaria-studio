/**
 * edition-cost.ts (#3748) — instrumentação de custo de tokens por
 * stage/agente da edição diária.
 *
 * Escopo desta instrumentação (achado overnight 260721b): o harness NÃO
 * expõe usage/token count do COORDENADOR (a sessão top-level que roda os
 * playbooks `orchestrator-stage-*.md`) de forma programática. O que ele
 * expõe é o bloco `<usage>` estruturado que volta no resultado de CADA
 * dispatch da tool `Agent` — ex:
 *
 *   <usage><subagent_tokens>115201</subagent_tokens><tool_uses>33</tool_uses><duration_ms>259892</duration_ms></usage>
 *
 * Este módulo captura esse bloco (ao vivo, no próprio turno do orchestrator
 * — não é parsing de transcript em disco) e agrega por stage/agent_type num
 * artefato por edição (`{editionDir}/_internal/cost.json`). **Cobre só
 * subagentes** — o custo do coordenador continua não-instrumentável por
 * este mecanismo; ver `COST_ARTIFACT_SCOPE_NOTE` abaixo, que é persistida
 * dentro do próprio artefato para que qualquer leitor do JSON veja a
 * limitação sem precisar deste comentário.
 *
 * Path do artefato usa `editionDir` (resolvido via
 * `find-current-edition.ts --resolve`), não `AAMMDD` cru — mesma convenção
 * de `pipeline-state.ts`, necessária pelo layout dual flat/nested
 * (#2463/#3025/#3530).
 *
 * **Relação com `stage-status.json`/#3441 (não é duplicação):**
 * `scripts/capture-stage-usage.ts` (#3441) já popula `cost_usd`/`tokens_in`/
 * `tokens_out`/`models` em `_internal/stage-status.json` por STAGE inteiro,
 * lendo o transcript local da sessão do Claude Code (`session-transcript.ts`)
 * — mecanismo diferente (parsing de disco, não o `<usage>` em-banda captado
 * aqui), útil só em sessão local, e sem quebra por `agent_type` (Stage 1
 * mistura source-researcher + discovery-searcher + scorer-chunk sob o mesmo
 * total; Stage 2 mistura writer-destaque + 3 social). Este módulo é
 * complementar: adiciona o breakdown por agente que `stage-status.json` não
 * tem, e funciona em qualquer modo de execução (local ou cloud) porque não
 * depende de transcript em disco — só do que já retorna no próprio dispatch.
 *
 * Funções puras (sem I/O): `parseUsageBlock`, `recordAgentCost`,
 * `aggregateCostByStage`, `buildCostArtifact`, `parseCostArtifact`,
 * `serializeCostArtifact`, `mergeCostEntries`. Wrappers de I/O (fino, só
 * leitura/escrita de arquivo): `readCostArtifactFromDisk`, `writeCostArtifact`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentUsage {
  subagent_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export interface AgentCostEntry extends AgentUsage {
  stage: number;
  agent_type: string;
  recorded_at: string;
}

export interface StageAgentAggregate {
  agent_type: string;
  dispatch_count: number;
  subagent_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export interface CostAggregate {
  by_stage: Record<string, StageAgentAggregate[]>;
  overall: {
    dispatch_count: number;
    subagent_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
}

export interface EditionCostArtifact {
  schema_version: 1;
  edition: string;
  generated_at: string;
  /** Documenta o que este artefato cobre/não cobre — ver header do módulo. */
  scope_note: string;
  entries: AgentCostEntry[];
  aggregate: CostAggregate;
}

export const COST_ARTIFACT_SCOPE_NOTE =
  "Cobre SÓ tokens de subagentes dispatchados via Agent (source-researcher, " +
  "discovery-searcher, writer-destaque, scorer-chunk, etc — capturados do bloco " +
  "<usage> retornado por cada dispatch, ao vivo no turno do orchestrator). NÃO " +
  "inclui o custo do orchestrator/coordenador (a sessão top-level) — o harness " +
  "não expõe usage do coordenador de forma programática (achado overnight " +
  "260721). Limitação conhecida do mecanismo, não um bug deste artefato.";

const USAGE_BLOCK_RE =
  /<usage>\s*<subagent_tokens>(\d+)<\/subagent_tokens>\s*<tool_uses>(\d+)<\/tool_uses>\s*<duration_ms>(\d+)<\/duration_ms>\s*<\/usage>/;

/**
 * Extrai `{subagent_tokens, tool_uses, duration_ms}` de um bloco `<usage>`
 * cru (o texto retornado por um dispatch `Agent`, colado verbatim). Retorna
 * `null` se o bloco não estiver presente ou estiver malformado — nunca lança.
 */
export function parseUsageBlock(raw: string): AgentUsage | null {
  const m = USAGE_BLOCK_RE.exec(raw);
  if (!m) return null;
  return {
    subagent_tokens: Number(m[1]),
    tool_uses: Number(m[2]),
    duration_ms: Number(m[3]),
  };
}

/**
 * Anexa uma entrada de custo (imutável — retorna um novo array, não muta
 * `entries`). Lança se `stage`/`agentType` forem inválidos — sinal de bug no
 * caller, não um caso a degradar silenciosamente.
 */
export function recordAgentCost(
  entries: AgentCostEntry[],
  stage: number,
  agentType: string,
  usage: AgentUsage,
  recordedAtIso: string = new Date().toISOString(),
): AgentCostEntry[] {
  if (!Number.isFinite(stage) || stage < 0) {
    throw new Error(`recordAgentCost: stage inválido: ${stage}`);
  }
  if (!agentType || typeof agentType !== "string") {
    throw new Error(`recordAgentCost: agentType inválido: ${agentType}`);
  }
  const entry: AgentCostEntry = {
    stage,
    agent_type: agentType,
    subagent_tokens: usage.subagent_tokens,
    tool_uses: usage.tool_uses,
    duration_ms: usage.duration_ms,
    recorded_at: recordedAtIso,
  };
  return [...entries, entry];
}

/** Agrega entradas por stage + agent_type, e também um total geral. */
export function aggregateCostByStage(entries: AgentCostEntry[]): CostAggregate {
  const byStage = new Map<string, Map<string, StageAgentAggregate>>();
  const overall = { dispatch_count: 0, subagent_tokens: 0, tool_uses: 0, duration_ms: 0 };

  for (const e of entries) {
    const stageKey = String(e.stage);
    if (!byStage.has(stageKey)) byStage.set(stageKey, new Map());
    const stageMap = byStage.get(stageKey)!;
    const existing = stageMap.get(e.agent_type) ?? {
      agent_type: e.agent_type,
      dispatch_count: 0,
      subagent_tokens: 0,
      tool_uses: 0,
      duration_ms: 0,
    };
    existing.dispatch_count += 1;
    existing.subagent_tokens += e.subagent_tokens;
    existing.tool_uses += e.tool_uses;
    existing.duration_ms += e.duration_ms;
    stageMap.set(e.agent_type, existing);

    overall.dispatch_count += 1;
    overall.subagent_tokens += e.subagent_tokens;
    overall.tool_uses += e.tool_uses;
    overall.duration_ms += e.duration_ms;
  }

  const by_stage: Record<string, StageAgentAggregate[]> = {};
  for (const [stageKey, agentMap] of byStage.entries()) {
    by_stage[stageKey] = [...agentMap.values()].sort(
      (a, b) => b.subagent_tokens - a.subagent_tokens,
    );
  }
  return { by_stage, overall };
}

/** Monta o artefato completo (entries + aggregate + scope_note) a partir de uma lista de entries. */
export function buildCostArtifact(
  edition: string,
  entries: AgentCostEntry[],
  generatedAtIso: string = new Date().toISOString(),
): EditionCostArtifact {
  return {
    schema_version: 1,
    edition,
    generated_at: generatedAtIso,
    scope_note: COST_ARTIFACT_SCOPE_NOTE,
    entries,
    aggregate: aggregateCostByStage(entries),
  };
}

/** Parseia um `cost.json` já lido em memória. Retorna `null` se malformado — nunca lança (mesmo padrão de `readSentinel`). */
export function parseCostArtifact(raw: string): EditionCostArtifact | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return parsed as EditionCostArtifact;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeCostArtifact(artifact: EditionCostArtifact): string {
  return JSON.stringify(artifact, null, 2) + "\n";
}

/**
 * Combina entries novas com as de um artefato pré-existente (se houver) —
 * permite que cada stage acumule no MESMO `cost.json` em vez de sobrescrever
 * o que stages anteriores da mesma edição já gravaram. Não deduplica: cada
 * dispatch é um evento real (retries custam tokens de verdade e devem
 * contar).
 */
export function mergeCostEntries(
  existing: EditionCostArtifact | null,
  newEntries: AgentCostEntry[],
): AgentCostEntry[] {
  return existing ? [...existing.entries, ...newEntries] : [...newEntries];
}

// ---------------------------------------------------------------------------
// I/O thin wrappers — path fixo `{editionDir}/_internal/cost.json`.
// ---------------------------------------------------------------------------

function costArtifactPath(editionDir: string): string {
  return resolve(editionDir, "_internal", "cost.json");
}

/** Lê `cost.json` do disco. Retorna `null` se ausente ou corrompido — nunca lança. */
export function readCostArtifactFromDisk(editionDir: string): EditionCostArtifact | null {
  const p = costArtifactPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    return parseCostArtifact(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Mescla `newEntries` com o que já existir em disco para esta edição e
 * regrava `cost.json` (recomputando o aggregate do zero). Cria `_internal/`
 * se necessário. Retorna o artefato final gravado.
 */
export function writeCostArtifact(
  editionDir: string,
  edition: string,
  newEntries: AgentCostEntry[],
): EditionCostArtifact {
  const existing = readCostArtifactFromDisk(editionDir);
  const mergedEntries = mergeCostEntries(existing, newEntries);
  const artifact = buildCostArtifact(edition, mergedEntries);
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(costArtifactPath(editionDir), serializeCostArtifact(artifact), "utf8");
  return artifact;
}
