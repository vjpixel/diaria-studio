/**
 * lint-checks/approved-item-removal.ts (#8121)
 *
 * O gate `url-bucket` (#165) compara a SEÇÃO onde uma URL aparece em
 * `02-reviewed.md` contra o bucket original em `_internal/01-approved.json`.
 * Quando o editor recategoriza um item entre seções no Stage 4 (ex: RADAR →
 * LANÇAMENTOS), a única forma de satisfazer o gate hoje é editar
 * `01-approved.json` diretamente — o que é esperado e não é o problema.
 *
 * O problema é REMOVER um item inteiro de `01-approved.json` (em vez de só
 * desreferenciá-lo em `02-reviewed.md`, que já basta pra satisfazer o
 * `url-bucket` — ele só valida URLs que aparecem no MD): isso apaga
 * totalmente o registro de que aquele item foi considerado/pontuado pelo
 * categorizador naquele dia, e corrompe o sinal que scripts de calibração
 * (`analyze-bucket-overrides.ts`, `calibrate-scoring-weights.ts`,
 * `check-highlight-themes.ts`, `check-track-a-negative-impact-canary.ts`)
 * usam pra medir onde o categorizador/scorer erra — eles diffam
 * `01-categorized.json` (saída crua do Stage 1) × `01-approved.json` (saída
 * pós-gate) assumindo que tudo que sai de `01-approved.json` saiu no gate do
 * Stage 1, nunca depois, no Stage 4.
 *
 * `detectRemovedApprovedItems` é o core PURO — compara dois estados JSON
 * (baseline = snapshot pós-Stage 1/2, atual = `01-approved.json` no momento
 * do gate do Stage 4) e retorna os itens que SUMIRAM de TODOS os buckets
 * (não apenas mudaram de bucket — isso é recategorização legítima, #8121
 * item 1 só proíbe REMOÇÃO). O call site em `invariant-checks/stage-4.ts`
 * (`checkApprovedItemRemoval`) lê o snapshot `stage2-post-gate` já mantido
 * por `derive-editor-requests.ts snapshot-stage2` (#5731) — nenhum snapshot
 * novo precisou ser criado pra esta issue.
 */

/** Buckets conhecidos de `01-approved.json` — inclui destaques/runners_up
 * (nunca deveriam "sumir" de verdade sem virar corte reportado em outro
 * lugar) e todos os buckets do pool secundário (chave de CATEGORIA —
 * `pesquisa`/`noticias`/`tutorial` — e de BUCKET — `radar`/`use_melhor` —
 * coexistem em edições de formatos diferentes; ambas entram aqui pra nunca
 * perder um item por causa da chave errada). */
const APPROVED_BUCKET_KEYS = [
  "highlights",
  "runners_up",
  "lancamento",
  "radar",
  "pesquisa",
  "noticias",
  "tutorial",
  "use_melhor",
  "video",
] as const;

export type ApprovedBucketKey = (typeof APPROVED_BUCKET_KEYS)[number];

export interface RemovedApprovedItem {
  url: string;
  title: string;
  /** Bucket onde o item estava no BASELINE (snapshot pós-Stage 1/2). */
  bucket: ApprovedBucketKey;
}

function extractUrl(item: unknown): string | undefined {
  const rec = item as { url?: unknown; article?: { url?: unknown } } | null | undefined;
  const url = rec?.url ?? rec?.article?.url;
  return typeof url === "string" && url !== "" ? url : undefined;
}

function extractTitle(item: unknown, fallbackUrl: string): string {
  const rec = item as { title?: unknown; article?: { title?: unknown } } | null | undefined;
  const title = rec?.title ?? rec?.article?.title;
  return typeof title === "string" && title !== "" ? title : fallbackUrl;
}

/** Indexa por URL todos os itens de `json`, por qualquer bucket conhecido.
 * URL duplicada entre buckets: 1º bucket na ordem de `APPROVED_BUCKET_KEYS`
 * vence (mesmo padrão de `indexPool` em `derive-editor-requests.ts`). */
function indexApprovedItems(json: unknown): Map<string, RemovedApprovedItem> {
  const byUrl = new Map<string, RemovedApprovedItem>();
  const root = json as Record<string, unknown> | null | undefined;
  for (const bucket of APPROVED_BUCKET_KEYS) {
    const items = root?.[bucket];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const url = extractUrl(item);
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, { url, title: extractTitle(item, url), bucket });
    }
  }
  return byUrl;
}

/**
 * Compara o BASELINE (snapshot pós-Stage 1/2) contra o estado ATUAL de
 * `01-approved.json`. Retorna os itens que existiam em QUALQUER bucket do
 * baseline e não existem em NENHUM bucket do estado atual — mover um item
 * entre buckets (ex: RADAR → LANÇAMENTOS) NÃO conta como removido, só a
 * ausência total da URL conta.
 */
export function detectRemovedApprovedItems(
  baselineJson: unknown,
  currentJson: unknown,
): RemovedApprovedItem[] {
  const baseline = indexApprovedItems(baselineJson);
  const current = indexApprovedItems(currentJson);
  const removed: RemovedApprovedItem[] = [];
  for (const [url, item] of baseline) {
    if (!current.has(url)) removed.push(item);
  }
  return removed;
}
