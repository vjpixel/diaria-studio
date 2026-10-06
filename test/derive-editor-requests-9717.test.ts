/**
 * #9717 — o detector casa destaques por URL, não por posição: troca de item,
 * reordenação, título reescrito e categoria trocada deixam de virar "title-choice".
 * Fixtures sintéticas no formato das edições 261005/261006 (data/ não vai pro CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff } from "../scripts/derive-editor-requests.ts";

const U1 = "https://example.com/a-um";
const U2 = "https://example.com/b-dois";
const U3 = "https://example.com/c-tres";
const U4 = "https://example.com/d-quatro";

function d(n: number, label: string, title: string, url: string): string {
  return [`**DESTAQUE ${n} | ${label}**`, `**[${title}](${url})**`, "Por que isso importa: texto estável.", ""].join("\n");
}
const kinds = (a: string, b: string) =>
  classifyNewsletterDiff(a, b).map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`);

describe("classifyNewsletterDiff por URL (#9717)", () => {
  it("item trocado → destaque-swap, não title-choice", () => {
    const old = d(1, "🚀 LANÇAMENTO", "Título A", U1);
    const neu = d(1, "🚀 LANÇAMENTO", "Título D", U4);
    assert.deepEqual(kinds(old, neu), ["d1:destaque-swap:item-trocado"]);
  });

  it("reordenação (D3 vira D1) → section-order nas duas posições, nenhum title-choice", () => {
    const old = [d(1, "🚀 LANÇAMENTO", "Título A", U1), d(2, "🔬 PESQUISA", "Título B", U2), d(3, "⚠️ IMPACTO", "Título C", U3)].join("\n");
    const neu = [d(1, "⚠️ IMPACTO", "Título C", U3), d(2, "🚀 LANÇAMENTO", "Título A", U1), d(3, "🔬 PESQUISA", "Título B", U2)].join("\n");
    const out = kinds(old, neu);
    assert.equal(out.length, 3);
    assert.ok(out.every((k) => k.endsWith(":section-order:reordenado")), out.join(","));
  });

  it("mesma URL, título reescrito → title-choice titulo-reescrito", () => {
    assert.deepEqual(
      kinds(d(1, "🚀 LANÇAMENTO", "Título A", U1), d(1, "🚀 LANÇAMENTO", "Título A novo", U1)),
      ["d1:title-choice:titulo-reescrito"],
    );
  });

  it("só o rótulo da categoria muda → bucket-move categoria-trocada", () => {
    assert.deepEqual(
      kinds(d(1, "🚀 LANÇAMENTO", "Título A", U1), d(1, "🔬 PESQUISA", "Título A", U1)),
      ["d1:bucket-move:categoria-trocada"],
    );
  });

  it("P2: título reescrito + 'Por que isso importa' reescrito → lead-rewrite, não title-choice", () => {
    const old = d(1, "🚀 LANÇAMENTO", "Título A", U1);
    const neu = old.replace("Título A", "Título A novo").replace("texto estável.", "outro texto.");
    const out = classifyNewsletterDiff(old, neu).map((r) => r.request_type);
    assert.deepEqual(out, ["lead-rewrite"]);
  });

  it("P2: título reescrito + corte grande → length-cut", () => {
    const old = d(1, "🚀 LANÇAMENTO", "Título A", U1).replace("texto estável.", "x".repeat(400));
    const neu = d(1, "🚀 LANÇAMENTO", "Título A novo", U1);
    assert.deepEqual(classifyNewsletterDiff(old, neu).map((r) => r.request_type), ["length-cut"]);
  });

  it("P2: mover + trocar juntos (D1=A,D2=B → D1=B,D2=X) → item-trocado, não só reordenado", () => {
    const old = [d(1, "🚀 LANÇAMENTO", "Título A", U1), d(2, "🔬 PESQUISA", "Título B", U2)].join("\n");
    const neu = [d(1, "🔬 PESQUISA", "Título B", U2), d(2, "🚀 LANÇAMENTO", "Título X", U4)].join("\n");
    const out = kinds(old, neu);
    assert.deepEqual(out, ["d1:destaque-swap:item-trocado", "d2:destaque-swap:item-trocado"]);
  });
});
