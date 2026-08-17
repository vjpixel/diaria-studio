#!/usr/bin/env node
/**
 * clarice-guardrail-alarm.ts (#4064)
 *
 * PARTE 1 (alarme) do ramp Clarice: ~10h após cada envio (`GUARDRAIL_EVAL_WINDOW_MS`
 * — eram 6h originalmente, ajustado em #4475 —
 * `scripts/lib/clarice-guardrail-alarm.ts`), avalia os guardrails do que
 * acabou de sair (reusando `evaluateArmGuardrails`/`thresholds.ts`, sem
 * reimplementar limiar) e, se houver breach, envia e-mail ao editor via Gmail
 * API direta (`scripts/lib/gmail-send.ts` — nenhum MCP disponível fora de uma
 * sessão Claude Code viva, então `create_draft` não serve aqui).
 *
 * Caso concreto que motivou a issue (#4061, ver docstring da lib): o braço B
 * fechou o envio 8 com 11,1% de abertura (limiar 15%) e o envio 9B saiu no
 * dia seguinte mesmo assim. O e-mail SEMPRE nomeia o próximo envio agendado e
 * até quando dá pra cancelar (campanha agendada na Brevo NÃO é imutável —
 * #4935 — dá pra cancelar via API ou painel e recriar; a janela até o
 * disparo é o que importa aqui).
 *
 * Escopo explícito (decisão do editor, 260727): SÓ o alarme. Nada bloqueia
 * nada — a trava no pré-flight do agendamento fica pra depois de ver o
 * alarme rodando.
 *
 * Uso:
 *   npx tsx scripts/clarice-guardrail-alarm.ts [--dry-run] [--to email@x.com]
 *
 *   --dry-run   avalia e imprime o que faria, mas NÃO envia e-mail nem grava
 *               o estado (idempotência) — para inspecionar sem efeito colateral.
 *   --to        override do destinatário (default: resolveEditorEmail(platform.config.json)).
 *
 * Env:
 *   Requer `data/.credentials.json` com o scope `gmail.send` (rodar
 *   `npx tsx scripts/oauth-setup.ts` novamente se o token foi obtido antes
 *   do #4064 — reconsentir é necessário pra um scope novo entrar em vigor).
 *
 * Estado (idempotência): `data/clarice-guardrail-alarm-state.json` — lista de
 * IDs de campanha já avaliadas. Uma campanha nunca é reavaliada/realarmada.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateSendGuardrails,
  isReadyForEvaluation,
  pickCampaignsPendingEvaluation,
  markEvaluated,
  resolveNextScheduledSend,
  buildGuardrailAlarmEmail,
  emptyGuardrailAlarmState,
  type GuardrailAlarmState,
  type CampaignGuardrailInput,
} from "./lib/clarice-guardrail-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "clarice-guardrail-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-guardrail-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
/** #5339: campanha avaliada 1x pra sempre (`markEvaluated`, nunca reavalia)
 * — o achado desaparece do pendente já na PRÓXIMA execução após o breach,
 * então 2 execuções consecutivas ausentes fecha rápido; mesmo valor de
 * cadência usado pelos outros alarmes já wired (esta task roda a cada 4h). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function loadState(): GuardrailAlarmState {
  if (!existsSync(STATE_PATH)) return emptyGuardrailAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (Array.isArray(raw?.evaluated)) return { evaluated: raw.evaluated.map(String) };
    return emptyGuardrailAlarmState();
  } catch {
    return emptyGuardrailAlarmState();
  }
}

function saveState(state: GuardrailAlarmState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional do lote 1/3:
// idempotência do E-MAIL (acima) e tracking de ISSUE são preocupações
// independentes.

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

function saveAlarmIssuesState(state: AlarmIssuesState): void {
  writeFileAtomic(ALARM_ISSUES_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/** Converte um breach num `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check` fixo
 * ("clarice-guardrail"); `fingerprint` = `campaign-{id}` — cada campanha só
 * é avaliada 1x pra sempre (`markEvaluated`, nunca reavaliada), então o
 * achado some do pendente já na execução seguinte. Sem PII: nome/id de
 * CAMPANHA, não e-mail de assinante — `campaignName` nunca carrega dado de
 * contato individual.
 *
 * `family: "evento"` (#5553) — a campanha nunca é reavaliada, então o achado
 * sumir de `pending` não significa "consertado", só "já avaliado uma vez".
 * Sem esta declaração, `planAlarmReconciliation` trataria a ausência como
 * resolução e fecharia a issue sozinha com o breach real intocado — foi
 * exatamente o que quase aconteceu com #5525 (o editor teve que retirar a
 * label `alarm` à mão pra evitar isso antes deste fix). */
export function toAlarmFinding(
  item: BrevoCampaignListItem,
  guardrail: ReturnType<typeof evaluateSendGuardrails>,
): AlarmFinding {
  return {
    check: "clarice-guardrail",
    fingerprint: `campaign-${item.id}`,
    family: "evento",
    title: `[diar.ia.br] Guardrail furado no envio "${item.name}"`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Guardrail-Alarm`",
      "(`scripts/clarice-guardrail-alarm.ts`).",
      "",
      `Campanha: "${item.name}" (id ${item.id})`,
      `Abertura: ${guardrail.openRatePct.toFixed(1)}% (contexto, não gatilha o breach — #5166)`,
      `Bounce hard: ${guardrail.hardBounceRatePct.toFixed(2)}% / total: ${guardrail.bounceRatePct.toFixed(2)}%`,
      `Unsub: ${guardrail.unsubRatePct.toFixed(2)}%`,
      `Spam: ${guardrail.spamRatePct.toFixed(3)}%`,
      "",
      "Ver o e-mail de alarme correspondente (Gmail do editor) pro detalhe completo",
      "de qual(is) limiar(es) foram furados e o próximo envio agendado.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) — achado de EVENTO",
      "PASSADO (#5553): a campanha só é avaliada 1x, então esta issue NÃO se",
      "auto-fecha quando o achado sai da checagem seguinte. Fica aberta até um",
      "humano investigar/fechar (rota Overnight na Triagem).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

interface BrevoCampaignListItem {
  id: number;
  name: string;
  sentDate?: string | null;
  scheduledAt?: string | null;
}
interface BrevoCampaignsListResponse {
  campaigns?: BrevoCampaignListItem[];
}
interface BrevoCampaignDetail {
  id: number;
  name: string;
  sentDate?: string | null;
  statistics?: { globalStats?: Record<string, number> };
}

async function fetchSentCampaigns(apiKey: string): Promise<BrevoCampaignListItem[]> {
  const { body } = await brevoGet(apiKey, "/emailCampaigns?status=sent&limit=50&sort=desc");
  return (body as BrevoCampaignsListResponse)?.campaigns ?? [];
}

async function fetchScheduledCampaigns(apiKey: string): Promise<BrevoCampaignListItem[]> {
  const { body } = await brevoGet(apiKey, "/emailCampaigns?status=queued&limit=50&sort=asc");
  return (body as BrevoCampaignsListResponse)?.campaigns ?? [];
}

async function fetchCampaignStats(apiKey: string, id: number): Promise<CampaignGuardrailInput | null> {
  const { status, body } = await brevoGet(apiKey, `/emailCampaigns/${id}?statistics=globalStats`);
  if (status === 404) return null;
  const detail = body as BrevoCampaignDetail;
  const gs = detail.statistics?.globalStats;
  if (!gs || !detail.sentDate) return null;
  return {
    id: detail.id,
    name: detail.name,
    sentDate: detail.sentDate,
    sent: gs.sent ?? 0,
    delivered: gs.delivered ?? 0,
    uniqueViews: gs.uniqueViews ?? 0,
    unsubscriptions: gs.unsubscriptions ?? 0,
    complaints: gs.complaints ?? 0,
    hardBounces: gs.hardBounces ?? 0,
    softBounces: gs.softBounces ?? 0,
  };
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const toOverride = getArg(process.argv, "to");
  const apiKey = process.env.BREVO_CLARICE_API_KEY ?? process.env.BREVO_API_KEY ?? "";
  if (!apiKey) {
    console.error("[clarice-guardrail-alarm] BREVO_CLARICE_API_KEY (ou BREVO_API_KEY) não definido.");
    process.exit(1);
  }

  const now = new Date();
  const state = loadState();

  const sentList = await fetchSentCampaigns(apiKey);
  const pending = pickCampaignsPendingEvaluation(
    sentList.filter((c): c is BrevoCampaignListItem & { sentDate: string } => !!c.sentDate),
    state,
    now,
  );

  if (pending.length === 0) {
    console.log("[clarice-guardrail-alarm] nenhuma campanha nova cruzou a janela de 10h ainda.");
    return;
  }

  const scheduled = await fetchScheduledCampaigns(apiKey);
  const nextScheduled = resolveNextScheduledSend(
    scheduled.map((c) => ({ name: c.name, scheduledAt: c.scheduledAt ?? null })),
    now,
  );

  const evaluations: { item: BrevoCampaignListItem; guardrail: ReturnType<typeof evaluateSendGuardrails> }[] = [];
  for (const item of pending) {
    // #4063-style guard: re-checa a janela com o `sentDate` já validado (o
    // filter acima usa o mesmo predicado, mas o TS narrow exige refazer aqui).
    if (!isReadyForEvaluation(item.sentDate ?? "", now)) continue;

    const stats = await fetchCampaignStats(apiKey, item.id);
    if (!stats) {
      console.log(`[clarice-guardrail-alarm] campanha ${item.id} (${item.name}) sem stats ainda — tenta na próxima execução.`);
      continue;
    }

    const guardrail = evaluateSendGuardrails(stats);
    console.log(
      `[clarice-guardrail-alarm] "${item.name}" (id ${item.id}): anyBreach=${guardrail.anyBreach} ` +
        `(abertura ${guardrail.openRatePct.toFixed(1)}%, bounce hard ${guardrail.hardBounceRatePct.toFixed(2)}%/total ${guardrail.bounceRatePct.toFixed(2)}%, ` +
        `unsub ${guardrail.unsubRatePct.toFixed(2)}%, spam ${guardrail.spamRatePct.toFixed(3)}%)`,
    );
    evaluations.push({ item, guardrail });
  }

  // #5339 — reconcilia UMA issue por campanha com breach ANTES de montar os
  // e-mails (o e-mail cita a issue), mesmo padrão do lote 1/3. Roda toda
  // execução não-dry-run, independente do gate `anyBreach` de cada item —
  // só campanhas com breach viram AlarmFinding.
  const breached = evaluations.filter((e) => e.guardrail.anyBreach);
  const alarmFindings: AlarmFinding[] = breached.map(({ item, guardrail }) => toAlarmFinding(item, guardrail));
  const alarmState = loadAlarmIssuesState();
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `[clarice-guardrail-alarm] --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState: nextAlarmIssuesState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextAlarmIssuesState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [o.fingerprint, { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error }]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`[clarice-guardrail-alarm] issue não criada/reusada (${o.fingerprint}): ${o.error}`);
      } else {
        console.log(`[clarice-guardrail-alarm] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  let nextState = state;
  for (const { item, guardrail } of evaluations) {
    if (guardrail.anyBreach) {
      const issueRef = issueRefs?.get(`campaign-${item.id}`);
      const { subject, body } = buildGuardrailAlarmEmail(item.name, guardrail, nextScheduled, now, undefined, issueRef);
      const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
      if (isDryRun) {
        console.log(`[clarice-guardrail-alarm] --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
      } else {
        await sendGmailMessage(to, subject, body);
        console.log(`[clarice-guardrail-alarm] e-mail de alarme enviado pra ${to} (campanha "${item.name}").`);
      }
    }

    if (!isDryRun) nextState = markEvaluated(nextState, item.id);
  }

  if (!isDryRun) saveState(nextState);
  else console.log("[clarice-guardrail-alarm] --dry-run: estado NÃO gravado.");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[clarice-guardrail-alarm] erro:", e);
    process.exit(1);
  });
}
