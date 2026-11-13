/**
 * scripts/lib/failover/neo-readiness-alarm.ts (#12983)
 *
 * Lógica pura do alarme do `300` sobre a prontidão do Neo. O check roda no
 * Passo 0 de `/diaria-edicao` quando a sessão é no Neo e grava o resultado no
 * KV (`infra:neo-readiness`, `scripts/failover/neo-readiness.ts --record`);
 * aqui decide o que alarmar a partir da leitura dessa chave:
 *
 *   - registro ausente ou com mais de 7 dias: `stale` (o Neo não roda o check
 *     há uma semana, então ninguém sabe se ele assumiria o `300`);
 *   - registro vermelho (alguma task `critical` com falta): `red`, com a lista
 *     do que falta no corpo (`contentSignature` comenta quando a lista muda);
 *   - registro ilegível (JSON quebrado): `stale` também, com o motivo.
 *
 * Os dois achados são família `estado`: somem sozinhos no próximo check verde
 * e recente, e a issue fecha pelo streak de `alarm-issues.ts`.
 *
 * Falha de LEITURA do KV (rede, credencial) não vira achado nem fecha issue:
 * o script sai 1 sem tocar o estado (`unmeasured`).
 */

import type { AlarmFinding } from "../alarm-issues.ts";
import type { ReadinessRecordRead } from "./neo-readiness.ts";

export const NEO_READINESS_ALARM_CHECK = "neo-readiness";
export const NEO_READINESS_STALE_FINGERPRINT = "neo-readiness:stale";
export const NEO_READINESS_RED_FINGERPRINT = "neo-readiness:red";
/** Idade máxima do último check (decisão do editor, 13/11/2026). */
export const NEO_READINESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type NeoReadinessAlarmVerdict = { kind: "unmeasured"; reason: string } | { kind: "measured"; findings: AlarmFinding[]; summary: string };

const HOW =
  "O check roda sozinho no Passo 0 de `/diaria-edicao` quando a sessão é no Neo. " +
  "À mão, no Neo, na raiz do repo: `npx tsx scripts/failover/neo-readiness.ts --record`. " +
  "Runbook: `docs/failover-neo.md` (§ Prontidão).";

export function evaluateNeoReadinessAlarm(read: ReadinessRecordRead, now: Date, maxAgeMs: number = NEO_READINESS_MAX_AGE_MS): NeoReadinessAlarmVerdict {
  if (read.kind === "error") return { kind: "unmeasured", reason: read.error };
  const base = { check: NEO_READINESS_ALARM_CHECK, family: "estado" as const, labels: ["bug"], priority: "P2" as const };

  if (read.kind === "absent" || read.kind === "invalid") {
    const why = read.kind === "absent" ? "nenhum check de prontidão do Neo registrado no KV" : `registro de prontidão ilegível (${read.error})`;
    return {
      kind: "measured",
      summary: why,
      findings: [
        {
          ...base,
          fingerprint: NEO_READINESS_STALE_FINGERPRINT,
          title: "Prontidão do Neo: sem check recente",
          body: `${why} (chave \`infra:neo-readiness\`, KV \`diaria-ops-state\`). Sem ele, ninguém sabe se o Neo assumiria o 300 numa queda (#12983).\n\n${HOW}`,
        },
      ],
    };
  }

  const r = read.report;
  const ageMs = now.getTime() - Date.parse(r.checkedAt);
  const ageDays = Math.floor(ageMs / 86_400_000);
  const findings: AlarmFinding[] = [];
  if (ageMs > maxAgeMs) {
    findings.push({
      ...base,
      fingerprint: NEO_READINESS_STALE_FINGERPRINT,
      title: "Prontidão do Neo: último check com mais de 7 dias",
      body:
        `O último check de prontidão do Neo é de ${r.checkedAt} (${ageDays} dias). ` +
        `Acima de 7 dias o resultado não diz mais se o Neo assumiria o 300 numa queda (#12983).\n\n${HOW}`,
    });
  }
  if (!r.ok) {
    const lines = r.tasks.filter((t) => !t.ready).map((t) => `- \`${t.name}\`: falta ${t.missing.join("; ")}`);
    findings.push({
      ...base,
      fingerprint: NEO_READINESS_RED_FINGERPRINT,
      title: "Prontidão do Neo: tasks critical sem condição de rodar",
      body:
        `Check de ${r.checkedAt} (máquina \`${r.machineId || "?"}\`): ${lines.length} task(s) \`critical\` não rodariam no Neo numa queda do 300.\n\n` +
        `${lines.join("\n")}\n\n${HOW}`,
      contentSignature: lines.join("\n"),
    });
  }
  const summary = findings.length ? findings.map((f) => f.title).join(" | ") : `prontidão do Neo verde, check de ${r.checkedAt}`;
  return { kind: "measured", findings, summary };
}
