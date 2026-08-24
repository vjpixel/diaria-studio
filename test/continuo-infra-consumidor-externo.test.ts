/**
 * test/continuo-infra-consumidor-externo.test.ts (#6056)
 *
 * Guard de regressão contra a classe de erro do #6056/#6059/#6060: remover a
 * infra do kind `continuo` deste repo tratando-a como código morto.
 *
 * Ela NÃO é morta — o `helios` roda um cron do Claude Code
 * (`cronjob 7089586af6cb`, `every 60m`, `workdir=/home/vjpixel/diaria-studio`)
 * que invoca a skill LOCAL `hermes-diaria-continuo` (mora em `~/.claude/skills/`
 * do `helios`, fora deste repo) DENTRO deste checkout, consumindo tudo que este
 * teste tranca. Nenhuma skill DESTE repo usa o kind hoje, então a infra parece
 * órfã pra qualquer varredura de higiene — foi exatamente essa leitura que
 * quebrou o loop de produção no #6059.
 *
 * Por que um teste e não só a linha no `CLAUDE.md` (que também existe, seção
 * "Princípios operacionais invariáveis"): o `knip` é estruturalmente cego a
 * este caso — o #6059 deletou a infra E os testes dela na mesma PR, de forma
 * simétrica, então nunca sobrou export órfão pra ele apontar. Um teste que
 * falha alto em CI é o único guard que dispara independente de quem está
 * lendo o quê. Mesmo espírito de `test/hub-registry-completeness.test.ts`
 * (#4558 Parte A): cruzar duas pontas mantidas separadamente, falhar quando
 * uma some.
 *
 * **Se você chegou aqui porque este teste falhou:** não "conserte" deletando o
 * teste. Vá ler a `hermes-diaria-continuo` no `helios` primeiro e confirme que
 * o consumidor externo morreu de verdade — só então remova o par (infra +
 * este teste) numa PR que explique isso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { requireKind } from "../scripts/lib/session-registry.ts";
import { COORDINATOR_KINDS } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Arquivos que a `hermes-diaria-continuo` invoca direto. Deletar qualquer um
 * quebra o loop dela no ciclo seguinte ao `git pull` (o passo 0 dela sincroniza
 * o master).
 */
const ARQUIVOS_CONSUMIDOS_PELO_HERMES = [
  "scripts/lib/continuo-plan-rotation.ts",
  "scripts/continuo-cost-summary.ts",
  "scripts/check-continuo-token-instrumentation.ts",
  ".claude/hooks/notify-continuo-askuserquestion.mjs",
];

describe("infra do kind continuo tem consumidor externo (#6056/#6059/#6060)", () => {
  it('requireKind aceita "continuo" — sem isso, register/heartbeat/claim-issue/end do hermes saem com exit 1', () => {
    assert.equal(requireKind("continuo"), "continuo");
  });

  for (const arquivo of ARQUIVOS_CONSUMIDOS_PELO_HERMES) {
    it(`${arquivo} existe — invocado pela hermes-diaria-continuo no helios`, () => {
      assert.ok(
        existsSync(join(ROOT, arquivo)),
        `${arquivo} sumiu. Ver o cabeçalho deste teste antes de remover: ele é ` +
          "consumido por uma skill que não vive neste repo.",
      );
    });
  }

  it("o hook notify-continuo-askuserquestion continua registrado em .claude/settings.json", () => {
    // O arquivo existir não basta: se ele sair do array de PreToolUse, o hermes
    // trava num AskUserQuestion pendente sem notificar ninguém — o watchdog não
    // cobre esse caso (WATCHED_KINDS não inclui `continuo` desde o #5390).
    const settings = readFileSync(join(ROOT, ".claude", "settings.json"), "utf8");
    assert.ok(
      settings.includes("notify-continuo-askuserquestion.mjs"),
      "hook removido de .claude/settings.json — o hermes perde a notificação de pergunta pendente.",
    );
  });

  it("COORDINATOR_KINDS do guard de merge inclui continuo — senão subagentes do hermes mergeiam sem guarda", () => {
    // Importado, não lido como texto: uma reformatação legítima do hook (quebra
    // de linha, extração da constante pra um módulo comum) não deve derrubar
    // este guard — só a remoção real do kind deve.
    assert.ok(
      COORDINATOR_KINDS.has("continuo"),
      'COORDINATOR_KINDS perdeu "continuo" — uma sessão do hermes deixa de contar como ' +
        "coordenadora e o guard do #5716 para de proteger os subagentes dela (fail-open, sem log).",
    );
  });
});
