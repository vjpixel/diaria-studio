export type ProseArmedClaim = "armed" | "not-armed" | "unknown";
export type RealArmedState = "armed" | "not-armed" | "unknown";

const ARMED_PATTERNS: RegExp[] = [
  /\bARMADA\b/,
  /\bARMADO\b/,
  /Confirmado ativo/,
  /\benabled \+ active\b/,
];

const NOT_ARMED_PATTERNS: RegExp[] = [
  /N[ÃA]O armad[oa]/i,
  /nunca tinha sido armada/i,
  /nunca foi armada/i,
];

export interface LineOwnership {
  owner: string | null;
  claim: ProseArmedClaim;
}

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

export function extractProseArmedClaim(line: string): ProseArmedClaim {
  const effective = line.replace(/(["“][^"”]{0,160}["”])/g, " ");
  let cleaned = effective;
  for (const re of NOT_ARMED_PATTERNS) {
    const m = re.exec(cleaned);
    if (m) {
      cleaned = cleaned.slice(0, m.index) + " " + cleaned.slice(m.index + m[0].length);
    }
  }
  let lastMatchIndex = -1;
  let claim: ProseArmedClaim = "unknown";
  for (const re of ARMED_PATTERNS) {
    const m = re.exec(cleaned);
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
  unverifiable: string[];
  checked: number;
}

export function evaluateProseDrift(
  prose: string,
  taskNames: readonly string[],
  realByTask: ReadonlyMap<string, RealArmedState>,
): ProseDriftEvaluation {
  const findings: ProseDriftFinding[] = [];
  const unverifiable = new Set<string>();
  let checked = 0;
  const lines = prose.split("\n");
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
