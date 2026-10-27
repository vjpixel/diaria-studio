#!/usr/bin/env node
/**
 * #11225: scheduler do canal Kit paralelo aposentado.
 * Preserva CLI e validação de data para compatibilidade; retorna code 2
 * sem ler estado, fazer PATCH ou agendar. O envio principal é
 * `schedule-newsletter-kit.ts`. Arquivos históricos não são alterados.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { updateBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import {
  readKitDiariaState,
  writeKitDiariaState,
} from "./kit-diaria-stage5-dispatch.ts";
import type { KitDiariaChannelConfig } from "./lib/kit-diaria-channel.ts";
import { editionAammddFromDir, checkScheduledAtMatchesEditionDate } from "./lib/edition-scheduled-at.ts";
import { resolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts"; // #9427

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ScheduleKitDiariaResult =
  | { code: 0; scheduledAt: string; broadcastId: number }
  | { code: 2; reason: string }
  | { code: 3 | 4 | 5; reason: string };

export interface ScheduleKitDiariaDeps {
  readPlatformConfig(): {
    kit_diaria?: KitDiariaChannelConfig;
    publishing?: { newsletter?: { backend?: string } };
  };
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
        publishing?: { newsletter?: { backend?: string } };
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
  options: { allowOtherDate?: boolean } = {},
): Promise<ScheduleKitDiariaResult> {
  // #8207 item 2 — mesmo guard de `schedule-newsletter-kit.ts`/
  // `schedule-daily-brevo.ts`: recusa `--scheduled-at` cuja data-calendário
  // em BRT diverge da data da edição, salvo `--allow-other-date`. Roda antes
  // de ler config/estado (fail fast).
  const editionAammdd = editionAammddFromDir(editionDir);
  if (editionAammdd) {
    const dateCheck = checkScheduledAtMatchesEditionDate(editionAammdd, scheduledAt, options.allowOtherDate);
    if (!dateCheck.ok) {
      return { code: 5, reason: dateCheck.reason };
    }
  }

  let cfg: {
    kit_diaria?: KitDiariaChannelConfig;
    publishing?: { newsletter?: { backend?: string } };
  };
  try {
    cfg = deps.readPlatformConfig();
  } catch (e) {
    return { code: 3, reason: `platform.config.json ilegível: ${(e as Error).message}` };
  }
  // #9001: `enabled` checado ANTES do guard de exclusão mútua com o backend
  // — mesma ordem de `decideKitChannelDispatch` (scripts/lib/kit-diaria-channel.ts).
  // Canal já desligado por default não precisa (nem deve) do motivo de
  // exclusão mútua: essa mensagem instrui "canal não participa por causa do
  // backend", o que soa como se `enabled` ainda estivesse ligado e
  // precisasse ser desligado — confuso quando já está `false`.
  if (cfg.kit_diaria?.enabled !== true) {
    return { code: 2, reason: "kit_diaria.enabled não é true — canal não participou desta edição." };
  }
  // #6321 — guard de exclusão mútua: com o backend já em "kit", o
  // switchover (#6114) envia pra audiência INTEIRA e este canal paralelo
  // NUNCA deve agendar, mesmo que `kit_diaria.enabled` tenha ficado `true`
  // por engano (dívida corrigida no próprio #6321/#6313, não garantia
  // futura).
  return {
    code: 2,
    reason: 'publishing.newsletter.backend === "kit" — canal paralelo aposentado (#11225); agendar também entregaria EM DOBRO. Canal não participa.',
  };
}


export async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const editionDir = getArg(argv, "edition-dir");
  const scheduledAt = getArg(argv, "scheduled-at");
  if (!editionDir || !scheduledAt) {
    console.error("uso: npx tsx scripts/schedule-kit-diaria.ts --edition-dir <dir> --scheduled-at <ISO> [--allow-other-date]");
    process.exitCode = 1;
    return;
  }
  const allowOtherDate = hasFlag(argv, "allow-other-date");
  let result: ScheduleKitDiariaResult;
  try {
    result = await scheduleKitDiaria(resolveEditionDirArg(editionDir, { root: ROOT }) /* #9427 */, scheduledAt, productionDeps(), { allowOtherDate });
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
