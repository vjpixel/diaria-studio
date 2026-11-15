/**
 * scripts/lib/systemd-units-drift-alarm.ts (#13152)
 *
 * Lógica pura do alarme agendado de units systemd instaladas defasadas
 * (`scripts/systemd-units-drift-alarm.ts`, task
 * `Diaria-Systemd-Units-Drift-Alarm`). Recebe o resultado de
 * `collectInstalledUnitDiffs` (o mesmo de `setup-systemd-timers.ts
 * --diff-installed`, #13136) e decide se há achado, com fingerprint, assunto
 * e corpo da issue de alarme.
 *
 * Por que existe: o `--diff-installed` só rodava à mão, então uma unit
 * instalada defasada depois de um merge (`Description=`, `OnCalendar=`,
 * `SuccessExitStatus=` novos no registro) só aparecia quando alguém lembrava
 * de conferir. Medido na PR #13147: 127 units geradas, 16 com `Description=`
 * velha, 1 com `OnCalendar=` diferente e 1 sem `SuccessExitStatus=`.
 */
import { createHash } from "node:crypto";
import type { InstalledUnitDiff } from "./systemd-node-binary.ts";

export const SYSTEMD_UNITS_DRIFT_CHECK = "systemd-units-drift-alarm";

/** Teto de units listadas no corpo e de linhas por unit — o resto vira contagem. */
export const MAX_UNITS_IN_BODY = 40;
export const MAX_LINES_PER_UNIT = 8;

export interface SystemdUnitsDriftFinding {
  fingerprint: string;
  subject: string;
  body: string;
  differs: InstalledUnitDiff[];
}

/**
 * Fingerprint derivado do CONJUNTO de divergências (unit + linhas `-`/`+`,
 * ordenado): o mesmo estado reusa a issue; um rearme parcial ou um merge que
 * muda o conjunto gera fingerprint novo, e o script fecha a issue anterior
 * (`closeSupersededAlarmIssues`, mesmo desenho do `route-marker-staleness-alarm`).
 */
export function systemdUnitsDriftFingerprint(differs: readonly InstalledUnitDiff[]): string {
  const lines = differs
    .flatMap((d) => [
      ...d.onlyInstalled.map((l) => `${d.fileName}\t-\t${l}`),
      ...d.onlyGenerated.map((l) => `${d.fileName}\t+\t${l}`),
      // Mesmas linhas em ordem diferente: ainda é divergência, conta a unit.
      ...(d.onlyInstalled.length === 0 && d.onlyGenerated.length === 0 ? [`${d.fileName}\t~`] : []),
    ])
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** `null` quando nenhuma unit instalada diverge (não instalada não conta). */
export function buildSystemdUnitsDriftFinding(
  diffs: readonly InstalledUnitDiff[],
  installedDirAbs: string,
): SystemdUnitsDriftFinding | null {
  const differs = diffs.filter((d) => d.status === "differs");
  if (differs.length === 0) return null;
  const notInstalled = diffs.filter((d) => d.status === "not-installed").length;
  const same = diffs.length - differs.length - notInstalled;

  const subject = `systemd: ${differs.length} unit(s) instalada(s) diverge(m) do gerado pelo master`;
  const out: string[] = [
    `\`setup-systemd-timers.ts --diff-installed\`, rodado pela task \`Diaria-Systemd-Units-Drift-Alarm\` no checkout principal, ` +
      `encontrou ${differs.length} unit(s) em \`${installedDirAbs}\` diferente(s) do que o registro (\`scripts/lib/scheduled-tasks.ts\`) ` +
      `gera hoje (${same} igual(is), ${notInstalled} não instalada(s), ${diffs.length} no total).`,
    "",
    "`-` = instalada, `+` = gerada do master.",
    "",
  ];
  for (const d of differs.slice(0, MAX_UNITS_IN_BODY)) {
    out.push(`- \`${d.fileName}\``);
    const lines = [...d.onlyInstalled.map((l) => `- ${l}`), ...d.onlyGenerated.map((l) => `+ ${l}`)];
    if (lines.length === 0) {
      out.push("  - (mesmas linhas, ordem diferente)");
      continue;
    }
    out.push("  ```");
    for (const l of lines.slice(0, MAX_LINES_PER_UNIT)) out.push(`  ${l}`);
    if (lines.length > MAX_LINES_PER_UNIT) out.push(`  ... +${lines.length - MAX_LINES_PER_UNIT} linha(s)`);
    out.push("  ```");
  }
  if (differs.length > MAX_UNITS_IN_BODY) {
    out.push(`- ... +${differs.length - MAX_UNITS_IN_BODY} unit(s); lista completa: \`npx tsx scripts/setup-systemd-timers.ts --diff-installed\``);
  }
  out.push(
    "",
    "**Como resolver:** na `300`, do checkout principal, `npx tsx scripts/setup-systemd-timers.ts --task <Nome>` e rearmar " +
      "pela receita impressa (`buildArmInstructions`). Mudança de `OnCalendar=` dispara catch-up com `Persistent=true` " +
      "(#5140): seguir o `touch` no carimbo antes do `start`. A issue fecha sozinha quando a próxima rodada não achar divergência.",
  );
  return { fingerprint: systemdUnitsDriftFingerprint(differs), subject, body: out.join("\n"), differs };
}
