/**
 * stage4-cascade-status.ts (#8123 Fatia 4 — cascatas com preview progressivo;
 * multi-highlight #8783)
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
 *      ficaram desatualizadas para UM destaque específico — grava/atualiza
 *      a entrada correspondente em `_internal/stage4-cascade-status.json`.
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
 *   4. Quando TODAS as cascatas de TODOS os destaques terminam (`done` ou
 *      `error`), o badge desaparece sozinho na próxima re-renderização (o
 *      HTML final nunca chama `injectRegeneratingBadge` de novo) —
 *      `clearCascadeStatus` remove o arquivo de estado (ou só a entrada de
 *      um destaque específico, via `--highlight`, quando as demais ainda
 *      estão em curso).
 *
 * **Estado por-DESTAQUE, não por-edição (#8783 — corrige o desenho original
 * da Fatia 4).** A versão original deste módulo guardava um único objeto de
 * cascata por arquivo — reestruturar vários destaques na mesma rodada de
 * `ajustar` (D1↔D2 trocados, itens do RADAR promovidos a D1/D3) chamava
 * `--start --highlight d1`, depois `--start --highlight d2`, depois
 * `--start --highlight d3`, e cada `--start` SOBRESCREVIA o registro do
 * highlight anterior — só o último ficava rastreado, perdendo o "pending"
 * dos demais silenciosamente. O estado agora é um MAPA `{ [highlight]:
 * CascadeEntry }` — `startCascade` só sobrescreve a entrada do PRÓPRIO
 * highlight que está declarando (coerente com "só o ajuste mais recente
 * DAQUELE destaque importa"), nunca as entradas de outros highlights em
 * curso. `--status`/`--mark`/`--clear` operam sobre a entrada certa (ou,
 * pra `--status`/`--clear` sem `--highlight`, sobre TODAS as entradas
 * pendentes) — não só a mais recentemente iniciada.
 *
 * Fail-soft por design: leitura de arquivo corrompido/ausente nunca lança —
 * volta pra "nenhuma cascata em curso" (pior caso: o badge não aparece,
 * nunca "trava o gate por acidente").
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CascadePieceName = "image" | "carousel" | "social";
export type CascadePieceState = "pending" | "done" | "error";

/** Uma cascata em curso para UM destaque (`highlight` é a chave do mapa que a contém, não um campo aqui). */
export interface CascadeEntry {
  /** Descrição curta do que disparou a cascata (ex: "título alterado", "reordenação D1↔D3"). */
  reason: string;
  requested_at: string;
  updated_at: string;
  pieces: Partial<Record<CascadePieceName, CascadePieceState>>;
}

/** Estado completo da edição — uma entrada por destaque com cascata em curso (#8783). */
export type CascadeState = Record<string, CascadeEntry>;

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

function isValidEntry(v: unknown): v is Partial<CascadeEntry> {
  return typeof v === "object" && v !== null && typeof (v as Partial<CascadeEntry>).pieces === "object" && (v as Partial<CascadeEntry>).pieces !== null;
}

function normalizeEntry(raw: Partial<CascadeEntry>): CascadeEntry {
  return {
    reason: typeof raw.reason === "string" ? raw.reason : "",
    requested_at: typeof raw.requested_at === "string" ? raw.requested_at : nowIso(),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
    pieces: raw.pieces as Partial<Record<CascadePieceName, CascadePieceState>>,
  };
}

/**
 * Lê o mapa de cascatas cru do disco — fail-soft (arquivo ausente/corrompido
 * vira `{}`). Formato legado de single-highlight (`{ highlight: "d1",
 * pieces: {...} }`, pré-#8783) não é migrado automaticamente — o estado
 * vive em `_internal/` (transitório, por-edição) e é sempre limpo pelo
 * `--clear` ao fim de uma cascata, então não há dado legado real a
 * preservar; um arquivo nesse formato antigo simplesmente não bate
 * `isValidEntry` para nenhuma chave e a leitura volta `{}` (pior caso: o
 * badge não aparece por um ciclo, nunca lança).
 */
function readState(statusPath: string): CascadeState {
  const raw = safeReadJson(statusPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state: CascadeState = {};
  for (const [highlight, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidEntry(entry)) {
      state[highlight] = normalizeEntry(entry);
    }
  }
  return state;
}

/** Lê o estado da cascata para a edição. `null` = nenhuma cascata em curso para NENHUM destaque (arquivo ausente/corrompido/vazio). */
export function readCascadeStatus(statusPath: string): CascadeState | null {
  const state = readState(statusPath);
  return Object.keys(state).length > 0 ? state : null;
}

/**
 * Inicia (ou reinicia) a cascata para `opts.highlight`, declarando quais
 * peças ficaram desatualizadas. Todas as peças nascem `pending`. **Só
 * sobrescreve a entrada do PRÓPRIO highlight** — entradas de outros
 * destaques com cascata em curso permanecem intactas (#8783).
 */
export function startCascade(
  statusPath: string,
  opts: { highlight: string; reason: string; pieces: CascadePieceName[] },
): CascadeState {
  const state = readState(statusPath);
  const uniquePieces = Array.from(new Set(opts.pieces)).filter(isValidPieceName);
  const pieces: Partial<Record<CascadePieceName, CascadePieceState>> = {};
  for (const p of uniquePieces) pieces[p] = "pending";
  const ts = nowIso();
  state[opts.highlight] = {
    reason: opts.reason,
    requested_at: ts,
    updated_at: ts,
    pieces,
  };
  writeJsonAtomic(statusPath, state);
  return state;
}

/**
 * Marca uma peça do destaque `highlight` como concluída (`done`) ou falha
 * (`error`). Se não houver cascata em curso para esse highlight específico,
 * ou a peça não fizer parte da cascata declarada, é um no-op silencioso que
 * devolve o estado atual (não-nulo se OUTROS highlights ainda tiverem
 * cascata em curso) — o mesmo fail-soft de antes, agora por-destaque: uma
 * corrida entre `--mark d1` e um `--start d2`/`--clear d1` concorrente nunca
 * deve derrubar o script chamador em background, nem apagar o progresso de
 * highlights não-relacionados.
 */
export function markPiece(
  statusPath: string,
  highlight: string,
  piece: CascadePieceName,
  state: Exclude<CascadePieceState, "pending">,
): CascadeState | null {
  const current = readState(statusPath);
  const entry = current[highlight];
  if (!entry || !(piece in entry.pieces)) {
    return Object.keys(current).length > 0 ? current : null;
  }
  current[highlight] = {
    ...entry,
    updated_at: nowIso(),
    pieces: { ...entry.pieces, [piece]: state },
  };
  writeJsonAtomic(statusPath, current);
  return current;
}

/**
 * Remove cascata(s) do estado. Sem `highlight`: cascata inteira resolvida —
 * remove o arquivo (equivalente ao comportamento pré-#8783). Com
 * `highlight`: remove só a entrada daquele destaque, preservando as demais
 * ainda em curso; se essa era a última entrada, remove o arquivo também.
 */
export function clearCascadeStatus(statusPath: string, highlight?: string): void {
  if (!highlight) {
    if (existsSync(statusPath)) {
      try {
        unlinkSync(statusPath);
      } catch {
        // fail-soft — pior caso é o badge reaparecer numa próxima leitura;
        // não vale travar o gate por isso.
      }
    }
    return;
  }
  const state = readState(statusPath);
  if (!(highlight in state)) return;
  delete state[highlight];
  if (Object.keys(state).length === 0) {
    clearCascadeStatus(statusPath);
    return;
  }
  writeJsonAtomic(statusPath, state);
}

/** true enquanto QUALQUER peça de QUALQUER destaque ainda estiver `pending`. */
export function isCascadePending(state: CascadeState | null): boolean {
  if (!state) return false;
  return Object.values(state).some((entry) => Object.values(entry.pieces).some((s) => s === "pending"));
}

/** Rótulos em PT-BR das peças `pending` de UMA entrada específica, na ordem fixa image→carousel→social. */
export function pendingPieceLabels(entry: CascadeEntry | null | undefined): string[] {
  if (!entry) return [];
  return ALL_PIECES.filter((p) => entry.pieces[p] === "pending").map((p) => PIECE_LABELS_PT[p]);
}

const BADGE_START = "<!-- stage4-cascade-badge:start -->";
const BADGE_END = "<!-- stage4-cascade-badge:end -->";

/**
 * Monta o HTML do banner "regenerando" a injetar no preview local — `null`
 * quando não há nada pendente em NENHUM destaque (estado ausente, ou todas
 * as peças de todas as entradas já resolvidas). Agrega todos os destaques
 * com peça(s) pendente(s) numa única linha (`D1: imagem, carrossel · D3:
 * texto social`), em ordem alfabética de highlight — puramente informativo,
 * nunca referencia a peça em si (a imagem/social ANTIGOS continuam no HTML
 * normalmente), só avisa que uma atualização está a caminho.
 */
export function buildRegeneratingBadgeHtml(state: CascadeState | null): string | null {
  if (!state) return null;
  const parts: string[] = [];
  for (const highlight of Object.keys(state).sort()) {
    const pending = pendingPieceLabels(state[highlight]);
    if (pending.length === 0) continue;
    parts.push(`${highlight.toUpperCase()}: ${pending.join(", ")}`);
  }
  if (parts.length === 0) return null;
  return (
    `<div style="position:sticky;top:0;z-index:9999;background:#fff3cd;` +
    `color:#664d03;border-bottom:2px solid #ffe69c;padding:8px 16px;` +
    `font:14px/1.4 system-ui,sans-serif;text-align:center;">` +
    `⏳ ${parts.join(" · ")} regenerando em segundo plano — a página atualiza sozinha quando terminar.` +
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
