/**
 * stage5-freshness.ts (#11698) — validação de frescor da edição antes do
 * dispatch do Stage 5, fail-closed e somente leitura.
 *
 * Duas máquinas sincronizam `data/` via OneDrive: o sentinel do Stage 4 pode
 * chegar antes dos demais arquivos. Sinais de edição possivelmente defasada:
 *   - output do sentinel ausente ou vazio;
 *   - output modificado DEPOIS do `completed_at` do sentinel (edição pós-gate,
 *     ou escrita de outra máquina ainda em curso);
 *   - cópia de conflito do OneDrive (`<nome>-<HOST>.<ext>`) ou `.tmp` ao lado;
 *   - `06-public-images.json` ausente (imagens do Stage 3/5c-pre não chegaram).
 * Não altera nada na edição.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BEEHIIV_BASE_URL } from "./edition-url.ts";

export const FRESHNESS_SLACK_MS = 2 * 60 * 1000;

export interface FreshnessResult {
  ok: boolean;
  problems: string[];
  /** Avisos que não bloqueiam (ex.: sentinel antigo sem hashes). */
  warnings?: string[];
}

// Sempre vigiados, mesmo se o sentinel vier com `outputs` vazio/inválido (fail-closed).
const ALWAYS_WATCHED = ["02-reviewed.md", "03-social.md"];

// URL própria resolvida; a pontuação final da frase (`. , ; : ! ?`) não faz parte da URL.
const SELF_URL_RE = new RegExp(
  `${BEEHIIV_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s)]*?(?=[.,;:!?]*(?:\\s|\\)|$))`,
  "g",
);
const normalizeSelfUrls = (c: string) => c.replace(SELF_URL_RE, "{edition_url}");

/**
 * sha256 do conteúdo aprovado. Em 03-social.md a URL própria resolvida pelo Stage 5
 * (§5c-2) volta ao placeholder `{edition_url}` antes do hash, senão a retomada divergiria.
 */
export function hashOutput(rel: string, content: Buffer): string {
  const data = rel === "03-social.md" ? Buffer.from(normalizeSelfUrls(content.toString("utf8")), "utf8") : content;
  return createHash("sha256").update(data).digest("hex");
}

/** Hashes dos outputs existentes, gravados no sentinel do Stage 4 (`output_hashes`). */
export function computeOutputHashes(editionDir: string, outputs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of outputs) {
    const p = join(editionDir, rel);
    if (existsSync(p) && statSync(p).isFile()) out[rel] = hashOutput(rel, readFileSync(p));
  }
  return out;
}

// Só existência/tamanho: o próprio Stage 5 (5c-pre) regrava este arquivo depois do sentinel.
const EXTRA_REQUIRED = ["06-public-images.json"];
// O Stage 5 (§5c-2, resolve-edition-url --validate-social) reescreve estes depois do
// sentinel ({edition_url} resolvida): mtime posterior não indica defasagem, senão a
// retomada fica presa em exit 4 para sempre. Existência/tamanho/conflito seguem valendo.
const REWRITTEN_BY_STAGE5 = ["03-social.md"];

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex único para cópias de conflito do OneDrive de um arquivo vigiado. */
export function conflictRegex(rel: string): RegExp {
  const base = rel.split("/").pop()!;
  const dot = base.lastIndexOf(".");
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  const variants = (h: string) => [h, h.toLowerCase(), h.toUpperCase(), h[0].toUpperCase() + h.slice(1).toLowerCase()];
  const hosts = [...new Set(["neo", "predator", "helios", "300", hostname()].filter(Boolean).flatMap(variants))].map(esc).join("|");
  // -safeBackup-0001 | -<host>[-safeBackup-0001] (qualquer caixa) | -<Host>[-N] capitalizado
  const suffix =
    `(?:-[A-Za-z0-9]+-safeBackup-\\d+|-safeBackup(?:-\\d+)?|-(?:${hosts})(?:-safeBackup)?(?:-\\d+)?|-[A-Z][A-Za-z0-9]*(?:-\\d+)?)`;
  return new RegExp(`^${esc(stem)}${suffix}${esc(ext)}(?:\\.tmp)?$|^${esc(base)}\\.tmp$`);
}

export function checkStage5Freshness(
  editionDir: string,
  opts: { slackMs?: number; acceptNewer?: boolean } = {},
): FreshnessResult {
  const slack = opts.slackMs ?? FRESHNESS_SLACK_MS;
  const problems: string[] = [];
  const sentinelPath = join(editionDir, "_internal", ".step-4-done.json");
  if (!existsSync(sentinelPath)) {
    return { ok: false, problems: ["sentinel do Stage 4 ausente (ainda sincronizando?)"] };
  }
  let outputs: string[] = [];
  let hashes: Record<string, string> = {};
  let completedMs = NaN;
  const warnings: string[] = [];
  try {
    const s = JSON.parse(readFileSync(sentinelPath, "utf8")) as {
      outputs?: unknown;
      completed_at?: string;
      output_hashes?: unknown;
    };
    if (Array.isArray(s.outputs) && s.outputs.every((x) => typeof x === "string")) outputs = s.outputs as string[];
    else problems.push("sentinel do Stage 4 com `outputs` inválido (não é lista de caminhos)");
    if (s.output_hashes && typeof s.output_hashes === "object" && !Array.isArray(s.output_hashes)) {
      hashes = s.output_hashes as Record<string, string>;
    }
    completedMs = Date.parse(s.completed_at ?? "");
  } catch {
    return { ok: false, problems: ["sentinel do Stage 4 ilegível"] };
  }
  if (!Number.isFinite(completedMs)) problems.push("sentinel do Stage 4 sem completed_at válido");
  if (Object.keys(hashes).length === 0) {
    warnings.push("sentinel do Stage 4 sem output_hashes (gravado antes do #11698): só o mtime vigia o conteúdo");
  }
  const watched = new Set<string>([...ALWAYS_WATCHED, ...outputs, ...EXTRA_REQUIRED]);
  for (const rel of watched) {
    const p = join(editionDir, rel);
    if (!existsSync(p)) {
      problems.push(`${rel}: ausente`);
      continue;
    }
    const st = statSync(p);
    if (st.size === 0) {
      problems.push(`${rel}: vazio`);
      continue;
    }
    if (EXTRA_REQUIRED.includes(rel)) continue;
    const expected = hashes[rel];
    if (typeof expected === "string") {
      // Hash vale mais que mtime: pega cópia pré-gate (mtime antigo) e dispensa isenção de 03-social.md.
      if (!opts.acceptNewer && hashOutput(rel, readFileSync(p)) !== expected) {
        problems.push(`${rel}: conteúdo difere do aprovado no gate 4 (sha256) — versão pré-gate ou editado depois`);
      }
    } else if (!opts.acceptNewer && !REWRITTEN_BY_STAGE5.includes(rel) && Number.isFinite(completedMs) && st.mtimeMs > completedMs + slack) {
      problems.push(`${rel}: modificado após o sentinel do Stage 4`);
    }
  }
  // Cópia de conflito do OneDrive (-safeBackup-NNNN, sufixo de host, .tmp ao lado);
  // irmãos legítimos como 03-social-pre-humanizador.md não casam.
  const res = [...watched].map(conflictRegex);
  for (const d of [editionDir, join(editionDir, "_internal")]) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (res.some((re) => re.test(name))) {
        problems.push(`${name}: cópia de conflito — confira e mova para _internal/_forensic/ se for descartável`);
      }
    }
  }
  return { ok: problems.length === 0, problems, ...(warnings.length ? { warnings } : {}) };
}
