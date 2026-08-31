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
  // escaparia da detecção e viraria falso-positivo de violação. No
  // corpus atual isso não se manifestou por coincidência (a correção
  // real de tick-20260828-*.md usa "está errado" DEPOIS da menção ao
  // wrapper, dentro da mesma janela) — mas a fragilidade é real e
  // independente de conteúdo específico. Buscar a negação na JANELA
  // INTEIRA (não só depois do wrapper) fecha essa direção sem abrir
  // a oposta: a janela já é estreita (3 linhas atrás, 2 à frente),
  // então uma negação em qualquer lugar dela ainda está perto o
  // bastante da afirmação pra ser plausivelmente a mesma frase.
  // -----------------------------------------------------------------------

  it("nenhum doc afirma que claude-openrouter.sh lê config.yaml / fallback_chains / coding_fallback (#6790)", () => {
    const REF_DIR = join(ROOT, "hermes/skills/hermes-diaria-continuo/references");
    const SKILL_MD = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

    // Verbo negativo que desmente a afirmação — se aparecer na janela da
    // frase, ela é corretora, não assertiva.
    const NEG_VERB =
      /\b(não|never|no|nenhum|sem|fora|errado|morto|obsoleto|removido|deixou|parou|não lê|não roteia|não resolve|não usa)\b/i;

    const files = [SKILL_MD, ...readdirSync(REF_DIR).map((f) => join(REF_DIR, f))].filter((f) =>
      f.endsWith(".md"),
    );

    const FORBIDDEN = /fallback_chains|coding_fallback|fallback_chain_key|smart_model_routing/;

    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("claude-openrouter")) continue;
        // Janela de 3 linhas pra trás e 2 pra frente: a afirmação é
        // contextual, não só a linha que menciona o wrapper.
        const window = lines.slice(Math.max(0, i - 3), i + 3).join(" ");
        if (!FORBIDDEN.test(window)) continue;
        // Procurar verbo negativo na JANELA INTEIRA — não só depois do
        // wrapper (ver achado no comentário acima do teste).
        if (NEG_VERB.test(window)) continue; // frase corretora
        assert.fail(
          `doc ${f.replace(ROOT + "/", "")}:` +
            ` linha ${i + 1} associa claude-openrouter.sh a termo proibido sem negação: "${line.trim()}"`,
        );
      }
    }
  });
});
