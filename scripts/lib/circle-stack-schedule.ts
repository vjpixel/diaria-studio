/**
 * scripts/lib/circle-stack-schedule.ts (#11778)
 *
 * Miolo puro do envio AGENDADO do post semanal do Radar de Notícias Stack
 * (task `Diaria-Circle-Stack-Weekly-Publish`, segunda 06:00 BRT no `300`,
 * CLI `scripts/publish-circle-stack-scheduled.ts`).
 *
 * Três decisões, todas puras para teste:
 *
 *   1. **Aprovação por ciclo.** O webhook da Stack publica na hora, numa
 *      comunidade de terceiro, sem como apagar pela API. A task só envia um
 *      ciclo que o editor aprovou: `data/weekly/{cycle}/_internal/circle-stack-approval.json`
 *      com o sha256 da seleção aprovada. Seleção editada depois da aprovação
 *      não bate o hash e não sai (o texto enviado é o texto aprovado).
 *   2. **Janela.** Só envia na própria segunda de publicação. O timer tem
 *      `Persistent=true`: um catch-up numa terça (servidor fora do ar na
 *      segunda) vira "Não enviado", nunca um post atrasado sem o editor saber.
 *   3. **Resultado.** Quatro desfechos, um e-mail em todos (inclusive no
 *      sucesso), assunto com o resultado e corpo com o que fazer:
 *        - `publicado`   — state do ciclo com `published_at`;
 *        - `ambiguo`     — `attempted_at` desta execução sem `published_at`:
 *                          o post pode ter saído, conferir no Radar;
 *        - `falhou`      — nada enviado, erro literal do publicador;
 *        - `nao-enviado` — trava de aprovação, janela ou seleção recusou.
 *
 * Nunca repete o envio nem usa `--force`: a falha pode ter publicado o post.
 */
import { createHash } from "node:crypto";
import type { CircleStackPublishedLike } from "./publish-state.ts";
import { formatAAMMDD } from "./weekly-linkedin-cycle.ts";

export const CIRCLE_STACK_APPROVAL_FILE = "circle-stack-approval.json";
export const CIRCLE_STACK_RADAR_URL = "https://plataforma.stack.com.br/c/radar-de-noticias-stack";

/** Registro de aprovação do ciclo, gravado por `--approve`. */
export interface CircleStackApproval {
  cycle: string;
  approved_at: string;
  /** sha256 (hex) do conteúdo exato de `circle-stack-selection.json` aprovado. */
  selection_sha256: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildCircleStackApproval(cycle: string, selectionRaw: string, now: Date): CircleStackApproval {
  return { cycle, approved_at: now.toISOString(), selection_sha256: sha256Hex(selectionRaw) };
}

export type ApprovalCheck = { ok: true; approvedAt: string } | { ok: false; reason: string };

/**
 * Pure: o ciclo está aprovado para o envio agendado? `approvalRaw`/`selectionRaw`
 * `null` = arquivo ausente. Qualquer dúvida (JSON ilegível, outro ciclo, hash
 * diferente) recusa: o custo de não enviar é um e-mail; o de enviar errado é um
 * post público que não se apaga.
 */
export function checkCircleStackApproval(
  approvalRaw: string | null,
  selectionRaw: string | null,
  cycle: string,
): ApprovalCheck {
  if (approvalRaw === null) {
    return { ok: false, reason: `ciclo ${cycle} sem registro de aprovação do editor` };
  }
  if (selectionRaw === null) {
    return { ok: false, reason: `ciclo ${cycle} aprovado, mas a seleção não existe nesta máquina (data/ não sincronizado?)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(approvalRaw);
  } catch (err) {
    return { ok: false, reason: `registro de aprovação ilegível: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "registro de aprovação não é um objeto JSON" };
  }
  const rec = parsed as Partial<Record<keyof CircleStackApproval, unknown>>;
  if (rec.cycle !== cycle) {
    return { ok: false, reason: `registro de aprovação é do ciclo ${JSON.stringify(rec.cycle)}, não de ${cycle}` };
  }
  if (typeof rec.approved_at !== "string" || Number.isNaN(Date.parse(rec.approved_at))) {
    return { ok: false, reason: "registro de aprovação sem approved_at válido" };
  }
  if (typeof rec.selection_sha256 !== "string" || rec.selection_sha256 !== sha256Hex(selectionRaw)) {
    return {
      ok: false,
      reason: "a seleção mudou depois da aprovação (sha256 diferente): o texto que sairia não é o que o editor aprovou",
    };
  }
  return { ok: true, approvedAt: rec.approved_at };
}

/** Pure: a execução cai na própria segunda de publicação? */
export function isCircleStackPublishWindow(todayAAMMDD: string, publishMonday: string): boolean {
  return todayAAMMDD === publishMonday;
}

/** Hora (BRT, relógio local do `300`) da task `Diaria-Circle-Stack-Weekly-Publish`. */
export const CIRCLE_STACK_PUBLISH_HOUR = 6;

/**
 * Pure (#11877): a execução agendada da segunda `publishMonday` já passou?
 * Verdadeiro em qualquer dia depois dela e na própria segunda a partir das
 * 06:00 (relógio local, mesmo de `formatAAMMDD`). Depois disso o timer não
 * roda de novo (o catch-up do `Persistent=true` só cobre execução perdida),
 * então uma aprovação desse ciclo não teria consumidor.
 */
export function isCircleStackScheduledRunPast(now: Date, publishMonday: string): boolean {
  const today = formatAAMMDD(now);
  if (today !== publishMonday) return today > publishMonday;
  return now.getHours() >= CIRCLE_STACK_PUBLISH_HOUR;
}

export type CircleStackScheduledOutcome =
  | { kind: "publicado"; publishedAt: string }
  | { kind: "ambiguo"; attemptedAt: string; error: string | null }
  | { kind: "falhou"; error: string }
  | { kind: "nao-enviado"; reason: string };

export interface ClassifyRunInput {
  cycle: string;
  /** Início desta execução — separa tentativa DESTA run de uma sobra antiga. */
  runStartedAt: Date;
  /** State do ciclo lido DEPOIS do publicador (`null` = ausente). */
  stateAfter: CircleStackPublishedLike | null;
  /** Erro do publicador; ausente = terminou sem erro. */
  error?: unknown;
  /** O erro é uma trava (`CircleStackPublishRefusal`), nada foi enviado. */
  errorIsRefusal?: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function attemptedThisRun(state: CircleStackPublishedLike | null, cycle: string, runStartedAt: Date): string | null {
  if (!state || state.cycle !== cycle || typeof state.attempted_at !== "string") return null;
  const t = Date.parse(state.attempted_at);
  if (Number.isNaN(t) || t < runStartedAt.getTime()) return null;
  return state.attempted_at;
}

function confirmedPublishedAt(state: CircleStackPublishedLike | null, cycle: string): string | null {
  if (!state || state.cycle !== cycle || typeof state.published_at !== "string") return null;
  return Number.isNaN(Date.parse(state.published_at)) ? null : state.published_at;
}

/**
 * Pure: classifica o resultado da execução do publicador. A trava vem primeiro
 * (o publicador recusou antes de gravar qualquer tentativa); depois vale o
 * state do disco, que é a única evidência do envio (#573): `published_at`
 * confirma; `attempted_at` desta run sem `published_at` é ambíguo; nenhum dos
 * dois com erro é falha sem envio.
 */
export function classifyCircleStackRun(input: ClassifyRunInput): CircleStackScheduledOutcome {
  const { cycle, runStartedAt, stateAfter } = input;
  if (input.error !== undefined && input.errorIsRefusal) {
    return { kind: "nao-enviado", reason: errorText(input.error) };
  }
  const attempted = attemptedThisRun(stateAfter, cycle, runStartedAt);
  const published = attempted ? confirmedPublishedAt(stateAfter, cycle) : null;
  if (published) return { kind: "publicado", publishedAt: published };
  if (attempted) {
    return { kind: "ambiguo", attemptedAt: attempted, error: input.error === undefined ? null : errorText(input.error) };
  }
  if (input.error !== undefined) return { kind: "falhou", error: errorText(input.error) };
  // Sem erro e sem tentativa gravada: o publicador não chegou a enviar (não
  // deveria acontecer com --publish). Nunca afirmar "publicado" sem o state.
  return { kind: "falhou", error: "o publicador terminou sem erro, mas não gravou tentativa de envio no state do ciclo" };
}

export interface OutcomeEmailContext {
  cycle: string;
  publishMonday: string;
  /** Caminho do state, relativo à raiz (para o editor abrir). */
  statePath: string;
}

const OUTCOME_LABEL: Record<CircleStackScheduledOutcome["kind"], string> = {
  publicado: "Publicado",
  ambiguo: "Ambíguo",
  falhou: "Falhou",
  "nao-enviado": "Não enviado",
};

/** Pure: assunto + corpo do e-mail ao editor, um por desfecho. */
export function buildCircleStackOutcomeEmail(
  outcome: CircleStackScheduledOutcome,
  ctx: OutcomeEmailContext,
): { subject: string; body: string } {
  const subject = `Radar de Notícias Stack ${ctx.cycle}: ${OUTCOME_LABEL[outcome.kind]}`;
  const manual = `npx tsx scripts/publish-circle-stack.ts --publish-monday ${ctx.publishMonday} --publish`;
  const footer = [
    "",
    "Task Diaria-Circle-Stack-Weekly-Publish (#11778). Ela não repete o envio nem usa --force.",
  ];
  let lines: string[];
  switch (outcome.kind) {
    case "publicado":
      lines = [
        `O post do ciclo ${ctx.cycle} saiu no Radar de Notícias Stack às ${outcome.publishedAt} (confirmado pelo webhook).`,
        "",
        "Nada a fazer. Para conferir:",
        CIRCLE_STACK_RADAR_URL,
      ];
      break;
    case "ambiguo":
      lines = [
        `A tentativa de envio do ciclo ${ctx.cycle} foi gravada às ${outcome.attemptedAt}, mas o webhook não confirmou.`,
        "O post PODE ter saído.",
        ...(outcome.error ? ["", "Erro do publicador:", outcome.error] : []),
        "",
        `O que fazer: conferir no Radar (${CIRCLE_STACK_RADAR_URL}).`,
        `- Se o post está lá: gravar published_at em ${ctx.statePath}.`,
        "- Se não está: publicar à mão com --force:",
        `  ${manual} --force`,
      ];
      break;
    case "falhou":
      lines = [
        `Nada foi enviado para o ciclo ${ctx.cycle}.`,
        "",
        "Erro do publicador:",
        outcome.error,
        "",
        "O que fazer: corrigir a causa e publicar à mão:",
        `  ${manual}`,
      ];
      break;
    case "nao-enviado":
      lines = [
        `O ciclo ${ctx.cycle} não foi enviado: ${outcome.reason}.`,
        "",
        "O que fazer: se a semana deve sair, rodar /diaria-stack (texto próprio + aprovação) e publicar à mão:",
        `  ${manual}`,
        "Se a semana não deve sair, nada a fazer.",
      ];
      break;
  }
  return { subject, body: [...lines, ...footer].join("\n") };
}

/**
 * Pure: exit code da task. Publicado e Não enviado são resultados esperados
 * (semana sem aprovação é escolha do editor) → 0. Ambíguo e Falhou pedem ação
 * → 1, e a unit fica `failed` (alarme de units falhas cobre o caso de o e-mail
 * também não sair).
 */
export function circleStackScheduledExitCode(outcome: CircleStackScheduledOutcome): number {
  return outcome.kind === "publicado" || outcome.kind === "nao-enviado" ? 0 : 1;
}
