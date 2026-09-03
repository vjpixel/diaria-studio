/**
 * scripts/lib/metrics/metas-store.ts (#7172, fatia 5 — #7177)
 *
 * A camada de I/O de `metas.ts` — `data/metas.json` (declarativo, FORA do
 * git: `data/` é `.gitignore` blanket, o repo é público e a meta carrega
 * número de negócio; sincroniza entre máquinas pelo OneDrive como o resto
 * de `data/`).
 *
 * Duas direções de falha OPOSTAS e deliberadas:
 *   - `loadMetas` — fail-soft. `data/` ou `data/metas.json` ausente devolve
 *     `[]` mais o motivo, NUNCA lança (clone fresco, sessão cloud — mesmo
 *     padrão de `openDiariaSubscribersDbSafe`).
 *   - `validateMetas` — erro duro. Arquivo presente e malformado, `id`
 *     duplicado, ou `metrica_id` ausente do registry lança nomeando as
 *     metas órfãs (mesma direção de `loadDivulgacaoSnippet`,
 *     `scripts/stitch-newsletter.ts`, #5227: ausência não é invalidez,
 *     presença errada é).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meta, Operador, JanelaMeta } from "./metas.ts";
import type { MetricDef } from "./registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_METAS_PATH = resolve(ROOT, "data", "metas.json");

const OPERADORES: readonly Operador[] = [">=", "<="];
const JANELAS: readonly JanelaMeta[] = ["dia", "semana", "mes"];

export interface LoadMetasResult {
  metas: Meta[];
  /** Não-nulo quando `metas` veio vazio por ausência de arquivo/diretório
   *  (nunca por erro de parse — isso é `validateMetas`, que lança). */
  motivo: string | null;
}

/** Checagem estrutural mínima (não substitui `validateMetas`, que checa
 *  contra o registry) — só garante que o JSON tem a forma esperada antes de
 *  fazer cast. @pure */
function isWellFormedMeta(value: unknown): value is Meta {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.trim() !== "" &&
    typeof m.metrica_id === "string" &&
    m.metrica_id.trim() !== "" &&
    typeof m.produto === "string" &&
    typeof m.alvo === "number" &&
    OPERADORES.includes(m.operador as Operador) &&
    JANELAS.includes(m.janela as JanelaMeta) &&
    (m.prazo === null || typeof m.prazo === "string") &&
    typeof m.criada_em === "string" &&
    typeof m.motivo === "string" &&
    typeof m.dono === "string"
  );
}

/** Fail-soft: `data/` ou `data/metas.json` ausente devolve `{ metas: [],
 *  motivo }`, nunca lança. Arquivo presente mas com JSON inválido TAMBÉM
 *  lança (aqui, não em `validateMetas`) — "presente e malformado" é erro
 *  duro por definição, mesmo antes de checar contra o registry. */
export function loadMetas(metasPath: string = DEFAULT_METAS_PATH): LoadMetasResult {
  if (!existsSync(metasPath)) {
    return { metas: [], motivo: `data/metas.json ausente em ${metasPath} — sem metas cadastradas (fail-soft)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metasPath, "utf8"));
  } catch (err) {
    throw new Error(
      `[metrics/metas-store] ${metasPath} existe mas não é JSON válido: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[metrics/metas-store] ${metasPath} deveria ser um array de Meta, recebeu ${typeof parsed}`);
  }
  const malformed = parsed.filter((m) => !isWellFormedMeta(m));
  if (malformed.length > 0) {
    throw new Error(
      `[metrics/metas-store] ${metasPath} tem ${malformed.length} entrada(s) malformada(s): ${JSON.stringify(malformed)}`,
    );
  }
  return { metas: parsed as Meta[], motivo: null };
}

/**
 * Erro duro: `id` duplicado, ou `metrica_id` fora do registry (F3/F4) —
 * lança nomeando as metas órfãs. `registry` aceita `readonly MetricDef[]`
 * pelo mesmo motivo de `assertRegistryValido(metrics)`: testável com
 * fixture sem depender do array real `METRICAS`.
 */
export function validateMetas(metas: readonly Meta[], registry: readonly MetricDef[]): void {
  const idsConhecidos = new Set(registry.map((m) => m.id));
  const seen = new Set<string>();
  const duplicadas: string[] = [];
  const orfas: string[] = [];
  for (const meta of metas) {
    if (seen.has(meta.id)) duplicadas.push(meta.id);
    seen.add(meta.id);
    if (!idsConhecidos.has(meta.metrica_id)) orfas.push(`${meta.id} -> ${meta.metrica_id}`);
  }
  if (duplicadas.length > 0) {
    throw new Error(`[metrics/metas-store] id de meta duplicado: ${[...new Set(duplicadas)].join(", ")}`);
  }
  if (orfas.length > 0) {
    throw new Error(
      `[metrics/metas-store] meta(s) apontando para metrica_id inexistente no registry: ${orfas.join("; ")}`,
    );
  }
}
