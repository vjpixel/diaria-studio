/**
 * scripts/lib/aarrr-whitelist.ts
 *
 * Priorização de issues por etapa do funil AAARRR (Awareness, Acquisition,
 * Activation, Retention, Referral, Revenue). Cada issue pode carregar labels
 * `aarrr:{etapa}`; `aarrr-whitelist.json` (raiz do repo, versionado) lista as
 * etapas liberadas. Decisão do editor (10/09/2026):
 *
 *   - issue SEM nenhuma label `aarrr:*` → não é afetada (infra, pipeline,
 *     manutenção seguem como antes);
 *   - issue COM label `aarrr:*` → só é trabalhada se ao menos uma das suas
 *     etapas estiver na whitelist; senão `classifyExecTrack` a devolve como
 *     `bloqueada` (`matched: "label:aarrr-fora-da-whitelist"`).
 *
 * O filtro mora no classificador (`issue-exec-track.ts`) porque ele já é a
 * fonte única consumida pelo overnight, develop, continuo, desbloqueia,
 * Triagem do Studio e fila do hermes — nenhum desses precisa mudar.
 *
 * Fail-closed: arquivo ausente/malformado = whitelist vazia (bloqueia toda
 * issue etiquetada), nunca "libera tudo".
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AARRR_LABEL_PREFIX = "aarrr:";

export const AARRR_STAGES = ["awareness", "acquisition", "activation", "retention", "referral", "revenue"] as const;

const WHITELIST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "aarrr-whitelist.json");

/** Etapas (`retention`, …) das labels `aarrr:*` da issue. */
export function aarrrStagesOf(labels: readonly string[]): string[] {
  return labels.filter((l) => l.startsWith(AARRR_LABEL_PREFIX)).map((l) => l.slice(AARRR_LABEL_PREFIX.length));
}

/** Parse tolerante do JSON — valores fora de `AARRR_STAGES` são descartados. */
export function parseAarrrWhitelist(raw: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(raw) as { whitelist?: unknown };
    if (!Array.isArray(parsed.whitelist)) return new Set();
    const valid = new Set<string>(AARRR_STAGES);
    return new Set(parsed.whitelist.filter((s): s is string => typeof s === "string" && valid.has(s)));
  } catch {
    return new Set();
  }
}

let cached: { mtimeMs: number; set: ReadonlySet<string> } | null = null;

/** Whitelist do repo. Relida quando o arquivo muda (mtime) — o Studio é um
 * processo longo e precisa refletir a edição sem restart. */
export function loadAarrrWhitelist(): ReadonlySet<string> {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(WHITELIST_PATH).mtimeMs;
  } catch {
    // ausente → whitelist vazia (fail-closed)
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.set;
  let raw = "";
  if (mtimeMs >= 0) {
    try {
      raw = readFileSync(WHITELIST_PATH, "utf8");
    } catch {
      // ilegível → whitelist vazia (fail-closed)
    }
  }
  cached = { mtimeMs, set: parseAarrrWhitelist(raw) };
  return cached.set;
}

/** A issue está vetada pela whitelist? Sem label `aarrr:*` → nunca. */
export function isBlockedByAarrrWhitelist(labels: readonly string[], whitelist: ReadonlySet<string>): boolean {
  const stages = aarrrStagesOf(labels);
  return stages.length > 0 && !stages.some((s) => whitelist.has(s));
}
