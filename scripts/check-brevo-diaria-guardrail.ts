#!/usr/bin/env node
/**
 * scripts/check-brevo-diaria-guardrail.ts (#4476 item 9 — "Circuit breakers
 * de campanha")
 *
 * Avalia a saúde AGREGADA dos envios da campanha `brevo_diaria` (conta Brevo
 * PRÓPRIA do editor — API key `platform.config.json → brevo_diaria.api_key_env`)
 * contra os mesmos limiares do ramp Clarice (abertura <15%, bounce duro ≥2%,
 * bounce total ≥5%, spam ≥0,1%, unsub ≥3% — ver
 * `scripts/lib/brevo-diaria-guardrail.ts` pro racional completo, inclusive
 * por que abertura NUNCA pausa sozinha). Se algum breaker de bounce/spam/unsub
 * for cruzado, PAUSA o rollout (latch persistido em
 * `data/brevo-diaria/guardrail-state.json`) — `sync-pending-to-brevo.ts` lê
 * esse estado e para de fazer backfill (novos contatos) enquanto pausado,
 * mesmo que ainda existam slots livres na fila top-300 (item 5).
 *
 * ## Diferença deliberada do alarme do ramp Clarice (`clarice-guardrail-alarm.ts`)
 *
 * Aquele alarme espera ~10h pós-envio (`GUARDRAIL_EVAL_WINDOW_MS`) antes de
 * avaliar CADA campanha isoladamente. Este script AGREGA todas as campanhas
 * `sent` da conta (soma bruta, sem janela de maturação) e roda toda vez que é
 * invocado — a issue #4476 pede explicitamente "circuit breakers ... checados
 * TODO DIA — não esperam maturação, a Brevo reporta bounce/spam quase em
 * tempo real" (seção "Rollout em canário"). O motivo da diferença: o alarme
 * Clarice decide se SUSPENDE manualmente 1 envio específico já agendado (por
 * isso precisa nomear "qual" e "até quando"); este script decide se PAUSA um
 * processo contínuo (o backfill) — não há "1 envio" pra nomear, e reagir mais
 * rápido a bounce/spam é estritamente mais seguro (nunca menos) que esperar.
 *
 * ## Latch — não despausa sozinho
 *
 * Uma vez pausado, o estado permanece pausado até `--unpause` explícito
 * (tipicamente rodado pelo editor depois de investigar e decidir que é
 * seguro continuar) — ver `applyGuardrailCheck`/`unpauseRollout` em
 * `scripts/lib/brevo-diaria-guardrail.ts`.
 *
 * ## Uso
 *
 *   npx tsx scripts/check-brevo-diaria-guardrail.ts               # avalia + persiste + alarma se NOVA pausa
 *   npx tsx scripts/check-brevo-diaria-guardrail.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause      # limpa o latch (ação explícita do editor)
 *
 * Env: `platform.config.json → brevo_diaria.api_key_env` (BREVO_DIARIA_API_KEY).
 * Requer `data/.credentials.json` com o scope `gmail.send` pro alarme (mesmo
 * requisito de `clarice-guardrail-alarm.ts`) — falha ao enviar e-mail é
 * best-effort (loga, não aborta o script — o estado já foi persistido, o
 * dado mais importante).
 *
 * Como o resto deste canal (#4266/#4476), `--push` real contra a Brevo nunca
 * rodou ao vivo nesta unidade (guard de publicação, `context/overnight-dispatch-rules.md`
 * #1) — validado só via testes com fetch mockado.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateBrevoDiariaRolloutGuardrail,
  describeBreaches,
  readRolloutGuardrailState,
  writeRolloutGuardrailState,
  applyGuardrailCheck,
  unpauseRollout,
  type CampaignGuardrailInput,
} from "./lib/brevo-diaria-guardrail.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");

interface BrevoDiariaConfig {
  api_key_env: string;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

interface BrevoCampaignListItem {
  id: number;
  name: string;
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

/** I/O — todas as campanhas `sent` da conta (não filtra por lista — a conta
 * inteira é dedicada a `brevo_diaria`, mesma premissa de `clarice-guardrail-alarm.ts`
 * pra `brevo_monthly`). */
async function fetchSentCampaigns(apiKey: string): Promise<BrevoCampaignListItem[]> {
  const { body } = await brevoGet(apiKey, "/emailCampaigns?status=sent&limit=50&sort=desc");
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
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const doUnpause = hasFlag(argv, "unpause");
  const log = (msg: string) => process.stderr.write(`[check-brevo-diaria-guardrail] ${msg}\n`);

  if (doUnpause) {
    if (isDryRun) {
      log("--dry-run + --unpause: imprimiria o unpause, NÃO grava.");
      return;
    }
    const state = readRolloutGuardrailState();
    const next = unpauseRollout(state, new Date());
    writeRolloutGuardrailState(next);
    log(`rollout despausado explicitamente (estava pausado desde: ${state.paused_at ?? "nunca"}).`);
    return;
  }

  const platformConfig = JSON.parse(readFileSync(PLATFORM_CONFIG_PATH, "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria) {
    log("ERRO: brevo_diaria não configurado em platform.config.json.");
    process.exit(2);
  }
  const apiKey = process.env[brevoDiaria!.api_key_env];
  if (!apiKey) {
    log(`ERRO: ${brevoDiaria!.api_key_env} não definido no ambiente.`);
    process.exit(2);
  }

  const campaignList = await fetchSentCampaigns(apiKey!);
  const stats: CampaignGuardrailInput[] = [];
  for (const item of campaignList) {
    const s = await fetchCampaignStats(apiKey!, item.id);
    if (s) stats.push(s);
  }
  log(`${stats.length} de ${campaignList.length} campanha(s) enviada(s) com stats disponíveis.`);

  const evaluation = evaluateBrevoDiariaRolloutGuardrail(stats);
  const stateBefore = readRolloutGuardrailState();

  if (evaluation === null) {
    log("nenhuma campanha com dado suficiente ainda — sem avaliação possível (nunca pausa/despausa por ausência de dado).");
    if (!isDryRun) writeRolloutGuardrailState(applyGuardrailCheck(stateBefore, null, new Date()));
    return;
  }

  const { result } = evaluation;
  log(
    `agregado de ${evaluation.campaignCount} campanha(s): anyBreach=${result.anyBreach} ` +
      `(abertura ${result.openRatePct.toFixed(1)}%, bounce hard ${result.hardBounceRatePct.toFixed(2)}%/total ${result.bounceRatePct.toFixed(2)}%, ` +
      `unsub ${result.unsubRatePct.toFixed(2)}%, spam ${result.spamRatePct.toFixed(3)}%)`,
  );

  const stateAfter = applyGuardrailCheck(stateBefore, evaluation, new Date());
  const newlyPaused = stateAfter.rollout_paused && !stateBefore.rollout_paused;

  if (isDryRun) {
    log(`--dry-run: NÃO persiste. rollout_paused seria=${stateAfter.rollout_paused}` + (newlyPaused ? " (NOVA pausa)" : ""));
    if (result.anyBreach) log(`breaches: ${describeBreaches(result).join("; ")}`);
    return;
  }

  writeRolloutGuardrailState(stateAfter);

  if (newlyPaused) {
    const breaches = describeBreaches(result);
    const subject = "[diar.ia.br] Rollout do canal Brevo Pending PAUSADO — circuit breaker furado";
    const body = [
      "O rollout do canal Brevo (segmento Pending, #4476) foi PAUSADO automaticamente:",
      "",
      ...breaches.map((b) => `- ${b}`),
      "",
      "O backfill contínuo (sync-pending-to-brevo.ts) NÃO vai ingerir novos contatos até você",
      "investigar e rodar:",
      "",
      "  npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause",
      "",
      `(alarme automático — avaliação rodou em ${new Date().toISOString()})`,
    ].join("\n");
    try {
      const to = resolveEditorEmail(PLATFORM_CONFIG_PATH);
      await sendGmailMessage(to, subject, body);
      log(`rollout PAUSADO — e-mail de alarme enviado pra ${to}.`);
    } catch (e) {
      // #738-adjacent: falha no ENVIO do alarme nunca deve mascarar que o
      // estado já foi persistido pausado (o dado mais importante já está
      // salvo) — best-effort, loga e segue.
      log(`AVISO: rollout PAUSADO, mas falha ao enviar e-mail de alarme: ${(e as Error).message}`);
    }
  } else if (stateAfter.rollout_paused) {
    log(`rollout permanece pausado desde ${stateAfter.paused_at} — sem novo alarme (idempotente).`);
  } else {
    log("rollout OK, sem pausa.");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[check-brevo-diaria-guardrail] erro:", e);
    process.exit(1);
  });
}
