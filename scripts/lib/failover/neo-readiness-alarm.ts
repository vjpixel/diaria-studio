/**
 * scripts/lib/failover/neo-readiness-alarm.ts (#12983)
 *
 * Lógica pura do alarme do `300` sobre a prontidão do Neo. O check roda no
 * Passo 0 de `/diaria-edicao` quando a sessão é no Neo e grava o resultado no
 * KV (`infra:neo-readiness`, `scripts/failover/neo-readiness.ts --record`);
 * aqui decide o que alarmar a partir da leitura dessa chave:
 *
 *   - registro ausente, corrompido, de outra máquina que não o Neo ou com mais
 *     de 7 dias: `stale` (ninguém sabe se o Neo assumiria o `300`);
 *   - registro vermelho (alguma task `critical` com falta): `red`, com as
 *     falhas comuns listadas uma vez e o resto por task. `contentSignature` é
 *     `task + id de checagem` (nunca o detalhe, que muda a cada rodada, ex.
 *     "há 5 h"), então só comenta quando o CONJUNTO de faltas muda;
 *   - o mesmo item `unverified` TRANSITÓRIO em `UNVERIFIED_STREAK_THRESHOLD`
 *     checks seguidos (Doppler deslogado, token sem resposta por rede/5xx,
 *     prazo, sync de `data/` sem sinal): `unverified`. Item com
 *     `structural: true` (Instagram sem helper, `--offline`) não conta: é
 *     limite permanente do check e abriria uma issue que nunca fecha. A contagem vive no estado do script
 *     (`updateUnverifiedStreak`), porque o KV guarda só o último check.
 *
 * Os achados são família `estado`: somem sozinhos quando a condição some, e a
 * issue fecha pelo streak de `alarm-issues.ts`.
 *
 * Falha de LEITURA do KV (rede, credencial) não vira achado nem fecha issue:
 * o script sai 1 sem tocar o estado (`unmeasured`). Registro corrompido, ao
 * contrário, conta como ausente e abre a issue `stale`.
 */

import type { AlarmFinding } from "../alarm-issues.ts";
import { isNeoMachine } from "../machine-id.ts";
import type { ReadinessRecordRead, ReadinessReport } from "./neo-readiness.ts";

export const NEO_READINESS_ALARM_CHECK = "neo-readiness";
export const NEO_READINESS_STALE_FINGERPRINT = "neo-readiness:stale";
export const NEO_READINESS_RED_FINGERPRINT = "neo-readiness:red";
export const NEO_READINESS_UNVERIFIED_FINGERPRINT = "neo-readiness:unverified";
/** Idade máxima do último check (decisão do editor, 13/11/2026). */
export const NEO_READINESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Checks seguidos com o mesmo item não verificado até virar achado. */
export const UNVERIFIED_STREAK_THRESHOLD = 4;

export type NeoReadinessAlarmVerdict = { kind: "unmeasured"; reason: string } | { kind: "measured"; findings: AlarmFinding[]; summary: string };

/** Estado do alarme entre execuções: quantos checks seguidos cada id ficou `unverified`. */
export interface UnverifiedStreakState {
  /** `checkedAt` do último check contado (o mesmo check lido 2 dias não conta 2 vezes). */
  lastCheckedAt: string | null;
  streaks: Record<string, { count: number; detail: string }>;
}

export const EMPTY_UNVERIFIED_STREAK: UnverifiedStreakState = { lastCheckedAt: null, streaks: {} };

/** Conta o check novo (se for novo): `unverified` soma 1, o resto zera. */
export function updateUnverifiedStreak(prev: UnverifiedStreakState, report: ReadinessReport): UnverifiedStreakState {
  if (prev.lastCheckedAt === report.checkedAt) return prev;
  const streaks: UnverifiedStreakState["streaks"] = {};
  for (const c of report.checks) {
    // Só os transitórios: um limite permanente (Instagram sem helper) abriria issue que nunca fecha.
    if (c.status !== "unverified" || c.structural === true) continue;
    streaks[c.id] = { count: (prev.streaks[c.id]?.count ?? 0) + 1, detail: c.detail };
  }
  return { lastCheckedAt: report.checkedAt, streaks };
}

const HOW =
  "O check roda sozinho no Passo 0 de `/diaria-edicao` quando a sessão é no Neo. " +
  "À mão, no Neo, na raiz do repo: `npx tsx scripts/failover/neo-readiness.ts --record`. " +
  "Runbook: `docs/failover-neo.md` (§ Prontidão).";

export function evaluateNeoReadinessAlarm(
  read: ReadinessRecordRead,
  now: Date,
  maxAgeMs: number = NEO_READINESS_MAX_AGE_MS,
  streak: UnverifiedStreakState = EMPTY_UNVERIFIED_STREAK,
): NeoReadinessAlarmVerdict {
  if (read.kind === "error") return { kind: "unmeasured", reason: read.error };
  const base = { check: NEO_READINESS_ALARM_CHECK, family: "estado" as const, labels: ["bug"], priority: "P2" as const };
  const stale = (why: string): NeoReadinessAlarmVerdict => ({
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
  });

  if (read.kind === "absent") return stale("nenhum check de prontidão do Neo registrado no KV");
  if (read.kind === "invalid") return stale(`registro de prontidão ilegível (${read.error})`);

  const r = read.report;
  if (!isNeoMachine(r.machineId)) return stale(`último registro de prontidão veio da máquina \`${r.machineId || "?"}\`, não do Neo`);

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
    const common = new Set(r.commonIds);
    const commonFails = r.checks.filter((c) => common.has(c.id) && c.status === "fail");
    const commonFailIds = new Set(commonFails.map((c) => c.id));
    const failing = r.tasks.filter((t) => !t.ready);
    const sig: string[] = [...commonFailIds].sort().map((id) => `*:${id}`);
    const lines: string[] = [];
    for (const t of failing) {
      const own = t.missingIds.map((id, i) => ({ id, detail: t.missing[i] ?? id })).filter((x) => !commonFailIds.has(x.id));
      for (const x of own) sig.push(`${t.name}:${x.id}`);
      lines.push(own.length ? `- \`${t.name}\`: falta ${own.map((x) => x.detail).join("; ")}` : `- \`${t.name}\`: só as falhas comuns`);
    }
    const commonBlock = commonFails.length ? `Falhas comuns (valem para todas as tasks):\n${commonFails.map((c) => `- ${c.detail}`).join("\n")}\n\n` : "";
    findings.push({
      ...base,
      fingerprint: NEO_READINESS_RED_FINGERPRINT,
      title: "Prontidão do Neo: tasks critical sem condição de rodar",
      body:
        `Check de ${r.checkedAt} (máquina \`${r.machineId}\`): ${failing.length} task(s) \`critical\` não rodariam no Neo numa queda do 300.\n\n` +
        `${commonBlock}Por task:\n${lines.join("\n")}\n\n${HOW}`,
      contentSignature: sig.sort().join("\n"),
    });
  }
  const persistent = Object.entries(streak.streaks)
    .filter(([, s]) => s.count >= UNVERIFIED_STREAK_THRESHOLD)
    .sort(([a], [b]) => a.localeCompare(b));
  if (persistent.length) {
    findings.push({
      ...base,
      fingerprint: NEO_READINESS_UNVERIFIED_FINGERPRINT,
      title: "Prontidão do Neo: itens sem verificação há vários checks",
      body:
        `${persistent.length} item(ns) ficaram "não verificado" em ${UNVERIFIED_STREAK_THRESHOLD}+ checks seguidos do Neo. ` +
        `"Não verificado" não impede \`pronto\`, então a prontidão pode estar dizendo verde sem olhar:\n\n` +
        `${persistent.map(([id, s]) => `- \`${id}\` (${s.count} checks): ${s.detail}`).join("\n")}\n\n${HOW}`,
      contentSignature: persistent.map(([id]) => id).join("\n"),
    });
  }
  const summary = findings.length ? findings.map((f) => f.title).join(" | ") : `prontidão do Neo verde, check de ${r.checkedAt}`;
  return { kind: "measured", findings, summary };
}
