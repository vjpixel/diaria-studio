/**
 * scripts/lib/clarice-envio-last-brake.ts (#5220)
 *
 * Sidecar JSON gravado por `clarice-envio-run.ts` (19:00 BRT) toda vez que
 * consegue LER o freio fresco (`clarice-envio-risk.ts`) com sucesso —
 * registra o que a rodada da NOITE viu, pra servir de FALLBACK pro guard
 * das 05:00 (`clarice-envio-guard.ts`) no dia em que os pré-requisitos dele
 * (`clarice-plan-wave`/`clarice-envio-risk`) falharem mesmo após retry: sem
 * conseguir reavaliar o freio com dado fresco, o guard cai pro último freio
 * CONHECIDO, lido DAQUI — nunca reconsultando a Brevo, que é justamente a
 * fonte que já falhou (decisão do editor #5220).
 *
 * Convenção de nome espelha o relatório markdown do mesmo dia:
 * `data/clarice-subscribers/envio-reports/envio-{aammdd}-brake.json`,
 * `{aammdd}` = dia-calendário BRT em que `clarice-envio-run.ts` RODOU (19:00
 * de ontem, relativo ao guard de hoje de manhã — mesma matemática de
 * `now - 24h` já usada pra resolver o ciclo em `clarice-envio-guard.ts`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import type { BrakeDecision } from "./clarice-envio-policy.ts";

export interface LastBrakeSnapshot {
  brake: BrakeDecision["level"];
  reasons: string[];
  recordedAt: string;
}

function brakeSnapshotPath(rootDir: string, aammdd: string): string {
  return resolve(rootDir, "data", "clarice-subscribers", "envio-reports", `envio-${aammdd}-brake.json`);
}

export function writeLastBrakeSnapshot(rootDir: string, aammdd: string, brake: BrakeDecision, recordedAt: string): void {
  const dir = resolve(rootDir, "data", "clarice-subscribers", "envio-reports");
  mkdirSync(dir, { recursive: true });
  const snapshot: LastBrakeSnapshot = { brake: brake.level, reasons: [...brake.reasons], recordedAt };
  writeFileAtomic(brakeSnapshotPath(rootDir, aammdd), JSON.stringify(snapshot, null, 2));
}

/**
 * `null` — ausente OU ilegível, tratados IGUAL pelo chamador (guard):
 * decisão do editor #5220, "ausente ou ilegível conta como não-ok" —
 * fail-closed. `onInvalid` (opcional) avisa que era CORRUPÇÃO, não ausência
 * normal (mesmo padrão de `readCampaignEntries` em `clarice-envio-guard.ts`)
 * — ausência (arquivo nunca existiu, ex: 1ª rodada, ou o run de ontem
 * abortou antes de conseguir ler o risco) permanece silenciosa, é o caso
 * normal.
 */
export function readLastBrakeSnapshot(
  rootDir: string,
  aammdd: string,
  onInvalid?: (msg: string) => void,
): LastBrakeSnapshot | null {
  const p = brakeSnapshotPath(rootDir, aammdd);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as LastBrakeSnapshot).brake === "string" &&
      Array.isArray((parsed as LastBrakeSnapshot).reasons) &&
      typeof (parsed as LastBrakeSnapshot).recordedAt === "string"
    ) {
      return parsed as LastBrakeSnapshot;
    }
    onInvalid?.(`⚠️  ${p} existe mas tem shape inesperado — tratando como ILEGÍVEL (fail-closed).`);
    return null;
  } catch (e) {
    onInvalid?.(`⚠️  ${p} existe mas não deu pra ler/parsear (${(e as Error).message}) — tratando como ILEGÍVEL (fail-closed).`);
    return null;
  }
}
