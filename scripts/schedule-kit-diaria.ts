#!/usr/bin/env node
/**
 * scripts/schedule-kit-diaria.ts (#6048 — wiring do canal Kit paralelo, #6126)
 *
 * Agenda o broadcast do **canal Kit PARALELO** criado por
 * `kit-diaria-stage5-dispatch.ts` na Etapa 5. Roda na Etapa 6, sob o MESMO
 * gate/horário do Schedule da Beehiiv — mesma divisão 5/6 do canal Brevo
 * (`schedule-daily-brevo.ts`, #5772), que este script espelha.
 *
 * ## Por que NÃO é o `schedule-newsletter-kit.ts`
 *
 * Aquele serve o switchover final (#6114): lê
 * `_internal/newsletter-kit-published.json` e é gated por
 * `checkKitBackendEnabled` (exige `publishing.newsletter.backend === "kit"`).
 * Este canal roda com o backend ainda em `"beehiiv"`, e tem estado próprio
 * (`_internal/kit-diaria-published.json`). Reusar aquele exigiria atravessar
 * os dois comportamentos com flags e acoplaria o caminho do #6114 a este.
 *
 * ## ⚠️ Editar broadcast agendado DESAGENDA (#6181)
 *
 * Medido ao vivo em 25/08/2026: `PATCH /v4/broadcasts/{id}` com `subject`
 * responde **200 e zera o `send_at`** — o broadcast volta a rascunho, em
 * silêncio, sem erro. No piloto dos Patronos, aplicar "- patronos" no assunto
 * cancelou o envio do dia seguinte; só não virou incidente porque houve
 * reconferência.
 *
 * **Qualquer edição de broadcast agendado exige RODAR ESTE SCRIPT DE NOVO.**
 * Não confie no 200 do PATCH — confira o `send_at` depois.
 *
 * ## Verificação pós-mutação (#573)
 *
 * Nunca reporta "agendado" a partir da resposta do PATCH — relê o broadcast
 * e confere o `send_at` de volta, mesmo padrão de `verify-scheduled-post.ts`
 * (Beehiiv) e `schedule-daily-brevo.ts` (Brevo).
 *
 * Exit codes (a tabela do playbook em `orchestrator-stage-6.md` §6d-kit-diaria
 * precisa espelhar isto — ver #6147, que nasceu de uma tabela desatualizada):
 *   1 — uso: `--edition-dir`/`--scheduled-at` ausente
 *   0 — agendado e verificado
 *   2 — canal desligado (`kit_diaria.enabled !== true`) ou estado ausente:
 *       NÃO é erro, é o caminho normal quando o canal não participou da edição
 *   3 — PATCH falhou (erro de API)
 *   4 — GET pós-PATCH não confirma o agendamento
 *
 * Uso:
 *   npx tsx scripts/schedule-kit-diaria.ts --edition-dir data/editions/AAMMDD/ --scheduled-at 2026-08-26T09:00:00Z
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { updateBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import {
  readKitDiariaState,
  writeKitDiariaState,
} from "./kit-diaria-stage5-dispatch.ts";
import type { KitDiariaChannelConfig } from "./lib/kit-diaria-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ScheduleKitDiariaResult =
  | { code: 0; scheduledAt: string; broadcastId: number }
  | { code: 2; reason: string }
  | { code: 3 | 4; reason: string };

export interface ScheduleKitDiariaDeps {
  readPlatformConfig(): { kit_diaria?: KitDiariaChannelConfig };
  readState: typeof readKitDiariaState;
  writeState: typeof writeKitDiariaState;
  patch(id: number, sendAt: string): Promise<{ id: number }>;
  verify(id: number): Promise<{ send_at?: string | null; subject?: string; preview_text?: string | null }>;
  log(line: string): void;
}

export function productionDeps(rootDir: string = ROOT): ScheduleKitDiariaDeps {
  return {
    readPlatformConfig: () =>
      JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as {
        kit_diaria?: KitDiariaChannelConfig;
      },
    readState: readKitDiariaState,
    writeState: writeKitDiariaState,
    patch: (id, sendAt) => updateBroadcast(id, { send_at: sendAt }),
    verify: (id) => getBroadcast(id),
    log: (line) => process.stderr.write(`[kit-diaria schedule] ${line}\n`),
  };
}

export async function scheduleKitDiaria(
  editionDir: string,
  scheduledAt: string,
  deps: ScheduleKitDiariaDeps,
): Promise<ScheduleKitDiariaResult> {
  let cfg: { kit_diaria?: KitDiariaChannelConfig };
  try {
    cfg = deps.readPlatformConfig();
  } catch (e) {
    return { code: 3, reason: `platform.config.json ilegível: ${(e as Error).message}` };
  }
  if (cfg.kit_diaria?.enabled !== true) {
    return { code: 2, reason: "kit_diaria.enabled não é true — canal não participou desta edição." };
  }

  let state: ReturnType<typeof readKitDiariaState>;
  try {
    state = deps.readState(editionDir);
  } catch (e) {
    // Estado corrompido é DIFERENTE de ausente (mesma disciplina do #6153):
    // ausente = canal pulou; ilegível = alguém precisa olhar.
    return { code: 3, reason: `estado do canal ilegível: ${(e as Error).message}` };
  }
  if (!state || typeof state.broadcast_id !== "number") {
    return { code: 2, reason: "_internal/kit-diaria-published.json ausente — canal pulou a Etapa 5." };
  }

  // Idempotência em resume: já agendado é caminho feliz, não re-PATCH.
  if (state.status === "scheduled" && state.scheduled_at) {
    deps.log(`já agendado para ${state.scheduled_at} — no-op.`);
    return { code: 0, scheduledAt: state.scheduled_at, broadcastId: state.broadcast_id };
  }

  try {
    await deps.patch(state.broadcast_id, scheduledAt);
  } catch (e) {
    return { code: 3, reason: `PATCH falhou: ${(e as Error).message}` };
  }

  // #573 — confirmar por releitura, nunca pela resposta do PATCH.
  let confirmed: { send_at?: string | null; subject?: string; preview_text?: string | null };
  try {
    confirmed = await deps.verify(state.broadcast_id);
  } catch (e) {
    return { code: 4, reason: `GET de verificação falhou: ${(e as Error).message}` };
  }
  if (!confirmed.send_at) {
    return { code: 4, reason: `GET pós-PATCH não traz send_at — agendamento NÃO confirmado.` };
  }
  // #6162 (achado do review): comparar INSTANTES, não só existência — mesmo
  // rigor de `schedule-daily-brevo.ts` (#5851). Um PATCH pode responder 2xx
  // sem aplicar o valor, deixando um `send_at` antigo de pé; checar só
  // "veio algo" aceitaria esse caso como sucesso.
  const pedidoMs = Date.parse(scheduledAt);
  const recebidoMs = Date.parse(confirmed.send_at);
  if (Number.isFinite(pedidoMs) && Number.isFinite(recebidoMs) && pedidoMs !== recebidoMs) {
    return {
      code: 4,
      reason: `send_at confirmado (${confirmed.send_at}) difere do pedido (${scheduledAt}) — PATCH não aplicou o valor.`,
    };
  }

  // #6181: reler subject/preview do broadcast em vez de preservar os locais.
  // Editar o subject no painel (ou por PATCH, como o "- patronos" do piloto)
  // deixava o arquivo local mentindo pra quem auditasse depois — o Kit é a
  // fonte de verdade, e agora o estado reflete o que de fato vai sair.
  deps.writeState(editionDir, {
    ...state,
    // #6183 (achado P2 do review): checagem explícita de `undefined`, NÃO `??`.
    // `preview_text` é `string | null` na API — `null` é valor LEGÍTIMO (o
    // editor removeu o preview no painel). Com `??`, um `null` do Kit cairia
    // no valor local stale, contradizendo o motivo desta releitura existir.
    subject: confirmed.subject !== undefined ? confirmed.subject : state.subject,
    preview_text: confirmed.preview_text !== undefined ? confirmed.preview_text : state.preview_text,
    status: "scheduled",
    scheduled_at: confirmed.send_at,
  });
  deps.log(`agendado para ${confirmed.send_at} (broadcast_id=${state.broadcast_id}) ✓`);
  return { code: 0, scheduledAt: confirmed.send_at, broadcastId: state.broadcast_id };
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const editionDir = getArg(argv, "edition-dir");
  const scheduledAt = getArg(argv, "scheduled-at");
  if (!editionDir || !scheduledAt) {
    console.error("uso: npx tsx scripts/schedule-kit-diaria.ts --edition-dir <dir> --scheduled-at <ISO>");
    process.exitCode = 1;
    return;
  }
  let result: ScheduleKitDiariaResult;
  try {
    result = await scheduleKitDiaria(resolve(ROOT, editionDir), scheduledAt, productionDeps());
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
  }
  console.log(JSON.stringify(result, null, 2));
  // #6162 (achado P1 do review): NÃO colapsar o 2 em 0. O docstring acima, a
  // tabela do §6d-kit-diaria e o precedente `schedule-daily-brevo.ts` tratam
  // 0/2/3/4 como códigos distintos — colapsar faria o processo nunca emitir o
  // 2 que a própria documentação promete. Quem lê o exit code do shell
  // receberia "sucesso" onde o contrato diz "não participou".
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}
