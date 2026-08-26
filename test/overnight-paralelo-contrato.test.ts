/**
 * test/overnight-paralelo-contrato.test.ts (#6299)
 *
 * O `/diaria-overnight` deixou de ser serial. Toda a mudança é PROSA — não há
 * função nova pra testar —, e é exatamente por isso que este arquivo existe:
 * a #6299 nasce da observação de que **afirmação em prosa envelhece sem que
 * ninguém perceba**, e a prova disso estava no próprio texto que ela corrige.
 *
 * A justificativa da serialização era: *"sem supervisão, paralelo elevaria o
 * blast-radius"* — escrita quando o overnight não tinha defesa nenhuma além de
 * "um de cada vez". Desde então o repo construiu 8 mecanismos determinísticos
 * que tornam o paralelo seguro (worktree isolado, cluster de conflito, fusão
 * de colidentes, `is-claimed` check-and-set, `conflicts` por arquivo, merge
 * lock, Gate 2, guard do #5716) e **nenhum deles exige o editor presente**. A
 * frase continuou lá, e continuou decidindo.
 *
 * **O fleet review (#4383) NÃO está nessa lista de propósito** — a primeira
 * versão desta issue o incluía, copiado do parágrafo equivalente do develop,
 * e era falso: branches `overnight/*` resolvem `low` (1 agente) no hook, nunca
 * o fleet de 5. Creditar ao overnight um mecanismo que ele não executa
 * enfraquece o próprio argumento. O `it` "não credita o fleet review ao
 * overnight" abaixo existe pra impedir que a cópia volte.
 *
 * Este teste trava as 4 afirmações que precisam permanecer verdadeiras juntas
 * — se alguém reverter uma sem as outras, o texto volta a mentir:
 *
 *   1. o overnight declara paralelismo com teto explícito;
 *   2. o MERGE segue estritamente serial nas duas skills;
 *   3. nenhuma das duas volta a atribuir a segurança do paralelo à
 *      supervisão humana;
 *   4. a prosa nova não convive com a prosa velha que ela substituiu
 *      (a Fase 1 não pode voltar a se abrir com "uma unidade por vez"
 *      enquanto o parágrafo da onda diz o contrário 10 linhas abaixo).
 *
 * Não é um teste de comportamento — é um guard de coerência entre documentos
 * que decidem execução, no mesmo espírito de
 * `test/continuo-infra-consumidor-externo.test.ts` (#6056) e
 * `test/hub-registry-completeness.test.ts` (#4558): cruzar duas pontas
 * mantidas separadamente e falhar quando uma some.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OVERNIGHT = ".claude/skills/diaria-overnight/SKILL.md";
const DEVELOP = ".claude/skills/diaria-develop/SKILL.md";
const CLAUDE_MD = "CLAUDE.md";

describe("#6299 — o overnight declara paralelismo, com teto", () => {
  it("a SKILL.md do overnight fala em compor ONDA antes do fan-out", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /Compor a onda antes de dispatchar/,
      "o passo de composição de onda sumiu do overnight — sem ele o fan-out não tem o que despachar em paralelo",
    );
  });

  it("declara teto de concorrência explícito, e menor que o do develop", () => {
    // Ler os DOIS tetos e comparar de verdade. A versão anterior deste teste
    // só casava a string "Teto de concorrência: 3" no overnight e afirmava na
    // mensagem que 3 < 6 sem nunca ter lido o 6 — se o develop baixasse pra 2,
    // o teste seguiria verde defendendo uma relação que passou a ser falsa
    // (achado do review da #6330).
    const overnightCap = read(OVERNIGHT).match(/Teto de concorrência: (\d+)/);
    assert.ok(
      overnightCap,
      "o teto do overnight sumiu ou mudou de forma — sem número explícito o fan-out não tem limite legível",
    );

    // Ancorar na DECLARAÇÃO autoritativa do develop, não na 1ª ocorrência
    // solta de "teto" no arquivo. A versão anterior usava /teto (?:de )?(\d+)/i
    // sobre o arquivo inteiro e caía numa célula de tabela comparativa; acertava
    // o 6 por acidente (a célula vizinha diz "teto **3**", que só não casou
    // porque o markdown bold separa "teto " do dígito). Uma edição estética
    // naquela tabela passaria a comparar contra o número errado, em silêncio
    // — achado do re-review da #6330.
    const developCap = read(DEVELOP).match(/Teto de concorrência\D{0,40}?(\d+)/i);
    assert.ok(
      developCap,
      "não achei a declaração autoritativa do teto do develop ('Teto de concorrência ... N') — se ela mudou de forma, ajustar ESTE teste junto, nunca afrouxar a regex pra pegar qualquer 'teto'",
    );

    const o = Number(overnightCap[1]);
    const d = Number(developCap[1]);
    assert.ok(
      o < d,
      `o teto do overnight (${o}) deixou de ser menor que o do develop (${d}). ` +
        "A relação é a decisão, não o número: o overnight roda DESASSISTIDO, então degrada queimando menos trabalho antes de alguém olhar.",
    );
  });

  it("reusa a análise de cluster do develop em vez de reimplementar", () => {
    const s = read(OVERNIGHT);
    assert.match(s, /an[áa]lise de cluster/i);
    assert.match(
      s,
      /fundem numa unidade s[óo]/,
      "a fusão de colidentes é o que faz o #636 continuar satisfeito POR CONSTRUÇÃO",
    );
  });
});

describe("#6299 — o MERGE continua estritamente serial nas duas skills", () => {
  // Esta é a metade que NÃO pode afrouxar junto. Paralelizar implementação e
  // paralelizar merge são coisas diferentes; a issue muda só a primeira.
  for (const [nome, path] of [
    ["overnight", OVERNIGHT],
    ["develop", DEVELOP],
  ] as const) {
    it(`${nome}: exige merge-lock-acquire antes do gh pr merge`, () => {
      const s = read(path);
      assert.match(
        s,
        /merge-lock-acquire/,
        `${nome} deixou de exigir o merge lock — master receberia mais de um squash ao mesmo tempo`,
      );
    });
  }

  it("o overnight afirma explicitamente que só o merge é serial", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /merge continua estritamente serial/i,
      "a distinção 'implementação paralela, merge serial' sumiu — é ela que preserva o histórico linear de master",
    );
  });

  it("CLAUDE.md acompanha: onda no dispatch, serial no merge", () => {
    const s = read(CLAUDE_MD);
    assert.match(
      s,
      /s[óo] o MERGE segue serial/i,
      "CLAUDE.md voltou a dizer '1 unidade por vez' sem a ressalva — é o arquivo carregado em TODA sessão, então mentir aqui custa mais",
    );
  });
});

describe("#6299 — nenhuma skill volta a creditar o paralelo à supervisão humana", () => {
  it("o develop não afirma mais que a supervisão é o que torna o paralelo seguro", () => {
    const s = read(DEVELOP);
    // A frase original era: "aqui a supervisão humana torna o paralelo
    // seguro". Ela sustentava a serialização do overnight por contraste — e
    // era factualmente errada: os 9 mecanismos que garantem a segurança são
    // todos determinísticos.
    assert.doesNotMatch(
      s,
      /supervis[ãa]o humana torna o paralelo seguro/i,
      "a afirmação factualmente errada voltou — ver #6299: o que torna o paralelo seguro é determinístico, não a presença do editor",
    );
  });

  it("o develop registra o que a supervisão humana DE FATO cobre", () => {
    const s = read(DEVELOP);
    assert.match(
      s,
      /Gate 1 cat\. C.*Gate B|Gate B.*Gate 1 cat\. C/s,
      "sumiu o registro de que a supervisão cobre Gate 1 cat. C e Gate B — sem isso a correção do #6299 perde o contraponto e alguém reverte por parecer que 'a supervisão não servia pra nada'",
    );
  });

  it("o overnight não descreve a si mesmo como serial por blast-radius", () => {
    const s = read(OVERNIGHT);
    assert.doesNotMatch(
      s,
      /Overnight roda serial \(#636\)/,
      "voltou a afirmação de que o overnight é serial — o #6299 a substituiu",
    );
  });
});

describe("#6299 — active_worktrees deixou de ser cosmético", () => {
  it("o overnight tem os DOIS call sites reais, não só a intenção declarada", () => {
    // A versão anterior deste teste casava a mera PRESENÇA da frase
    // "heartbeat --active-worktrees" em qualquer lugar do arquivo — e passava
    // verde num arquivo que dizia "chamar ao abrir e ao fechar" sem ter
    // escrito a chamada em ponto nenhum, enquanto a seção de coexistência
    // afirmava, 300 linhas abaixo, que o comando "ainda não é chamado por
    // nenhuma skill". Teste que confirma a intenção em vez do call site dá
    // exatamente a garantia falsa que a #6299 existe pra eliminar.
    const s = read(OVERNIGHT);
    const callSites = s.match(/npx tsx scripts\/lib\/session-registry\.ts heartbeat --kind overnight --active-worktrees/g) ?? [];
    assert.ok(
      callSites.length >= 2,
      `esperava ≥2 call sites concretos de heartbeat --active-worktrees (abertura da onda + fechamento de cada worktree), achei ${callSites.length}. ` +
        "Só o PAR mantém o número honesto: publicar só ao abrir faz a sessão parecer permanentemente cheia e sufoca a concorrente pelo resto da noite.",
    );
  });

  it("não afirma mais que o comando nunca é chamado — era a contradição interna", () => {
    const s = read(OVERNIGHT);
    assert.doesNotMatch(
      s,
      /ainda não é chamado por nenhuma skill/i,
      "a seção de coexistência voltou a dizer que o write-path não tem chamador, contradizendo os call sites da Fase 1 — se o overnight de fato parar de chamar, remover os call sites E esta afirmação juntos",
    );
  });

  it("o DEVELOP também não afirma que o overnight não chama — contradição CRUZADA", () => {
    // O 1º fix desta issue corrigiu só o lado overnight e deixou o item 6
    // espelhado do develop dizendo "nenhum call site desta skill (nem do
    // overnight) invoca esse comando" — que virou falso no mesmo commit.
    // Nenhum teste pegou, porque todos liam só OVERNIGHT. Corrigir um lado de
    // uma afirmação mantida em dois arquivos é meio trabalho, e o leitor que
    // consulta o arquivo errado recebe a versão falsa (achado do re-review
    // da #6330).
    const s = read(DEVELOP);
    assert.doesNotMatch(
      s,
      /nem do overnight\) invoca esse comando/i,
      "o develop voltou a afirmar que o overnight não chama heartbeat --active-worktrees — desde o #6299 ele chama, em 2 call sites",
    );
    // E o par positivo: o develop precisa registrar a assimetria DENTRO do
    // item 6, senão uma sessão develop lê "não mecanizado" e assume que o
    // overnight também não publica — a leitura que a faz abrir 6 por cima dos
    // 3 dele. Escopar ao item 6 e não ao arquivo: o develop já cita #6299
    // noutro trecho (a correção da "supervisão humana"), então um
    // `match(/#6299/)` global passaria mesmo com este item intocado — vácuo,
    // que é o defeito que este arquivo inteiro existe pra não cometer.
    const item6 = s.match(/6\. \*\*Teto de concorrência por sessão\*\*[\s\S]{0,1400}/)?.[0] ?? "";
    assert.ok(item6, "não achei o item 6 do develop — se ele mudou de forma/numeração, ajustar este teste");
    assert.match(
      item6,
      /#6299/,
      "o item 6 do develop não registra que o overnight passou a publicar active_worktrees (#6299) — sem isso a assimetria fica invisível justamente pra quem precisa dela",
    );
  });
});

describe("#6299 — a prosa nova não convive com a prosa velha", () => {
  it("a Fase 1 não volta a se abrir com 'uma unidade por vez'", () => {
    // O review da #6330 pegou exatamente isto: o parágrafo da onda foi
    // inserido, mas o cabeçalho da Fase 1 continuou dizendo "Uma unidade de
    // trabalho por vez" 10 linhas acima. As duas afirmações não podem ser
    // verdadeiras juntas, e a mais antiga é a que um leitor apressado segue.
    const s = read(OVERNIGHT);
    assert.doesNotMatch(
      s,
      /^Uma \*\*unidade de trabalho\*\*.*por vez/m,
      "o cabeçalho serial da Fase 1 voltou — ele contradiz o parágrafo de composição de onda logo abaixo",
    );
  });

  it("não credita o fleet review (#4383) ao overnight", () => {
    // Branches `overnight/*` resolvem `low` (1 agente) no hook, nunca o fleet
    // de 5 — esse é mecanismo do develop. A 1ª versão da #6299 copiou a lista
    // do develop inteira e trouxe o #4383 junto.
    const s = read(OVERNIGHT);
    const paragrafo = s.match(/Compor a onda antes de dispatchar[\s\S]{0,900}/)?.[0] ?? "";
    assert.doesNotMatch(
      paragrafo,
      /fleet review pré-merge \(#4383\)[^—]*—?\s*e \*\*nenhum deles/,
      "o #4383 voltou pra lista de mecanismos que sustentam o paralelo do overnight, mas o overnight não executa fleet review",
    );
  });
});
