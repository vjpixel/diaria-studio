/**
 * test/setup-resume-social-260827-disable-preserve.test.ts
 *
 * Regressão dedicada do hotfix PR #6360 (achado ao vivo: master vermelho,
 * commit `dc558b5c` reprovando `test/scheduled-task-registration.test.ts`,
 * gate de merge de CI bloqueado pra todo PR aberto no momento).
 *
 * `scripts/overnight/setup-resume-social-260827.ps1` chamava
 * `Register-ScheduledTask -Force` sem preservar o estado `Disabled` da task
 * pré-existente — a mesma classe de bug que #3775/#3780 já corrigiram em
 * `setup-edicao-schedule.ps1` (que este teste usa como referência de
 * padrão correto). `-Force` substitui a task INTEIRA, incluindo
 * `Enabled=True`; sem o guard, re-rodar o script sobre uma task que o
 * editor desabilitou manualmente reativaria ela em silêncio.
 *
 * O guard GENÉRICO em `test/scheduled-task-registration.test.ts` (varre
 * todo `.ps1` sob `scripts/` dinamicamente) já cobre este arquivo — este
 * teste é um pin EXPLÍCITO e nomeado, documentando o script/commit exatos
 * que motivaram o fix, útil se o guard genérico for reescrito no futuro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(ROOT, "scripts/overnight/setup-resume-social-260827.ps1");

describe("setup-resume-social-260827.ps1: preserva estado Disabled apos Register-ScheduledTask -Force (#6360)", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  it("captura $Existing ANTES do Register-ScheduledTask -Force", () => {
    // Busca a INVOCAÇÃO real do cmdlet (início de linha, seguida de
    // continuação `\` ou espaço), não qualquer menção em comentário/docstring
    // — o .SYNOPSIS deste script cita "Register-ScheduledTask" em prosa (linha
    // 12), o que faria um indexOf ingênuo achar a ocorrência errada.
    const registerCallMatch = source.match(/^Register-ScheduledTask\s*`?\s*$/m);
    assert.ok(registerCallMatch, "esperava a invocação Register-ScheduledTask no início de linha");
    const registerIdx = registerCallMatch.index!;

    const existingIdx = source.indexOf("$Existing = Get-ScheduledTask");
    assert.ok(existingIdx >= 0, "esperava uma captura de $Existing via Get-ScheduledTask");
    assert.ok(
      existingIdx < registerIdx,
      "$Existing precisa ser capturado ANTES do Register-ScheduledTask -Force, senão já reflete o estado pós-Force",
    );
  });

  it("reaplica Disable-ScheduledTask quando $Existing.State era Disabled", () => {
    assert.match(
      source,
      /\$Existing[\s\S]{0,40}-eq\s+["']Disabled["']/,
      "esperava um check pós-Register do estado Disabled da task existente",
    );
    assert.match(
      source,
      /Disable-ScheduledTask\s+-TaskName\s+\$TaskName/,
      "esperava uma chamada Disable-ScheduledTask -TaskName $TaskName pra restaurar o estado perdido pelo -Force",
    );
  });
});
