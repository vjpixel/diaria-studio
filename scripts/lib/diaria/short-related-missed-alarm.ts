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
 * do alarme diz isso explicitamente. Desde o #12541 o `missing-record` sai
 * como issue `acao` (sem e-mail urgente, `shortRelatedMissedSeverity`) até o
 * registro do vínculo ganhar um canal fora do OneDrive, e a precondição
 * "haveria vídeo" é a mesma do plano da task (`assessEditionVideoEvidence`).
 *
 * Desde o #12541 item 2 o registro também vai para o KV da Cloudflare
 * (`short-related:{AAMMDD}`, `scripts/lib/diaria/short-related-kv.ts`), que a
 * task do Neo grava por API. Ordem de leitura: KV com registro decide (com o
 * arquivo também com registro, vence o mais avançado, `pickMoreAdvancedRecord`);
 * KV sem registro cai no arquivo replicado (como antes); KV que não respondeu com o
 * arquivo também sem registro vira `record-unconfirmed`, veredito explícito de
 * incerteza (issue `acao`, sem afirmar falha). Arquivo com registro decide
 * mesmo com o KV fora.
 */

import { SHORT_RELATED_GIVE_UP_MINUTES, isWeekdayEdition, type ShortRelatedRecord } from "./youtube-short-related.ts";
import type { ShortsPublishedFile } from "./short-video.ts";
import { YOUTUBE_SHORTS_DESTINATION, assessEditionVideoEvidence, type FileRead } from "./edition-video-evidence.ts";
import type { NotifySeverity } from "../editor-notify.ts";
import type { ShortRelatedKvRead } from "./short-related-kv.ts";

// Reexportados: o destino e o `FileRead` nasceram aqui (#11353) e moraram no
// helper compartilhado desde o #12541.
export { YOUTUBE_SHORTS_DESTINATION, type FileRead };

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
  | "shorts-registry-unreadable"
  // Alarma como incerteza (#12541 item 2): o KV não respondeu e o arquivo
  // replicado também não tem registro. Nunca afirma que a task não rodou.
  | "record-unconfirmed";

const ALARMING: ReadonlySet<ShortRelatedMissedVerdict> = new Set<ShortRelatedMissedVerdict>([
  "missing-record",
  "failed-not-alerted",
  "record-unreadable",
  "shorts-registry-unreadable",
  "record-unconfirmed",
]);

export function isAlarmingShortRelatedVerdict(v: ShortRelatedMissedVerdict): boolean {
  return ALARMING.has(v);
}

export interface ShortRelatedMissedInput {
  aammdd: string;
  now: Date;
  editionExists: boolean;
  noVideo: boolean;
  shortsRegistry: FileRead<ShortsPublishedFile>;
  /** `05-youtube-step.json` (#12541, regra de evidência compartilhada). Default: ausente. */
  youtubeStep?: FileRead<{ outcome?: unknown }>;
  /** `05-youtube-published.json` existe (#12541). Default: `false`. */
  horizontalUploadRecord?: boolean;
  /** `05-video-url.txt` com link do YouTube (#12541). Default: `false`. */
  d1VideoUrl?: boolean;
  record: FileRead<ShortRelatedRecord>;
  /**
   * Registro no KV da Cloudflare (`short-related:{AAMMDD}`, #12541 item 2),
   * consultado ANTES do arquivo replicado. Default: `absent` (o comportamento
   * de antes, só o arquivo decide).
   */
  kvRecord?: ShortRelatedKvRead;
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
  /** De onde veio o registro que decidiu (#12541): KV, arquivo replicado, ou nenhum. */
  recordSource: "kv" | "file" | null;
  /** Erro da leitura do KV, quando houve (o veredito pode ter vindo do arquivo). */
  kvError: string | null;
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
  let recordSource: "kv" | "file" | null = null;
  const kv: ShortRelatedKvRead = input.kvRecord ?? { kind: "absent" };
  const kvError = kv.kind === "error" ? kv.error : null;
  const out = (verdict: ShortRelatedMissedVerdict, reason: string): ShortRelatedMissedEvaluation => ({
    ...base,
    shortRef,
    recordSource,
    kvError,
    verdict,
    reason,
  });

  if (!isWeekdayEdition(input.aammdd)) return out("weekend", "fim de semana: não há edição");
  if (!input.editionExists) return out("no-edition", "pasta da edição não existe");
  // #12541: a mesma regra de evidência positiva que o plano da task do Neo usa.
  const evidence = assessEditionVideoEvidence({
    noVideo: input.noVideo,
    shortsRegistry: input.shortsRegistry,
    youtubeStep: input.youtubeStep,
    horizontalUploadRecord: input.horizontalUploadRecord,
    d1VideoUrl: input.d1VideoUrl,
  });
  if (!evidence.hasEvidence) return out("no-video", evidence.reason);

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

  // #12541 item 2: o KV é gravado pela task do Neo por API e lido aqui na
  // hora; vem antes do arquivo replicado em `data/`.
  const decide = (r: ShortRelatedRecord, where: string): ShortRelatedMissedEvaluation => {
    if (r.status === "linked") return out("linked", `já vinculado (${r.shortId} → ${r.horizontalId}), registro no ${where}`);
    if (r.alertedAt) return out("task-alerted", `a task já avisou o editor em ${r.alertedAt} (registro no ${where})`);
    return out("failed-not-alerted", `registro "${r.status}" sem alertedAt no ${where}: a task registrou a falha mas o alerta não saiu`);
  };
  const rec = input.record;
  if (kv.kind === "ok" && rec.kind === "ok") {
    // Os dois canais com registro (#12541 fleet review): vence o mais
    // avançado (linked > alertado > failed sem alerta); empate, o `at` mais
    // recente; empate de novo, o KV. Nunca "KV sempre vence": um KV que
    // ficou com `failed` de uma execução anterior (publicação posterior
    // falhou) não pode virar e-mail urgente com o arquivo já `linked`.
    const pick = pickMoreAdvancedRecord(kv.value, rec.value);
    recordSource = pick;
    const chosen = pick === "kv" ? kv.value : rec.value;
    const ev = decide(chosen, pick === "kv" ? "KV" : "arquivo replicado");
    const divergent = recordRank(kv.value) !== recordRank(rec.value) || kv.value.at !== rec.value.at;
    if (!divergent) return ev;
    return {
      ...ev,
      reason: `${ev.reason}; KV e arquivo divergem (KV: ${describeRecord(kv.value)}; arquivo: ${describeRecord(rec.value)}), valeu o ${pick === "kv" ? "KV" : "arquivo"}`,
    };
  }
  if (kv.kind === "ok") {
    recordSource = "kv";
    return decide(kv.value, "KV");
  }

  if (rec.kind === "ok") {
    recordSource = "file";
    return decide(rec.value, "arquivo replicado");
  }
  if (rec.kind === "unreadable") {
    recordSource = "file";
    return out("record-unreadable", `registro do vínculo ilegível (${rec.error})`);
  }
  if (kv.kind === "error") {
    return out(
      "record-unconfirmed",
      `KV ilegível (${kv.error}) e sem _internal/06-short-related.json no 300: não dá para saber se a task rodou; nada confirma falha`,
    );
  }
  return out(
    "missing-record",
    "sem registro no KV nem _internal/06-short-related.json no 300 depois do prazo: execução da task e vínculo não confirmados; possível atraso de replicação do arquivo em data/ (ou o Neo ainda sem gravar no KV)",
  );
}

/** Quão avançado é o registro: 2 vinculado, 1 alerta enviado, 0 falha sem alerta. */
function recordRank(r: ShortRelatedRecord): number {
  if (r.status === "linked") return 2;
  return r.alertedAt ? 1 : 0;
}

function describeRecord(r: ShortRelatedRecord): string {
  return `${r.status}${r.alertedAt ? ` alertado ${r.alertedAt}` : ""} em ${r.at}`;
}

/**
 * Pure (#12541): KV e arquivo com registro, qual decide. O mais avançado
 * vence; empate, o `at` mais recente (ISO compara como string); empate, o KV.
 */
export function pickMoreAdvancedRecord(kv: ShortRelatedRecord, file: ShortRelatedRecord): "kv" | "file" {
  const dr = recordRank(kv) - recordRank(file);
  if (dr !== 0) return dr > 0 ? "kv" : "file";
  return (file.at ?? "") > (kv.at ?? "") ? "file" : "kv";
}

/**
 * Pure (#12541): severidade do alarme. `missing-record` nasce da AUSÊNCIA de
 * registro, e ausência não prova que a task do Neo não rodou (item 23 das
 * regras de dispatch; a 261105, #12315, alarmou assim). O KV (item 2) tira a
 * dependência da replicação, mas só depois que o Neo passar a gravar nele
 * (token no `.env` do Neo + passo final do roteiro); até a gravação estar
 * comprovada em produção, `missing-record` segue issue `acao` (sem e-mail sob
 * `email_policy: "urgent_only"`). `record-unconfirmed` (KV fora do ar, nada no
 * arquivo) é incerteza por definição e também sai `acao`. Os demais leem um
 * registro que EXISTE e
 * continuam `urgente`.
 */
export function shortRelatedMissedSeverity(verdict: ShortRelatedMissedVerdict): Extract<NotifySeverity, "acao" | "urgente"> {
  return verdict === "missing-record" || verdict === "record-unconfirmed" ? "acao" : "urgente";
}

/** Pure: assunto e corpo do alarme (issue + e-mail). */
export function buildShortRelatedMissedAlarm(ev: ShortRelatedMissedEvaluation, studioUrl: string): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Short ${ev.aammdd}: vínculo do vídeo relacionado não confirmado no 300`,
    body: [
      "Achado automático do alarme `Diaria-Short-Related-Missed-Alarm` (#11353), rodando no `300`.",
      "",
      `Edição: ${ev.aammdd}`,
      `Veredito: ${ev.verdict} — ${ev.reason}`,
      `Short: ${ev.shortRef ?? "desconhecido"}`,
      `Horário do Short: ${ev.shortAt ?? "não derivado"}; prazo da task: ${ev.deadline ?? "não derivado"}`,
      "",
      "A task LOCAL `diaria-short-video-relacionado` (#10811) roda no Neo pelo app Claude desktop.",
      `Fonte do registro: ${ev.recordSource === "kv" ? "KV da Cloudflare (short-related:" + ev.aammdd + ")" : ev.recordSource === "file" ? "arquivo replicado em data/" : "nenhuma"}${ev.kvError ? `; leitura do KV falhou: ${ev.kvError}` : ""}.`,
      "A ausência de confirmação no 300 não comprova falha da task no Neo nem ausência do vínculo no YouTube.",
      "O check consulta o KV da Cloudflare (gravado pela task por API, #12541) e o registro replicado; não consulta o vínculo no Studio/YouTube.",
      "",
      `Para conferir o vínculo e, somente se estiver ausente, vincular à mão: ${studioUrl} → o Short → Elementos do vídeo → Vídeo relacionado → Adicionar → Escolha um vídeo específico → o horizontal → Salvar.`,
      "",
      ...(ev.verdict === "record-unconfirmed"
        ? ["Incerteza: o KV não respondeu e o arquivo replicado não tem registro. Isto NÃO afirma que a task falhou; conferir o Short no Studio resolve."]
        : ev.verdict === "missing-record"
          ? ["Ressalva: a task só grava no KV depois que o Neo tem o token Cloudflare no `.env` e o passo final do roteiro; antes disso, sem registro no KV vale o arquivo replicado em `data/`, que pode atrasar. Conferir o Short no Studio resolve as duas hipóteses."]
          : []),
    ].join("\n"),
  };
}
