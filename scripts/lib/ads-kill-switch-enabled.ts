/**
 * ads-kill-switch-enabled.ts (#5239)
 *
 * Toggle explícito "pausa automática ligada/desligada" do kill switch por
 * custo das campanhas de anúncio (`scripts/ads-kill-switch-alarm.ts`) —
 * mesmo molde de `scripts/lib/clarice-novos-enabled.ts` (#4941), com o
 * MESMO default seguro: `enabled: false` de arquivo ausente.
 *
 * Este toggle controla só a EXECUÇÃO da pausa — o ALARME (e-mail + issue de
 * alarme) dispara sempre, independente deste estado (checklist da issue
 * #5239: "alarme por e-mail sempre, tenha pausado ou não"). Mesmo com o
 * toggle em `enabled: true`, `ads-kill-switch-alarm.ts` só tenta a pausa se
 * a flag `--execute-pause` também for passada explicitamente na invocação —
 * dupla trava deliberada (persistida + por invocação), e mesmo assim o
 * único executor exportado por `ads-kill-switch.ts`
 * (`notWiredPauseExecutor`) nunca toca nenhuma API paga de verdade (ver
 * docstring daquele módulo).
 *
 * Estado persistido em `data/ads-kill-switch-enabled.json` — arquivo NOVO e
 * dedicado, nunca reaproveita nenhum estado já existente sob `data/`.
 *
 * Uso CLI (mesmo padrão de `clarice-novos-enabled.ts`):
 *   npx tsx scripts/lib/ads-kill-switch-enabled.ts
 *   # → imprime "enabled" ou "disabled" (exit 0 sempre)
 *   npx tsx scripts/lib/ads-kill-switch-enabled.ts --set enabled
 *   npx tsx scripts/lib/ads-kill-switch-enabled.ts --set disabled
 *
 * @see scripts/lib/clarice-novos-enabled.ts (#4941 — molde original)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, isMainModule } from "./cli-args.ts";

export interface AdsKillSwitchEnabledState {
  /** `false` = default de arquivo ausente (lado seguro). `true` = o editor
   *  liberou explicitamente a EXECUÇÃO da pausa (ainda sujeita à flag
   *  `--execute-pause` por invocação — ver docstring do módulo). */
  enabled: boolean;
  /** ISO — quando o estado foi alterado pela última vez via
   *  `setAdsKillSwitchEnabled`. `null` = nunca escrito. */
  updatedAt: string | null;
}

const DEFAULT_STATE: AdsKillSwitchEnabledState = { enabled: false, updatedAt: null };

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "ads-kill-switch-enabled.json");
}

/** Lê o estado do toggle. Fail-soft total (arquivo ausente, JSON corrompido,
 *  `enabled` de tipo errado) -> `{enabled: false, updatedAt: null}` — nunca
 *  lança, e o fail-soft aponta pro lado SEGURO (pausa desligada). */
export function readAdsKillSwitchEnabledState(rootDir: string): AdsKillSwitchEnabledState {
  const p = statePath(rootDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AdsKillSwitchEnabledState>;
    if (typeof raw.enabled !== "boolean") return { ...DEFAULT_STATE };
    return {
      enabled: raw.enabled,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Atalho booleano — o que `ads-kill-switch-alarm.ts` de fato consulta
 *  antes de sequer considerar chamar o executor de pausa. */
export function isAdsKillSwitchEnabled(rootDir: string): boolean {
  return readAdsKillSwitchEnabledState(rootDir).enabled;
}

/** Escreve o novo estado do toggle — único ponto de escrita deste módulo.
 *  Propaga qualquer erro de escrita real (disco cheio, permissão) pro
 *  caller — não é fail-soft como a leitura: uma falha silenciosa aqui
 *  deixaria o editor achando que mudou o estado quando na verdade não
 *  mudou. */
export function setAdsKillSwitchEnabled(
  rootDir: string,
  enabled: boolean,
  opts: { now?: () => Date } = {},
): AdsKillSwitchEnabledState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  const state: AdsKillSwitchEnabledState = { enabled, updatedAt: now().toISOString() };
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const setArg = getArg(process.argv.slice(2), "set");
  if (setArg === "enabled" || setArg === "disabled") {
    const state = setAdsKillSwitchEnabled(process.cwd(), setArg === "enabled");
    console.log(state.enabled ? "enabled" : "disabled");
  } else {
    console.log(isAdsKillSwitchEnabled(process.cwd()) ? "enabled" : "disabled");
  }
}
