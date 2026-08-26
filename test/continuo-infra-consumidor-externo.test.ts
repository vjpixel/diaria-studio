/**
 * test/continuo-infra-consumidor-externo.test.ts (#6056)
 *
 * Guard de regressão contra a classe de erro do #6056/#6059/#6060: remover a
 * infra do kind `continuo` deste repo tratando-a como código morto.
 *
 * Ela NÃO é morta — o `helios` roda um cron **do Hermes**
 * (`~/.hermes/cron/jobs.json`, job `5d791ef6fc2c`, `every 60m`,
 * `workdir=/home/vjpixel/diaria-studio`) que invoca a skill LOCAL
 * `hermes-diaria-continuo` DENTRO deste checkout, consumindo tudo que este
 * teste tranca. Nenhuma skill DESTE repo usa o kind hoje, então a infra parece
 * órfã pra qualquer varredura de higiene — foi exatamente essa leitura que
 * quebrou o loop de produção no #6059.
 *
 * **Duas correções de fato, do #6168** — este cabeçalho errava as duas, e
 * errar isso manda quem for verificar o consumidor externo pro lugar errado,
 * que é o caminho mais curto pra concluir "não existe" e remover a infra de
 * novo:
 *   - a skill mora em `/home/vjpixel/.hermes/skills/productivity/hermes-diaria-continuo/`,
 *     **não** em `~/.claude/skills/` (lá só existe o `humanizador`);
 *   - quem a agenda é o cron do **Hermes**, **não** um "cron do Claude Code";
 *   - o job id mudou de `7089586af6cb` para `5d791ef6fc2c` quando o runtime foi
 *     religado em 26/08/2026 (`hermes cron create` gera id novo).
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimIssue,
  endSession,
  registerSession,
  requireKind,
} from "../scripts/lib/session-registry.ts";
import { COORDINATOR_KINDS } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import { needsSessionId } from "../.claude/hooks/inject-session-id.mjs";

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

  it("endSession funciona pro kind continuo — é o contrato de FIM DE TICK (#6168)", () => {
    // Por que isto é travado aqui: a `hermes-diaria-continuo` registra sempre
    // com o MESMO session-id estável e, até o #6168, nunca chamava `end` ao
    // fechar o tick. Consequência medida: o registro sobrevive entre ticks com
    // `claimed_issues` de trabalho já encerrado, e nada distingue "tick rodando
    // agora" de "tick que terminou há 50 min" — overnight/develop pulavam
    // issues por até 90 minutos por causa de claims de um tick morto.
    //
    // O lado ESTE-REPO desse contrato é só isto: `end --kind continuo` precisa
    // de fato remover o registro e reportar honestamente se removeu. O lado de
    // lá (a skill chamar `end`) mora fora do repo e não é testável daqui — por
    // isso o diff dela vai colado num comentário da #6168, que é a única forma
    // de review/histórico que aquele arquivo tem.
    const root = mkdtempSync(join(tmpdir(), "continuo-end-"));
    try {
      registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", { tag: "helios" });
      assert.equal(
        endSession(root, "continuo", "hermes-cron-5d791ef6fc2c", "helios"),
        true,
        "end deveria remover o registro do tick",
      );
      assert.equal(
        endSession(root, "continuo", "hermes-cron-5d791ef6fc2c", "helios"),
        false,
        'end idempotente: 2ª chamada reporta "nada a remover", nunca sucesso falso (#5797)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-registrar um tick NÃO apaga claims em voo (#6294) — o hermes registra com id estável", () => {
    // A skill usa um `session-id` ESTÁVEL entre ticks, então `register` é
    // chamado de novo sobre um registro que pode existir. Antes do #6168,
    // `registerSession` montava o record do zero com `claimed_issues: []` —
    // um segundo `register` liberava silenciosamente todas as issues que o
    // tick anterior segurava, no meio do trabalho.
    const root = mkdtempSync(join(tmpdir(), "continuo-reg-"));
    try {
      registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", { tag: "helios" });
      claimIssue(root, "continuo", "hermes-cron-5d791ef6fc2c", 6232, "helios");
      const again = registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", { tag: "helios", pid: 999 });
      assert.deepEqual(again.record.claimed_issues, [6232], "re-registro preservou o claim em voo");
      assert.equal(again.record.pid, 999, "e ainda aplicou o campo novo que motivou o re-registro");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("os subcomandos novos do #6168/#6296 recebem --session-id injetado — o hermes nunca sabe o próprio", () => {
    // A skill do hermes vai consultar `conflicts` (Parte C da #6168). Sem a
    // injeção, `--session-id` fica vazio, a própria sessão não se auto-exclui
    // dos peers e ela conflita consigo mesma — degradação silenciosa, exato
    // modo de falha que o #5161 item 4 já corrigiu pro `is-claimed`.
    for (const sub of ["conflicts", "grant-merge", "check-merge-grant", "consume-merge-grant"]) {
      const cmd = `npx tsx scripts/lib/session-registry.ts ${sub} --kind continuo`;
      assert.equal(needsSessionId(cmd), true, `${sub} deveria receber --session-id injetado`);
    }
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
