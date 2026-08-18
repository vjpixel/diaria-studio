/**
 * test/scheduled-task-registration.test.ts (#3560, generalizado #3764,
 * restaurado #5616 após o cutover #5115/#5162 ter deletado este arquivo como
 * efeito colateral de deletar os 40 `.ps1` legados — não porque os 3
 * invariantes abaixo pararam de valer. Restaurado de `bf6f6571^` e adaptado:
 * a 2ª suíte (Disable-ScheduledTask pós -Force) usava uma lista fixa de 5
 * arquivos que o cutover apagou; agora deriva dinamicamente de quais `.ps1`
 * sob `scripts/` de fato chamam `Register-ScheduledTask ... -Force`, então
 * cobre os 2 `.ps1` reintroduzidos pelo #5611 e qualquer um futuro sem
 * precisar editar este arquivo de novo.
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
  // #3775 corrigiu 2 scripts, #3780 estendeu o mesmo fix a mais 3 (lista
  // fixa original — apagada pelo cutover #5115/#5162 junto com os arquivos).
  // Restaurado (#5616) como derivação DINÂMICA sobre todo `.ps1` sob
  // `scripts/`: qualquer script que registre task via
  // `Register-ScheduledTask ... -Force` precisa do mesmo guard, sem depender
  // de listar arquivos à mão.
  const ps1Files = ps1FilesUnder(SCRIPTS_DIR);
  const registersWithForce = ps1Files.filter((file) => {
    const lines = logicalLines(readFileSync(file, "utf8"));
    return lines.some((l) => /Register-ScheduledTask\b/.test(l) && /-Force\b/.test(l));
  });

  it("sanity: pelo menos 1 .ps1 registra task via Register-ScheduledTask -Force", () => {
    assert.ok(
      registersWithForce.length > 0,
      "nenhum .ps1 encontrado chamando Register-ScheduledTask -Force — scan quebrado " +
        "(este teste deixaria de proteger silenciosamente).",
    );
  });

  for (const file of registersWithForce) {
    const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
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

/**
 * #4155 — sintaxe do trigger de repetição.
 *
 * `setup-clarice-guardrail-alarm-schedule.ps1` (gerado pelo #4131) tinha DOIS
 * erros que impediam o registro da task, e portanto deixavam o alarme de
 * guardrail do #4064 permanentemente desarmado — em silêncio, já que nada
 * mais checava a existência da task:
 *
 *   1. `New-ScheduledTaskTrigger -Once (Get-Date) ...` — `-Once` é SWITCH e
 *      não aceita valor posicional; o instante inicial vai em `-At`. Falha com
 *      "Não é possível localizar um parâmetro posicional que aceite o
 *      argumento '<data>'".
 *   2. `-RepetitionDuration ([TimeSpan]::MaxValue)` — serializa para
 *      `P99999999DT23H59M59S`, que o Task Scheduler recusa no XML
 *      (HRESULT 0x80041318). Repetição indefinida se obtém OMITINDO o
 *      parâmetro.
 *
 * Por que estático e genérico: os dois erros só aparecem ao EXECUTAR, e o
 * guard de publicação da rodada overnight proíbe executar — corretamente.
 * Então a rede tem que ser um teste que varre todo `.ps1` sob `scripts/`,
 * como os demais invariantes deste arquivo.
 */
describe("#4155 — New-ScheduledTaskTrigger: sintaxe que impede o registro", () => {
  const files = ps1FilesUnder(SCRIPTS_DIR);

  it("há .ps1 sob scripts/ para varrer", () => {
    assert.ok(files.length > 0, "esperava ao menos um .ps1 sob scripts/");
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).split("\\").join("/");
    const lines = logicalLines(readFileSync(file, "utf8"));

    for (const line of lines) {
      if (!/New-ScheduledTaskTrigger\b/.test(line)) continue;

      it(`${rel}: -Once não recebe valor posicional (usa -At)`, () => {
        // Reprova `-Once <algo>` onde <algo> não é outro parâmetro (-Xxx).
        assert.doesNotMatch(
          line,
          /-Once\s+(?!-)\S/,
          `-Once é switch: o instante inicial vai em -At (ex: -Once -At (Get-Date)). Linha: ${line.trim()}`,
        );
      });

      it(`${rel}: -RepetitionDuration não usa [TimeSpan]::MaxValue`, () => {
        assert.doesNotMatch(
          line,
          /-RepetitionDuration\s+\(?\[TimeSpan\]::MaxValue\)?/i,
          `[TimeSpan]::MaxValue vira P99999999DT23H59M59S e o Task Scheduler recusa. Para repetição indefinida, OMITA -RepetitionDuration. Linha: ${line.trim()}`,
        );
      });
    }
  }
});

// Nota (#5616, restauração): os dois `describe` originais aqui (horário do
// `setup-clarice-sync-schedule.ps1` pós-#3682 e do
// `setup-evaluate-brevo-diaria-schedule.ps1` pós-#4534) foram omitidos na
// restauração — os `.ps1` que testavam continuam removidos pelo cutover
// #5115/#5162 (migrados para systemd) e não foram reintroduzidos pelo #5611.
// Testes file-specific contra arquivo ausente quebrariam com ENOENT sem
// proteger nada; os 3 invariantes GENÉRICOS acima (que é o escopo desta
// restauração) já cobrem os `.ps1` que existem hoje e qualquer um futuro.
// Se `setup-clarice-sync-schedule.ps1`/`setup-evaluate-brevo-diaria-schedule.ps1`
// (ou equivalentes) voltarem a existir como `.ps1`, recuperar estes dois
// blocos de `bf6f6571^:test/scheduled-task-registration.test.ts`.
