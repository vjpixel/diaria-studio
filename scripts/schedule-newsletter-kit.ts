#!/usr/bin/env node
/**
 * scripts/schedule-newsletter-kit.ts (#464 — reescrever publish-newsletter para Kit API, #461)
 *
 * Agenda de verdade o broadcast de PRODUÇÃO criado por
 * `publish-newsletter-kit.ts` (Etapa 5) — mesma divisão 5/6 já usada pra
 * newsletter Beehiiv (rascunho na 5, Schedule na 6) e pro canal Brevo
 * diária (`schedule-daily-brevo.ts`, #5772), que este script espelha:
 * PATCH de agendamento + verificação pós-mutação via GET, nunca reporta
 * "agendado" a partir só da resposta do PATCH.
 *
 * **Chamado pelo orchestrator desde #464/PR #6096** — `orchestrator-stage-6.md`
 * §6d-kit dispatcha este script quando `publishing.newsletter.backend ===
 * "kit"` (mesma flag que `publish-newsletter-kit.ts` já lia sozinho antes
 * dessa PR, agora também lida pelo playbook — ver §"Branch por backend" em
 * `orchestrator-stage-5.md`/`orchestrator-stage-6.md`). O guard abaixo
 * (`checkKitBackendEnabled`, reusado de `publish-newsletter-kit.ts`)
 * continua existindo como defesa contra invocação standalone acidental —
 * não é mais o único motivo de o script nunca rodar, já que o default do
 * flag segue `"beehiiv"` e o dispatch do orchestrator só chama isto quando
 * o flag já confirmou `"kit"`.
 *
 * ## Por que um script separado do `--send-test`
 *
 * `publish-newsletter-kit.ts --send-test` cria um broadcast DESCARTÁVEL
 * separado (ver docstring de `kit-broadcasts.ts` sobre por que reusar o
 * broadcast real corromperia a Etapa 6 — uma vez `send_at` setado e
 * disparado, o broadcast fica `completed` PARA SEMPRE). Este script é o
 * que finalmente dá `send_at` ao broadcast de PRODUÇÃO (rastreado em
 * `_internal/newsletter-kit-published.json`), então roda só na Etapa 6,
 * depois do gate humano — nunca antes.
 *
 * Uso:
 *   npx tsx scripts/schedule-newsletter-kit.ts --edition-dir <dir> --scheduled-at <ISO8601>
 *
 * Exit codes:
 *   0 — agendado e verificado (GET confirma status "scheduled" + send_at
 *       correto NESTA chamada, ou já confirmado em invocação anterior —
 *       idempotente, ver `alreadyScheduled` no resultado)
 *   1 — uso/erro genérico (args ausentes/inválidos)
 *   2 — `publishing.newsletter.backend` != "kit" (guard contra invocação fora do switchover)
 *   3 — `_internal/newsletter-kit-published.json` ausente ou sem broadcast_id
 *       (nada a agendar — Etapa 5 não rodou o publisher Kit ainda)
 *   4 — PATCH falhou (erro de API)
 *   5 — GET de verificação pós-PATCH não confirma o agendamento esperado
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { updateBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { readPublishedState, writePublishedState, checkKitBackendEnabled, type KitNewsletterPublished } from "./publish-newsletter-kit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PlatformConfig {
  publishing?: { newsletter?: { backend?: string } };
}

export type ScheduleNewsletterKitResult =
  | { ok: true; broadcastId: number; scheduledAt: string; status: string; alreadyScheduled?: boolean }
  | { ok: false; code: 3 | 4 | 5; reason: string };

/**
 * Pura o suficiente pra ser testável — `deps.readPublished`/`deps.writePublished`/
 * `deps.patchSchedule`/`deps.getBroadcastStatus` são injetáveis (nenhuma
 * chamada de rede/I/O real em teste). Mesmo padrão de `ScheduleDailyBrevoDeps`
 * (`schedule-daily-brevo.ts`, #5772) — o guard de backend (`checkKitBackendEnabled`)
 * fica FORA desta função, só em `main()`, porque é uma checagem de config
 * de arquivo, não parte do fluxo de agendamento em si.
 */
export interface ScheduleNewsletterKitDeps {
  readPublished: (editionDir: string) => KitNewsletterPublished | null;
  writePublished: (editionDir: string, state: KitNewsletterPublished) => void;
  patchSchedule: (broadcastId: number, sendAt: string) => Promise<unknown>;
  getBroadcastStatus: (broadcastId: number) => Promise<{ status: string; sendAt: string | null }>;
}

export async function scheduleNewsletterKit(
  editionDir: string,
  scheduledAtIso: string,
  deps: ScheduleNewsletterKitDeps,
): Promise<ScheduleNewsletterKitResult> {
  const published = deps.readPublished(editionDir);
  if (!published || typeof published.broadcast_id !== "number") {
    return {
      ok: false,
      code: 3,
      reason:
        "_internal/newsletter-kit-published.json ausente ou sem broadcast_id — nada a agendar " +
        "(publish-newsletter-kit.ts não rodou pra esta edição ainda, ou falhou na Etapa 5).",
    };
  }
  const broadcastId = published.broadcast_id;

  // Idempotência (mesmo padrão do #5781/Brevo): um broadcast Kit `completed`
  // não pode ser atualizado (ver docstring de `kit-broadcasts.ts` — 422
  // "Broadcast has already been sent."). Resume após sucesso mas antes do
  // sentinel do Stage 6 não deve re-tentar o PATCH.
  if (published.status === "scheduled" && typeof published.scheduled_at === "string") {
    return {
      ok: true,
      broadcastId,
      scheduledAt: published.scheduled_at,
      status: "already_scheduled",
      alreadyScheduled: true,
    };
  }

  try {
    await deps.patchSchedule(broadcastId, scheduledAtIso);
  } catch (e) {
    return { ok: false, code: 4, reason: `PATCH /broadcasts/${broadcastId} falhou: ${(e as Error).message}` };
  }

  let verified: { status: string; sendAt: string | null };
  try {
    verified = await deps.getBroadcastStatus(broadcastId);
  } catch (e) {
    return {
      ok: false,
      code: 5,
      reason: `GET /broadcasts/${broadcastId} (verificação pós-PATCH) falhou: ${(e as Error).message}`,
    };
  }

  // Compara INSTANTES, não strings (mesmo achado do #5851 na Brevo — um ESP
  // pode devolver o timestamp num formato/offset diferente do enviado,
  // representando o MESMO instante). `Date.parse` retorna NaN pra string
  // inválida — `receivedMs !== expectedMs` já cobre esse caso (NaN nunca é
  // igual a nada), então um `sendAt` ausente/corrompido reprova aqui, nunca
  // um falso "confirmado" por acidente.
  const expectedMs = Date.parse(scheduledAtIso);
  const receivedMs = verified.sendAt != null ? Date.parse(verified.sendAt) : NaN;
  if (receivedMs !== expectedMs || Number.isNaN(receivedMs)) {
    return {
      ok: false,
      code: 5,
      reason:
        `GET pós-PATCH não confirma o agendamento: esperado send_at=${scheduledAtIso}, ` +
        `recebido ${JSON.stringify(verified.sendAt)} (status atual: ${verified.status}).`,
    };
  }

  // Só persiste depois da verificação via GET confirmar — nunca a partir só do PATCH.
  deps.writePublished(editionDir, { ...published, status: "scheduled", scheduled_at: verified.sendAt! });

  return { ok: true, broadcastId, scheduledAt: verified.sendAt!, status: verified.status };
}

export function productionDeps(): ScheduleNewsletterKitDeps {
  return {
    readPublished: (editionDir) => readPublishedState(editionDir),
    writePublished: (editionDir, state) => writePublishedState(editionDir, state),
    patchSchedule: async (broadcastId, sendAt) => updateBroadcast(broadcastId, { send_at: sendAt }),
    getBroadcastStatus: async (broadcastId) => {
      const broadcast = await getBroadcast(broadcastId);
      return { status: broadcast.status, sendAt: broadcast.send_at };
    },
  };
}

/**
 * #464 (achado do review, PR #6096): extraído como função exportada
 * (`rootDirOverride` testável, mesmo padrão de `publish-newsletter-kit.ts::main`)
 * — antes vivia inline no bloco `isMainModule`, usando `process.exit()`
 * direto (mata o processo, inviável de testar) em vez de `process.exitCode`
 * + `return`. Fecha a assimetria de cobertura de CLI apontada pelo
 * pr-test-analyzer: o guard de backend != "kit" agora tem teste dedicado,
 * como o do script irmão já tinha.
 */
export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const editionDirArg = getStringArg(argv, "edition-dir");
  const scheduledAtArg = getStringArg(argv, "scheduled-at");
  if (!editionDirArg || !scheduledAtArg) {
    process.stderr.write(
      "uso: npx tsx scripts/schedule-newsletter-kit.ts --edition-dir <dir> --scheduled-at <ISO8601>\n",
    );
    process.exitCode = 1;
    return;
  }

  const platformConfig = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as PlatformConfig;
  const backendCheck = checkKitBackendEnabled(platformConfig);
  if (!backendCheck.ok) {
    process.stderr.write(`[schedule-newsletter-kit] ERRO: ${backendCheck.reason}\n`);
    process.exitCode = 2;
    return;
  }

  const editionDir = resolve(editionDirArg);
  const result = await scheduleNewsletterKit(editionDir, scheduledAtArg, productionDeps());
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    // #464 (achado do review, PR #6096): sem este `.catch`, uma exceção não
    // tratada (JSON.parse malformado em readPublishedState, erro de I/O em
    // writePublishedState) derrubava com stack trace cru e exit code
    // não-documentado, em vez do contrato estruturado {ok:false,code} que
    // o resto do módulo estabelece — mesmo padrão já usado em
    // `publish-newsletter-kit.ts` (arquivo irmão desta mesma PR).
    process.stderr.write(`[schedule-newsletter-kit] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
