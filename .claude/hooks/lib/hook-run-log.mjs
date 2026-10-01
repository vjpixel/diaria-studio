// .claude/hooks/lib/hook-run-log.mjs (#9280)
//
// Append de um evento em `{repoRoot}/data/run-log.jsonl` — mesma forma de
// `logTscGuardEvent` (block-pr-create-tsc-failure.mjs) e `logEffortDecision`
// (pr-create-review.mjs). Fail-soft: logar nunca pode propagar nem bloquear
// o hook. Não grave valores sensíveis em `details`.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function appendHookRunLog(
  repoRoot, agent, level, message, details,
  { appendFn = appendFileSync, mkdirFn = mkdirSync } = {},
) {
  try {
    if (typeof repoRoot !== "string" || repoRoot === "") return;
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: null,
      agent,
      level,
      message,
      details,
    };
    const logPath = join(repoRoot, "data", "run-log.jsonl");
    mkdirFn(dirname(logPath), { recursive: true });
    appendFn(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Swallow — mesmo contrato do resto deste diretório.
  }
}
