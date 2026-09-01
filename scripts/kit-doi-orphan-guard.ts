#!/usr/bin/env node
/**
 * scripts/kit-doi-orphan-guard.ts (#6810)
 *
 * Alarme agendado: detecta assinantes Kit criados `inactive` (double
 * opt-in do worker `poll`, #6340) que NUNCA foram vinculados ao form de
 * confirmação (`platform.config.json` → `kit.doiFormId`) — e por isso nunca
 * vão receber o e-mail de confirmação nem sair de `inactive` sozinhos. Ver
 * a docstring de `scripts/lib/kit-doi-orphan-guard.ts` pra contexto
 * completo (o incidente de 28/08/2026 que motivou esta unidade) e a regra
 * exata do que conta como órfão.
 *
 * Mesmo molde de `scripts/subscribe-redirect-drift-check.ts`: este arquivo
 * faz só I/O (2 chamadas REST Kit + e-mail + issue via
 * `scripts/lib/alarm-issues.ts`); toda a decisão (quem é órfão, fingerprint,
 * idempotência, corpo do e-mail) é pura e testada em
 * `scripts/lib/kit-doi-orphan-guard.ts`.
 *
 * ## Escopo desta unidade (#6810) — só a Ação 2 (detecção)
 *
 * A Ação 1 da issue (`POST /forms/{form}/subscribers/{id}` pra cada órfão,
 * disparando a confirmação com atraso) **não está implementada aqui** —
 * envia e-mail real a pessoas reais, decisão do editor (irreversível pra
 * terceiros, critério 1 de "Perguntar é exceção" do CLAUDE.md). Este script
 * só DETECTA e ALARMA; o resgate continua manual.
 *
 * ## Uso
 *
 *   npx tsx scripts/kit-doi-orphan-guard.ts               # avalia + persiste + alarma se NOVO
 *   npx tsx scripts/kit-doi-orphan-guard.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/kit-doi-orphan-guard.ts --to email@x   # override do destinatário
 *
 * ## Config/env
 *
 * `KIT_API_KEY` (leitura, `scripts/lib/kit-config.ts`) — MESMA key dos
 * demais scripts REST Kit deste repo, nunca escrita: este script só chama
 * `GET /v4/subscribers` e `GET /v4/forms/{form}/subscribers`, os dois de
 * LEITURA (ver `scripts/lib/kit-subscribers.ts`). `platform.config.json` →
 * `kit.doiFormId` — mesmo id do `KIT_DOI_FORM_ID` configurado no
 * `workers/poll/wrangler.toml` do worker `poll` (config duplicada de
 * propósito: o worker lê via env Cloudflare, este script lê do JSON
 * versionado, mesmo padrão de `kit.tallyFormId`/`fetch-tally-audience.ts`).
 * `doiFormId` ausente/vazio → o script loga e sai sem checar nada (fail-
 * soft — sem form configurado não há como saber quem foi vinculado, então
 * não há base pra decidir órfão; nunca lança).
 *
 * `data/.credentials.json` com o scope `gmail.send` — só necessário quando
 * há órfão novo pra de fato enviar o e-mail (mesmo requisito dos outros
 * alarmes locais deste repo).
 *
 * ## Guard de publicação
 *
 * Só LEITURA contra o Kit (2 `GET`s). Nenhuma escrita, nenhum
 * `--push`/flag de ativação — nada aqui precisa do guard de publicação do
 * overnight/develop além do já implícito em "nunca rodar contra a conta
 * real fora de teste" (mesma disciplina do #6340 item 3): não executado ao
 * vivo nesta unidade (worktree isolado, sem `KIT_API_KEY` real garantida) —
 * validado via testes com `kitFetch`/`fetch` mockado.
 *
 * Como os outros alarmes locais deste repo, o registro na task
 * (`scripts/lib/scheduled-tasks.ts`) nasce DECLARADO — armar via
 * `scripts/setup-systemd-timers.ts` na checkout compartilhada (`helios`) é
 * ação POSTERIOR do editor.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { listAllKitSubscribers, listAllFormSubscribers } from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import {
  findKitDoiOrphans,
  computeKitDoiOrphanFingerprint,
  kitDoiOrphanFindingKey,
  shouldAlarmKitDoiOrphans,
  advanceKitDoiOrphanState,
  emptyKitDoiOrphanAlarmState,
  buildKitDoiOrphanAlarmEmail,
  type KitDoiOrphan,
  type KitDoiOrphanAlarmState,
} from "./lib/kit-doi-orphan-guard.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "kit-doi-orphan-guard", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "kit-doi-orphan-guard", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[kit-doi-orphan-guard]";
/** Task roda diária — 2 execuções limpas consecutivas = ~48h sem órfão
 *  pendente antes de fechar a issue automaticamente, mesmo valor de
 *  `subscribe-redirect-drift-check.ts`/`hub-drift-check.ts` pra cadência
 *  diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência do e-mail) ───────────────────────────────────────

export function loadState(statePath: string = STATE_PATH): KitDoiOrphanAlarmState {
  if (!existsSync(statePath)) return emptyKitDoiOrphanAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<KitDoiOrphanAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyKitDoiOrphanAlarmState();
  }
}

export function saveState(state: KitDoiOrphanAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE) ─────────────────────────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional dos demais
// alarmes deste repo: idempotência do E-MAIL (acima) e tracking de ISSUE
// são preocupações independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte UM órfão individual no `AlarmFinding` que
 *  `scripts/lib/alarm-issues.ts` consome — 1 issue por ASSINANTE, não 1
 *  agregada pro conjunto inteiro (mesmo padrão de `toAlarmFinding` em
 *  `hub-drift-check.ts`/`subscribe-redirect-drift-check.ts`: `check` e
 *  `fingerprint` usam `kitDoiOrphanFindingKey`, estável por órfão). Um
 *  fingerprint agregado do CONJUNTO faria a issue de um órfão que continua
 *  pendente "fechar" (e uma nova abrir) sempre que a composição mudasse —
 *  novo órfão surgindo ou um antigo sendo resgatado — mesmo sem nenhuma
 *  mudança no estado daquele assinante específico (achado de review do PR
 *  #6993, corrigido aqui antes do merge). Prioridade `P1` — mesmo bug
 *  original da issue #6810: cadastro real, silencioso, sem workaround
 *  automático. */
export function toAlarmFinding(orphan: KitDoiOrphan): AlarmFinding {
  const fingerprint = kitDoiOrphanFindingKey(orphan);
  return {
    check: fingerprint,
    fingerprint,
    family: "estado",
    title: `[diar.ia.br] cadastro Kit preso em inactive sem confirmação (double opt-in) — ${orphan.email_address}`,
    body: [
      "Achado automático do alarme `Diaria-Kit-Doi-Orphan-Guard`",
      "(`scripts/kit-doi-orphan-guard.ts`).",
      "",
      `Assinante órfão: ${orphan.email_address} (id ${orphan.id}) — criado em ${orphan.created_at}, ${orphan.ageHours.toFixed(1)}h atrás.`,
      "",
      "Resgate manual (Ação 1 da issue #6810 — decisão do editor, envia",
      "e-mail real a este assinante):",
      "`POST /v4/forms/{KIT_DOI_FORM_ID}/subscribers/{id}` dispara a",
      "confirmação com atraso.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando este órfão deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  let doiFormId: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(PLATFORM_CONFIG_PATH, "utf8")) as { kit?: { doiFormId?: string } };
    doiFormId = cfg.kit?.doiFormId;
  } catch (e) {
    console.error(`${LOG_PREFIX} não foi possível ler ${PLATFORM_CONFIG_PATH}: ${(e as Error).message}`);
  }
  if (!doiFormId) {
    console.log(`${LOG_PREFIX} platform.config.json → kit.doiFormId ausente — nada a checar (sem form, não há como saber quem foi vinculado).`);
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    console.log(`${LOG_PREFIX} ${kitConfigResult.reason} — nada a checar.`);
    return;
  }
  const kitConfig = kitConfigResult.config;

  const [inactiveSubscribers, formSubscribers] = await Promise.all([
    listAllKitSubscribers(kitConfig, { status: "inactive" }),
    listAllFormSubscribers(doiFormId, kitConfig),
  ]);
  const formSubscriberIds = new Set(formSubscribers.map((s) => s.id));

  console.log(
    `${LOG_PREFIX} ${inactiveSubscribers.length} assinante(s) inactive, ${formSubscriberIds.size} vinculado(s) ao form ${doiFormId}.`,
  );

  const now = new Date();
  const orphans = findKitDoiOrphans(inactiveSubscribers, formSubscriberIds, now);

  console.log(`${LOG_PREFIX} ${orphans.length} órfão(s) pendente(s) (>= 48h, nunca vinculado ao form).`);
  for (const o of orphans) {
    console.log(`${LOG_PREFIX}   - ${o.email_address} (id ${o.id}, ${o.ageHours.toFixed(1)}h)`);
  }

  const state = loadState();

  // Reconcilia issue ANTES de montar o e-mail (o e-mail cita a issue),
  // mesmo padrão de subscribe-redirect-drift-check.ts. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  const alarmFindings: AlarmFinding[] = orphans.map(toAlarmFinding);
  const alarmState = loadAlarmIssuesState();
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.fingerprint,
        { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
      ]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`${LOG_PREFIX} [${o.check}] issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`${LOG_PREFIX} [${o.check}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  if (shouldAlarmKitDoiOrphans(state, orphans)) {
    const { subject, body } = buildKitDoiOrphanAlarmEmail(orphans, now, issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional de subscribe-redirect-drift-check.ts:
      // se o envio falhar, saveState abaixo não roda, e a próxima execução
      // tenta alarmar de novo em vez de marcar este achado como "já
      // avisado" sem o editor ter recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem órfão pendente, ou o mesmo conjunto já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = orphans.length > 0 ? computeKitDoiOrphanFingerprint(orphans) : null;
  saveState(advanceKitDoiOrphanState(nextFingerprint, now));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
