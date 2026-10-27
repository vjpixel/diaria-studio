/**
 * scripts/lib/diaria/short-related-missed-alarm.ts (#11353)
 *
 * Lógica pura do alarme que pega a task LOCAL do vídeo relacionado do Short
 * (#10811, `diaria-short-video-relacionado`, app Claude desktop no Neo)
 * quando ela NÃO roda. A task alerta o editor sozinha quando o vínculo falha
 * (`--alert` de `scripts/youtube-short-related-plan.ts`), mas se ela não
 * roda (Neo desligado, app fechado, sessão morrendo antes do Passo 5) não
 * sobra nenhum sinal. Este check roda no `300` (task
 * `Diaria-Short-Related-Missed-Alarm`) depois do prazo de desistência da task
 * e olha só o que ela deixa em disco, em `data/` replicado pelo OneDrive.
 *
 * Alarma numa edição de dia útil com Short registrado
 * (`_internal/06-shorts-published.json` com destino `youtube_shorts`) e sem
 * `_internal/no-video.json` quando, passado `shortAt + SHORT_RELATED_GIVE_UP_MINUTES`:
 *   - `_internal/06-short-related.json` não existe (a task não rodou ou
 *     morreu antes de registrar qualquer coisa) — `missing-record`;
 *   - o registro existe sem `alertedAt` e sem `linked` — a task registrou a
 *     falha do Studio mas o alerta não saiu — `failed-not-alerted`;
 *   - o registro existe e está ilegível — `record-unreadable` (a própria
 *     task trava nele, e ninguém fica sabendo).
 * Registro com `alertedAt` = o editor já foi avisado pela task; `linked` =
 * nada a fazer. Os dois não alarmam.
 *
 * Ausência em `data/` vista no `300` pode ser atraso de replicação do
 * OneDrive (`context/overnight-dispatch-rules.md` item 23). O alarme sai
 * mesmo assim, porque o custo de um alarme falso é o editor conferir o
 * Studio (1 minuto), e o de um silêncio é o Short ficar sem vínculo; o corpo
 * do alarme diz isso explicitamente.
 */

import { SHORT_RELATED_GIVE_UP_MINUTES, isWeekdayEdition, type ShortRelatedRecord } from "./youtube-short-related.ts";
import type { ShortsPublishedFile } from "./short-video.ts";

/** Destino do registro do vertical que conta como "Short publicado no YouTube". */
export const YOUTUBE_SHORTS_DESTINATION = "youtube_shorts";

export type ShortRelatedMissedVerdict =
  // Não alarma
  | "weekend"
  | "no-edition"
  | "no-video"
  | "no-short"
  | "before-deadline"
  | "linked"
  | "task-alerted"
  // Alarma
  | "missing-record"
  | "failed-not-alerted"
  | "record-unreadable"
  | "shorts-registry-unreadable";

const ALARMING: ReadonlySet<ShortRelatedMissedVerdict> = new Set<ShortRelatedMissedVerdict>([
  "missing-record",
  "failed-not-alerted",
  "record-unreadable",
  "shorts-registry-unreadable",
]);

export function isAlarmingShortRelatedVerdict(v: ShortRelatedMissedVerdict): boolean {
  return ALARMING.has(v);
}

/** Leitura de um arquivo da edição: ausente, lido, ou ilegível (com o erro). */
export type FileRead<T> = { kind: "absent" } | { kind: "ok"; value: T } | { kind: "unreadable"; error: string };

export interface ShortRelatedMissedInput {
  aammdd: string;
  now: Date;
  editionExists: boolean;
  noVideo: boolean;
  shortsRegistry: FileRead<ShortsPublishedFile>;
  record: FileRead<ShortRelatedRecord>;
  /**
   * Horário do Short (BRT, no dia da edição). `null` = não derivado (config
   * ilegível): o prazo passa a ser o próprio instante da checagem — a task
   * agendada roda depois do slot mais tardio do teste de horário, então
   * esperar mais não muda nada.
   */
  shortAt: Date | null;
}

export interface ShortRelatedMissedEvaluation {
  aammdd: string;
  verdict: ShortRelatedMissedVerdict;
  /** ISO do prazo (`shortAt + SHORT_RELATED_GIVE_UP_MINUTES`); `null` se não derivado. */
  deadline: string | null;
  shortAt: string | null;
  /** ID/URL do Short no registro do vertical, quando houver. */
  shortRef: string | null;
  reason: string;
}

/** Pure: o que o alarme conclui sobre a edição `aammdd` agora. */
export function evaluateShortRelatedMissed(input: ShortRelatedMissedInput): ShortRelatedMissedEvaluation {
  const deadline = input.shortAt ? new Date(input.shortAt.getTime() + SHORT_RELATED_GIVE_UP_MINUTES * 60_000) : null;
  const base = {
    aammdd: input.aammdd,
    deadline: deadline ? deadline.toISOString() : null,
    shortAt: input.shortAt ? input.shortAt.toISOString() : null,
  };
  let shortRef: string | null = null;
  const out = (verdict: ShortRelatedMissedVerdict, reason: string): ShortRelatedMissedEvaluation => ({
    ...base,
    shortRef,
    verdict,
    reason,
  });

  if (!isWeekdayEdition(input.aammdd)) return out("weekend", "fim de semana: não há edição");
  if (!input.editionExists) return out("no-edition", "pasta da edição não existe");
  if (input.noVideo) return out("no-video", "edição marcada sem vídeo (_internal/no-video.json)");

  const reg = input.shortsRegistry;
  if (reg.kind === "absent") return out("no-short", "sem _internal/06-shorts-published.json: o Short não foi registrado");
  if (reg.kind === "unreadable") {
    if (deadline && input.now.getTime() < deadline.getTime()) {
      return out("before-deadline", `prazo da task (${base.deadline}) ainda não passou`);
    }
    return out("shorts-registry-unreadable", `registro do vertical ilegível (${reg.error}): a task do vínculo também não consegue lê-lo`);
  }
  const entry = reg.value.entries.find((e) => e.destination === YOUTUBE_SHORTS_DESTINATION);
  if (!entry) return out("no-short", "registro do vertical sem o destino youtube_shorts");
  shortRef = entry.url ?? entry.id;

  if (deadline && input.now.getTime() < deadline.getTime()) {
    return out("before-deadline", `prazo da task (${base.deadline}) ainda não passou`);
  }

  const rec = input.record;
  if (rec.kind === "absent") {
    return out("missing-record", "sem _internal/06-short-related.json depois do prazo: a task do vínculo não rodou ou morreu antes de registrar");
  }
  if (rec.kind === "unreadable") return out("record-unreadable", `registro do vínculo ilegível (${rec.error})`);
  if (rec.value.status === "linked") return out("linked", `já vinculado (${rec.value.shortId} → ${rec.value.horizontalId})`);
  if (rec.value.alertedAt) return out("task-alerted", `a task já avisou o editor em ${rec.value.alertedAt}`);
  return out("failed-not-alerted", `registro "${rec.value.status}" sem alertedAt: a task registrou a falha mas o alerta não saiu`);
}

/** Pure: assunto e corpo do alarme (issue + e-mail). */
export function buildShortRelatedMissedAlarm(ev: ShortRelatedMissedEvaluation, studioUrl: string): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Short ${ev.aammdd} sem vídeo relacionado: a task do Neo não registrou o vínculo`,
    body: [
      "Achado automático do alarme `Diaria-Short-Related-Missed-Alarm` (#11353), rodando no `300`.",
      "",
      `Edição: ${ev.aammdd}`,
      `Veredito: ${ev.verdict} — ${ev.reason}`,
      `Short: ${ev.shortRef ?? "desconhecido"}`,
      `Horário do Short: ${ev.shortAt ?? "não derivado"}; prazo da task: ${ev.deadline ?? "não derivado"}`,
      "",
      "A task LOCAL `diaria-short-video-relacionado` (#10811) roda no Neo pelo app Claude desktop.",
      "Se o Neo estava desligado ou o app fechado, ela não rodou e não avisou ninguém.",
      "",
      `Para vincular à mão: ${studioUrl} → o Short → Elementos do vídeo → Vídeo relacionado → Adicionar → Escolha um vídeo específico → o horizontal → Salvar.`,
      "",
      "Ressalva: este check lê `data/` replicado pelo OneDrive no `300`. Se o Neo gravou o registro e ele ainda",
      "não replicou, o alarme é falso — conferir o Short no Studio resolve as duas hipóteses.",
    ].join("\n"),
  };
}
