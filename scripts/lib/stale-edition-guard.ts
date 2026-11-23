/**
 * stale-edition-guard.ts (#11690) — detecta "data/ defasado, outra máquina à frente".
 *
 * Achado na 261030: gate 4 aprovado no Neo, sentinel ainda não sincronizado
 * (OneDrive) no 300; o Stage 4 re-rodou inteiro por cima e o sync devolveu o
 * clobber. Quando o sentinel do stage anterior/atual está AUSENTE, só vale
 * re-rodar se nada indicar que outro host está à frente.
 *
 * Fail-closed: qualquer sinal bloqueia. Sem sinal (mesma máquina, estado
 * consistente) → `ok`. Puro, sem I/O (o CLI coleta os fatos).
 */
import type { EditionLockRecord } from "./edition-lock.ts";

export interface StaleEditionFacts {
  /** Stage cujo sentinel está ausente e que o caller quer (re)rodar/pré-requisitar. */
  step: number;
  /** Steps (1..6) cujo `.step-N-done.json` existe localmente. */
  sentinelSteps: number[];
  lock: EditionLockRecord | null;
  localHost: string;
  /**
   * O sentinel existe mas os outputs dele não (Stage 5 exit 2): o sentinel
   * chegou antes dos arquivos no sync. Aí um registro de OUTRO host que cobre
   * o stage vale como sinal mesmo com o sentinel local presente.
   */
  outputsMissing?: boolean;
  /** Arquivo `edition-lock` existe mas está corrompido/ilegível (sync em trânsito): fail-closed. */
  lockUnreadable?: boolean;
  /**
   * Idade (ms) do arquivo mais recente da edição NESTA máquina (`null`/ausente =
   * desconhecida ou pasta vazia). Só usada com `step` 5 (#13851).
   */
  newestFileAgeMs?: number | null;
  /**
   * Etapa que está checando o pré-requisito (`--caller-stage 5` com `--step 4`,
   * #13851). Já normalizada para número (`"05"` → 5) pelo CLI.
   */
  callerStage?: number;
  /** Relógio (ms) para a janela do tombstone de interrupção (#11713). Default `Date.now()`. */
  now?: number;
}

/**
 * Por quanto tempo um tombstone de interrupção (release simples, #11713) de
 * OUTRO host conta como sinal. Diferente do de conclusão, que se resolve
 * sozinho quando o sentinel sincroniza, o de interrupção não tem condição de
 * saída: sem janela, todo `abortar` num host exigiria `--force` no outro para
 * sempre. 6 h cobre com folga o atraso normal do OneDrive (minutos); queda
 * de sync mais longa é a classe dos alarmes de sync (#5548), não deste guard.
 */
export const INTERRUPTED_TOMBSTONE_WINDOW_MS = 6 * 3_600_000;

/**
 * Janela em que arquivo recente da edição + sentinel do Stage 4 ausente conta
 * como "gate aprovado em outra máquina, sentinel em trânsito" (#13851).
 */
export const PREV_GATE_RECENT_WINDOW_MS = 30 * 60_000;

/**
 * Arquivos que o próprio `/diaria-publica` grava na edição ANTES (Parte A, o
 * horizontal) ou em paralelo (Parte B, o vertical em background, #12655) ao
 * assert do sentinel 4 da Etapa 5 (#13867). Não provam que o gate 4 foi
 * aprovado em outra máquina: a escrita é desta sessão de vídeo. Sem esta
 * exclusão, `prev_gate_in_transit` disparava quase sempre que faltava o
 * sentinel 4 nesse fluxo, inclusive com o gate nunca aprovado.
 *
 * Literais (e não import dos módulos de vídeo, que puxariam a cadeia do
 * YouTube para este módulo puro); `test/stale-edition-guard-13867.test.ts`
 * confere contra as constantes de origem.
 */
export const PUBLICA_VIDEO_FILES: readonly string[] = [
  "_internal/05-video-url.txt", // D1_VIDEO_URL_FILE
  "_internal/05-youtube-published.json", // YOUTUBE_PUBLISHED_FILE
  "_internal/05-youtube-pending-approval.json", // YOUTUBE_PENDING_APPROVAL_FILE
  "_internal/publica-phases.jsonl", // PUBLICA_PHASES_FILE
  "_internal/06-shorts-published.json",
  "_internal/04-youtube-short-capa.source.json", // SHORT_COVER_SOURCE_FILE
  "04-youtube-thumb.jpg", // YOUTUBE_THUMB_FILE
  "04-youtube-short-capa.jpg", // SHORT_COVER_FILE
];
/** Diretórios de trabalho da capa do horizontal (Passo A2). */
export const PUBLICA_VIDEO_DIRS: readonly string[] = [
  "_internal/youtube-thumb-frames/", // THUMB_FRAMES_DIR
  "_internal/youtube-thumb-portraits/", // THUMB_PORTRAITS_DIR
  "_internal/youtube-thumb-capa-bg/", // THUMB_CAPA_BG_DIR
];
/** Vídeo baixado e legenda (`youtubeVideoFileName`, `youtubeCaptionFileName`, o `-short` do vertical) e o plano com hash. */
const PUBLICA_VIDEO_PATTERNS: readonly RegExp[] = [
  /^diaria-comentada-\d{6}(-short)?\.(mp4|srt)$/,
  /^_internal\/video-publish-plan\.[a-z-]+\.json$/,
];

/** Pura: `relPath` (relativo à pasta da edição, com `/`) é artefato de vídeo do `/diaria-publica` (#13867). */
export function isPublicaVideoFile(relPath: string): boolean {
  const p = relPath.replaceAll("\\", "/");
  return (
    PUBLICA_VIDEO_FILES.includes(p) ||
    PUBLICA_VIDEO_DIRS.some((d) => p.startsWith(d)) ||
    PUBLICA_VIDEO_PATTERNS.some((re) => re.test(p))
  );
}

export type StaleSignal =
  /** Etapa 5 sem `.step-4-done.json` mas com atividade recente na edição: sync em trânsito (#13851). */
  | { kind: "prev_gate_in_transit"; newest_age_ms: number }
  | { kind: "unreadable_lock" }
  | { kind: "later_sentinel"; step: number }
  | { kind: "remote_lock"; host: string; stage: number; heartbeat_at: string }
  /** Tombstone de release (aprovação normal) de outro host, sentinel do stage não chegou. */
  | { kind: "remote_completed"; host: string; stage: number; released_at: string }
  /** Tombstone de release simples (`editar`/`abortar`/halt) de outro host, recente (#11713). */
  | { kind: "remote_interrupted"; host: string; stage: number; released_at: string };

export interface StaleEditionVerdict {
  ok: boolean;
  signals: StaleSignal[];
}

/**
 * Sinais (qualquer um bloqueia; sem nenhum → ok). Só bloqueia com evidência:
 *  - sentinel de stage SEGUINTE local;
 *  - trava viva/vencida de OUTRO host (ou de host ilegível) cobrindo `step`;
 *  - tombstone de conclusão (`completed_stage`, ver edition-lock) de OUTRO host
 *    cobrindo `step`, com o sentinel desse stage ausente (ou `outputsMissing`).
 *    Cobre o caso em que a remoção da trava sincroniza antes do sentinel.
 *  - tombstone de interrupção (`interrupted_stage`, #11713) de OUTRO host
 *    cobrindo `step`, solto há menos de `INTERRUPTED_TOMBSTONE_WINDOW_MS`
 *    (`released_at` ilegível conta como recente). Independe do sentinel: o
 *    stage não concluiu lá, mas um arquivo editado lá pode estar em trânsito.
 *  - Etapa 5 (`step` 5 ou `callerStage` 5) sem sentinel do Stage 4 e com
 *    arquivo da edição de até `PREV_GATE_RECENT_WINDOW_MS` (#13851): gate
 *    provavelmente aprovado em outra máquina, sentinel em trânsito. Não emite
 *    quando a trava (viva ou tombstone) é deste host — a atividade é local.
 * Mesma máquina com estado consistente nunca bloqueia. `stage` ilegível conta
 * como à frente (fail-closed).
 */
export function assessStaleEdition(f: StaleEditionFacts): StaleEditionVerdict {
  const signals: StaleSignal[] = [];
  for (const s of [...f.sentinelSteps].sort((a, b) => a - b)) {
    if (s > f.step) signals.push({ kind: "later_sentinel", step: s });
  }
  const l = f.lock;
  const otherHost = !!l && (typeof l.host !== "string" || l.host === "" || l.host !== f.localHost);
  // Trava (viva ou tombstone) deste host: a atividade recente é local, não um
  // gate aprovado em outra máquina — não há sync em trânsito a esperar.
  const lockIsLocal = !!l && !otherHost;
  if (
    (f.step === 5 || f.callerStage === 5) &&
    !lockIsLocal &&
    !f.sentinelSteps.includes(4) &&
    typeof f.newestFileAgeMs === "number" &&
    f.newestFileAgeMs <= PREV_GATE_RECENT_WINDOW_MS
  ) {
    signals.push({ kind: "prev_gate_in_transit", newest_age_ms: Math.max(0, f.newestFileAgeMs) });
  }
  if (f.lockUnreadable) signals.push({ kind: "unreadable_lock" });
  if (l && otherHost) {
    const hostLabel = typeof l.host === "string" && l.host ? l.host : "(host ilegível)";
    if (l.released_at && l.interrupted_stage !== undefined) {
      const stage = Number.isFinite(l.interrupted_stage) ? l.interrupted_stage : Number.POSITIVE_INFINITY;
      const rel = Date.parse(l.released_at);
      const age = Number.isFinite(rel) ? (f.now ?? Date.now()) - rel : 0;
      if (stage >= f.step && age <= INTERRUPTED_TOMBSTONE_WINDOW_MS) {
        signals.push({ kind: "remote_interrupted", host: hostLabel, stage: l.interrupted_stage, released_at: l.released_at });
      }
    } else if (l.released_at) {
      // Tombstone: só vale com o stage concluído lá e o sentinel dele não chegado aqui.
      const done = Number.isFinite(l.completed_stage) ? (l.completed_stage as number) : Number.POSITIVE_INFINITY;
      if (done >= f.step && (f.outputsMissing || !f.sentinelSteps.includes(f.step))) {
        signals.push({ kind: "remote_completed", host: hostLabel, stage: l.completed_stage ?? Number.NaN, released_at: l.released_at });
      }
    } else {
      const lockStage = Number.isFinite(l.stage) ? l.stage : Number.POSITIVE_INFINITY;
      if (lockStage >= f.step) {
        signals.push({ kind: "remote_lock", host: hostLabel, stage: l.stage, heartbeat_at: l.heartbeat_at });
      }
    }
  }
  return { ok: signals.length === 0, signals };
}

export function describeSignals(signals: StaleSignal[]): string {
  return signals
    .map((s) =>
      s.kind === "prev_gate_in_transit"
        ? `sentinel do Stage 4 ausente com arquivo da edição de ${Math.round(s.newest_age_ms / 60_000)} min atrás: gate possivelmente aprovado em outra máquina (sync em trânsito) ou ainda em andamento; confira antes de re-rodar a Etapa 4`
        : s.kind === "later_sentinel"
        ? `sentinel do Stage ${s.step} já existe`
        : s.kind === "unreadable_lock"
          ? "edition-lock corrompido/ilegível (sync em trânsito?)"
          : s.kind === "remote_interrupted"
          ? `outro host (${s.host}) soltou o Stage ${Number.isFinite(s.stage) ? s.stage : "?"} sem concluir em ${s.released_at} (editar/abortar/halt), arquivos editados lá podem não ter sincronizado`
          : s.kind === "remote_completed"
          ? `outro host (${s.host}) concluiu o Stage ${Number.isFinite(s.stage) ? s.stage : "?"} em ${s.released_at}, sentinel/outputs ainda não sincronizados`
          : `edition-lock de outro host (${s.host}, Stage ${Number.isFinite(s.stage) ? s.stage : "?"}, heartbeat ${s.heartbeat_at})`,
    )
    .join("; ");
}
