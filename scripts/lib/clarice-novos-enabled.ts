/**
 * clarice-novos-enabled.ts (#4941)
 *
 * Toggle explícito "envio automático ativo/pausado" da task diária
 * `Diaria-Clarice-Novos` — mesmo molde de `scripts/lib/studio-chat-enabled.ts`
 * (#4078, removido no #6942 junto com o chat do Studio; ver
 * `scripts/lib/clarice-envio-enabled.ts` como sucessor vivo do mesmo
 * padrão), com UMA diferença deliberada no default.
 *
 * Contexto: até o #4941, `/diaria-clarice-novos` era invocação MANUAL
 * ~4×/semana, e a própria SKILL.md documentava o kill switch de um alarme
 * disparado (`Diaria-Clarice-Guardrail-Alarm`) como "simplesmente não rodar a
 * skill de novo — invocação é manual". Automatizar a rotina (cron diário,
 * 17:00 BRT) faz esse kill switch deixar de existir — sem um sinal explícito,
 * a única forma de pausar seria `systemctl --user stop` na máquina (exige
 * terminal, não dá pra fazer do celular). Este módulo devolve o sinal.
 *
 * **Default INVERTIDO em relação a `studio-chat-enabled.ts` (removido no
 * #6942) — e de propósito:** lá, `enabled: true` era o default seguro
 * porque o pior caso de um chat "ligado sem querer" era UX incômoda. Aqui,
 * o que está do outro lado do
 * toggle é ENVIO DE E-MAIL REAL E IRREVERSÍVEL (`--send-now`, #4347 D7) sem
 * gate humano (#4347 D6) — o pior caso de "ligado sem querer" é uma campanha
 * disparada que o editor não pretendia. Por isso `enabled: false` é o
 * default de arquivo AUSENTE: armar o timer nunca liga a automação sozinho —
 * o editor precisa escrever `{"enabled": true}` explicitamente (via CLI ou,
 * futuramente, um botão no Studio) depois de conferir a 1ª rodada.
 *
 * Consumido por `scripts/clarice-novos-run.ts` (Passo 0, ANTES de qualquer
 * chamada Stripe/MV/Brevo) — rodada pausada sai limpo (exit 0), grava
 * relatório "pausado", e não faz NENHUMA chamada de escrita. Não é falha:
 * um timer vermelho todo dia treina o editor a ignorar o alarme.
 *
 * Estado persistido em `data/clarice-novos-enabled.json` — arquivo NOVO e
 * dedicado, nunca reaproveita nenhum estado já existente sob `data/`
 * (mesma disciplina do #4078).
 *
 * Uso CLI (mesmo padrão de `exec-mode.ts`/`clarice-envio-enabled.ts`):
 *   npx tsx scripts/lib/clarice-novos-enabled.ts
 *   # → imprime "enabled" ou "disabled" (exit 0 sempre)
 *   npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled
 *   npx tsx scripts/lib/clarice-novos-enabled.ts --set disabled
 *
 * @see CLAUDE.md § tasks agendadas — Diaria-Clarice-Novos
 * @see scripts/lib/studio-chat-enabled.ts (#4078 — molde original, removido
 *      no #6942 junto com o chat do Studio)
 * @see scripts/lib/clarice-envio-enabled.ts (#5027 — mesmo padrão, sucessor vivo)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, isMainModule } from "./cli-args.ts";

export interface ClariceNovosEnabledState {
  /** `false` = default de arquivo ausente (lado seguro — ver docstring do
   * módulo). `true` = o editor liberou explicitamente o disparo automático. */
  enabled: boolean;
  /** ISO — quando o estado foi alterado pela última vez via `setClariceNovosEnabled`.
   * `null` = nunca escrito (arquivo ausente, estado no default). */
  updatedAt: string | null;
}

const DEFAULT_STATE: ClariceNovosEnabledState = { enabled: false, updatedAt: null };

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-novos-enabled.json");
}

/** Lê o estado do toggle. Fail-soft total (arquivo ausente, JSON corrompido,
 * `enabled` de tipo errado) -> `{enabled: false, updatedAt: null}` — nunca
 * lança, e o fail-soft aponta pro lado SEGURO (pausado), ao contrário de
 * `studio-chat-enabled.ts` — ver docstring do módulo pro porquê da inversão. */
export function readClariceNovosEnabledState(rootDir: string): ClariceNovosEnabledState {
  const p = statePath(rootDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ClariceNovosEnabledState>;
    if (typeof raw.enabled !== "boolean") return { ...DEFAULT_STATE };
    return {
      enabled: raw.enabled,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Atalho booleano de `readClariceNovosEnabledState` — o que
 * `clarice-novos-run.ts` de fato consulta no Passo 0. */
export function isClariceNovosEnabled(rootDir: string): boolean {
  return readClariceNovosEnabledState(rootDir).enabled;
}

/** Escreve o novo estado do toggle — único ponto de escrita deste módulo.
 * Cria `data/` se por algum motivo ainda não existir. Propaga qualquer erro
 * de escrita real (disco cheio, permissão) pro caller — mesma disciplina de
 * `setChatEnabled`: não é fail-soft como a leitura, uma falha silenciosa
 * aqui deixaria o editor achando que mudou o estado quando na verdade não
 * mudou. */
export function setClariceNovosEnabled(
  rootDir: string,
  enabled: boolean,
  opts: { now?: () => Date } = {},
): ClariceNovosEnabledState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  const state: ClariceNovosEnabledState = { enabled, updatedAt: now().toISOString() };
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const setArg = getArg(process.argv.slice(2), "set");
  if (setArg === "enabled" || setArg === "disabled") {
    const state = setClariceNovosEnabled(process.cwd(), setArg === "enabled");
    console.log(state.enabled ? "enabled" : "disabled");
  } else {
    console.log(isClariceNovosEnabled(process.cwd()) ? "enabled" : "disabled");
  }
}
