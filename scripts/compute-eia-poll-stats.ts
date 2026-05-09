/**
 * compute-eia-poll-stats.ts (#107)
 *
 * Calcula estatísticas do poll do É IA? da edição anterior pra preencher
 * a linha "Resultado da última edição: X% das pessoas acertaram" automaticamente.
 *
 * Inputs:
 *   --edition <AAMMDD>           Edição atual (onde o output será gravado).
 *   --prev-edition <AAMMDD>      (opcional) Edição anterior; default = auto-discover.
 *   --responses <path>           JSON com array de respostas do poll.
 *                                Cada entrada: { choice: string, responded_at?: iso }.
 *   --correct-choice <value>     (opcional) Override de qual choice é correta.
 *                                Default = derivado do `ai_side` em
 *                                `_internal/01-eia-meta.json` da edição anterior.
 *   --since <iso>                (opcional) Filtra responses por responded_at >= since.
 *   --threshold <int>            (opcional, default 5) Mínimo de respostas pra
 *                                reportar % com confiança.
 *   --out <path>                 (opcional) Override do output path.
 *                                Default: data/editions/{edition}/_internal/04-eia-poll-stats.json
 *
 * Saídas (sempre exit 0 — nunca trava pipeline):
 *   - JSON em --out com stats (mesmo se total=0).
 *   - Se ai_side=null na edição anterior: log warn, escreve `{ skipped: "ai_side_null" }`.
 *   - Se prev edition não encontrada: log warn, escreve `{ skipped: "no_previous_edition" }`.
 *
 * Esta separação (script puro de cálculo + agente faz fetch via MCP) mantém o
 * cálculo testável e evita acoplamento com Beehiiv MCP shape exato.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts"; // #1031
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PollResponse {
  choice: string;
  responded_at?: string;
}

export interface EiaMeta {
  edition?: string;
  ai_side?: "A" | "B" | null;
  wikimedia?: { image_date_used?: string };
}

export interface PollStats {
  previous_edition: string | null;
  poll_id: string | null;
  total_responses: number;
  correct_responses: number;
  pct_correct: number | null;
  since_iso: string | null;
  correct_choice: string | null;
  below_threshold: boolean;
  skipped?: string;
}

export function findPreviousEdition(
  editionsDir: string,
  currentEdition: string,
): string | null {
  if (!existsSync(editionsDir)) return null;
  const entries = readdirSync(editionsDir).filter((e) => /^\d{6}$/.test(e));
  const earlier = entries.filter((e) => e < currentEdition).sort();
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

export function readEiaMeta(editionDir: string): EiaMeta | null {
  const path = resolve(editionDir, "_internal/01-eia-meta.json");
  if (!existsSync(path)) return null;
  try {
    // #1031: schema-validated parse (parseEiaMeta de lib/schemas/eia-meta.ts)
    // Schema central requer ai_side ∈ {A, B}; se faltar/inválido → null fallback.
    // Cast pra local EiaMeta justificado: shape compatible (central é mais
    // strict — central rejeita ai_side null mas aqui já tratamos parse falha
    // como null, equivalente ao comportamento anterior).
    const parsed = parseEiaMeta(JSON.parse(readFileSync(path, "utf8")));
    return {
      edition: parsed.edition,
      ai_side: parsed.ai_side,
      wikimedia: parsed.wikimedia,
    };
  } catch {
    return null;
  }
}

export function filterResponses(
  responses: PollResponse[],
  since?: string,
): PollResponse[] {
  if (!since) return responses;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return responses;
  return responses.filter((r) => {
    if (!r.responded_at) return true;
    const t = Date.parse(r.responded_at);
    return Number.isNaN(t) ? true : t >= sinceMs;
  });
}

export function computeStats(opts: {
  responses: PollResponse[];
  correctChoice: string | null;
  threshold: number;
  previousEdition: string | null;
  pollId?: string | null;
  since?: string | null;
}): PollStats {
  const total = opts.responses.length;
  const correct = opts.correctChoice
    ? opts.responses.filter((r) => r.choice === opts.correctChoice).length
    : 0;
  const belowThreshold = total < opts.threshold;
  const pct =
    total === 0 || belowThreshold || !opts.correctChoice
      ? null
      : Math.round((correct / total) * 100);
  return {
    previous_edition: opts.previousEdition,
    poll_id: opts.pollId ?? null,
    total_responses: total,
    correct_responses: correct,
    pct_correct: pct,
    since_iso: opts.since ?? null,
    correct_choice: opts.correctChoice,
    below_threshold: belowThreshold,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function writeOutput(outPath: string, stats: PollStats): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(stats, null, 2) + "\n", "utf8");
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const edition = args.edition;
  if (!edition) {
    console.error("Uso: compute-eia-poll-stats.ts --edition <AAMMDD> [--prev-edition <AAMMDD>] [--responses <path>] [--correct-choice <A|B>] [--since <iso>] [--threshold <n>] [--out <path>]");
    process.exit(1);
  }

  const editionsDir = resolve(ROOT, "data/editions");
  const prevEdition =
    args["prev-edition"] ?? findPreviousEdition(editionsDir, edition);
  const outPath =
    args.out ??
    resolve(editionsDir, edition, "_internal/04-eia-poll-stats.json");

  const skipBase: PollStats = {
    previous_edition: prevEdition,
    poll_id: null,
    total_responses: 0,
    correct_responses: 0,
    pct_correct: null,
    since_iso: args.since ?? null,
    correct_choice: null,
    below_threshold: true,
  };

  if (!prevEdition) {
    console.warn("[compute-eia-poll-stats] sem edição anterior — skip");
    writeOutput(outPath, { ...skipBase, skipped: "no_previous_edition" });
    return;
  }

  const prevDir = resolve(editionsDir, prevEdition);
  const meta = readEiaMeta(prevDir);
  const correctChoice =
    args["correct-choice"] ?? (meta?.ai_side ?? null);

  if (!correctChoice) {
    console.warn(
      `[compute-eia-poll-stats] ai_side ausente em ${prevEdition}/_internal/01-eia-meta.json — skip`,
    );
    writeOutput(outPath, {
      ...skipBase,
      skipped: meta ? "ai_side_null" : "no_eia_meta",
    });
    return;
  }

  let responses: PollResponse[] = [];
  if (args.responses) {
    const responsesPath = resolve(ROOT, args.responses);
    if (existsSync(responsesPath)) {
      try {
        const parsed = JSON.parse(readFileSync(responsesPath, "utf8"));
        if (Array.isArray(parsed)) {
          responses = parsed.filter(
            (r): r is PollResponse =>
              typeof r === "object" && r !== null && typeof r.choice === "string",
          );
        }
      } catch (e) {
        console.warn(
          `[compute-eia-poll-stats] erro lendo ${responsesPath}: ${(e as Error).message}`,
        );
      }
    } else {
      console.warn(`[compute-eia-poll-stats] responses file não existe: ${responsesPath}`);
    }
  }

  const filtered = filterResponses(responses, args.since);
  const threshold = args.threshold ? Math.max(1, Number(args.threshold)) : 5;

  const stats = computeStats({
    responses: filtered,
    correctChoice,
    threshold,
    previousEdition: prevEdition,
    since: args.since ?? null,
  });

  writeOutput(outPath, stats);
  console.log(JSON.stringify(stats));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
