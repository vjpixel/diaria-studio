/**
 * test/ads-rolling-cac-regime.test.ts (#8396)
 *
 * Dois guards de uma mesma classe de defeito: **regra morta que continua
 * legível como se fosse vigente.**
 *
 * O incidente: o §3.4 do `00-PROTOCOLO.md` ("congelamento operacional durante
 * os 15 dias") foi SUBSTITUÍDO pela Emenda 07/09/2026 — o regime vigente é o
 * oposto, refinamento iterativo com edição em voo permitida. Mas o aviso de
 * substituição tinha 1 linha e o texto proibitivo inteiro continuava abaixo
 * dele, com a emenda ~900 linhas adiante. Quem lê o protocolo por seção
 * (`grep 3.4`) chegava na regra morta — e um agente respondeu ao editor "não
 * aplique, o protocolo congela edição durante a janela".
 *
 * (a) `REGIME_VIGENTE` existe, cita a emenda e aparece em TODA saída de
 *     `ads-rolling-cac.ts` (texto e `--json`): a leitura diária passa a
 *     carregar a regra junto com o número, alcançando quem nunca abre o
 *     protocolo.
 * (b) nenhuma seção marcada "SUBSTITUÍD*" no `00-PROTOCOLO.md` pode manter um
 *     corpo de texto longo abaixo do aviso.
 *
 * **O guard (b) lê um arquivo em `data/`** — junction local do OneDrive,
 * ausente em clone fresco e no CI. Ele DEGRADA (skip explícito) quando o
 * arquivo não existe; falhar por ausência transformaria um guard editorial
 * em CI vermelho para todo mundo. Mesmo idiom de
 * `test/article-page-merge-tags-7580.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { REGIME_VIGENTE } from "../scripts/ads-rolling-cac.ts";
import {
  MAX_LINHAS_APOS_AVISO,
  findSecoesSubstituidasComTextoMorto,
} from "../scripts/lib/ads-protocolo-substituidas.ts";

describe("#8396 — ads-rolling-cac.ts declara o regime vigente em toda saída", () => {
  it("REGIME_VIGENTE nomeia o regime e a emenda que o instituiu", () => {
    assert.match(REGIME_VIGENTE, /refinamento iterativo/i);
    assert.match(
      REGIME_VIGENTE,
      /Emenda 07\/09/,
      "a linha precisa apontar a emenda pelo nome — sem a âncora, quem lê não tem como achar o texto vigente",
    );
    assert.match(
      REGIME_VIGENTE,
      /edi[cç][aã]o em voo permitida/i,
      "o ponto inteiro é dizer o que MUDOU em relação ao §3.4 (que proibia edição em voo)",
    );
    assert.match(
      REGIME_VIGENTE,
      /edicoes\.jsonl/,
      "a disciplina de registro é a única parte do §3.4 que sobreviveu — tem que viajar junto",
    );
  });

  const SRC = readFileSync("scripts/ads-rolling-cac.ts", "utf8");

  it("o payload `--json` carrega o campo `regime`", () => {
    assert.match(
      SRC,
      /JSON\.stringify\(\s*\{\s*regime:\s*REGIME_VIGENTE/,
      "`regime` tem que estar no objeto serializado pelo `--json` — é por ele que a skill do relatório lê a regra " +
        "canônica em vez de parafrasear de memória",
    );
  });

  it("a saída de TEXTO imprime a mesma constante, não uma segunda redação", () => {
    assert.match(
      SRC,
      /console\.log\(`\$\{REGIME_VIGENTE\}/,
      "texto e JSON precisam sair da MESMA constante — duas redações divergem em silêncio",
    );
  });
});

const PROTOCOLO = "data/aquisicao/campanhas-260816/00-PROTOCOLO.md";

const secao = (aviso: string, corpo: string[]): string =>
  ["### 3.4 Congelamento operacional durante os 15 dias", "", aviso, "", ...corpo, "", "### 3.5 Outra seção", "", "x"].join(
    "\n",
  );

const AVISO = "> **SUBSTITUÍDO em 07/09/2026** — ver a Emenda no fim deste documento.";

describe("#8396 — detector de seção SUBSTITUÍDA que mantém o texto morto abaixo do aviso", () => {
  // Estes casos rodam SEMPRE (inclusive no CI, onde `data/` não existe) —
  // sem eles a lógica de detecção não teria cobertura nenhuma, porque o
  // único alvo real vive num diretório ausente do CI.
  it("acusa o formato que causou o incidente: aviso de 1 linha + corpo proibitivo inteiro", () => {
    const md = secao(AVISO, [
      "Proibido em qualquer braço: alterar keyword, negativa, lance, teto.",
      "",
      "**Qualquer edição em qualquer braço reinicia a janela dos 3.**",
      "",
      "**A razão mais forte não é paridade, é aprendizado.**",
      "",
      "Mais uma linha de regra morta.",
    ]);
    const achados = findSecoesSubstituidasComTextoMorto(md);
    assert.equal(achados.length, 1);
    assert.equal(achados[0].linha, 1);
    assert.equal(achados[0].linhasVivas, 4);
    assert.match(achados[0].primeiraLinhaViva, /^Proibido/);
  });

  it("aceita a seção corrigida: aviso longo, mas nenhuma prosa fora da citação", () => {
    const md = secao([AVISO, ">", "> O que sobrevive: a disciplina de registro em `edicoes.jsonl`.", ">", "> Texto original em `00-PROTOCOLO-ARQUIVO.md`."].join("\n"), []);
    assert.deepEqual(findSecoesSubstituidasComTextoMorto(md), []);
  });

  it(`tolera até ${MAX_LINHAS_APOS_AVISO} linhas vivas (um ponteiro curto fora da citação ainda passa)`, () => {
    const md = secao(AVISO, ["Ver a Emenda no fim do documento.", "", "Texto original em `00-PROTOCOLO-ARQUIVO.md`."]);
    assert.deepEqual(findSecoesSubstituidasComTextoMorto(md), []);
  });

  it("NÃO acusa emenda que apenas MENCIONA em prosa a seção que ela substitui", () => {
    const md = [
      "## Emenda 17/09/2026 — regra de decisão",
      "",
      '**Decisão do editor.** Substitui a "Regra de decisão" (seção marcada como SUBSTITUÍDA acima).',
      "",
      "Texto vivo da emenda, que é regra vigente e tem que continuar legível.",
      "",
      "Mais texto vivo.",
      "",
      "E mais.",
      "",
      "E mais ainda.",
    ].join("\n");
    assert.deepEqual(
      findSecoesSubstituidasComTextoMorto(md),
      [],
      "a palavra aparece no corpo, mas a seção é a regra VIVA — acusar aqui tornaria o guard inútil por ruído",
    );
  });

  it("NÃO acusa aviso escrito com continuação preguiçosa de blockquote (review #8396, finding 2)", () => {
    // No Markdown, linha sem `>` logo abaixo de uma com `>` ainda é citação.
    const md = secao([AVISO, "continuação do aviso sem `>`, ainda dentro da citação", "e mais uma linha assim"].join("\n"), []);
    assert.deepEqual(findSecoesSubstituidasComTextoMorto(md), []);
  });

  it("a linha em branco FECHA a citação — prosa depois dela volta a ser viva", () => {
    const md = secao(AVISO, [
      "Proibido alterar keyword.",
      "",
      "**Qualquer edição reinicia a janela.**",
      "",
      "Terceira linha morta.",
      "",
      "Quarta linha morta.",
    ]);
    assert.equal(findSecoesSubstituidasComTextoMorto(md).length, 1);
  });

  it("cabeçalho de QUALQUER nível fecha a seção (review #8396, finding 6)", () => {
    const md = [
      "### 3.4 Congelamento",
      "",
      AVISO,
      "",
      "# Título de nível 1 que fecha a seção",
      "",
      "Prosa viva que pertence à OUTRA seção.",
      "",
      "Mais prosa viva.",
      "",
      "E mais.",
      "",
      "E mais ainda.",
    ].join("\n");
    assert.deepEqual(
      findSecoesSubstituidasComTextoMorto(md),
      [],
      "sem fechar em `#`, o corpo da seção substituída vazaria por cima do resto do documento",
    );
  });

  it("NÃO acusa a palavra usada dentro de uma tabela no meio de outro assunto", () => {
    const md = [
      "## 0. Precedências",
      "",
      "| # | tema | antes | agora |",
      "| - | - | - | - |",
      "| 0.2 | Meta | clique | conversão; a campanha é SUBSTITUÍDA por uma nova |",
      "",
      "Prosa viva que segue valendo.",
      "",
      "Mais prosa viva.",
      "",
      "E mais.",
      "",
      "E mais ainda.",
    ].join("\n");
    assert.deepEqual(findSecoesSubstituidasComTextoMorto(md), []);
  });
});

describe("#8396 — 00-PROTOCOLO.md real: nenhuma seção substituída com texto morto", () => {
  it(
    "o arquivo vivo do editor está limpo",
    { skip: !existsSync(PROTOCOLO) ? `${PROTOCOLO} ausente (data/ é junction do OneDrive, fora do CI)` : false },
    () => {
      const achados = findSecoesSubstituidasComTextoMorto(readFileSync(PROTOCOLO, "utf8"));
      assert.deepEqual(
        achados,
        [],
        `seção substituída mantendo o texto antigo legível abaixo do aviso:\n` +
          achados.map((a) => `  linha ${a.linha} — "${a.titulo}": ${a.linhasVivas} linhas vivas`).join("\n") +
          `\n\nQuem lê o protocolo por seção chega na regra MORTA — a viva fica centenas de linhas depois. ` +
          `Substitua o corpo por um ponteiro de 2-3 linhas pra emenda que a substituiu e mova o texto original ` +
          `pro 00-PROTOCOLO-ARQUIVO.md (mesma pasta).`,
      );
    },
  );
});
