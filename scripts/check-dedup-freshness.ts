/**
 * check-dedup-freshness.ts
 *
 * Pre-flight de Stage 0: valida que `data/past-editions-raw.json` está fresh
 * o suficiente pra base de dedup ser confiável.
 *
 * Compara `max(published_at)` no raw com `Date.now() - <maxStalenessHours>`.
 * Se o raw está stale, o script falha loud (exit 1) — orchestrator deve
 * apresentar ao editor antes de prosseguir, em vez de aprovar links repetidos
 * com base congelada.
 *
 * Caso real (#230): edição 260428 com `data/past-editions-raw.json` carregando
 * só 5 edições de 14-23/abril enquanto Beehiiv tinha posts de 04-25 e 04-27.
 * Destaque GPT-5.5 do gate batia com edição 04-25 — dedup não pegou. Editor
 * só notou no review manual.
 *
 * Uso pelo orchestrator no Stage 0, **após** o `refresh-dedup-runner`:
 *
 *   npx tsx scripts/check-dedup-freshness.ts
 *
 * Flags opcionais:
 *   --max-staleness-hours <N>   default 48 (cobertura de fim de semana)
 *   --raw <path>                default data/past-editions-raw.json
 *   --now <ISO>                 override pra teste/CI; default Date.now()
 *
 * Output (stdout, JSON):
 *   { "ok": true,  "most_recent": "2026-04-27T...", "age_hours": 12.3, ... }
 *   { "ok": false, "most_recent": "2026-04-23T...", "age_hours": 96.7, ... }
 *
 * Exit codes:
 *   0 = fresh (ou base vazia + bootstrap pendente, decidido pelo caller)
 *   1 = stale (orchestrator: pedir ao editor pra investigar antes de prosseguir)
 *   2 = erro (raw não existe, args inválidos, JSON corrompido)
 *
 * Refs #230.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface FreshnessResult {
  ok: boolean;
  raw_path: string;
  count: number;
  most_recent: string | null;
  age_hours: number | null;
  max_staleness_hours: number;
  reason?: string;
}

interface RawPost {
  id?: string;
  title?: string;
  published_at?: string;
}

/**
 * Pure: avalia freshness dado um array de posts e ts atual. Não toca filesystem.
 */
export function evaluateFreshness(
  posts: RawPost[],
  nowMs: number,
  maxStalenessHours: number,
  rawPath = "data/past-editions-raw.json",
): FreshnessResult {
  if (posts.length === 0) {
    return {
      ok: false,
      raw_path: rawPath,
      count: 0,
      most_recent: null,
      age_hours: null,
      max_staleness_hours: maxStalenessHours,
      reason: "raw vazio — bootstrap nunca rodou ou falhou",
    };
  }

  let maxMs = -Infinity;
  let maxIso: string | null = null;
  for (const p of posts) {
    const iso = p.published_at;
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = iso;
    }
  }

  if (maxIso === null) {
    return {
      ok: false,
      raw_path: rawPath,
      count: posts.length,
      most_recent: null,
      age_hours: null,
      max_staleness_hours: maxStalenessHours,
      reason: "nenhuma entrada com published_at parseável",
    };
  }

  const ageMs = nowMs - maxMs;
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageHoursRounded = Math.round(ageHours * 10) / 10;

  // Guarda contra `published_at` no futuro (#241): clock skew, dados de teste
  // ou parsing quebrado podem produzir idade negativa. Tratar como anomalia
  // — escolha do issue: failhar loud, deixar editor decidir.
  if (ageHours < 0) {
    return {
      ok: false,
      raw_path: rawPath,
      count: posts.length,
      most_recent: maxIso,
      age_hours: ageHoursRounded,
      max_staleness_hours: maxStalenessHours,
      reason: `edição mais recente tem published_at no futuro (${maxIso}, ${Math.abs(ageHours).toFixed(1)}h à frente do agora) — verificar clock skew, dados de teste no raw, ou parsing quebrado`,
    };
  }

  const ok = ageHours <= maxStalenessHours;
  return {
    ok,
    raw_path: rawPath,
    count: posts.length,
    most_recent: maxIso,
    age_hours: ageHoursRounded,
    max_staleness_hours: maxStalenessHours,
    reason: ok
      ? undefined
      : `edição mais recente publicada há ${ageHours.toFixed(1)}h (limite ${maxStalenessHours}h) — scripts/refresh-dedup.ts pode ter falhado silenciosamente; investigar antes de prosseguir`,
  };
}

/**
 * Emite um FreshnessResult em formato JSON pra stdout (#240).
 * Centraliza pra todos os paths de erro emitirem o mesmo schema —
 * orchestrator pode `JSON.parse(stdout)` em qualquer exit code.
 */
function emitJson(
  rawPath: string,
  maxStalenessHours: number,
  reason: string,
): void {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        raw_path: rawPath,
        count: 0,
        most_recent: null,
        age_hours: null,
        max_staleness_hours: maxStalenessHours,
        reason,
      } satisfies FreshnessResult,
      null,
      2,
    ) + "\n",
  );
}

interface CliFlags {
  maxStalenessHours: number;
  rawPath: string;
  now?: string;
}

/**
 * Default dinâmico baseado no dia da semana (#675).
 * Segunda: 96h (cobre até a sexta anterior); Terça: 72h; demais: 48h.
 * Evita alarme falso toda segunda-feira quando a newsletter não publica no fim de semana.
 */
export function defaultMaxStalenessHours(now: Date = new Date()): number {
  const dow = now.getUTCDay(); // 0=Dom, 1=Seg, 2=Ter
  if (dow === 1) return 96;
  if (dow === 2) return 72;
  return 48;
}

export function parseArgs(argv: string[]): CliFlags | { error: string } {
  let maxStalenessHours = defaultMaxStalenessHours();
  let rawPath = "data/past-editions-raw.json";
  let now: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-staleness-hours" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `--max-staleness-hours inválido: ${argv[i + 1]}` };
      }
      maxStalenessHours = n;
      i++;
    } else if (a === "--raw" && argv[i + 1]) {
      rawPath = argv[i + 1];
      i++;
    } else if (a === "--now" && argv[i + 1]) {
      now = argv[i + 1];
      i++;
    }
  }
  return { maxStalenessHours, rawPath, now };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Defaults conservadores pra error paths que disparam antes do parse.
  const fallbackRaw = "data/past-editions-raw.json";
  const fallbackHours = 48;

  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    emitJson(fallbackRaw, fallbackHours, parsed.error);
    process.exit(2);
  }

  const rawAbs = resolve(ROOT, parsed.rawPath);
  if (!existsSync(rawAbs)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw não existe em ${parsed.rawPath} — rodar npx tsx scripts/refresh-dedup.ts (bootstrap) antes`,
    );
    process.exit(1);
  }

  let posts: RawPost[];
  try {
    posts = JSON.parse(readFileSync(rawAbs, "utf8")) as RawPost[];
  } catch (e) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw inválido (JSON parse falhou): ${(e as Error).message}`,
    );
    process.exit(2);
  }
  if (!Array.isArray(posts!)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `raw em formato inesperado: esperado array, recebido ${typeof posts}`,
    );
    process.exit(2);
  }

  const nowMs = parsed.now ? Date.parse(parsed.now) : Date.now();
  if (Number.isNaN(nowMs)) {
    emitJson(
      parsed.rawPath,
      parsed.maxStalenessHours,
      `--now inválido: ${parsed.now}`,
    );
    process.exit(2);
  }

  const result = evaluateFreshness(
    posts!,
    nowMs,
    parsed.maxStalenessHours,
    parsed.rawPath,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
