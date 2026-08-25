/**
 * task-registry-prose-drift.ts (#6105 item 2)
 *
 * Lógica PURA do drift-check entre a PROSA do registro
 * (`docs/scheduled-tasks-registry.md`) e o estado real do systemd `--user`.
 *
 * Motivação (#6105, achado ao vivo 25/08/2026): a entrada prosa de
 * `Diaria-Onboarding-Welcome-Run` dizia "não armada" enquanto o timer real
 * estava `enabled / active` — o comparador executável do #5607
 * (`task-never-armed-alarm.ts`) não pega esse caso porque compara
 * `scheduled-tasks.ts` (registro tipado) × systemd; quem mentia era o `.md`,
 * que é o que o CLAUDE.md manda ler. Esta checagem valida a AFIRMAÇÃO
 * TEXTUAL de cada entrada do `.md` contra o estado real.
 *
 * HEURÍSTICA DE POSSE (importante — validada contra o registro real):
 * cada entrada do registro é um parágrafo/linha que nomeia a PRÓPRIA task
 * primeiro e depois cita VIZINHAS por referência cruzada ("logo depois do
 * `Diaria-X`", "mesmo padrão de guard das tasks-irmãs `Diaria-Y`"). A
 * afirmação de arme do parágrafo pertence ao dono do parágrafo — a primeira
 * task mencionada nele. Duas alternativas foram descartadas por gerar falsos
 * positivos medidos no dry-run contra o registro real: atribuir a afirmação
 * a toda task citada na linha (1º rascunho: 16 "drifts", 15 falsos) e janela
 * de proximidade em caracteres (2º rascunho: contaminação persiste porque o
 * registro cita vizinhas COLADAS às afirmações). Linha sem nenhuma task do
 * registro = ignorada. Afirmação ausente na linha do dono = sem claim
 * (`unknown`) — nunca alarma.
 *
 * Este módulo NUNCA executa systemctl — só classifica; I/O fica no script.
 *
 * @module
 */

export type ProseArmedClaim = "armed" | "not-armed" | "unknown";

export type RealArmedState = "armed" | "not-armed" | "unknown";

/** Padrões que AFIRMAM arme (case-sensitive de propósito: a prosa do
 * registro usa "ARMADA" em maiúsculas pra ênfase; "Confirmado ativo" é o
 * outro formulário observado). */
const ARMED_PATTERNS: RegExp[] = [
  /\bARMADA\b/,
  /\bARMADO\b/,
  /Confirmado ativo/,
  /\benabled \+ active\b/,
];

/** Padrões que AFIRMAM desarme. Inclui os formulários compostos observados
 * ("DECLARADA — ainda NÃO armada", "nunca tinha sido armada"). */
const NOT_ARMED_PATTERNS: RegExp[] = [
  /N[ÃA]O armad[oa]/i,
  /nunca tinha sido armada/i,
  /nunca foi armada/i,
];

export interface LineOwnership {
  /** Primeira task do registro mencionada na linha (dono das afirmações). */
  owner: string | null;
  /** Afirmação de arme da linha — vence o ÚLTIMO padrão (a prosa narra
   * atualizações cronologicamente: "era NÃO armada, agora ARMADA"). */
  claim: ProseArmedClaim;
}

/**
 * Resolve o dono e a afirmação de UMA linha.
 */
export function resolveLineOwnership(line: string, taskNames: readonly string[]): LineOwnership {
  let owner: string | null = null;
  let firstIdx = Infinity;
  for (const task of taskNames) {
    const idx = line.indexOf(task);
    if (idx !== -1 && idx < firstIdx) {
      firstIdx = idx;
      owner = task;
    }
  }
  return { owner, claim: extractProseArmedClaim(line) };
}

/**
 * Extrai a afirmação de arme de uma linha (sem posse). Se ambos os
 * formulários aparecem, vence o que aparece POR ÚLTIMO.
 */
export function extractProseArmedClaim(line: string): ProseArmedClaim {
  // Notas históricas ENTRE ASPAS ("Esta entrada dizia \"ainda NÃO armada
  // ...\" até ...") citam o texto antigo sem afirmá-lo — achado ao vivo na
  // entrada do Onboarding (#6105). Remover trechos cotados antes de casar
  // os padrões; a afirmação vigente fica sempre fora de aspas.
  const effective = line.replace(/(["“][^"”]{0,160}["”])/g, " ");
  let lastMatchIndex = -1;
  let claim: ProseArmedClaim = "unknown";
  for (const re of ARMED_PATTERNS) {
    const m = re.exec(effective);
    if (m && m.index > lastMatchIndex) {
      lastMatchIndex = m.index;
      claim = "armed";
    }
  }
  for (const re of NOT_ARMED_PATTERNS) {
    const m = re.exec(effective);
    if (m && m.index > lastMatchIndex) {
      lastMatchIndex = m.index;
      claim = "not-armed";
    }
  }
  return claim;
}

export interface ProseDriftFinding {
  task: string;
  claim: Exclude<ProseArmedClaim, "unknown">;
  real: Exclude<RealArmedState, "unknown">;
  line: number;
}

export interface ProseDriftEvaluation {
  findings: ProseDriftFinding[];
  /** Tasks com afirmação reconhecível cujo estado real era `unknown`
   * (systemctl indisponível) — reportadas à parte, nunca alarme. */
  unverifiable: string[];
  checked: number;
}

/**
 * Avalia a prosa inteira contra o estado real por task.
 *
 * @param prose        Conteúdo integral do `docs/scheduled-tasks-registry.md`.
 * @param taskNames    Nomes canônicos das tasks (`listScheduledTaskNames()`).
 * @param realByTask   Estado real por task name.
 */
export function evaluateProseDrift(
  prose: string,
  taskNames: readonly string[],
  realByTask: ReadonlyMap<string, RealArmedState>,
): ProseDriftEvaluation {
  const findings: ProseDriftFinding[] = [];
  const unverifiable = new Set<string>();
  let checked = 0;
  const lines = prose.split("\n");
  // Última afirmação por task (a prosa narra atualizações; a entrada mais
  // recente — linha mais abaixo — é a vigente).
  const lastClaimByTask = new Map<string, { claim: Exclude<ProseArmedClaim, "unknown">; line: number }>();
  for (let i = 0; i < lines.length; i++) {
    const { owner, claim } = resolveLineOwnership(lines[i], taskNames);
    if (!owner || claim === "unknown") continue;
    lastClaimByTask.set(owner, { claim, line: i + 1 });
  }
  for (const [task, { claim, line }] of lastClaimByTask) {
    checked++;
    const real = realByTask.get(task) ?? "unknown";
    if (real === "unknown") {
      unverifiable.add(task);
      continue;
    }
    if (claim !== real) {
      findings.push({ task, claim, real, line });
    }
  }
  return { findings, unverifiable: [...unverifiable].sort(), checked };
}
