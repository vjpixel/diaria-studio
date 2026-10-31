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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const FRESHNESS_SLACK_MS = 2 * 60 * 1000;

export interface FreshnessResult {
  ok: boolean;
  problems: string[];
}

// Só existência/tamanho: o próprio Stage 5 (5c-pre) regrava este arquivo depois do sentinel.
const EXTRA_REQUIRED = ["06-public-images.json"];

export function checkStage5Freshness(editionDir: string, opts: { slackMs?: number } = {}): FreshnessResult {
  const slack = opts.slackMs ?? FRESHNESS_SLACK_MS;
  const problems: string[] = [];
  const sentinelPath = join(editionDir, "_internal", ".step-4-done.json");
  if (!existsSync(sentinelPath)) {
    return { ok: false, problems: ["sentinel do Stage 4 ausente (ainda sincronizando?)"] };
  }
  let outputs: string[] = [];
  let completedMs = NaN;
  try {
    const s = JSON.parse(readFileSync(sentinelPath, "utf8")) as { outputs?: string[]; completed_at?: string };
    outputs = Array.isArray(s.outputs) ? s.outputs : [];
    completedMs = Date.parse(s.completed_at ?? "");
  } catch {
    return { ok: false, problems: ["sentinel do Stage 4 ilegível"] };
  }
  if (!Number.isFinite(completedMs)) problems.push("sentinel do Stage 4 sem completed_at válido");
  const watched = new Set<string>([...outputs, ...EXTRA_REQUIRED]);
  for (const rel of watched) {
    const p = join(editionDir, rel);
    if (!existsSync(p)) {
      problems.push(`${rel}: ausente`);
      continue;
    }
    const st = statSync(p);
    if (st.size === 0) problems.push(`${rel}: vazio`);
    else if (!EXTRA_REQUIRED.includes(rel) && Number.isFinite(completedMs) && st.mtimeMs > completedMs + slack) {
      problems.push(`${rel}: modificado após o sentinel do Stage 4`);
    }
  }
  // Cópia de conflito do OneDrive: "<nome>-<HOST>[-N].<ext>" com HOST capitalizado
  // (ex.: 06-public-images-Neo.json); irmãos legítimos como 03-social-pre-humanizador.md não casam.
  for (const d of [editionDir, join(editionDir, "_internal")]) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      const conflict = [...watched].some((w) => {
        const base = w.split("/").pop()!;
        const dot = base.lastIndexOf(".");
        const stem = dot < 0 ? base : base.slice(0, dot);
        const ext = dot < 0 ? "" : base.slice(dot);
        const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Z][A-Za-z0-9]*(-\\d+)?(${ext.replace(".", "\\.")}|${ext.replace(".", "\\.")}\\.tmp)$`);
        return re.test(name);
      });
      if (conflict) {
        problems.push(`${name}: cópia de conflito — confira e mova para _internal/_forensic/ se for descartável`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
