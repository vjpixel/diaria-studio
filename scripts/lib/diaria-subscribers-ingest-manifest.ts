/**
 * diaria-subscribers-ingest-manifest.ts (#6464 fatias 3/4 — #6586/#6587)
 *
 * Manifest de progresso GENÉRICO, reusado pelos dois builders por
 * plataforma que escrevem no store `diaria-subscribers-db.ts`:
 *   - `diaria-subscribers-ingest-kit.ts` (#6586) — 1 entry por broadcast.
 *   - `diaria-subscribers-ingest-brevo.ts` (#6587) — 1 entry por CONTA
 *     (só `brevo_diaria` desde #7196 — `brevo_clarice` nunca ingere no
 *     store da diária; o progresso DENTRO de uma conta usa um checkpoint
 *     próprio, mais granular — ver docstring do builder).
 *
 * Mesmo padrão de `beehiiv-engagement-manifest.ts` (#6465): puro (sem I/O),
 * `status` decide retomada (`ok` nunca reprocessa; `pending`/`partial`/
 * `error` sempre voltam em `pendingEntries`). Generalizado aqui em vez de
 * duplicado porque as DUAS fatias precisam exatamente do mesmo contrato
 * (id → status + contadores + timestamp + erro) — só o que cada `id`
 * REPRESENTA difere (broadcast vs conta).
 */

export type IngestEntryStatus = "pending" | "ok" | "partial" | "error";

export interface IngestManifestEntry {
  id: string;
  label?: string;
  status: IngestEntryStatus;
  /** Contadores livres do caller (ex: `{ sent: 594, delivered: 251 }` pro
   *  Kit, `{ events: 812 }` pro Brevo) — o manifest não interpreta, só guarda. */
  counts?: Record<string, number>;
  /** ISO timestamp da última tentativa (sucesso ou falha). */
  fetched_at?: string;
  error?: string;
}

export interface IngestManifest {
  generated_at: string;
  entries: IngestManifestEntry[];
}

/** Manifest vazio — usado quando não há `manifest.json` em disco ainda. */
export function buildInitialManifest(generatedAt: string): IngestManifest {
  return { generated_at: generatedAt, entries: [] };
}

/**
 * Funde ids recém-descobertos num manifest existente — nunca rebaixa o
 * status de uma entry já processada (`ok`/`partial`/`error` permanecem
 * intocados), só adiciona `pending` novas e preenche `label` que faltava.
 * Sem isso, cada re-scan apagaria o progresso já confirmado.
 */
export function mergeManifestEntries(
  existing: IngestManifest,
  discovered: Array<{ id: string; label?: string }>,
  generatedAt: string,
): IngestManifest {
  const byId = new Map<string, IngestManifestEntry>(existing.entries.map((e) => [e.id, e]));
  for (const d of discovered) {
    const current = byId.get(d.id);
    if (!current) {
      byId.set(d.id, { id: d.id, label: d.label, status: "pending" });
    } else if (!current.label && d.label) {
      byId.set(d.id, { ...current, label: d.label });
    }
  }
  return { generated_at: generatedAt, entries: [...byId.values()] };
}

/** Substitui (ou adiciona) a entry de `id` pelo resultado de uma tentativa. */
export function upsertManifestEntry(manifest: IngestManifest, entry: IngestManifestEntry): IngestManifest {
  const entries = manifest.entries.filter((e) => e.id !== entry.id);
  entries.push(entry);
  return { ...manifest, entries };
}

/** Entries que ainda precisam de trabalho — `ok` nunca aparece aqui. */
export function pendingManifestEntries(manifest: IngestManifest): IngestManifestEntry[] {
  return manifest.entries.filter((e) => e.status !== "ok");
}

export interface IngestCoverageSummary {
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  /** `true` só quando não sobra nada a fazer — todas as entries `ok`. */
  closed: boolean;
}

export function manifestCoverageSummary(manifest: IngestManifest): IngestCoverageSummary {
  const summary: IngestCoverageSummary = { total: manifest.entries.length, ok: 0, partial: 0, error: 0, pending: 0, closed: false };
  for (const e of manifest.entries) {
    if (e.status === "ok") summary.ok++;
    else if (e.status === "partial") summary.partial++;
    else if (e.status === "error") summary.error++;
    else summary.pending++;
  }
  summary.closed = summary.total > 0 && summary.ok === summary.total;
  return summary;
}
