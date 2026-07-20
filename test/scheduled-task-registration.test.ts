/**
 * test/scheduled-task-registration.test.ts (#3560, generalizado #3764)
 *
 * Regressão: `Set-ScheduledTask` NÃO tem o parâmetro `-Description` — só
 * `Register-ScheduledTask` tem. Vários scripts de setup de task (tunnel do
 * Studio, watchdog overnight, sync Clarice, edição agendada) chegaram a
 * fazer `Set-ScheduledTask ... -Description` no branch de "task já existe",
 * o que falhava com "NamedParameterNotFound,Set-ScheduledTask" ao re-rodar
 * o script sobre uma task já registrada (erro observado 260720 ao reiniciar
 * o tunnel do Studio — #3757 corrigiu 3 scripts; #3764 achou o MESMO bug
 * intocado em outros 2, porque a suíte original só cobria uma lista fixa de
 * arquivos).
 *
 * A correção troca o if/else por um único `Register-ScheduledTask -Force`
 * (idempotente: cria ou sobrescreve, e aceita -Description). Este teste trava
 * a regressão de forma estática e GENÉRICA: varre TODO `.ps1` sob `scripts/`
 * (não uma lista fixa — #3764 Rec do fix sugerido, pra não reabrir o mesmo
 * gap se um script futuro reintroduzir o padrão) e reprova qualquer
 * invocação de `Set-ScheduledTask` que carregue `-Description` (mesmo com
 * continuação de linha via backtick).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

/** Lista .ps1 recursivamente sob um diretório (mesmo padrão de test/ps1-bom-or-ascii-invariant.test.ts). */
function ps1FilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...ps1FilesUnder(full));
    else if (name.toLowerCase().endsWith(".ps1")) out.push(full);
  }
  return out;
}

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

describe("setup de scheduled task: nunca Set-ScheduledTask -Description (#3560, #3764)", () => {
  const ps1Files = ps1FilesUnder(SCRIPTS_DIR);

  it("sanity: encontrou pelo menos 1 arquivo .ps1 (senão o scan está quebrado)", () => {
    assert.ok(
      ps1Files.length > 0,
      `nenhum .ps1 encontrado sob ${SCRIPTS_DIR} — scan de descoberta quebrado ` +
        `(este teste deixaria de proteger silenciosamente).`,
    );
  });

  for (const file of ps1Files) {
    const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
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

    // Só scripts que de fato registram tasks (chamam Register-ScheduledTask)
    // precisam do padrão idempotente -Description ... -Force — scripts que
    // só EXECUTAM uma task já registrada (runners) não chamam esse cmdlet.
    const registersTask = lines.some((l) => /Register-ScheduledTask\b/.test(l));
    if (registersTask) {
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
  }
});

describe("setup de scheduled task: preserva estado Disabled após Register-ScheduledTask -Force (#3775, estendido #3780)", () => {
  // Register-ScheduledTask -Force substitui a task INTEIRA (ao contrário de
  // Set-ScheduledTask, que só atualiza os campos passados) — qualquer
  // propriedade não especificada na chamada volta ao default, incluindo
  // Enabled=True. Verificado empiricamente (260720): desabilitar a task via
  // Disable-ScheduledTask e re-rodar o branch de update com
  // Register-ScheduledTask -Force reativa a task silenciosamente, sem log
  // nem aviso — desfazendo um Disable manual do editor.
  //
  // #3775 corrigiu 2 scripts (setup-clarice-sync-schedule.ps1,
  // setup-edicao-schedule.ps1). #3780 estendeu o MESMO fix aos 3 scripts
  // originalmente corrigidos pelo #3757 (Set-ScheduledTask -Description ->
  // Register-ScheduledTask -Force) que tinham o mesmo bug latente:
  // setup-studio-service.ps1, setup-remote-tunnel.ps1,
  // setup-watchdog-schedule.ps1. Todos os 5 scripts de registro de task do
  // repo agora cobertos.
  const FIXED_FILES = [
    "scripts/setup-clarice-sync-schedule.ps1",
    "scripts/overnight/setup-edicao-schedule.ps1",
    "scripts/studio/setup-studio-service.ps1",
    "scripts/studio/setup-remote-tunnel.ps1",
    "scripts/overnight/setup-watchdog-schedule.ps1",
  ];

  for (const rel of FIXED_FILES) {
    const file = join(ROOT, ...rel.split("/"));
    const source = readFileSync(file, "utf8");
    const lines = logicalLines(source);

    it(`${rel}: reaplica Disable-ScheduledTask quando a task existente estava Disabled`, () => {
      const registerIdx = lines.findIndex(
        (l) => /Register-ScheduledTask\b/.test(l) && /-Force\b/.test(l),
      );
      assert.ok(registerIdx >= 0, "esperava um Register-ScheduledTask ... -Force no script");

      const after = lines.slice(registerIdx + 1).join("\n");
      assert.match(
        after,
        /\$Existing[\s\S]{0,40}-eq\s+["']Disabled["']/,
        "esperava um check pós-Register do estado Disabled da task existente ($Existing.State -eq \"Disabled\")",
      );
      assert.match(
        after,
        /Disable-ScheduledTask\s+-TaskName\s+\$TaskName/,
        "esperava uma chamada Disable-ScheduledTask -TaskName $TaskName pra restaurar o estado Disabled perdido pelo -Force",
      );
    });
  }
});
