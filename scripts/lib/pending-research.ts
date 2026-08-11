/**
 * pending-research.ts (#4990)
 *
 * Rastreamento determinístico de "pesquisa pendente" — quando o editor pede,
 * no gate humano do Stage 4 (`orchestrator-stage-4.md` §4d.1 "ajustar"), que
 * o orchestrator busque conteúdo NOVO para um bucket (tipicamente USE MELHOR)
 * em vez de só editar texto já escrito.
 *
 * Por que existe: incidente #4990 (edição 260811) — o editor pediu pesquisa
 * adicional pra USE MELHOR no gate do Stage 4, a pesquisa nunca foi
 * completada naquela sessão, e a seção desapareceu da edição publicada sem
 * NENHUM aviso em nenhum stage subsequente. `use_melhor:[]` seguiu vazio até
 * o Stage 6 (auto-reporter), quando um humano notou o buraco só porque leu o
 * resultado final — não porque o pipeline avisou.
 *
 * Este módulo não implementa retry automático de pesquisa (#4990 item 1) —
 * decisão deliberada: reabrir a pesquisa do Stage 1 (dedup/categorize/score)
 * a partir do meio do Stage 4 é uma mudança estrutural maior, fora do escopo
 * desta unidade (ver PR #4990 body). O que este módulo garante é que a
 * LACUNA nunca mais fica silenciosa (#4990 item 2/3): o pedido do editor é
 * persistido em disco (sobrevive a troca de sessão/resume — o cenário real
 * do incidente, onde a pesquisa foi "esquecida" entre sessões) e um check
 * determinístico consome esse marker pra emitir warning explícito enquanto
 * o bucket alvo continuar vazio.
 *
 * Marker: `_internal/pending-research.json` — 1 pedido pendente por edição
 * (write subsequente sobrescreve; não é uma fila). Se o editor pedir pesquisa
 * pra 2 buckets diferentes na mesma edição, o 2º --write substitui o 1º —
 * limitação aceita (caso raro; cada pedido já teria sido flagrado sozinho
 * antes do 2º ocorrer, já que o gate se re-apresenta a cada "ajustar").
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { normalizeCategorizedBuckets } from "./categorized-buckets.ts";

export const PENDING_RESEARCH_FILENAME = "pending-research.json";

export type PendingResearchStatus = "pending" | "resolved";

export interface PendingResearchMarker {
  /** Bucket alvo do pedido — tipicamente "use_melhor", mas genérico (#4990 escopo aberto a outros buckets). */
  bucket: string;
  /** Descrição em linguagem natural do que o editor pediu (ex: "mais 2 tutoriais de RAG"). */
  request: string;
  requestedAt: string;
  status: PendingResearchStatus;
  resolvedAt?: string;
  /** Motivo do resolve — "auto: bucket populado" (automático) ou texto livre passado via --resolve --reason. */
  resolvedReason?: string;
}

function markerPath(editionDir: string): string {
  return join(editionDir, "_internal", PENDING_RESEARCH_FILENAME);
}

/**
 * Grava (ou sobrescreve) o marker de pesquisa pendente. Chamado quando o
 * orchestrator reconhece, no loop "ajustar" do Stage 4, que o editor pediu
 * conteúdo NOVO (não edição de texto existente) pra um bucket.
 */
export function writePendingResearch(
  editionDir: string,
  bucket: string,
  request: string,
): string {
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const path = markerPath(editionDir);
  const marker: PendingResearchMarker = {
    bucket,
    request,
    requestedAt: new Date().toISOString(),
    status: "pending",
  };
  writeFileSync(path, JSON.stringify(marker, null, 2) + "\n", "utf8");
  return path;
}

/** Lê o marker atual, ou `null` se ausente/corrompido. */
export function readPendingResearch(editionDir: string): PendingResearchMarker | null {
  const path = markerPath(editionDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PendingResearchMarker;
    if (!parsed || typeof parsed.bucket !== "string" || typeof parsed.status !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Marca o marker existente como resolvido — chamado manualmente (editor/
 * orchestrator decidiu não perseguir a pesquisa, ou integrou o resultado à
 * mão sem passar pela auto-resolução de `checkPendingResearch`).
 * No-op (retorna false) se não houver marker ou já estiver resolvido.
 */
export function resolvePendingResearch(editionDir: string, reason?: string): boolean {
  const current = readPendingResearch(editionDir);
  if (!current || current.status === "resolved") return false;
  const updated: PendingResearchMarker = {
    ...current,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    ...(reason ? { resolvedReason: reason } : {}),
  };
  writeFileSync(markerPath(editionDir), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return true;
}

export type PendingResearchCheckResult =
  | { pending: false; reason: "no-marker" }
  | { pending: false; reason: "already-resolved" }
  | { pending: false; reason: "auto-resolved"; marker: PendingResearchMarker; bucketCount: number }
  | { pending: true; marker: PendingResearchMarker; bucketCount: number };

/**
 * Núcleo do guard (#4990). Lê o marker; se `pending` e o bucket alvo já tem
 * itens em `01-approved.json` (ou o `--approved-json` passado), auto-resolve
 * (grava `status: "resolved"` com `resolvedReason: "auto: bucket populado"`)
 * e retorna `auto-resolved` — cobre o caminho feliz onde a pesquisa FOI
 * completada e ninguém lembrou de rodar `--resolve` manualmente.
 *
 * Se o bucket segue vazio, retorna `pending: true` — caller decide como
 * surfacear (warning, nunca bloqueia — #4990 item 2, "avisar explicitamente",
 * não "impedir").
 *
 * @param approvedJsonPath  Default: `{editionDir}/_internal/01-approved.json`.
 */
export function checkPendingResearch(
  editionDir: string,
  approvedJsonPath?: string,
): PendingResearchCheckResult {
  const marker = readPendingResearch(editionDir);
  if (!marker) return { pending: false, reason: "no-marker" };
  if (marker.status !== "pending") return { pending: false, reason: "already-resolved" };

  const jsonPath = approvedJsonPath ?? resolve(editionDir, "_internal", "01-approved.json");
  let bucketCount = 0;
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
      const buckets = normalizeCategorizedBuckets(parsed);
      const key = marker.bucket as keyof typeof buckets;
      bucketCount = Array.isArray(buckets[key]) ? buckets[key].length : 0;
    } catch {
      bucketCount = 0;
    }
  }

  if (bucketCount > 0) {
    resolvePendingResearch(editionDir, "auto: bucket populado");
    return {
      pending: false,
      reason: "auto-resolved",
      marker,
      bucketCount,
    };
  }

  return { pending: true, marker, bucketCount };
}
