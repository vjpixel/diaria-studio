/**
 * stage4-cascade-status.ts (#8123 Fatia 4 — cascatas com preview progressivo)
 *
 * A issue #8123 pede que uma troca/reordenação/título de destaque no gate
 * do Stage 4 (`.claude/agents/orchestrator-stage-4.md` §4d.1, passos 3/4)
 * mostre o TEXTO atualizado no preview em ~10s, com a imagem e o social
 * ANTIGOS marcados como "regenerando" — sem bloquear o preview esperando
 * `image-generate.ts`/`gen-carousel-cards.ts`/`social-writer` terminarem em
 * background. Este módulo é o estado compartilhado que torna isso possível:
 *
 *   1. Ao aplicar a edição de título/reorder, o orchestrator chama
 *      `startCascade` (via o CLI fino `scripts/stage4-cascade-status.ts
 *      --start`) declarando quais peças (`image`, `carousel`, `social`)
 *      ficaram desatualizadas — grava `_internal/stage4-cascade-status.json`.
 *   2. O preview de TEXTO é servido imediatamente (§4b step 2b já existente,
 *      sem mudança) — o orchestrator injeta o badge "regenerando" nesse HTML
 *      via `buildRegeneratingBadgeHtml`/`injectRegeneratingBadge` antes de
 *      servir, e responde ao editor sem esperar as peças em background.
 *   3. `image-generate.ts`/`gen-carousel-cards.ts` rodam com
 *      `run_in_background: true` (scripts puros, não-LLM — genuinamente
 *      não-bloqueantes); `social-writer` é dispatchado como Agent logo
 *      depois do texto já ter sido respondido ao editor. Cada peça, ao
 *      terminar, chama `markPiece` (`--mark`) e o orchestrator re-renderiza
 *      + re-serve o HTML daquela peça — o watcher da Fatia 1
 *      (`serve-preview.ts --watch`) já reflete a mudança em disco sem ação
 *      adicional do editor.
 *   4. Quando todas as peças declaradas terminam (`done` ou `error`), o
 *      badge desaparece sozinho na próxima re-renderização (o HTML final
 *      nunca chama `injectRegeneratingBadge` de novo) — `clearCascadeStatus`
 *      remove o arquivo de estado.
 *
 * Estado por-edição (não por-ajuste): uma nova cascata (`startCascade`)
 * SOBRESCREVE qualquer estado anterior — coerente com o gate exigir só o
 * ajuste MAIS RECENTE resolvido antes de aceitar `sim` (mesmo racional do
 * `inputs_hash` de coalescing da Fatia 3, `stage4-check-lock.ts`).
 *
 * Fail-soft por design: leitura de arquivo corrompido/ausente nunca lança —
 * volta pra "nenhuma cascata em curso" (pior caso: o badge não aparece,
 * nunca "trava o gate por acidente").
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CascadePieceName = "image" | "carousel" | "social";
export type CascadePieceState = "pending" | "done" | "error";

export interface CascadeStatus {
  /** Destaque afetado — "d1" | "d2" | "d3". */
  highlight: string;
  /** Descrição curta do que disparou a cascata (ex: "título alterado", "reordenação D1↔D3"). */
  reason: string;
  requested_at: string;
  updated_at: string;
  pieces: Partial<Record<CascadePieceName, CascadePieceState>>;
}

const PIECE_LABELS_PT: Record<CascadePieceName, string> = {
  image: "imagem",
  carousel: "carrossel",
  social: "texto social",
};

const ALL_PIECES: CascadePieceName[] = ["image", "carousel", "social"];

function isValidPieceName(v: string): v is CascadePieceName {
  return (ALL_PIECES as string[]).includes(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeReadJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // fail-soft — arquivo corrompido é tratado como ausente
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  // rename é atômico no mesmo filesystem — mesmo padrão de
  // stage4-post-edit-checks.ts (#8123 Fatia 3), evita leitor concorrente
  // (badge injector, ou o próprio gate) ver um JSON truncado a meio-write.
  renameSync(tmpPath, path);
}

/** Lê o estado da cascata para a edição. `null` = nenhuma cascata em curso (ou arquivo ausente/corrompido). */
export function readCascadeStatus(statusPath: string): CascadeStatus | null {
  const raw = safeReadJson(statusPath) as Partial<CascadeStatus> | null;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.highlight !== "string" || typeof raw.pieces !== "object" || raw.pieces === null) {
    return null;
  }
  return {
    highlight: raw.highlight,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    requested_at: typeof raw.requested_at === "string" ? raw.requested_at : nowIso(),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
    pieces: raw.pieces as Partial<Record<CascadePieceName, CascadePieceState>>,
  };
}

/**
 * Inicia (ou reinicia — sobrescreve) a cascata declarando quais peças
 * ficaram desatualizadas para `highlight`. Todas as peças nascem `pending`.
 */
export function startCascade(
  statusPath: string,
  opts: { highlight: string; reason: string; pieces: CascadePieceName[] },
): CascadeStatus {
  const uniquePieces = Array.from(new Set(opts.pieces)).filter(isValidPieceName);
  const pieces: Partial<Record<CascadePieceName, CascadePieceState>> = {};
  for (const p of uniquePieces) pieces[p] = "pending";
  const ts = nowIso();
  const status: CascadeStatus = {
    highlight: opts.highlight,
    reason: opts.reason,
    requested_at: ts,
    updated_at: ts,
    pieces,
  };
  writeJsonAtomic(statusPath, status);
  return status;
}

/**
 * Marca uma peça como concluída (`done`) ou falha (`error`). Se não houver
 * cascata em curso, ou a peça não fizer parte da cascata declarada, é um
 * no-op silencioso — o mesmo fail-soft de `readCascadeStatus` (uma corrida
 * entre `--mark` e um `--clear`/`--start` concorrente nunca deve derrubar o
 * script chamador em background).
 */
export function markPiece(
  statusPath: string,
  highlight: string,
  piece: CascadePieceName,
  state: Exclude<CascadePieceState, "pending">,
): CascadeStatus | null {
  const current = readCascadeStatus(statusPath);
  if (!current || current.highlight !== highlight) return current;
  if (!(piece in current.pieces)) return current;
  const updated: CascadeStatus = {
    ...current,
    updated_at: nowIso(),
    pieces: { ...current.pieces, [piece]: state },
  };
  writeJsonAtomic(statusPath, updated);
  return updated;
}

/** Remove o arquivo de estado — cascata totalmente resolvida, badge não deve mais aparecer. */
export function clearCascadeStatus(statusPath: string): void {
  if (existsSync(statusPath)) {
    try {
      unlinkSync(statusPath);
    } catch {
      // fail-soft — pior caso é o badge reaparecer numa próxima leitura;
      // não vale travar o gate por isso.
    }
  }
}

/** true enquanto QUALQUER peça declarada ainda estiver `pending`. */
export function isCascadePending(status: CascadeStatus | null): boolean {
  if (!status) return false;
  return Object.values(status.pieces).some((s) => s === "pending");
}

/** Rótulos em PT-BR das peças ainda `pending`, na ordem fixa image→carousel→social. */
export function pendingPieceLabels(status: CascadeStatus | null): string[] {
  if (!status) return [];
  return ALL_PIECES.filter((p) => status.pieces[p] === "pending").map((p) => PIECE_LABELS_PT[p]);
}

const BADGE_START = "<!-- stage4-cascade-badge:start -->";
const BADGE_END = "<!-- stage4-cascade-badge:end -->";

/**
 * Monta o HTML do banner "regenerando" a injetar no preview local — `null`
 * quando não há nada pendente (cascata ausente, ou todas as peças já
 * resolvidas). Puramente informativo: nunca referencia a peça em si (a
 * imagem/social ANTIGOS continuam no HTML normalmente), só avisa que uma
 * atualização está a caminho.
 */
export function buildRegeneratingBadgeHtml(status: CascadeStatus | null): string | null {
  const pending = pendingPieceLabels(status);
  if (pending.length === 0) return null;
  const label = pending.join(", ");
  const destaque = (status as CascadeStatus).highlight.toUpperCase();
  return (
    `<div style="position:sticky;top:0;z-index:9999;background:#fff3cd;` +
    `color:#664d03;border-bottom:2px solid #ffe69c;padding:8px 16px;` +
    `font:14px/1.4 system-ui,sans-serif;text-align:center;">` +
    `⏳ ${destaque}: ${label} regenerando em segundo plano — a página atualiza sozinha quando terminar.` +
    `</div>`
  );
}

/**
 * Injeta (ou remove, se `badgeHtml` for `null`) o banner logo após a tag
 * `<body...>` — sempre envolvido nos marcadores `BADGE_START`/`BADGE_END`
 * (o caller passa só o conteúdo visual; o wrapping fica aqui, não em
 * `buildRegeneratingBadgeHtml`, pra `injectRegeneratingBadge` ser
 * auto-suficiente na sua própria idempotência). Idempotente: qualquer
 * banner injetado numa chamada anterior é removido antes de inserir o
 * novo — nunca acumula banners numa rajada de re-renderizações. Se o HTML
 * não tiver `<body`, o banner é prefixado (fallback — não deveria
 * acontecer com os templates do projeto).
 */
export function injectRegeneratingBadge(html: string, badgeHtml: string | null): string {
  const escapedStart = BADGE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = BADGE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = html.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`), "");
  if (!badgeHtml) return stripped;
  const wrapped = `${BADGE_START}${badgeHtml}${BADGE_END}`;
  if (/<body[^>]*>/.test(stripped)) {
    return stripped.replace(/(<body[^>]*>)/, `$1${wrapped}`);
  }
  return wrapped + stripped;
}
