/**
 * test/hermes-model-chain-drift.test.ts (#6663)
 *
 * Guard de regressão contra o drift medido no #6663: `MODELS_DEFAULT` em
 * `hermes/scripts/claude-openrouter.sh` (o que o wrapper de fato roda) e a
 * tabela "ferramenta | o que faz | modelo" de
 * `hermes/skills/hermes-diaria-continuo/SKILL.md` (a doc que o loop do
 * Hermes/quem investiga lê) divergiram silenciosamente — o #6617 trocou o
 * primário do wrapper e ninguém atualizou o SKILL.md, que continuou listando
 * `glm-5.2:free` como primário meses depois de ele ter saído da cadeia.
 *
 * Este teste faz o parse do array bash `MODELS_DEFAULT` (regex simples — o
 * script não muda de forma estrutural com frequência) e confere que cada
 * slug, em forma COMPLETA, aparece na linha da tabela do SKILL.md que
 * documenta esse script. Cobre só o par wrapper↔SKILL.md — o
 * `~/.hermes/config.yaml` fica fora do repo, sem como travar em CI daqui
 * (ver corpo da issue #6663, item 4).
 *
 * **Se você chegou aqui porque este teste falhou:** você mudou
 * `MODELS_DEFAULT` sem atualizar a tabela do SKILL.md (ou vice-versa) — edite
 * o lado que ficou pra trás, não relaxe este teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");
const SKILL_PATH = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

/**
 * Remove comentários shell (`# ...`) linha a linha, respeitando aspas — sem
 * isso, um `)` dentro de um comentário inline (comum neste repo: referências
 * a issue tipo `# primário (#6663)`) trunca o parse de MODELS_DEFAULT antes
 * do fechamento real do array, caso a declaração algum dia vire multi-linha
 * com comentário por item (achado do fleet review da PR #6671).
 */
function stripShellComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function parseModelsDefault(wrapperSource: string): string[] {
  const cleaned = stripShellComments(wrapperSource);
  const match = cleaned.match(/MODELS_DEFAULT=\(([^)]*)\)/);
  assert.ok(
    match,
    "MODELS_DEFAULT=(...) não encontrado em hermes/scripts/claude-openrouter.sh — " +
      "o script mudou de forma estrutural, atualize o regex deste teste.",
  );
  const inner = match![1];
  const slugs = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    slugs.length > 0,
    "MODELS_DEFAULT foi encontrado mas nenhum slug entre aspas foi extraído — regex desalinhado com o formato real.",
  );
  return slugs;
}

function findWrapperTableRow(skillSource: string): string {
  const line = skillSource
    .split("\n")
    .find((l) => l.includes("claude-openrouter.sh") && l.trim().startsWith("|"));
  assert.ok(
    line,
    "Nenhuma linha de tabela referenciando claude-openrouter.sh encontrada em " +
      "hermes/skills/hermes-diaria-continuo/SKILL.md — a tabela 'ferramenta | o que faz | modelo' mudou de forma.",
  );
  return line!;
}

describe("cadeia de modelos do Hermes: wrapper e SKILL.md não podem divergir (#6663)", () => {
  const wrapperSource = readFileSync(WRAPPER_PATH, "utf8");
  const skillSource = readFileSync(SKILL_PATH, "utf8");

  const models = parseModelsDefault(wrapperSource);
  const tableRow = findWrapperTableRow(skillSource);

  it("MODELS_DEFAULT tem pelo menos 1 modelo :free e o fallback pago glm-5.3-flash por último", () => {
    assert.ok(models.length >= 2, "cadeia degenerada a 1 único modelo — sem fallback.");
    assert.ok(
      models.slice(0, -1).some((m) => m.endsWith(":free")),
      "nenhum dos modelos antes do fallback termina em :free — a cadeia deveria priorizar free tier.",
    );
    assert.equal(
      models[models.length - 1],
      "z-ai/glm-5.3-flash",
      "o fallback pago (z-ai/glm-5.3-flash) deve continuar como ÚLTIMO da cadeia — " +
        "é a rede de segurança, não deve virar primário por acidente de reordenação.",
    );
  });

  for (const slug of models) {
    it(`slug "${slug}" de MODELS_DEFAULT aparece, em forma COMPLETA, na tabela do SKILL.md`, () => {
      assert.ok(
        tableRow.includes(slug),
        `"${slug}" está em MODELS_DEFAULT (hermes/scripts/claude-openrouter.sh) mas não aparece ` +
          "na linha da tabela 'ferramenta | o que faz | modelo' de " +
          "hermes/skills/hermes-diaria-continuo/SKILL.md (linha ~40). Atualize a tabela para " +
          "os slugs REAIS que o wrapper roda hoje, em forma completa (não abreviada).",
      );
    });
  }

  it("a ORDEM dos slugs na tabela do SKILL.md corresponde à ordem em MODELS_DEFAULT", () => {
    // Não basta cada slug aparecer (checagem acima) — a mudança REAL que o
    // #6663 faz no wrapper é justamente uma REORDENAÇÃO primário/fallback, e
    // uma checagem só de presença (substring) fica verde mesmo se a tabela
    // listar os mesmos 3 slugs fora de ordem. Confirmado ao vivo pelo fleet
    // review da PR: trocar a ordem na tabela (sem tocar o wrapper) mantinha
    // as assertions de presença passando.
    const positions = models.map((slug) => tableRow.indexOf(slug));
    for (const pos of positions) {
      assert.notEqual(pos, -1, "slug ausente da tabela — já coberto pela checagem de presença acima.");
    }
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] > positions[i - 1],
        `ordem da tabela do SKILL.md diverge de MODELS_DEFAULT: "${models[i - 1]}" (pos ${positions[i - 1]}) ` +
          `deveria vir ANTES de "${models[i]}" (pos ${positions[i]}) na linha da tabela, mas não vem. ` +
          `Linha atual: "${tableRow.trim()}"`,
      );
    }
  });

  it("a tabela do SKILL.md não lista nenhum slug abreviado (ex: 'glm-5.2:free' sem o prefixo 'z-ai/')", () => {
    // Regra do #6663: slugs abreviados dificultam casar doc com código —
    // exigir forma completa (com prefixo do provedor) na tabela.
    const abreviado = /(?<!\/)\b(glm-5\.\d+(?:-flash)?|dots-3-note-preview|laguna-s-2\.1):free\b/;
    assert.equal(
      abreviado.test(tableRow),
      false,
      `linha da tabela contém slug abreviado sem prefixo de provedor: "${tableRow.trim()}"`,
    );
  });

  // -----------------------------------------------------------------------
  // #6790: asserção negativa — doc NUNCA pode afirmar que o wrapper lê
  // config.yaml / fallback_chains / coding_fallback como fonte da cadeia.
  // O wrapper roda o array bash MODELS_DEFAULT, hardcoded; o bloco
  // smart_model_routing é config morta como roteador.
  //
  // A armadilha: a seção de CORREÇÃO (ex: tick-20260828-*.md) cita os
  // mesmos termos justamente pra negá-los. Match cru gera falso positivo.
  // Estratégia: procura afirmação POSITIVA — termos de crença perto do
  // nome do wrapper, sem verbo negativo interposto.
  //
  // Achado (sessão 31/08, ao destravar #6790): a 1ª versão buscava o
  // verbo negativo só DEPOIS da menção ao wrapper (`afterWrapper`) —
  // uma frase corretora com a negação ANTES do nome do wrapper (ex:
  // "não é verdade que claude-openrouter.sh usa fallback_chains")
  // escaparia da detecção e viraria falso-positivo de violação.
  //
  // 1ª tentativa de fix: buscar na JANELA INTEIRA. Review independente
  // (mesma sessão) achou o problema — janela inteira é PERMISSIVA
  // DEMAIS na direção oposta: uma negação numa frase SEM RELAÇÃO
  // nenhuma, só coincidentemente dentro das 3 linhas antes do trecho,
  // passaria a eximir uma afirmação genuinamente errada (falso
  // negativo — contra-exemplo construído pelo review: "O roteamento
  // não é feito manualmente... claude-openrouter.sh lê o
  // fallback_chains..." deixaria de ser flagado).
  //
  // Fix final: busca a partir do PRIMEIRO dos dois marcadores (menção
  // ao wrapper OU ao termo proibido, o que vier antes no texto) até o
  // fim da janela — cobre negação tanto ANTES do wrapper quanto DEPOIS
  // do termo proibido (o padrão real do corpus: "está errado" vem
  // depois dos dois), mas não drena uma frase anterior não-relacionada
  // que só por acidente cai nas 3 linhas de contexto. Extraído como
  // função pura (`isUnnegatedForbiddenClaim`, abaixo do describe) pra
  // poder ser testada em isolamento contra os 2 contra-exemplos.
  // -----------------------------------------------------------------------

  it("nenhum doc afirma que claude-openrouter.sh lê config.yaml / fallback_chains / coding_fallback (#6790)", () => {
    const REF_DIR = join(ROOT, "hermes/skills/hermes-diaria-continuo/references");
    const SKILL_MD = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

    const files = [SKILL_MD, ...readdirSync(REF_DIR).map((f) => join(REF_DIR, f))].filter((f) =>
      f.endsWith(".md"),
    );

    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("claude-openrouter")) continue;
        // Janela de 3 linhas pra trás e 2 pra frente: a afirmação é
        // contextual, não só a linha que menciona o wrapper.
        const windowLines = lines.slice(Math.max(0, i - 3), i + 3);
        if (!isUnnegatedForbiddenClaim(windowLines)) continue;
        assert.fail(
          `doc ${f.replace(ROOT + "/", "")}:` +
            ` linha ${i + 1} associa claude-openrouter.sh a termo proibido sem negação: "${line.trim()}"`,
        );
      }
    }
  });
});

// #6790: verbo negativo que desmente a afirmação — se aparecer na janela
// relevante (ver isUnnegatedForbiddenClaim), a frase é corretora, não
// assertiva.
const NEG_VERB =
  /\b(não|never|no|nenhum|sem|fora|errado|morto|obsoleto|removido|deixou|parou|não lê|não roteia|não resolve|não usa)\b/i;
const FORBIDDEN_CHAIN_SOURCE = /fallback_chains|coding_fallback|fallback_chain_key|smart_model_routing/;

/**
 * Pure (#6790): decide se `windowLines` (contexto de texto ao redor de uma
 * menção a "claude-openrouter") contém uma afirmação NÃO-NEGADA de que o
 * wrapper lê a cadeia de `config.yaml`/`fallback_chains`/`coding_fallback`
 * — `true` = violação (deve falhar o teste), `false` = ausente ou
 * corretora (isenta).
 *
 * Busca o verbo negativo a partir do PRIMEIRO dos dois marcadores (menção
 * ao wrapper OU ao termo proibido, o que vier antes no texto) até o fim da
 * janela. Nem "só depois do wrapper" nem "janela inteira" bastam sozinhos
 * — ver os 2 testes de regressão logo abaixo, que reproduzem os 2
 * contra-exemplos que derrubaram cada uma dessas versões anteriores.
 */
/** Corte grosseiro de sentenças (fim de frase = `.`/`!`/`?` seguido de
 *  espaço) — não lida com abreviações/URLs com ponto, aceitável pro escopo
 *  estreito deste guard (doc em prosa curta, não texto arbitrário). */
function sentenceBoundaries(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?]\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) ends.push(m.index + m[0].length);
  return ends;
}

export function isUnnegatedForbiddenClaim(windowLines: string[]): boolean {
  const window = windowLines.join(" ");
  const forbiddenMatch = FORBIDDEN_CHAIN_SOURCE.exec(window);
  if (!forbiddenMatch) return false;
  const wrapperIdx = window.indexOf("claude-openrouter");
  if (wrapperIdx === -1) return false;

  // A negação só conta se estiver na MESMA sentença de um dos 2 marcadores
  // (cobre "Não é verdade que claude-openrouter.sh usa X" — negação ANTES
  // do wrapper, mas na mesma frase) OU na sentença seguinte (cobre "X.
  // Isso está errado." — o padrão real do corpus, correção como frase
  // separada). Uma negação numa sentença ANTERIOR não-relacionada nunca
  // conta — é aí que "só depois do wrapper" e "janela inteira" erravam
  // cada um pra um lado (ver os 2 contra-exemplos abaixo).
  const ends = sentenceBoundaries(window);
  const startOfSentenceAt = (pos: number) => {
    let start = 0;
    for (const end of ends) {
      if (end <= pos) start = end;
      else break;
    }
    return start;
  };
  const endOfSentenceAt = (pos: number) => ends.find((end) => end > pos) ?? window.length;

  const firstIdx = Math.min(wrapperIdx, forbiddenMatch.index);
  const secondIdx = Math.max(wrapperIdx, forbiddenMatch.index);
  const spanStart = startOfSentenceAt(firstIdx);
  const spanEnd = endOfSentenceAt(endOfSentenceAt(secondIdx)); // sentença dos marcadores + a seguinte
  const relevant = window.slice(spanStart, spanEnd);
  return !NEG_VERB.test(relevant);
}

describe("isUnnegatedForbiddenClaim (#6790 — puro, os 3 cenários que derrubaram as 2 versões anteriores)", () => {
  it("frase corretora real do corpus (negação DEPOIS do wrapper e do termo proibido) → isenta", () => {
    const windowLines = [
      "**CORREÇÃO (30/08/2026).** A frase original desta seção dizia que o wrapper",
      "`claude-openrouter.sh` \"resolve via `fallback_chains.coding_fallback` em",
      "`~/.hermes/config.yaml`\". Isso está errado por DOIS motivos independentes, e",
    ];
    assert.equal(isUnnegatedForbiddenClaim(windowLines), false);
  });

  it("contra-exemplo do review: negação NÃO-RELACIONADA antes do wrapper não isenta uma afirmação genuinamente errada", () => {
    // Achado do review independente desta PR: a versão "janela inteira"
    // (descartada) deixava esta frase passar — a negação sobre roteamento
    // manual não tem nada a ver com a afirmação (falsa) que vem depois.
    const windowLines = [
      "O roteamento não é feito manualmente pelo editor.",
      "claude-openrouter.sh lê o fallback_chains do config.yaml pra decidir o modelo.",
    ];
    assert.equal(isUnnegatedForbiddenClaim(windowLines), true, "deve flagar — a negação anterior é de outro assunto");
  });

  it("negação ANTES do wrapper mas ligada à MESMA afirmação (o bug original do afterWrapper) → isenta", () => {
    const windowLines = ['Não é verdade que claude-openrouter.sh usa fallback_chains do config.yaml.'];
    assert.equal(isUnnegatedForbiddenClaim(windowLines), false);
  });

  it("sem menção ao wrapper → nunca viola (guard de entrada)", () => {
    assert.equal(isUnnegatedForbiddenClaim(["fallback_chains é usado em outro lugar qualquer"]), false);
  });

  it("sem termo proibido → nunca viola", () => {
    assert.equal(isUnnegatedForbiddenClaim(["claude-openrouter.sh roda MODELS_DEFAULT hardcoded"]), false);
  });
});
