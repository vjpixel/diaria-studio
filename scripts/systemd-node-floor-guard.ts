#!/usr/bin/env node
/**
 * scripts/systemd-node-floor-guard.ts (#7522)
 *
 * CLI READ-ONLY: varre `~/.config/systemd/user/*.service` já armados e
 * reporta qualquer unit node-based cujo `ExecStart=` roda um node abaixo do
 * piso do projeto (>=22.5, `check-node-version.ts`) — a condição que deixou
 * `diaria-corrupted-names-weekly-check.service` (e mais 8 units) `failed`
 * em `helios` porque `node:sqlite` não existe no Node do sistema.
 *
 * NUNCA muta nada: não escreve em `~/.config/systemd/user/`, não chama
 * `systemctl` (nem `daemon-reload`/`enable`/`restart`). Religar os units
 * corrigidos é ação manual do editor — ver o comando de reparo impresso
 * no fim da saída quando `verdict !== "ok"`.
 *
 * Lógica pura em `scripts/lib/systemd-node-floor-guard.ts`
 * (`scanArmedUnitsNodeFloor`) — este arquivo é só apresentação + exit code.
 *
 * Uso:
 *   npx tsx scripts/systemd-node-floor-guard.ts
 *   # exit 0 + "ok" se nenhum unit node-based estiver abaixo do piso
 *   # exit 1 + tabela se algum estiver ("below-floor") ou não confirmável
 *   #   ("cannot-verify" — nunca "ok" por omissão, regra #7776)
 */
import { isMainModule } from "./lib/cli-args.ts";
import { scanArmedUnitsNodeFloor, type SystemdUnitsNodeFloorReport } from "./lib/systemd-node-floor-guard.ts";

/** Comando de reparo pronto pra colar — regenera os units a partir do
 * registro (agora com o guard de #7522 em `buildSystemdUnitFiles`, então só
 * completa se `npx tsx` já resolver pra um node >= piso) e religa. */
const REPAIR_COMMAND = [
  "# 1) Confirme que o shell que vai gerar os units resolve um node >= 22.5",
  "#    (ex: nvm use 24, ou garanta que /usr/bin/node não vem antes no PATH)",
  "node --version",
  "",
  "# 2) Regenera .service/.timer pra TODAS as tasks com o node correto",
  "npx tsx scripts/setup-systemd-timers.ts",
  "",
  "# 3) Copia os units regenerados pra cima dos armados (revisa o diff antes se quiser)",
  "cp .systemd-units/*.service .systemd-units/*.timer ~/.config/systemd/user/",
  "",
  "# 4) Recarrega o daemon e reinicia as units que estavam quebradas",
  "systemctl --user daemon-reload",
  "systemctl --user reset-failed",
  "# repita --now por unit que precisa voltar a rodar imediatamente, ex:",
  "# systemctl --user restart diaria-corrupted-names-weekly-check.service",
].join("\n");

export function formatReport(report: SystemdUnitsNodeFloorReport): string {
  const lines: string[] = [];
  lines.push(`veredito geral: ${report.verdict}`);
  if (report.detail) lines.push(report.detail);
  if (report.units.length === 0) {
    lines.push("(nenhum unit node-based encontrado em ~/.config/systemd/user/)");
  } else {
    lines.push("");
    for (const u of report.units) {
      const versionInfo = u.nodeVersion ? ` (${u.nodeVersion})` : "";
      lines.push(`  [${u.verdict}] ${u.unitFileName}${versionInfo}`);
      if (u.detail) lines.push(`      ${u.detail}`);
    }
  }
  if (report.verdict === "below-floor") {
    lines.push("");
    lines.push("Comando de reparo (ação MANUAL do editor — este guard não muta systemd):");
    lines.push(REPAIR_COMMAND);
  }
  return lines.join("\n");
}

export function main(): number {
  const report = scanArmedUnitsNodeFloor();
  console.log(formatReport(report));
  return report.verdict === "ok" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
