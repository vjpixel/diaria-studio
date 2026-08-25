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
 * ## Alarme de campanha suspensa (#6146)

 * Mecanismo SEPARADO do circuit breaker acima, no mesmo script só porque
 * já roda de 4 em 4h contra esta conta. Detecta campanha em
 * `status=suspended` e manda e-mail — uma vez por id (`selectUnalarmedSuspended`).
 *
 * Existe porque `fetchSentCampaigns` só lista `status=sent`: em 25/08/2026
 * este guardrail rodou 6× reportando `rollout OK` enquanto a campanha da
 * edição estava suspensa e o canal, caído. Ele era estruturalmente incapaz
 * de ver o problema.
 *
 * NÃO mexe no latch `rollout_paused`: suspensão é cota/plataforma, não
 * entregabilidade — pausar o backfill não corrige nada e ainda criaria um
 * segundo estado pro editor despausar à mão.
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
  selectUnalarmedSuspended,
  type CampaignGuardrailInput,
  type RolloutGuardrailState,
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

interface SuspendedCampaign {
  id: number;
  name: string;
  scheduledAt?: string | null;
}

/**
 * I/O — campanhas em `suspended` (#6146).
 *
 * `fetchSentCampaigns` acima só enxerga `status=sent`, e é por isso que a
 * suspensão da edição 260825 passou ~12h sem nenhum alarme: uma campanha
 * suspensa NUNCA entra naquela lista, então o guardrail rodou 6 vezes no dia
 * reportando "rollout OK" enquanto o canal estava caído. Uma campanha só vai
 * pra `suspended` por ação da plataforma (falta de cota, revisão antifraude)
 * ou do editor no painel — em nenhum dos casos ela se recupera sozinha.
 */
async function fetchSuspendedCampaigns(
  apiKey: string,
  log: (msg: string) => void,
): Promise<SuspendedCampaign[]> {
  const { body } = await brevoGet(apiKey, "/emailCampaigns?status=suspended&limit=50&sort=desc");
  const campaigns = (body as { campaigns?: SuspendedCampaign[] })?.campaigns;
  // `?? []` aqui seria o bug do #6146 de novo, um nível acima: "não consegui
  // ler" viraria "não há campanha suspensa", e o alarme nunca dispararia.
  // `brevoGet` devolve `{status: 404, body: {}}` SEM lançar, então um 404 ou
  // uma troca de contrato chegariam exatamente assim. Leitura ilegível é
  // erro — mesma regra de `fetchTransactionalRequests`.
  if (!Array.isArray(campaigns)) {
    throw new Error(
      "GET /emailCampaigns?status=suspended não devolveu `campaigns` como array " +
        `(recebido: ${JSON.stringify(campaigns)}) — lista de campanhas suspensas ilegível.`,
    );
  }
  const usable = campaigns.filter((c) => typeof c?.id === "number");
  if (usable.length !== campaigns.length) {
    log(
      `AVISO: ${campaigns.length - usable.length} entrada(s) de campanha suspensa sem \`id\` numérico, ` +
        "ignorada(s) — resposta parcialmente malformada da Brevo.",
    );
  }
  return usable;
}

/**
 * Alarme de campanha suspensa. Separado do alarme de circuit breaker
 * (que reporta entregabilidade) porque a ação do editor é outra: aqui não
 * há o que despausar, há uma campanha que não saiu e uma cota a investigar.
 */
async function alarmSuspendedCampaigns(
  fresh: number[],
  all: SuspendedCampaign[],
  log: (msg: string) => void,
): Promise<void> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const subject = `[diar.ia.br] Campanha Brevo SUSPENSA — ${fresh.length} campanha(s) não enviada(s)`;
  const body = [
    "A Brevo marcou como `suspended` campanha(s) do canal diária que estavam agendadas.",
    "Campanha suspensa NÃO envia e NÃO se recupera sozinha:",
    "",
    ...fresh.map((id) => {
      const c = byId.get(id);
      return `- #${id} "${c?.name ?? "(sem nome)"}" (agendada para: ${c?.scheduledAt ?? "?"})`;
    }),
    "",
    "A Brevo suspende por mais de um motivo — cota da conta esgotada, revisão",
    "antifraude, ou ação manual no painel. Checar o painel se o consumo abaixo",
    "estiver normal.",
    "",
    "Hipótese a descartar primeiro (foi a causa em 260825, #6146): o plano free tem",
    "UM balde de 300 e-mails/dia compartilhado entre transacional e marketing — um",
    "pico de transacional consome a cota e a campanha morre suspensa no horário.",
    "",
    "Investigar o consumo do dia:",
    "",
    "  curl -H \"api-key: $BREVO_DIARIA_API_KEY\" \\",
    "    'https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=AAAA-MM-DD&endDate=AAAA-MM-DD'",
    "",
    `(alarme automático — checagem rodou em ${new Date().toISOString()})`,
  ].join("\n");
  const to = resolveEditorEmail(PLATFORM_CONFIG_PATH);
  await sendGmailMessage(to, subject, body);
  log(`campanha(s) suspensa(s) ${fresh.join(", ")} — e-mail de alarme enviado pra ${to}.`);
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

export interface SuspendedCampaignsDeps {
  fetchSuspended: () => Promise<SuspendedCampaign[]>;
  readState: () => RolloutGuardrailState;
  writeState: (state: RolloutGuardrailState) => void;
  alarm: (fresh: number[], all: SuspendedCampaign[]) => Promise<void>;
  isDryRun: boolean;
  log: (msg: string) => void;
}

/**
 * Detecta e alarma campanhas suspensas (#6146). Extraída de `main()` com
 * deps injetáveis porque a ordem aqui é o comportamento inteiro — e ordem
 * errada custa um alarme perdido, que é o bug original.
 *
 * Regra que não pode mudar: persistir o dedup SÓ depois do e-mail sair.
 * Gravar antes e falhar o envio marcaria o id como "já alarmado" e a
 * campanha suspensa nunca mais geraria alarme. Alarme repetido é barato;
 * alarme engolido é o #6146 se repetindo.
 */
export async function handleSuspendedCampaigns(deps: SuspendedCampaignsDeps): Promise<void> {
  const suspended = await deps.fetchSuspended();
  if (suspended.length === 0) return;

  const { fresh, next } = selectUnalarmedSuspended(
    deps.readState(),
    suspended.map((c) => c.id),
  );
  if (fresh.length === 0) {
    deps.log(`${suspended.length} campanha(s) suspensa(s) na conta — todas já alarmadas, sem novo e-mail.`);
    return;
  }
  if (deps.isDryRun) {
    deps.log(`--dry-run: alarmaria ${fresh.length} campanha(s) suspensa(s) nova(s): ${fresh.join(", ")} — NÃO persiste.`);
    return;
  }
  try {
    await deps.alarm(fresh, suspended);
    deps.writeState(next);
  } catch (e) {
    // Não persiste o dedup — a próxima rodada (4h) tenta de novo.
    deps.log(`AVISO: falha ao alarmar campanha(s) suspensa(s) ${fresh.join(", ")}: ${(e as Error).message}`);
  }
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

  // #6146: ANTES da avaliação de entregabilidade, e independente dela — o
  // fluxo abaixo tem early-returns (`evaluation === null`) que pulariam esta
  // checagem se ela viesse depois.
  await handleSuspendedCampaigns({
    fetchSuspended: () => fetchSuspendedCampaigns(apiKey!, log),
    readState: () => readRolloutGuardrailState(),
    writeState: (st) => writeRolloutGuardrailState(st),
    alarm: (fresh, all) => alarmSuspendedCampaigns(fresh, all, log),
    isDryRun,
    log,
  });

  const campaignList = await fetchSentCampaigns(apiKey!);
  const stats: CampaignGuardrailInput[] = [];
  for (const item of campaignList) {
    const s = await fetchCampaignStats(apiKey!, item.id);
    if (s) stats.push(s);
  }
  log(`${stats.length} de ${campaignList.length} campanha(s) enviada(s) com stats disponíveis.`);

  // #4476 self-review: lê o estado ANTES de avaliar, pra passar `unpaused_at`
  // como corte (`sentAfter`) — sem isso, um recheck logo após `--unpause`
  // reavaliava o mesmo agregado que causou a pausa e re-pausava sozinho,
  // sobrepondo a decisão do editor em silêncio (ver "Janela de agregação
  // pós-unpause" em scripts/lib/brevo-diaria-guardrail.ts).
  const stateBefore = readRolloutGuardrailState();
  const evaluation = evaluateBrevoDiariaRolloutGuardrail(stats, undefined, stateBefore.unpaused_at);

  if (evaluation === null) {
    const reason = stateBefore.unpaused_at
      ? `nenhuma campanha enviada desde o unpause em ${stateBefore.unpaused_at} ainda — aguardando dado NOVO pra reavaliar (não re-pausa sobre dado antigo)`
      : "nenhuma campanha com dado suficiente ainda";
    log(`${reason} — sem avaliação possível (nunca pausa/despausa por ausência de dado).`);
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
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de awaits de rede (fetchSentCampaigns/fetchCampaignStats/sendGmailMessage),
  // o cenário exato da classe UV_HANDLE_CLOSING no Windows (#1401/#4638/#4651/
  // #4653): process.exit() força o shutdown do libuv antes dos sockets
  // keep-alive do fetch fecharem. process.exitCode deixa o event loop drenar
  // sozinho. Os guards pré-await (linhas acima) continuam com process.exit(2)
  // de propósito — nenhum fetch rodou ainda nesses pontos.
  main().catch((e) => {
    console.error("[check-brevo-diaria-guardrail] erro:", e);
    process.exitCode = 1;
  });
}
