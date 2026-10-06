/**
 * #9753 — três defeitos do derive-editor-requests:
 * 1. diff do `01-approved.json` posicional (reorder virava 2× destaque-swap;
 *    swap real contava 2x somado ao da newsletter);
 * 2. URL trocada da mesma página, só na linha de título, virava title-choice;
 * 3. CRLF no `02-reviewed.md` jogava o arquivo inteiro em `intro`/`other`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyApprovedDiff, classifyNewsletterDiff, dedupeDestaqueSwaps } from "../scripts/derive-editor-requests.ts";

const U1 = "https://example.com/a-um";
const U2 = "https://example.com/b-dois";
const U3 = "https://example.com/c-tres";
const U4 = "https://example.com/d-quatro";

const approved = (urls: string[]) =>
  JSON.stringify({ highlights: urls.map((url, i) => ({ article: { url, title: `T${i + 1}-${url.slice(-4)}` } })) });

const types = (out: Array<{ request_type: string; target: string }>) => out.map((r) => `${r.target}:${r.request_type}`);

describe("classifyApprovedDiff casa destaques por URL (#9753 item 1)", () => {
  it("reordenação pura D1↔D3 → só section-order, nenhum destaque-swap", () => {
    const out = classifyApprovedDiff(approved([U1, U2, U3]), approved([U3, U2, U1]));
    assert.deepEqual(types(out), ["newsletter:section-order"]);
  });

  it("swap real no D2 → 1 destaque-swap no d2", () => {
    const out = classifyApprovedDiff(approved([U1, U2, U3]), approved([U1, U4, U3]));
    assert.deepEqual(types(out), ["d2:destaque-swap"]);
    assert.equal((out[0].context as any).old_url, U2);
    assert.equal((out[0].context as any).new_url, U4);
  });

  it("swap + reordenação: item novo no topo, antigos descem → 1 swap no slot do item novo", () => {
    const out = classifyApprovedDiff(approved([U1, U2, U3]), approved([U4, U1, U2]));
    assert.deepEqual(types(out), ["d1:destaque-swap"]);
    assert.equal((out[0].context as any).old_url, U3);
  });

  it("mesma página com query/www diferente não é troca", () => {
    const out = classifyApprovedDiff(approved([U1, U2]), approved([U1.replace("https://", "https://www.") + "?utm_source=x", U2]));
    assert.deepEqual(out, []);
  });

  it("corte do D2 (3→2) aponta o item que saiu, não a cauda posicional", () => {
    const out = classifyApprovedDiff(approved([U1, U2, U3]), approved([U1, U3]));
    assert.deepEqual(types(out), ["d2:destaque-cut"]);
    assert.equal((out[0].context as any).old_url, U2);
  });
});

describe("dedupeDestaqueSwaps — swap real conta 1x (#9753 item 1)", () => {
  const d = (n: number, title: string, url: string) =>
    [`**DESTAQUE ${n} | 🚀 LANÇAMENTO**`, `**[${title}](${url})**`, "Por que isso importa: texto estável.", ""].join("\n");

  it("newsletter + approved registrando a mesma troca → 1 destaque-swap", () => {
    const nl = classifyNewsletterDiff(d(1, "Título A", U1), d(1, "Título D", U4));
    const ap = classifyApprovedDiff(approved([U1]), approved([U4]));
    const all = dedupeDestaqueSwaps([...nl, ...ap]);
    assert.deepEqual(types(all), ["d1:destaque-swap"]);
    assert.equal((all[0].context as any).change_kind, "item-trocado"); // a da newsletter fica
  });

  it("reordenação: newsletter dá section-order e o approved não acrescenta swap", () => {
    const old = [d(1, "Título A", U1), d(2, "Título B", U2), d(3, "Título C", U3)].join("\n");
    const neu = [d(1, "Título C", U3), d(2, "Título B", U2), d(3, "Título A", U1)].join("\n");
    const all = dedupeDestaqueSwaps([
      ...classifyNewsletterDiff(old, neu),
      ...classifyApprovedDiff(approved([U1, U2, U3]), approved([U3, U2, U1])),
    ]);
    assert.equal(all.filter((r) => r.request_type === "destaque-swap").length, 0);
  });

  it("swap só no approved (newsletter não viu) é mantido", () => {
    const ap = classifyApprovedDiff(approved([U1, U2]), approved([U1, U4]));
    assert.deepEqual(types(dedupeDestaqueSwaps(ap)), ["d2:destaque-swap"]);
  });
});

describe("classifyNewsletterDiff — link trocado da mesma página (#9753 item 2)", () => {
  it("só a query muda na linha de título → link-swap link-trocado, não title-choice", () => {
    const line = (url: string) => ["**DESTAQUE 1 | 🚀 LANÇAMENTO**", `**[Título A](${url})**`, "Por que isso importa: x.", ""].join("\n");
    const out = classifyNewsletterDiff(line(U1), line(`${U1}?utm_source=diaria`));
    assert.deepEqual(
      out.map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`),
      ["d1:link-swap:link-trocado"],
    );
  });
});

describe("classifyNewsletterDiff — CRLF (#9753 item 3)", () => {
  const body = (title: string) =>
    ["**DESTAQUE 1 | 🚀 LANÇAMENTO**", `**[${title}](${U1})**`, "Por que isso importa: x.", "", "**📡 RADAR**", "item", ""].join("\n");

  it("arquivo novo em CRLF com título reescrito → seção destaque-1, nunca intro/other", () => {
    const out = classifyNewsletterDiff(body("Título A"), body("Título A novo").replace(/\n/g, "\r\n"));
    assert.deepEqual(out.map((r) => `${r.target}:${r.request_type}`), ["d1:title-choice"]);
  });

  it("só o fim de linha muda → nenhum pedido", () => {
    assert.deepEqual(classifyNewsletterDiff(body("Título A"), body("Título A").replace(/\n/g, "\r\n")), []);
  });
});
