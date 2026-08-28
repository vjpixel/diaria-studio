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
import { readFileSync } from "node:fs";
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
});
