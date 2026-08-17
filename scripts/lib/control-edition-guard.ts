/**
 * control-edition-guard.ts (#5547 item 3)
 *
 * Guard de ruído concorrente para o instrumento de medição da edição de
 * controle (#5419). Existe para nunca mais deixar passar despercebido o erro
 * medido no #5413: sessão concorrente na mesma máquina inflou a medição da
 * edição 260814 em 29% (303M de 1.001M tokens vieram de 5 sessões humanas
 * paralelas) — sem guard, esse número quase virou fato aceito.
 *
 * Duas fontes de sinal, **combinadas, nenhuma substitui a outra**:
 *
 * 1. **`checkTranscriptContamination`** — sinal de PRECISÃO (ex-post,
 *    baseado em dado real): lê `sessions_excluded`/`session_filter` já
 *    persistidos em `_internal/stage-status.json` por
 *    `scripts/capture-stage-usage.ts` (#5413) — quantos OUTROS transcripts
 *    tinham turnos na mesma janela de cada stage e foram excluídos pelo
 *    filtro de sessão. `sessions_excluded > 0` num stage não significa que a
 *    medição DAQUELE stage está contaminada (o filtro já excluiu o ruído) —
 *    significa que HAVIA ruído por perto, o que é precisamente o sinal que
 *    #5413 existe para reportar. `session_filter === "all_sessions"` é mais
 *    grave: o filtro não conseguiu isolar a sessão da edição (id ausente ou
 *    transcript não encontrado) e o número daquele stage pode estar somando
 *    sessões concorrentes de verdade.
 *
 * 2. **`checkSessionRegistryNoise`** — sinal de COBERTURA (ponto-no-tempo,
 *    via `scripts/lib/session-registry.ts`, o registro já usado por
 *    overnight/develop/continuo): lista sessões `overnight`/`develop`/
 *    `continuo` ativas AGORA. Limitação honesta: `data/sessions/*.json` é
 *    removido em `endSession` — não há histórico de sessões que já
 *    terminaram, então este check só enxerga o que está ativo no momento em
 *    que é chamado. Não prova sozinho que não houve concorrência durante as
 *    horas de execução da edição; serve como confirmação/alerta adicional,
 *    mais forte quando chamado logo no início e logo no fim da coleta (ver
 *    recomendação de uso no CLI, `scripts/check-control-edition-noise.ts`).
 *    Também não enxerga sessões interativas comuns do editor (que não se
 *    registram em `session-registry.ts` — só overnight/develop/continuo se
 *    registram) — é exatamente o tipo de sessão que causou os 29% de ruído
 *    na 260814. Por isso o sinal 1 (transcript, que vê TODA sessão Claude
 *    Code local, independente de kind) é o mais confiável dos dois; o sinal
 *    2 é aditivo.
 *
 * Resultado: `contaminated` é a OR dos dois sinais. Nunca descarta a
 * medição em silêncio (a chamada retorna sempre o dado completo) e nunca
 * aceita como boa sem aviso (`reasons` lista exatamente por quê).
 */

import type { StageStatusDoc } from "../update-stage-status.ts";
import { listActiveSessions, type SessionRecord } from "./session-registry.ts";

export interface TranscriptContaminationCheck {
  /** Soma de `sessions_excluded` de todos os stages — quantos transcripts
   * concorrentes (de qualquer kind) tinham turnos nas janelas medidas e
   * foram excluídos pelo filtro de sessão. `0` = nenhum sinal de ruído por
   * perto observado nos stages capturados. */
  total_sessions_excluded: number;
  /** Stages com `sessions_excluded > 0` — havia sessão concorrente por
   * perto, mesmo que o filtro tenha isolado corretamente. */
  stages_with_excluded_sessions: number[];
  /** Stages cujo `session_filter` persistido é `"all_sessions"` — o filtro
   * NÃO conseguiu isolar a sessão da edição; o `tokens_in` daquele stage
   * pode estar somando sessões concorrentes sem filtro nenhum. Mais grave
   * que `stages_with_excluded_sessions`. */
  stages_with_unfiltered_fallback: number[];
  /** Stages sem nenhum dado de captura (#5413) — não têm como contribuir
   * pro sinal de contaminação (nem confirmar, nem negar). Informativo. */
  stages_without_capture: number[];
  clean: boolean;
}

/** Lê `_internal/stage-status.json` (já em memória, via `loadDoc`) e agrega
 * o sinal de contaminação por transcript (#5413) — puro, sem I/O. */
export function checkTranscriptContamination(doc: StageStatusDoc): TranscriptContaminationCheck {
  let totalExcluded = 0;
  const stagesExcluded: number[] = [];
  const stagesUnfiltered: number[] = [];
  const stagesWithoutCapture: number[] = [];

  for (const row of doc.rows) {
    if (row.tokens_in == null && row.session_filter == null) {
      stagesWithoutCapture.push(row.stage);
      continue;
    }
    const excluded = row.sessions_excluded ?? 0;
    totalExcluded += excluded;
    if (excluded > 0) stagesExcluded.push(row.stage);
    if (row.session_filter === "all_sessions") stagesUnfiltered.push(row.stage);
  }

  return {
    total_sessions_excluded: totalExcluded,
    stages_with_excluded_sessions: stagesExcluded,
    stages_with_unfiltered_fallback: stagesUnfiltered,
    stages_without_capture: stagesWithoutCapture,
    clean: totalExcluded === 0 && stagesUnfiltered.length === 0,
  };
}

/** Recorte enxuto de `SessionRecord` — só o que importa pro diagnóstico de
 * ruído, evita vazar `claimed_issues`/`active_worktrees` internos no relatório. */
export interface NoisySession {
  kind: SessionRecord["kind"];
  machineTag: string;
  sessionId: string;
  phase?: string;
  stale?: boolean;
}

export interface SessionRegistryNoiseCheck {
  checked_at: string;
  /** Sessões overnight/develop/continuo ativas AGORA, excluindo (quando
   * informado) a sessão que está fazendo a própria medição. */
  other_active_sessions: NoisySession[];
  clean: boolean;
}

/**
 * Consulta `session-registry.ts` (o mesmo registro de overnight/develop/
 * continuo) por sessões ativas agora, excluindo a própria (se
 * `opts.excludeSessionId` for passado — evita a sessão `/diaria-develop` que
 * está RODANDO esta medição se auto-marcar como ruído). Ver limitação de
 * cobertura no cabeçalho do módulo — sinal ponto-no-tempo, não retroativo.
 */
export function checkSessionRegistryNoise(
  repoRoot: string,
  opts: { excludeSessionId?: string; now?: number } = {},
): SessionRegistryNoiseCheck {
  const now = opts.now ?? Date.now();
  const active = listActiveSessions(repoRoot, now).filter(
    (s) => !opts.excludeSessionId || s.sessionId !== opts.excludeSessionId,
  );
  const other: NoisySession[] = active.map((s) => ({
    kind: s.kind,
    machineTag: s.machineTag,
    sessionId: s.sessionId,
    phase: s.phase,
    stale: s.stale,
  }));
  return {
    checked_at: new Date(now).toISOString(),
    other_active_sessions: other,
    clean: other.length === 0,
  };
}

export interface ConcurrentNoiseVerdict {
  contaminated: boolean;
  transcript_check: TranscriptContaminationCheck;
  registry_check: SessionRegistryNoiseCheck;
  reasons: string[];
}

/**
 * Combina os dois sinais num veredito único. `contaminated` é a OR dos dois
 * — qualquer um marcando ruído é suficiente para marcar a medição inteira
 * como CONTAMINADA (nunca descarta em silêncio: quem chamar continua
 * recebendo a medição completa, só com este campo anexado; a decisão do que
 * fazer com uma medição contaminada é do comparador/do editor, não deste
 * guard).
 */
export function assessConcurrentNoise(
  doc: StageStatusDoc,
  repoRoot: string,
  opts: { excludeSessionId?: string; now?: number } = {},
): ConcurrentNoiseVerdict {
  const transcriptCheck = checkTranscriptContamination(doc);
  const registryCheck = checkSessionRegistryNoise(repoRoot, opts);

  const reasons: string[] = [];
  if (transcriptCheck.stages_with_unfiltered_fallback.length > 0) {
    reasons.push(
      `stage(s) ${transcriptCheck.stages_with_unfiltered_fallback.join(", ")} capturado(s) sem filtro de sessão ` +
        `(session_filter=all_sessions) — tokens_in pode somar sessão concorrente sem isolamento.`,
    );
  }
  if (transcriptCheck.stages_with_excluded_sessions.length > 0) {
    reasons.push(
      `stage(s) ${transcriptCheck.stages_with_excluded_sessions.join(", ")} tinha(m) ${
        transcriptCheck.total_sessions_excluded
      } sessão(ões) concorrente(s) na mesma janela, excluída(s) pelo filtro (#5413) — ruído confirmado por perto.`,
    );
  }
  if (registryCheck.other_active_sessions.length > 0) {
    const kinds = registryCheck.other_active_sessions.map((s) => `${s.kind}:${s.sessionId.slice(0, 8)}`).join(", ");
    reasons.push(
      `session-registry reporta ${registryCheck.other_active_sessions.length} sessão(ões) overnight/develop/continuo ` +
        `ativa(s) no momento da checagem (${kinds}) — sinal ponto-no-tempo, não cobre a janela inteira da edição.`,
    );
  }

  return {
    contaminated: !transcriptCheck.clean || !registryCheck.clean,
    transcript_check: transcriptCheck,
    registry_check: registryCheck,
    reasons,
  };
}
