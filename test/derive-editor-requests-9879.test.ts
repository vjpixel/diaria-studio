/**
 * #9879/#9880 — seções de pool (USE MELHOR, LANÇAMENTOS, RADAR) não geram
 * mais "title-choice" nem "length-cut" quando o editor corta/troca ITENS.
 *
 * Medição nos diffs reais (stage2-post-gate × 02-reviewed.md, 260930..261008):
 * 31 itens de pool cortados e 0 descrições encurtadas; o "length-cut" vinha
 * da seção encolher >30% por item removido, e o "title-choice" do radar/
 * use-melhor/lancamentos vinha da 1ª linha `**[` mudar quando o 1º item saía.
 * Fixtures sintéticas no formato real de 261007 (data/ não vai pro CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff, classifyPoolItemSetChange } from "../scripts/derive-editor-requests.ts";

function item(title: string, url: string, desc: string): string {
  return [`**[${title}](${url})**  `, desc, ""].join("\n");
}
function section(header: string, items: string[]): string {
  return ["---", "", header, "", ...items, "---", ""].join("\n");
}

const A = item("Como usar IA para produtividade", "https://querobolsa.com.br/revista/como-usar-ia", "Guia com usos de ChatGPT, Claude e Gemini em tarefas do dia a dia profissional. (10 min)");
const B = item("Ideias de mochila maluca infantil", "https://www.techtudo.com.br/guia/2026/10/mochila.ghtml", "Entenda como funciona a trend que está bombando nas redes sociais e crie a sua. (15 min)");
const C = item("Claude Code Mods Tutorial", "https://app.therundown.ai/guides/claude-code-mods-tutorial", "Aprenda a usar os mods do Claude Code para incluir uma pergunta de revisão. (10 min)");
const D = item("Incident Command Dashboard with ChatGPT Sites", "https://www.chatprd.ai/how-i-ai/workflows/dashboard", "Monte com o ChatGPT Sites um painel em tempo real para coordenar incidentes. (5 min)");
const E = item("Decisions API is now available", "https://community.openai.com/t/decisions-api/1403877", "A Decisions API entrou em beta público para todos os desenvolvedores.");

const kinds = (a: string, b: string) =>
  classifyNewsletterDiff(a, b).map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`);

describe("pool: corte/troca de item não é title-choice nem length-cut (#9879/#9880)", () => {
  it("USE MELHOR 4→2 (caso real 261007) → pool-cut, não length-cut", () => {
    const old = section("**🛠️ USE MELHOR**", [A, B, C, D]);
    const neu = section("**🛠️ USE MELHOR**", [A, C]);
    assert.deepEqual(kinds(old, neu), ["use-melhor:pool-cut:itens-cortados"]);
  });

  it("1º item do RADAR cortado (caso real 261008) → pool-cut, não title-choice", () => {
    const old = section("**📡 RADAR**", [E, A, B]);
    const neu = section("**📡 RADAR**", [A, B]);
    const out = classifyNewsletterDiff(old, neu);
    assert.deepEqual(out.map((r) => r.request_type), ["pool-cut"]);
    assert.equal((out[0].context as any).items_removed, 1);
    assert.equal((out[0].context as any).items_added, 0);
  });

  it("item trocado por outro no LANÇAMENTOS → link-swap itens-trocados", () => {
    const old = section("**🚀 LANÇAMENTOS**", [A, B, C]);
    const neu = section("**🚀 LANÇAMENTOS**", [D, B]);
    assert.deepEqual(kinds(old, neu), ["lancamentos:link-swap:itens-trocados"]);
  });

  it("item adicionado → pool-add", () => {
    assert.deepEqual(kinds(section("**📡 RADAR**", [A]), section("**📡 RADAR**", [A, B])), ["radar:pool-add:itens-adicionados"]);
  });

  it("mesmos itens, descrição encurtada >30% → length-cut continua valendo", () => {
    const longA = item("Como usar IA para produtividade", "https://querobolsa.com.br/revista/como-usar-ia", "x".repeat(600));
    const shortA = item("Como usar IA para produtividade", "https://querobolsa.com.br/revista/como-usar-ia", "x".repeat(100));
    assert.deepEqual(kinds(section("**🛠️ USE MELHOR**", [longA]), section("**🛠️ USE MELHOR**", [shortA])), ["use-melhor:length-cut:"]);
  });

  it("mesmos itens com tracking diferente na URL → conjunto igual (null)", () => {
    const withUtm = A.replace("como-usar-ia)", "como-usar-ia?utm_source=x)");
    assert.equal(classifyPoolItemSetChange(section("**📡 RADAR**", [A]), section("**📡 RADAR**", [withUtm])), null);
  });

  it("destaque com título reescrito na mesma URL segue title-choice (não regrediu #9717)", () => {
    const d = (t: string) => ["**DESTAQUE 1 | 🚀 LANÇAMENTO**", `**[${t}](https://example.com/a)**`, "Por que isso importa: texto.", ""].join("\n");
    assert.deepEqual(kinds(d("Título A"), d("Título A novo")), ["d1:title-choice:titulo-reescrito"]);
  });
});
