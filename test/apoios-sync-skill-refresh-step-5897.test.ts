/**
 * test/apoios-sync-skill-refresh-step-5897.test.ts (#5897, regressão #633)
 *
 * O Passo 4 de `/diaria-apoios-sync` existe porque `--push` NÃO dispara
 * reprocessamento de segmento na Beehiiv (#4485): segmento é lista
 * materializada, e sem refresh manual um envio segmentado no mesmo dia do push
 * acerta a lista ANTIGA — a classe de erro que o #4436 existiu pra eliminar.
 *
 * O passo instruía clicar um botão "Refresh segment" na aba Overview. Esse
 * botão foi REMOVIDO da UI da Beehiiv (medido ao vivo em 260821: nenhum
 * `<button>` da página casa /refresh|reload|process/i). Seguindo a instrução
 * antiga, o operador procura um botão inexistente e ou para no meio deixando
 * os 6 segmentos stale, ou conclui que "regenera sozinho" — leitura que o
 * #4485 já refutou. Nos dois casos o envio segmentado erra o alvo em silêncio.
 *
 * Trava o caminho verificado que substituiu o botão (Configure → "Update
 * segment") e impede que a instrução morta volte como comando.
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, mesmo padrão de
 * overnight-skill-npm-test-scope.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = resolve(ROOT, ".claude/skills/diaria-apoios-sync/SKILL.md");
const content = readFileSync(SKILL_MD, "utf8");

/**
 * Texto do SKILL.md com todo run de whitespace colapsado num espaço único.
 *
 * Indispensável, não cosmético: este arquivo quebra linha a ~76 colunas e
 * quebra livremente NO MEIO de frases entre aspas — no próprio Passo 4.2 o
 * termo aparece quebrado como `"Update\n   segment"`. Uma checagem linha a
 * linha (`line.includes("Refresh segment")`) não veria uma instrução morta que
 * voltasse quebrada como `"Refresh\n   segment"`, e o teste passaria em
 * silêncio exatamente no caso que ele existe pra pegar.
 */
function normalizedContent(): string {
  return content.replace(/\s+/g, " ");
}

/**
 * A ÚNICA menção legítima ao botão removido: a nota histórica que documenta
 * que ele não existe mais.
 *
 * Casada como frase INTEIRA sobre o texto normalizado, e não como "linha que
 * por acaso contém as palavras NÃO existe mais" — esse filtro mais frouxo
 * isentaria qualquer instrução morta que coincidisse com esse trecho, e
 * quebraria à toa se a nota fosse reescrita com outras palavras.
 */
const HISTORICAL_NOTE =
  '**O botão "Refresh segment" da aba Overview NÃO existe mais (#5897).**';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("diaria-apoios-sync — Passo 4 usa o caminho verificado, não o botão removido (#5897)", () => {
  it('instrui Configure → "Update segment" como o gatilho de reprocessamento', () => {
    // Uma asserção só, sobre o texto normalizado: as duas metades precisam
    // estar na MESMA instrução. Checá-las separadas deixaria o teste passar
    // com a ressalva "sem alterar nenhuma condição" tendo migrado pra outro
    // ponto do documento, descrevendo outra coisa.
    assert.match(
      normalizedContent(),
      /\*\*sem alterar nenhuma condição\*\*, clicar \*\*"Update segment"\*\*/,
      'Passo 4.1 deve mandar clicar "Update segment" SEM alterar condição, numa instrução só',
    );
    assert.match(
      normalizedContent(),
      /o `editor_url` já abre a aba \*\*Configure\*\*/,
      "deve dizer em qual aba o editor_url cai — a instrução antiga mandava trocar de aba",
    );
  });

  it('não instrui mais clicar o botão removido "Refresh segment"', () => {
    const normalized = normalizedContent();

    // A nota histórica precisa existir — é ela que explica pro operador por
    // que a instrução antiga sumiu, em vez de deixar o sumiço inexplicado.
    assert.ok(
      normalized.includes(HISTORICAL_NOTE),
      "a nota histórica que documenta a remoção do botão deve continuar no arquivo",
    );

    // E precisa ser a ÚNICA menção ao botão. Qualquer ocorrência a mais é
    // instrução morta voltando — inclusive quebrada em duas linhas, que a
    // normalização acima reúne numa só.
    assert.equal(
      countOccurrences(normalized, "Refresh segment"),
      1,
      "o botão removido só pode aparecer 1x no arquivo (na nota histórica); " +
        "qualquer ocorrência a mais é instrução morta voltando",
    );
  });

  it("preserva o gate determinístico do Passo 4.2 como o critério de sucesso", () => {
    // A lição do #5897 não é "corrigir o clique" — é que o clique é a parte
    // frágil e o gate é a parte confiável. Se o gate sair, a skill volta a
    // poder declarar sucesso com segmentos stale.
    assert.match(
      normalizedContent(),
      /evaluateSegmentCountGate/,
      "Passo 4.2 deve continuar chamando evaluateSegmentCountGate",
    );
    assert.match(
      normalizedContent(),
      /nunca declarar sucesso com o gate falhando/,
      "deve continuar proibindo declarar sucesso com gate.ok === false",
    );
    assert.match(
      normalizedContent(),
      /gate\.ok === false/,
      "deve nomear gate.ok === false como o sintoma canônico de refresh que não pegou",
    );
  });

  it("mantém o achado do #4485 que torna o passo obrigatório", () => {
    // Mudar só o VALOR do custom field (o que --push faz) continua não
    // disparando nada. É a assimetria entre salvar-o-formulário e
    // mudar-o-valor que justifica o passo manual existir.
    assert.match(
      normalizedContent(),
      /mudança de VALOR do campo, que é o que o `--push` faz/,
      "deve preservar a assimetria medida no #4485 (salvar dispara; mudar valor não)",
    );
  });

  it('não reusa "Passo 1" pra falar do sub-passo 4.1', () => {
    // O documento já tem um "## Passo 1 — drift check dos 6 segmentos"
    // top-level. Um operador que leia "repetir o passo 1" no meio do Passo 4
    // pode voltar 100+ linhas e re-rodar o drift check, que é outra coisa.
    assert.match(
      normalizedContent(),
      /sub-passo 4\.1 acima — NÃO o Passo 1 desta skill/,
      "a instrução de repetir deve desambiguar explicitamente contra o Passo 1 top-level",
    );
  });
});
