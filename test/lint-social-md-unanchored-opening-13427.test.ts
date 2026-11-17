/**
 * #13427: lintUnanchoredOpening — 1ª frase de `## d{N}` / `## d{N}-cards`
 * precisa se sustentar sozinha. Caso real: edição 261118, D3 ("O estudo parte
 * de um alerta", introduzido pela passada do humanizador).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintUnanchoredOpening, runStage2SocialLintReport } from "../scripts/lint-social-md.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mkMd(sections: Record<string, string>): string {
  const body = Object.entries(sections)
    .map(([k, v]) => `## ${k}\n\n${v}\n`)
    .join("\n");
  return `# Social\n\n${body}\n# Curto\n\n## d1\n\nO estudo parte de um alerta.\n`;
}

describe("lintUnanchoredOpening (#13427)", () => {
  it("flaga o texto real da 261118 na legenda e no card", () => {
    const md = mkMd({
      d3: "O estudo parte de um alerta: modelos de IA já resolvem tarefas de nível de doutorado.\n\n#InteligenciaArtificial",
      "d3-cards": "**O estudo parte de um alerta**: modelos já resolvem tarefas difíceis.\n\nSegundo parágrafo.",
    });
    const r = lintUnanchoredOpening(md);
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches.map((m) => m.section), ["d3", "d3-cards"]);
    assert.match(r.matches[0].opener, /^O estudo/i);
  });

  it("flaga demonstrativo e substantivo genérico sem qualificador", () => {
    const md = mkMd({
      d1: "Isso muda a rotina de quem usa o modelo.",
      d2: "A empresa anunciou um corte de vagas.",
    });
    assert.equal(lintUnanchoredOpening(md).matches.length, 2);
  });

  it("não flaga aberturas autossuficientes", () => {
    const md = mkMd({
      d1: "A Anthropic lançou um modelo que roda direto no navegador, sem enviar nada pra nuvem.",
      d2: "O estudo da Stanford com 1.200 empresas mostra que vagas júnior caíram 13%.",
      "d2-cards": "Em 2025, 40% das vagas de programação júnior sumiram nos EUA.",
      d3: "O GPT-5 passou a recusar pedidos de médicos em 3 hospitais.",
    });
    assert.deepEqual(lintUnanchoredOpening(md).matches, []);
  });

  it("só olha a 1ª frase: antecedente dentro da seção não acusa a 2ª", () => {
    const md = mkMd({ d1: "A OpenAI publicou um estudo sobre agentes. O estudo mede 12 tarefas." });
    assert.deepEqual(lintUnanchoredOpening(md).matches, []);
  });

  it("ignora seções fora de d{N} (Curto, post_pixel)", () => {
    const md = "# Social\n\n## post_pixel\n\nO estudo parte de um alerta.\n";
    assert.deepEqual(lintUnanchoredOpening(md).matches, []);
  });

  it("entra no relatório do Stage 2 como warn-only sem derrubar passed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-13427-"));
    try {
      writeFileSync(join(dir, "03-social.md"), mkMd({ d3: "O estudo parte de um alerta." }));
      const rep = runStage2SocialLintReport(dir);
      const c = rep.checks.find((x) => x.id === "no-unanchored-opening");
      assert.ok(c);
      assert.equal(c.severity, "warn-only");
      assert.equal(c.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
