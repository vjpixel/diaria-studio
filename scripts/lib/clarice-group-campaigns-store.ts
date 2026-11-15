/**
 * scripts/lib/clarice-group-campaigns-store.ts (#13098, extraído no #13135)
 *
 * Leitura e escrita MESCLADA do registro `{ciclo}/segments/group-campaigns.json`.
 *
 * Uma invocação lê o registro no início e regrava o array INTEIRO no fim (no
 * `clarice-schedule-group.ts --send-now`, depois de um poll de até ~15 min; no
 * `clarice-envio-guard.ts`, depois dos PUTs de suspensão). Duas invocações no
 * mesmo ciclo apagariam uma a entrada da outra; o guard das 05:00 depende da
 * entrada da onda do dia. Cada escrita relê o disco sob trava e só aplica as
 * entradas que ESTA invocação mudou desde a leitura (ou criou). O registro
 * nunca remove entradas, então o que está no disco e não mudou aqui fica.
 *
 * Todo writer de `group-campaigns.json` passa por `writeGroupCampaignsMerged`
 * (ou, para uma reescrita pontual sob a mesma trava, `withGroupCampaignsLock`).
 * `test/clarice-group-campaigns-writers-13135.test.ts` lista os writers e
 * reprova um writer novo que grave o arquivo por fora deste módulo.
 *
 * Fica em `lib/` (e não em `clarice-schedule-group.ts`, onde nasceu) para o
 * guard das 05:00 não importar o grafo inteiro do script de agendamento.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";

/** O mínimo que a mescla precisa: a identidade de uma entrada do registro. */
export interface GroupCampaignKeyed {
  key: string;
  campaignId: number;
}

/** Retrato do que esta invocação leu (ou gravou por último), por path absoluto. */
const groupCampaignsBaseline = new Map<string, GroupCampaignKeyed[]>();

const sameCampaign = (a: GroupCampaignKeyed, b: GroupCampaignKeyed): boolean =>
  a.key === b.key && a.campaignId === b.campaignId;

/**
 * Lê o registro SEM registrar o retrato. Ausente = `[]` (1º envio do ciclo);
 * JSON inválido lança (nunca cai num `[]` silencioso).
 */
export function readGroupCampaignsRaw<T extends GroupCampaignKeyed>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T[];
  } catch (e) {
    throw new Error(`group-campaigns.json corrompido (JSON inválido): ${path}\n${String(e)}`);
  }
}

/** Lê o registro e guarda o retrato desta leitura, base da escrita mesclada. */
export function readGroupCampaignsTracked<T extends GroupCampaignKeyed>(path: string): T[] {
  const parsed = readGroupCampaignsRaw<T>(path);
  groupCampaignsBaseline.set(resolve(path), structuredClone(parsed));
  return parsed;
}

/**
 * Pura: `onDisk` mais as entradas de `current` que diferem de `baseline`
 * (mesma `key` + `campaignId`) ou que não existiam nele. A entrada mudada
 * substitui a do disco na mesma posição; a nova vai para o fim.
 */
export function mergeGroupCampaigns<T extends GroupCampaignKeyed>(
  baseline: readonly T[],
  current: readonly T[],
  onDisk: readonly T[],
): T[] {
  const merged = onDisk.map((e) => ({ ...e }));
  for (const cur of current) {
    const base = baseline.find((b) => sameCampaign(b, cur));
    if (base && JSON.stringify(base) === JSON.stringify(cur)) continue;
    const i = merged.findIndex((d) => sameCampaign(d, cur));
    if (i >= 0) merged[i] = { ...cur };
    else merged.push({ ...cur });
  }
  return merged;
}

/** Pura: entradas do `baseline` que não estão mais no disco (o registro
 * nunca remove; sumir é edição à mão ou arquivo trocado). */
export function baselineEntriesMissingFromDisk<T extends GroupCampaignKeyed>(
  baseline: readonly T[],
  onDisk: readonly T[],
): T[] {
  return baseline.filter((b) => !onDisk.some((d) => sameCampaign(d, b)));
}

/** Trava da escrita do registro (`file-lock.ts`, seção crítica curta). */
export function withGroupCampaignsLock<T>(path: string, fn: (abs: string) => T): T {
  const abs = resolve(path);
  return withFileLock(`${abs}.lock`, () => fn(abs));
}

/** Escreve `content` (o array desta invocação) no registro, mesclado com o
 * disco sob trava. Sem leitura rastreada antes, o retrato é `[]` e toda
 * entrada de `content` conta como mudada (nada do disco é perdido). */
export function writeGroupCampaignsMerged(
  path: string,
  content: string,
  logFn: (msg: string) => void = (m) => console.error(m),
): void {
  const current = JSON.parse(content) as GroupCampaignKeyed[];
  const abs = withGroupCampaignsLock(path, (absPath) => {
    const baseline = groupCampaignsBaseline.get(absPath) ?? [];
    const onDisk = readGroupCampaignsRaw(absPath);
    for (const gone of baselineEntriesMissingFromDisk(baseline, onDisk)) {
      logFn(
        `⚠ group-campaigns.json: a entrada ${gone.key} (campanha #${gone.campaignId}) lida no início sumiu do disco ` +
          `(edição à mão ou arquivo trocado?) — ` +
          (current.some((c) => sameCampaign(c, gone)) ? "regravada a partir desta invocação." : "mantida fora."),
      );
    }
    writeFileAtomic(absPath, JSON.stringify(mergeGroupCampaigns(baseline, current, onDisk), null, 2));
    return absPath;
  });
  groupCampaignsBaseline.set(abs, structuredClone(current));
}
