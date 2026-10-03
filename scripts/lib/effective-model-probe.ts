#!/usr/bin/env npx tsx
/**
 * effective-model-probe.ts (#9527)
 *
 * O pin `model`/`effort` do frontmatter de /diaria-overnight só vale no 1º turno:
 * o primeiro `<task-notification>` / `[Subagent hand-back]` abre um turno novo e a
 * sessão volta ao par DELA. Esta lib lê o par EFETIVO no transcript (campos
 * `message.model` + `perTurnEffort` por entrada `assistant`) pra Fase 0 comparar
 * com o esperado (`claude-opus-5-5`/`low`) e pro relatório contar o par efetivo
 * em vez do configurado.
 *
 * CLI: `--transcript <path> | --session-id <id>` `[--expect-model M] [--expect-effort E] [--since-line N]`
 * Imprime JSON; exit 0 = par efetivo bate, 2 = diverge, 1 = erro/sem entrada assistant.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_MODEL = "claude-opus-5-5";
export const EXPECTED_EFFORT = "low";

export interface TurnPair {
  model: string;
  effort: string;
}

/** Pares (model, effort) de cada entrada `assistant` do JSONL, em ordem. Linhas inválidas são ignoradas. */
export function parseAssistantPairs(jsonl: string, sinceLine = 0): TurnPair[] {
  const out: TurnPair[] = [];
  jsonl.split("\n").forEach((line, i) => {
    if (i < sinceLine || !line.trim()) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== "assistant" || typeof o?.message?.model !== "string") return;
    if (o.message.model.startsWith("<")) return; // "<synthetic>"
    out.push({ model: o.message.model, effort: String(o.perTurnEffort ?? o.effort ?? "unknown") });
  });
  return out;
}

/** Contagem por "model/effort". */
export function tallyPairs(pairs: TurnPair[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const p of pairs) t[`${p.model}/${p.effort}`] = (t[`${p.model}/${p.effort}`] ?? 0) + 1;
  return t;
}

export interface ProbeResult {
  effective: TurnPair | null;
  expected: TurnPair;
  ok: boolean;
  tally: Record<string, number>;
}

/** O par efetivo é o da ÚLTIMA entrada assistant (o turno em que a rodada de fato roda). */
export function probe(
  jsonl: string,
  expected: TurnPair = { model: EXPECTED_MODEL, effort: EXPECTED_EFFORT },
  sinceLine = 0,
): ProbeResult {
  const pairs = parseAssistantPairs(jsonl, sinceLine);
  const effective = pairs.length ? pairs[pairs.length - 1] : null;
  return {
    effective,
    expected,
    ok: !!effective && effective.model === expected.model && effective.effort === expected.effort,
    tally: tallyPairs(pairs),
  };
}

export function findTranscript(sessionId: string, projectsDir = join(homedir(), ".claude", "projects")): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const d of readdirSync(projectsDir)) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Fallback sem id: .jsonl mais recente do diretório de projeto do cwd (o hook não injeta id neste script). */
export function newestTranscriptForCwd(cwd = process.cwd(), projectsDir = join(homedir(), ".claude", "projects")): string | null {
  const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function main(): void {
  const a = process.argv.slice(2);
  const get = (k: string) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : undefined);
  const sid = get("--session-id") ?? process.env.CLAUDE_SESSION_ID;
  const path = get("--transcript") ?? (sid ? findTranscript(sid) : newestTranscriptForCwd());
  if (!path || !existsSync(path)) {
    console.error("transcript não encontrado (--transcript <path> ou --session-id <id>)");
    process.exit(1);
  }
  const r = probe(
    readFileSync(path, "utf8"),
    { model: get("--expect-model") ?? EXPECTED_MODEL, effort: get("--expect-effort") ?? EXPECTED_EFFORT },
    Number(get("--since-line") ?? 0),
  );
  console.log(JSON.stringify(r));
  process.exit(r.effective ? (r.ok ? 0 : 2) : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
