/**
 * scripts/mark-retrospectiva-channel.ts (#9474)
 *
 * Wrapper CLI fino pra gravar o resultado de um canal no state por canal de
 * `/diaria-mensal-apoiadores` (`data/monthly/{ciclo}/_internal/divulgacao-published.json`,
 * `scripts/lib/mensal/retrospectiva-divulgacao.ts`) — análogo a
 * `mark-artigo-especial-channel.ts` (#5979). Existe pelo mesmo motivo de lá:
 * os canais sem script próprio (`apoiase` via Claude in Chrome,
 * `linkedin_perfil` no composer manual) não podem depender de o agente
 * "lembrar de escrever o JSON certo" — 1 comando auditável no histórico do
 * Bash, nunca edição manual do arquivo.
 *
 * Modo `--sync-email`: projeta o state do publisher Kit
 * (`_internal/beehiiv-apoiadores-state.json`, `publish-monthly-apoiadores-kit.ts`)
 * no canal `email` via `deriveEmailChannelState` — o publisher continua sendo
 * a fonte de verdade do broadcast e não foi alterado.
 *
 * Uso:
 *   npx tsx scripts/mark-retrospectiva-channel.ts --cycle 2609-10 \
 *     --channel apoiase --status done --url https://apoia.se/diaria/contents/view/...
 *   npx tsx scripts/mark-retrospectiva-channel.ts --cycle 2609-10 \
 *     --channel linkedin_perfil --status failed --reason "composer recusou a imagem"
 *   npx tsx scripts/mark-retrospectiva-channel.ts --cycle 2609-10 --sync-email
 */

import { isMainModule, getStringArg, hasFlag } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { readApoiadoresState } from "./lib/mensal/monthly-apoiadores-state.ts";
import { buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import {
  RETROSPECTIVA_DIVULGACAO_CHANNELS,
  type RetrospectivaDivulgacaoChannel,
  deriveEmailChannelState,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
} from "./lib/mensal/retrospectiva-divulgacao.ts";

function isChannel(v: string): v is RetrospectivaDivulgacaoChannel {
  return (RETROSPECTIVA_DIVULGACAO_CHANNELS as readonly string[]).includes(v);
}

export interface MarkRetrospectivaChannelOptions {
  cycle: string;
  cycleDir: string;
  channel: RetrospectivaDivulgacaoChannel;
  status: "done" | "failed";
  url?: string;
  reason?: string;
}

/** Corpo testável: grava 1 canal. `failed` exige `reason`. */
export function runMarkRetrospectivaChannel(o: MarkRetrospectivaChannelOptions): { statePath: string } {
  if (o.status === "failed" && !o.reason) {
    throw new Error("--status failed exige --reason (é o que o próximo run/editor lê pra decidir se retenta).");
  }
  const statePath = retrospectivaDivulgacaoStatePath(o.cycleDir);
  const state = readRetrospectivaDivulgacaoState(statePath, o.cycle);
  const at = new Date().toISOString();
  const ch = o.status === "done" ? buildDoneChannelState(at, o.url ?? null) : buildFailedChannelState(at, o.reason!);
  writeRetrospectivaDivulgacaoState(statePath, withChannelState(state, o.channel, ch));
  return { statePath };
}

export type SyncEmailResult =
  | { action: "written"; status: "done" | "failed"; reason: string | null }
  | { action: "kept-manual-done" }
  | { action: "nothing" };

/**
 * Corpo testável do `--sync-email`: lê o state do publisher Kit e projeta no
 * canal `email`.
 *
 * Preserva um `done` já gravado quando a projeção só diria "audiência não
 * confirmável" (`kitAudienceVerified: null`): é exatamente o caso em que o
 * SKILL manda o editor conferir no painel e marcar `done` à mão — reverter
 * isso a cada execução faria a skill entrar em loop num falso `failed`
 * (achado do review do PR #9475). `kitAudienceVerified: false` (audiência
 * DIVERGENTE, incidente) sempre sobrescreve.
 */
export function runSyncEmailChannel(cycle: string, cycleDir: string): SyncEmailResult {
  const apoiadores = readApoiadoresState(cycleDir);
  const derived = deriveEmailChannelState(apoiadores);
  if (!derived) return { action: "nothing" };
  const statePath = retrospectivaDivulgacaoStatePath(cycleDir);
  const state = readRetrospectivaDivulgacaoState(statePath, cycle);
  if (derived.status === "failed" && state.channels.email?.status === "done" && apoiadores?.kitAudienceVerified !== false) {
    return { action: "kept-manual-done" };
  }
  writeRetrospectivaDivulgacaoState(statePath, withChannelState(state, "email", derived));
  return { action: "written", status: derived.status === "done" ? "done" : "failed", reason: derived.reason };
}

function main(): void {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const cycleDir = monthlyDir(cycle);

  if (hasFlag(argv, "sync-email")) {
    const r = runSyncEmailChannel(cycle, cycleDir);
    if (r.action === "nothing") {
      console.log("Canal `email`: nenhum broadcast Kit registrado ainda pra este ciclo — nada gravado (segue pendente).");
    } else if (r.action === "kept-manual-done") {
      console.log("Canal `email`: mantido o `done` marcado à mão (audiência conferida no painel) — a releitura do publisher segue sem confirmação.");
    } else {
      console.log(`Canal \`email\` gravado como "${r.status}"${r.reason ? ` — ${r.reason}` : ""}.`);
      if (r.status === "failed") process.exitCode = 1;
    }
    return;
  }

  const channelArg = getStringArg(argv, "channel", { example: "apoiase" });
  const statusArg = getStringArg(argv, "status", { example: "done" });
  if (!channelArg || !statusArg) {
    console.error(
      `Uso: --cycle YYMM-MM --channel {${RETROSPECTIVA_DIVULGACAO_CHANNELS.join("|")}} --status {done|failed} ` +
        '[--url https://...] [--reason "..."]  |  --cycle YYMM-MM --sync-email',
    );
    process.exit(2);
  }
  if (!isChannel(channelArg)) {
    console.error(`--channel inválido: "${channelArg}" — esperado um de {${RETROSPECTIVA_DIVULGACAO_CHANNELS.join(", ")}}.`);
    process.exit(2);
  }
  if (statusArg !== "done" && statusArg !== "failed") {
    console.error(`--status inválido: "${statusArg}" — esperado "done" ou "failed".`);
    process.exit(2);
  }
  const { statePath } = runMarkRetrospectivaChannel({
    cycle,
    cycleDir,
    channel: channelArg,
    status: statusArg,
    url: getStringArg(argv, "url", { example: "https://apoia.se/diaria/contents/view/..." }),
    reason: getStringArg(argv, "reason", { example: "DOM do painel mudou" }),
  });
  console.log(`OK — canal "${channelArg}" gravado como "${statusArg}" em ${statePath}.`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
