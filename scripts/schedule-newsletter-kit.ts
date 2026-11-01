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
 *   npx tsx scripts/schedule-newsletter-kit.ts --edition-dir <dir> --scheduled-at <ISO8601> [--allow-other-date]
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
 *   6 — `--scheduled-at` diverge da data da edição (#8207) — recusado salvo
 *       `--allow-other-date`; ver `scripts/lib/edition-scheduled-at.ts`
 *       OU (#11689) `--scheduled-at` já passou / a <2 min de agora (sem
 *       override; roda depois do atalho idempotente) — voltar ao gate do Stage 6
 *   7 — (#10437) audiência não confirmada. Com `kit.diaria_exclusion_segment`
 *       ligado: segmento não resolvido, ou o broadcast relido ANTES do PATCH
 *       não mostra o filtro do segmento (nada agendado; se ele JÁ estava
 *       agendado, é desagendado com `send_at: null` + releitura e o estado
 *       local volta pra "draft"), ou o relido DEPOIS do PATCH diverge (mesmo
 *       desfazer). Com ele desligado: o store da Brevo tem contatos
 *       `kit-sem-abertura:` em `in_brevo`, ou não pôde ser lido. Nunca agenda
 *       pra base inteira no lugar.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { updateBroadcast, listSegments, type KitSubscriberFilter } from "./lib/kit-broadcasts.ts";
import { hasBrevoDiariaCampaign, resolveDiariaAudience, verifyDiariaAudienceFilter, type DiariaExclusionSegmentConfig } from "./lib/kit-diaria-audience.ts"; // #10437
import { readKitSemAberturaInBrevoCount } from "./lib/kit-sem-abertura.ts"; // #10437
import { getBroadcast } from "./lib/kit-client.ts";
import { readPublishedState, writePublishedState, checkKitBackendEnabled, type KitNewsletterPublished } from "./publish-newsletter-kit.ts";
import { editionAammddFromDir, checkScheduledAtMatchesEditionDate, checkScheduledAtNotPast, FINAL_GUARD_MIN_LEAD_MS } from "./lib/edition-scheduled-at.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts"; // #9427
import { runSemanalFrioAfterSchedule, summarizeSemanalFrioForSchedule } from "./publish-kit-semanal-frio.ts"; // #11221

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PlatformConfig {
  publishing?: { newsletter?: { backend?: string } };
  kit?: { diaria_exclusion_segment?: DiariaExclusionSegmentConfig };
}

export type ScheduleNewsletterKitResult =
  | { ok: true; broadcastId: number; scheduledAt: string; status: string; alreadyScheduled?: boolean }
  | { ok: false; code: 3 | 4 | 5 | 6 | 7; reason: string };

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
  /** `sendAt: null` desfaz o agendamento (#10437, filtro divergente pós-PATCH). */
  patchSchedule: (broadcastId: number, sendAt: string | null) => Promise<unknown>;
  /** `subscriberFilter` (#10437): o `subscriber_filter` relido, quando o Kit o ecoa. */
  getBroadcastStatus: (broadcastId: number) => Promise<{ status: string; sendAt: string | null; subscriberFilter?: unknown }>;
}

export async function scheduleNewsletterKit(
  editionDir: string,
  scheduledAtIso: string,
  deps: ScheduleNewsletterKitDeps,
  options: {
    allowOtherDate?: boolean;
    /** Relógio injetável (testes, #11689). */
    now?: Date;
    /**
     * #10437 — presente só com `kit.diaria_exclusion_segment` ligado: o filtro
     * de segmento que o broadcast PRECISA ter. Relido antes do PATCH (aborta
     * sem agendar) e depois (desfaz o agendamento se divergir). Ausente =
     * comportamento de sempre, nenhuma leitura extra.
     */
    expectedAudienceFilter?: KitSubscriberFilter;
  } = {},
): Promise<ScheduleNewsletterKitResult> {
  // #8207 item 2 — recusa `--scheduled-at` cuja data-calendário em BRT diverge
  // da data da edição, salvo `--allow-other-date` explícito. Roda ANTES de
  // qualquer leitura/mutação (fail fast). Quando o editionDir não é um
  // diretório de edição reconhecível (`AAMMDD` no basename — ex: tmpdir
  // arbitrário de teste), não há data-alvo pra comparar: pula o guard em vez
  // de recusar por um path que nunca foi uma edição de verdade.
  const editionAammdd = editionAammddFromDir(editionDir);
  if (editionAammdd) {
    const dateCheck = checkScheduledAtMatchesEditionDate(editionAammdd, scheduledAtIso, options.allowOtherDate);
    if (!dateCheck.ok) {
      return { ok: false, code: 6, reason: dateCheck.reason };
    }
  }

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

  // #10437 — antes de qualquer agendamento (inclusive o atalho idempotente
  // abaixo): com a audiência por segmento, o broadcast relido tem que mostrar
  // o filtro do segmento. Senão nada é agendado.
  if (options.expectedAudienceFilter) {
    let before: Awaited<ReturnType<ScheduleNewsletterKitDeps["getBroadcastStatus"]>>;
    try {
      before = await deps.getBroadcastStatus(broadcastId);
    } catch (e) {
      return {
        ok: false,
        code: 7,
        reason: `GET /broadcasts/${broadcastId} (conferência da audiência antes de agendar, #10437) falhou: ${(e as Error).message}`,
      };
    }
    const verdict = verifyDiariaAudienceFilter(before.subscriberFilter, options.expectedAudienceFilter);
    if (!verdict.ok) {
      if (before.sendAt == null) {
        return { ok: false, code: 7, reason: `broadcast_id=${broadcastId} NÃO agendado: ${verdict.reason}` };
      }
      // Já estava agendado (Etapa 6 anterior, ou agendado à mão) com a
      // audiência divergente: "não agendar" não basta, ele sairia assim
      // mesmo. Desagenda e confirma por releitura.
      const undo = await undoSchedule(deps, broadcastId);
      if (undo.ok) {
        const { scheduled_at: _dropped, ...rest } = published;
        deps.writePublished(editionDir, { ...rest, status: "draft" });
      }
      return {
        ok: false,
        code: 7,
        reason: `broadcast_id=${broadcastId} JÁ ESTAVA agendado (send_at=${before.sendAt}) com a audiência divergente: ${verdict.reason} ${undo.message}.`,
      };
    }
  }

  // Idempotência HONESTA (#8207 item 3, achado do bug secundário que mascarou
  // a causa raiz do agendamento-no-dia-errado: reagendar pelo script oficial
  // respondia "sucesso" sem mudar nada). `already_scheduled` só quando o
  // horário GRAVADO é o MESMO instante do pedido — mesmo padrão já usado
  // pra confirmar sucesso mais abaixo (compara instantes via `Date.parse`,
  // não strings: dois formatos podem representar o mesmo instante). Pedido
  // com horário DIFERENTE cai pro PATCH normal abaixo — mesmo padrão de
  // `schedule-kit-diaria.ts` (#7285), que já reagenda em vez de confiar
  // cegamente no cache quando o alvo diverge. Broadcast Kit `completed`
  // (já enviado, 422 "Broadcast has already been sent.", ver docstring de
  // `kit-broadcasts.ts`) segue coberto — reagendar tenta o PATCH e o erro
  // vira `code: 4` normalmente, nunca um falso sucesso.
  if (published.status === "scheduled" && typeof published.scheduled_at === "string") {
    const storedMs = Date.parse(published.scheduled_at);
    const requestedMs = Date.parse(scheduledAtIso);
    if (Number.isFinite(storedMs) && Number.isFinite(requestedMs) && storedMs === requestedMs) {
      return {
        ok: true,
        broadcastId,
        scheduledAt: published.scheduled_at,
        status: "already_scheduled",
        alreadyScheduled: true,
      };
    }
  }

  // #11689 — defesa final contra passado, DEPOIS do atalho idempotente (re-rodar
  // um agendamento já feito continua sucesso) e ANTES do PATCH. Roda mesmo com
  // basename de edição irreconhecível. Margem pequena: o gate já exigiu 15 min,
  // aqui só recusa passado de fato (evita agendamento parcial entre canais).
  const pastCheck = checkScheduledAtNotPast(scheduledAtIso, options.now, { minLeadMs: FINAL_GUARD_MIN_LEAD_MS });
  if (!pastCheck.ok) {
    return { ok: false, code: 6, reason: pastCheck.reason };
  }

  try {
    await deps.patchSchedule(broadcastId, scheduledAtIso);
  } catch (e) {
    return { ok: false, code: 4, reason: `PATCH /broadcasts/${broadcastId} falhou: ${(e as Error).message}` };
  }

  let verified: Awaited<ReturnType<ScheduleNewsletterKitDeps["getBroadcastStatus"]>>;
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

  // #10437 — o PATCH de `send_at` não pode ter trocado a audiência. Divergiu ⇒
  // desfaz o agendamento (send_at: null) e reprova.
  if (options.expectedAudienceFilter) {
    const verdict = verifyDiariaAudienceFilter(verified.subscriberFilter, options.expectedAudienceFilter);
    if (!verdict.ok) {
      const undo = await undoSchedule(deps, broadcastId);
      if (undo.ok && published.status === "scheduled") {
        const { scheduled_at: _dropped, ...rest } = published;
        deps.writePublished(editionDir, { ...rest, status: "draft" });
      }
      return { ok: false, code: 7, reason: `broadcast_id=${broadcastId}: ${verdict.reason} ${undo.message}.` };
    }
  }

  // Só persiste depois da verificação via GET confirmar — nunca a partir só do PATCH.
  deps.writePublished(editionDir, { ...published, status: "scheduled", scheduled_at: verified.sendAt! });

  return { ok: true, broadcastId, scheduledAt: verified.sendAt!, status: verified.status };
}

/** #10437 — `send_at: null` + releitura (2xx não é prova). Nunca lança. */
async function undoSchedule(deps: ScheduleNewsletterKitDeps, broadcastId: number): Promise<{ ok: boolean; message: string }> {
  try {
    await deps.patchSchedule(broadcastId, null);
    const reread = await deps.getBroadcastStatus(broadcastId);
    if (reread.sendAt != null) {
      return { ok: false, message: `desagendamento NÃO confirmado (releitura mostra send_at=${reread.sendAt}) — DESAGENDE À MÃO no Kit AGORA` };
    }
    return { ok: true, message: "agendamento desfeito (send_at: null, confirmado por releitura)" };
  } catch (e) {
    return { ok: false, message: `FALHA ao desfazer o agendamento (${(e as Error).message}) — DESAGENDE À MÃO no Kit AGORA` };
  }
}

export function productionDeps(): ScheduleNewsletterKitDeps {
  return {
    readPublished: (editionDir) => readPublishedState(editionDir),
    writePublished: (editionDir, state) => writePublishedState(editionDir, state),
    patchSchedule: async (broadcastId, sendAt) => updateBroadcast(broadcastId, { send_at: sendAt }),
    getBroadcastStatus: async (broadcastId) => {
      const broadcast = await getBroadcast(broadcastId);
      return { status: broadcast.status, sendAt: broadcast.send_at, subscriberFilter: broadcast.subscriber_filter };
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
      "uso: npx tsx scripts/schedule-newsletter-kit.ts --edition-dir <dir> --scheduled-at <ISO8601> [--allow-other-date]\n",
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

  const resolvedArg = tryResolveEditionDirArg(editionDirArg, { root: rootDir }); // #9427 (antes: cwd)
  if (!resolvedArg.ok) {
    process.stderr.write(`[schedule-newsletter-kit] ERRO: ${resolvedArg.error}\n`);
    process.exitCode = 1;
    return;
  }
  const editionDir = resolvedArg.editionDir;
  const allowOtherDate = hasFlag(argv, "allow-other-date");
  // #10437 — flag desligada (default) ⇒ `mode: "all"`, sem rede, sem
  // conferência extra; salvo se o store da Brevo tiver gente já movida (aí
  // a base inteira seria envio em dobro e o agendamento é recusado).
  const moved = readKitSemAberturaInBrevoCount(rootDir);
  if ("error" in moved) {
    const reason = `${moved.error} — não dá pra afirmar que ninguém foi movido pra Brevo (#10437); nada agendado.`;
    console.log(JSON.stringify({ ok: false, code: 7, reason }));
    process.exitCode = 7;
    return;
  }
  if (moved.warning) process.stderr.write(`[schedule-newsletter-kit] warn: ${moved.warning} (#10437).\n`);
  const audience = await resolveDiariaAudience(
    platformConfig.kit?.diaria_exclusion_segment,
    { listSegments: () => listSegments() },
    { movedToBrevoCount: moved.count, brevoCampaignPublished: hasBrevoDiariaCampaign(editionDir) },
  );
  if (!audience.ok) {
    console.log(JSON.stringify({ ok: false, code: 7, reason: audience.reason }));
    process.exitCode = 7;
    return;
  }
  const result = await scheduleNewsletterKit(editionDir, scheduledAtArg, productionDeps(), {
    allowOtherDate,
    ...(audience.mode === "segment" ? { expectedAudienceFilter: audience.filter } : {}),
  });
  // #11221 — semanal de frio (2º broadcast de segunda, tag `frio`, mesmo
  // `send_at`). Nunca muda o exit code do agendamento da diária, mas o
  // desfecho vai no JSON (`semanal_frio: {status, reason, broadcast_id}`) e
  // falha sai como ERRO no stderr — visível pra Etapa 6 relatar ao editor.
  // #11294 item 2 — com o principal NÃO agendado (falha, ou desfeito pelo
  // exit 7), a semanal só acompanha: se já estava agendada, é desagendada
  // (senão sairia sozinha); nunca é criada.
  let semanalFrio: ReturnType<typeof summarizeSemanalFrioForSchedule> | undefined;
  {
    const log = (msg: string) => process.stderr.write(`[schedule-newsletter-kit] semanal frio: ${msg}\n`);
    const semanal = await runSemanalFrioAfterSchedule(editionDir, log, rootDir, undefined, { followOnly: !result.ok });
    // `not_monday` fica fora como no caller do publisher (review do PR #11326):
    // sairia em toda edição que não é de segunda, sem nada a relatar.
    if (semanal.status !== "disabled" && semanal.status !== "nothing_to_follow" && semanal.status !== "not_monday") {
      semanalFrio = summarizeSemanalFrioForSchedule(semanal);
      log(`${semanal.status === "failed" ? "ERRO: " : ""}${semanal.status}${semanalFrio.reason ? ` — ${semanalFrio.reason}` : ""}`);
    }
  }
  console.log(JSON.stringify(semanalFrio ? { ...result, semanal_frio: semanalFrio } : result));
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
