/**
 * test/diaria-overnight-rescan-sem-cap-5272.test.ts (#5272)
 *
 * Trava a eliminação do cap de re-varredura (`rescans_done` K=2) do
 * /diaria-overnight: a fila principal é re-varrida enquanto cada re-scan
 * devolver issue nova, `rescans_done` vira contador puro de observabilidade, e
 * o motivo `rescan-limit` deixa de existir. No lugar do contador ficam três
 * mecanismos: anti-livelock e guard de colisão editorial. Um teto de relógio
 * (09:00 BRT) chegou a entrar aqui e foi retirado no mesmo dia por decisão do
 * editor — a rodada não tem deadline de tempo (#2039), e a ausência do teto é
 * testada tanto quanto a do cap.
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

  it("os dois mecanismos que substituem o cap estão documentados, e nenhum é um contador", () => {
    assert.match(overnight, /\(i\) \*\*anti-livelock\*\*/);
    assert.match(overnight, /\(ii\) \*\*guard de colisão com a manhã\*\*/);
    assert.match(
      overnight,
      /dois mecanismos, nenhum deles um contador/,
      "a substituição do cap não pode reintroduzir contagem",
    );
    // A contagem aparece 2x no mesmo parágrafo (na enumeração e no fecho que
    // compara com o develop). Afirmar só a presença de "dois" deixava passar um
    // "três mecanismos acima" esquecido no fecho — foi o que aconteceu ao
    // remover o teto (achado do review da PR #5274).
    assert.doesNotMatch(
      overnight,
      /três mecanismos/,
      "nenhum resquício da contagem de quando o teto de relógio existia",
    );
  });

  it("NÃO existe teto de relógio: nem instrução, nem campo de plan.json, nem linha de relatório", () => {
    // Decisão do editor (260814): um teto das 09:00 BRT entrou junto com o
    // #5272 e foi retirado no mesmo dia. A rodada não tem deadline de tempo
    // (#2039) — o freio é a fila secar. Este caso existe porque um limite
    // mecânico já foi retirado desta seção duas vezes; a próxima sessão que
    // "consertar" a ausência dele quebra este teste antes de mergear.
    assert.doesNotMatch(
      overnight,
      /não INICIAR uma nova re-varredura de convergência depois das/,
      "nenhuma instrução de teto de horário pode voltar",
    );
    assert.doesNotMatch(
      overnight,
      /rescan_window_closed_at/,
      "o campo que registrava o acionamento do teto saiu do schema e do relatório",
    );
    assert.doesNotMatch(
      overnight,
      /TZ=America\/Sao_Paulo date/,
      "nenhuma checagem de relógio sobrou na re-varredura",
    );
    assert.match(
      overnight,
      /\*\*NÃO existe teto de relógio \(decisão do editor, 260814\)/,
      "a ausência é declarada, não deixada implícita",
    );
    assert.match(
      overnight,
      /Não reintroduzir teto nem contador sem decisão explícita do editor/,
      "a instrução de não reintroduzir é explícita",
    );
  });

  it("a consequência aceita (dia sem edição = rodada sem limite de horário) fica registrada, não escondida", () => {
    assert.match(
      overnight,
      /em dia sem edição — quando o guard \(ii\) nunca aciona — uma rodada que siga recebendo issues novas continua trabalhando sem nenhum limite de horário/,
      "o buraco conhecido do desenho é documentado onde o coordenador lê",
    );
    assert.match(
      claudeMd,
      /em dia sem edição a rodada não tem limite de horário/,
      "CLAUDE.md carrega a mesma consequência, pra não depender de abrir a skill",
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
