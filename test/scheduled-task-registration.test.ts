/**
 * test/scheduled-task-registration.test.ts (#3560)
 *
 * Regressão: `Set-ScheduledTask` NÃO tem o parâmetro `-Description` — só
 * `Register-ScheduledTask` tem. Os scripts de setup de task (tunnel do Studio e
 * watchdog overnight) chegaram a fazer `Set-ScheduledTask ... -Description` no
 * branch de "task já existe", o que falhava com
 * "NamedParameterNotFound,Set-ScheduledTask" ao re-rodar o script sobre uma task
 * já registrada (erro observado 260720 ao reiniciar o tunnel do Studio).
 *
 * A correção troca o if/else por um único `Register-ScheduledTask -Force`
 * (idempotente: cria ou sobrescreve, e aceita -Description). Este teste trava a
 * regressão de forma estática: qualquer invocação de `Set-ScheduledTask` que
 * carregue `-Description` (mesmo com continuação de linha via backtick) reprova.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPTS = [
  "../scripts/studio/setup-remote-tunnel.ps1",
  "../scripts/studio/setup-studio-service.ps1",
  "../scripts/overnight/setup-watchdog-schedule.ps1",
];

/**
 * Junta continuações de linha do PowerShell (backtick no fim da linha) para que
 * uma invocação multi-linha vire uma única string, e retorna a lista de
 * "comandos lógicos" do script.
 */
function logicalLines(source: string): string[] {
  return source
    .replace(/`\r?\n\s*/g, " ") // colapsa continuações `<newline>
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l)); // descarta linhas de comentário
}

describe("setup de scheduled task (#3560)", () => {
  for (const rel of SCRIPTS) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    const source = readFileSync(path, "utf8");
    const lines = logicalLines(source);

    it(`${rel}: nunca chama Set-ScheduledTask com -Description`, () => {
      const offenders = lines.filter(
        (l) => /Set-ScheduledTask\b/.test(l) && /-Description\b/.test(l),
      );
      assert.deepEqual(
        offenders,
        [],
        `Set-ScheduledTask não aceita -Description; use Register-ScheduledTask -Force. Ofensores:\n${offenders.join("\n")}`,
      );
    });

    it(`${rel}: registra a task com -Description via Register-ScheduledTask -Force`, () => {
      const register = lines.find(
        (l) =>
          /Register-ScheduledTask\b/.test(l) &&
          /-Description\b/.test(l) &&
          /-Force\b/.test(l),
      );
      assert.ok(
        register,
        "esperava um Register-ScheduledTask -Description ... -Force (idempotente) no script",
      );
    });
  }
});
