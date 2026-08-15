/**
 * scripts/lib/plugin-review-drift-check.ts (#5311)
 *
 * Decisão pura + tipos pro drift-check dos system prompts dos 5 agentes do
 * plugin `pr-review-toolkit` que `DEFAULT_EFFORT = "max"` dispara
 * (`.claude/hooks/pr-create-review.mjs`, `REVIEW_AGENT` +
 * `REVIEW_FLEET_MAX_EXTRA`): `code-reviewer`, `silent-failure-hunter`,
 * `pr-test-analyzer`, `comment-analyzer`, `type-design-analyzer`.
 *
 * ─── Por que "sinal relevante", não hash do arquivo inteiro (decisão do editor) ──
 *
 * O arquivo do plugin vem do marketplace, fora deste repo — editorial
 * cosmética (reformatação, exemplo reescrito, seção reordenada) não deveria
 * disparar alarme. O que importa é a linguagem que FILTRA achados (limiar de
 * confiança, "only report", "filter aggressively", threshold de severidade)
 * — é essa linguagem que o hook (`buildReviewInstruction`) tenta sobrepor por
 * especificidade (#5304), e é justamente ela que pode mudar sem ninguém
 * perceber (arquivo não é versionado aqui). `extractRelevantSignal` isola só
 * as linhas que casam esse vocabulário; o restante do arquivo (exemplos,
 * formatação, prosa) nunca entra no fingerprint.
 *
 * Hoje (#5311, achado original) só `code-reviewer.md` tem essa linguagem
 * explícita ("Only report issues with confidence ≥ 80"). Os outros 4 nunca
 * foram auditados sob esse ângulo — `extractRelevantSignal` roda igual nos
 * 5, e um sinal vazio (nenhuma linha casa) é um resultado válido, não um
 * erro: se um dos 4 GANHAR essa linguagem numa atualização futura do
 * marketplace (ex: um limiar de confiança sendo introduzido), o sinal deixa
 * de ser vazio e o drift-check alarma — é exatamente o caso que importa
 * capturar.
 */

export interface PluginReviewAgentSpec {
  /** Nome do agente, sem o prefixo `pr-review-toolkit:` (ex: "code-reviewer"). */
  agentName: string;
  /** Nome do arquivo dentro de `agents/` (ex: "code-reviewer.md"). */
  fileName: string;
}

/** Os 5 agentes que `DEFAULT_EFFORT = "max"` dispara — `REVIEW_AGENT` +
 * `REVIEW_FLEET_MAX_EXTRA` em `.claude/hooks/pr-create-review.mjs`. Lista
 * fixa de propósito (não descoberta por varredura de diretório): o
 * `pr-review-toolkit` também empacota `code-simplifier.md`, que este repo
 * nunca dispatcha via `pr-create-review.mjs` — não faz sentido monitorar
 * drift num agente que não está no caminho do gate de auto-merge (#5251). */
export const PLUGIN_REVIEW_AGENTS: readonly PluginReviewAgentSpec[] = [
  { agentName: "code-reviewer", fileName: "code-reviewer.md" },
  { agentName: "silent-failure-hunter", fileName: "silent-failure-hunter.md" },
  { agentName: "pr-test-analyzer", fileName: "pr-test-analyzer.md" },
  { agentName: "comment-analyzer", fileName: "comment-analyzer.md" },
  { agentName: "type-design-analyzer", fileName: "type-design-analyzer.md" },
];

/** Vocabulário que marca uma linha como "sinal relevante" pro filtro de
 * achados de um review agent — limiar de confiança/severidade, instrução de
 * filtrar/reportar seletivamente. Case-insensitive. Mantido pequeno e
 * explícito (não um regex genérico tipo /confiden.*\d+/) — cada termo aqui
 * foi observado no texto real do plugin (#5311) ou é uma variante óbvia do
 * mesmo vocabulário; ampliar esta lista é o ajuste esperado se um agente
 * introduzir uma formulação nova que devesse contar como sinal e hoje não
 * conta. */
const RELEVANT_SIGNAL_KEYWORDS = [
  "confidence",
  "only report",
  "filter aggressively",
  "high-confidence",
  "high confidence",
  "severity threshold",
  "minimum confidence",
] as const;

/**
 * Pura — extrai, de um markdown de agente, só as linhas cujo texto (case-
 * insensitive) contém algum termo de `RELEVANT_SIGNAL_KEYWORDS`. Preserva a
 * ordem original, remove espaço de borda por linha (cosmética de indentação
 * não deveria contar), e junta com `\n`. Uma string vazia é um resultado
 * válido — significa "este agente não tem hoje nenhuma linguagem de filtro
 * de confiança/severidade nesse vocabulário".
 */
export function extractRelevantSignal(content: string): string {
  const lower = RELEVANT_SIGNAL_KEYWORDS;
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && lower.some((kw) => line.toLowerCase().includes(kw)))
    .join("\n");
}

export type PluginReviewAgentStatus =
  | "missing_plugin" // diretório do plugin inteiro ausente (sessão cloud/clone fresco) — skip, nunca alarma
  | "missing_file" // plugin presente mas este agente específico não tem arquivo (marketplace reestruturou) — reportado, não alarma sozinho
  | "no_baseline" // 1ª vez que este agente é observado — estabelece baseline, não alarma
  | "unchanged" // sinal extraído bate com o baseline persistido
  | "changed"; // sinal extraído DIFERE do baseline — o achado que este check existe pra pegar

export interface PluginReviewAgentResult {
  agentName: string;
  status: PluginReviewAgentStatus;
  /** Sinal extraído nesta execução — `null` quando `missing_plugin`/`missing_file`. */
  signal: string | null;
  /** Sinal persistido da execução anterior — `null` em `no_baseline`/ausência. */
  previousSignal: string | null;
}

/** Estado persistido — mapa agentName -> último sinal observado + quando. */
export interface PluginReviewDriftState {
  agents: Record<string, { signal: string; capturedAt: string }>;
  /** Fingerprint do conjunto de agentes com `status: "changed"` já alarmado
   * — mesma semântica de idempotência de `WorkerDriftAlarmState`. `null`
   * quando não há drift pendente conhecido. */
  lastAlarmedFingerprint: string | null;
}

export function emptyPluginReviewDriftState(): PluginReviewDriftState {
  return { agents: {}, lastAlarmedFingerprint: null };
}

/**
 * Pura — decide o status de UM agente a partir do conteúdo lido nesta
 * execução (`null` se o arquivo não existe) e do sinal persistido da
 * execução anterior (`null` se nunca observado).
 */
export function evaluateAgentDrift(
  agentName: string,
  content: string | null,
  previousSignal: string | null,
): PluginReviewAgentResult {
  if (content === null) {
    return { agentName, status: "missing_file", signal: null, previousSignal };
  }
  const signal = extractRelevantSignal(content);
  if (previousSignal === null) {
    return { agentName, status: "no_baseline", signal, previousSignal: null };
  }
  return {
    agentName,
    status: signal === previousSignal ? "unchanged" : "changed",
    signal,
    previousSignal,
  };
}

/** Pura — mapeia `evaluateAgentDrift` sobre a lista de agentes + conteúdo já
 * lido (I/O fica no script chamador). `contents` é `agentName -> conteúdo
 * (null se arquivo ausente)`; `previousState` é o estado persistido carregado
 * pelo script. */
export function evaluateAllAgentsDrift(
  agents: readonly PluginReviewAgentSpec[],
  contents: ReadonlyMap<string, string | null>,
  previousState: PluginReviewDriftState,
): PluginReviewAgentResult[] {
  return agents.map((a) =>
    evaluateAgentDrift(a.agentName, contents.get(a.agentName) ?? null, previousState.agents[a.agentName]?.signal ?? null),
  );
}

/** Pura — `true` se algum agente tem `status: "changed"` (o único status que
 * justifica alarme; `no_baseline`/`missing_file`/`unchanged` não). */
export function hasPendingPluginReviewDrift(results: readonly PluginReviewAgentResult[]): boolean {
  return results.some((r) => r.status === "changed");
}

/** Pura — fingerprint estável (ordem-independente) do conjunto de agentes
 * com drift pendente, pro guard de idempotência do alarme. */
export function computePluginReviewDriftFingerprint(results: readonly PluginReviewAgentResult[]): string {
  return results
    .filter((r) => r.status === "changed")
    .map((r) => `${r.agentName}:${r.signal}`)
    .sort()
    .join("|");
}

/** Pura — `true` se o fingerprint atual de drift pendente é NOVO em relação
 * ao já alarmado (mesma semântica de `shouldAlarm` em worker-drift-check.ts
 * — nunca re-alarma o MESMO drift, mas alarma de novo se ele mudar ou se
 * tinha resolvido e voltou). */
export function shouldAlarmPluginReviewDrift(state: PluginReviewDriftState, results: readonly PluginReviewAgentResult[]): boolean {
  const pending = hasPendingPluginReviewDrift(results);
  if (!pending) return false;
  const fingerprint = computePluginReviewDriftFingerprint(results);
  return fingerprint !== state.lastAlarmedFingerprint;
}

/** Pura — próximo estado persistido a partir dos resultados desta execução:
 * TODO agente com `content` lido nesta rodada (missing_file excluído — não
 * sobrescreve um baseline anterior com "sumiu", que seria mais provável
 * reorganização do marketplace do que sinal de segurança) ganha entry nova/
 * atualizada; agentes ausentes preservam a entry anterior intacta. */
export function advancePluginReviewDriftState(
  state: PluginReviewDriftState,
  results: readonly PluginReviewAgentResult[],
  now: Date,
): PluginReviewDriftState {
  const agents = { ...state.agents };
  for (const r of results) {
    if (r.signal === null) continue; // missing_file — preserva entry anterior, se houver
    agents[r.agentName] = { signal: r.signal, capturedAt: now.toISOString() };
  }
  const pending = hasPendingPluginReviewDrift(results);
  return {
    agents,
    lastAlarmedFingerprint: pending ? computePluginReviewDriftFingerprint(results) : state.lastAlarmedFingerprint,
  };
}

/** Pura — assunto + corpo do e-mail de alarme (texto puro, mesmo padrão de
 * `buildWorkerDriftAlarmEmail`/`buildHomeMetaDriftAlarmEmail`). Só é chamada
 * quando `shouldAlarmPluginReviewDrift` já confirmou pendência nova. */
export function buildPluginReviewDriftAlarmEmail(
  results: readonly PluginReviewAgentResult[],
  now: Date = new Date(),
): { subject: string; body: string } {
  const changed = results.filter((r) => r.status === "changed");
  const subject = `[diar.ia.br] ${changed.length} agente(s) do pr-review-toolkit mudou o sinal de filtro de review`;

  const lines: string[] = [
    "O drift-check do system prompt dos agentes de review (#5311) detectou",
    "mudança na linguagem de filtro de confiança/severidade de pelo menos",
    "um agente do plugin `pr-review-toolkit` — esse texto vem do",
    "marketplace, fora deste repo, e nada mais aqui teria avisado.",
    "",
    `Agente(s) com sinal alterado (${changed.length}):`,
  ];
  for (const r of changed) {
    lines.push(`  - pr-review-toolkit:${r.agentName}`);
    lines.push(`    Antes: ${JSON.stringify(r.previousSignal)}`);
    lines.push(`    Agora: ${JSON.stringify(r.signal)}`);
  }
  lines.push(
    "",
    "Revisar se `.claude/hooks/pr-create-review.mjs` (`buildReviewInstruction`)",
    "ainda sobrepõe adequadamente a nova diretiva — ver #5304/#5251.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
