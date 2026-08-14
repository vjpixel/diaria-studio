/**
 * test/diaria-overnight-rescan-sem-cap-5272.test.ts (#5272)
 *
 * Trava a eliminação do cap de re-varredura (`rescans_done` K=2) do
 * /diaria-overnight: a fila principal é re-varrida enquanto cada re-scan
 * devolver issue nova, `rescans_done` vira contador puro de observabilidade, e
 * o motivo `rescan-limit` deixa de existir. No lugar do contador ficam três
 * mecanismos — anti-livelock, guard de colisão editorial e o teto de relógio
 * das 09:00 BRT.
 *
 * Regressão de #5272: o cap era descrito em 3 lugares como "a única garantia de
 * terminação do overnight", com aviso explícito de "não unificar com o develop".
 * Deixar esse texto no lugar faria a próxima sessão que lesse a skill
 * reintroduzir o cap achando que consertava um bug — por isso a ausência das
 * frases antigas é testada, não só a presença das novas.
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, como diaria-develop-goal-exhaust-all-4319.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overnight = readFileSync(resolve(ROOT, ".claude/skills/diaria-overnight/SKILL.md"), "utf8");
const develop = readFileSync(resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md"), "utf8");
const claudeMd = readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8");
const statusline = readFileSync(resolve(ROOT, "scripts/overnight-statusline.ts"), "utf8");

describe("diaria-overnight re-varredura sem cap (#5272)", () => {
  it("o cap K=2 saiu: nenhuma condição de parada lê `rescans_done`", () => {
    assert.doesNotMatch(
      overnight,
      /Quando `rescans_done` >= 2/,
      "a condição de encerramento por contagem de re-scans não pode sobreviver",
    );
    assert.doesNotMatch(
      overnight,
      /Guard de convergência\*\* \(K=2/,
      "o guard não pode mais ser rotulado com o cap K=2",
    );
    assert.match(
      overnight,
      /Re-varredura de convergência — SEM CAP \(#5272/,
      "a re-varredura é declarada sem cap",
    );
    assert.match(
      overnight,
      /repetir enquanto cada re-scan devolver issue nova sem status terminal/,
      "condição de parada é 'nada novo', não uma contagem",
    );
  });

  it("`rescans_done` vira contador puro e plan.json legado com valor >= 2 não encerra a rodada", () => {
    assert.match(
      overnight,
      /`rescans_done` continua sendo incrementado a cada re-scan, mas como \*\*contador puro de observabilidade\*\*/,
      "rescans_done documentado como contador puro",
    );
    assert.match(
      overnight,
      /`plan\.json` retomado com `rescans_done >= 2` \*\*não\*\* encerra a rodada por causa disso/,
      "compat de plan.json legado: valor herdado do cap não pode encerrar um resume",
    );
  });

  it("o motivo `rescan-limit` sumiu do enum de `pulada` e de todos os consumidores", () => {
    assert.match(
      overnight,
      /\*\*`rescan-limit` saiu do enum em #5272\*\*/,
      "a remoção do motivo é explícita no schema do plan.json",
    );
    // Só as DUAS notas de remoção podem citar o motivo (a proibição na Fase 1 e
    // a nota no enum do schema). Nenhuma outra passagem — in_round da Fase 0,
    // unidades puladas da Fase 1 — pode continuar listando um motivo que não é
    // mais gravável, senão o coordenador volta a gravá-lo por imitação.
    const mentions = overnight.match(/rescan-limit/g) ?? [];
    assert.equal(
      mentions.length,
      2,
      `rescan-limit só pode sobreviver nas 2 notas de remoção; encontrado ${mentions.length}x`,
    );
    assert.match(
      overnight,
      /deixou de existir\*\* — não gravar esse motivo em nenhuma circunstância/,
      "a proibição de gravar o motivo é explícita, não só a remoção do enum",
    );
    assert.doesNotMatch(
      statusline,
      /`sem-resposta`, `rescan-limit`, `ambigua`/,
      "o consumidor de plan.json não pode documentar um motivo extinto como corrente",
    );
  });

  it("os três mecanismos que substituem o cap estão documentados, e nenhum é um contador", () => {
    assert.match(overnight, /\(i\) \*\*anti-livelock\*\*/);
    assert.match(overnight, /\(ii\) \*\*guard de colisão com a manhã\*\*/);
    assert.match(overnight, /\(iii\) \*\*teto de relógio\*\*/);
    assert.match(
      overnight,
      /três mecanismos, nenhum deles um contador/,
      "a substituição do cap não pode reintroduzir contagem",
    );
  });

  it("teto de relógio: só impede ABRIR novo ciclo depois das 09:00 BRT, nunca interrompe trabalho em curso", () => {
    assert.match(
      overnight,
      /não INICIAR uma nova re-varredura de convergência depois das \*\*09:00 BRT\*\*/,
      "o teto é sobre iniciar, não sobre interromper",
    );
    assert.match(
      overnight,
      /a unidade corrente sempre termina, o teto só recusa abrir mais um ciclo/,
      "trabalho em andamento é preservado",
    );
    assert.match(
      overnight,
      /gravar `rescan_window_closed_at: now\(\)` em `plan\.json`/,
      "o acionamento do teto é registrado no plan.json",
    );
    assert.match(
      overnight,
      /"rescan_window_closed_at": null/,
      "o campo está no schema do plan.json",
    );
    assert.match(
      overnight,
      /Convergência NÃO confirmada — teto de relógio das 09:00 BRT/,
      "a Fase 2 distingue 'janela fechou' de 'a fila esgotou de verdade'",
    );
  });

  it("o cap de `findings_depth` (2) NÃO foi removido junto — a divergência com o develop continua só nele", () => {
    assert.match(
      overnight,
      /O cap de `findings_depth` \(2\) NÃO muda/,
      "o escopo do #5272 é re-varredura, não a cadeia de findings",
    );
    assert.match(
      overnight,
      /Este cap de profundidade 2.*NÃO existem no `\/diaria-develop`/s,
      "a divergência de findings_depth continua documentada",
    );
    assert.match(
      develop,
      /\*\*Este é o único cap que ainda diverge\*\*/,
      "o develop registra que só o cap de findings separa as duas skills",
    );
  });

  it("as 3 passagens 'não unificar com o develop' foram reescritas, não deixadas contradizendo a decisão", () => {
    assert.doesNotMatch(
      overnight,
      /o cap mecânico é a única garantia de terminação que existe/,
      "a premissa do cap como única garantia foi revogada",
    );
    assert.doesNotMatch(
      overnight,
      /Não "unificar" os dois mecanismos — isso quebraria a única garantia de parada/,
      "o aviso de não-unificar da Fase 1 saiu junto com o cap",
    );
    assert.doesNotMatch(
      develop,
      /\*\*O `\/diaria-overnight` não muda\*\*/,
      "o develop não pode continuar afirmando que o overnight mantém o cap",
    );
    assert.match(
      develop,
      /O `\/diaria-overnight` seguiu o mesmo caminho em #5272/,
      "o develop registra o alinhamento",
    );
  });

  it("CLAUDE.md separa os dois caps: re-varredura saiu dos dois lados, profundidade de finding só do develop", () => {
    assert.doesNotMatch(
      claudeMd,
      /só o overnight, que roda desassistido, ainda precisa deles/,
      "CLAUDE.md não pode continuar dizendo que o overnight precisa dos dois caps",
    );
    assert.match(claudeMd, /o de \*\*re-varredura\*\* saiu também do overnight em #5272/);
    assert.match(
      claudeMd,
      /só o cap de \*\*profundidade de finding\*\* segue exclusivo do overnight/,
    );
  });
});
