import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { segmentosSemTrechos, validarRoteiroFalas, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { duracaoPorVideo, propostaBlocosDoRoteiro } from "../scripts/lib/diaria/roteiro-videos.ts";
import { renderRoteiroPagina } from "../scripts/lib/diaria/roteiro-pagina.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const TEXTO = "O programa abre hoje. Mais quatro países da Ásia também. Isso vale a partir do dia 19, quando a regra sai oficialmente. Fim.";
const A = "Mais quatro países da Ásia também.";
const B = "Isso vale a partir do dia 19, quando a regra sai oficialmente.";

function roteiro(cortes: unknown): RoteiroFalas {
  const r: RoteiroFalas = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const f = r.falas.find((x) => x.id === "H4")!;
  f.texto = TEXTO;
  delete (f as { cortes?: unknown }).cortes;
  (f as { cortes?: unknown }).cortes = cortes;
  return r;
}

describe("#13436: mais de um corte por vídeo na mesma fala", () => {
  it("segmentosSemTrechos tira os dois trechos", () => {
    assert.deepEqual(segmentosSemTrechos(TEXTO, [A, B]), ["O programa abre hoje.", "Fim."]);
    assert.equal(segmentosSemTrechos(TEXTO, [A, "inexistente"]), null);
  });
  it("lista de cortes valida; formato antigo segue valendo", () => {
    const r = roteiro({ vertical1: [A, { trecho: B, reserva: true }] });
    assert.deepEqual(validarRoteiroFalas(r), []);
    assert.deepEqual(validarRoteiroFalas(roteiro({ vertical1: A })), []);
  });
  it("recusa trecho ausente, sobreposto e lista vazia", () => {
    assert.match(validarRoteiroFalas(roteiro({ vertical1: [A, "nada disso"] })).join("\n"), /cortes\.vertical1\[1\]: trecho não aparece/);
    assert.match(validarRoteiroFalas(roteiro({ vertical1: [A, "países da Ásia também. Isso"] })).join("\n"), /se sobrepõem/);
    assert.match(validarRoteiroFalas(roteiro({ vertical1: [] })).join("\n"), /lista vazia/);
  });
  it("duração: os dois cortes fixos saem da conta; reserva não", () => {
    const duas = duracaoPorVideo(roteiro({ vertical1: [A, B] })).find((d) => d.video === "vertical1")!;
    const sem = duracaoPorVideo(roteiro(undefined)).find((d) => d.video === "vertical1")!;
    const uma = duracaoPorVideo(roteiro({ vertical1: [A] })).find((d) => d.video === "vertical1")!;
    assert.ok(duas.palavras < uma.palavras && uma.palavras < sem.palavras);
    const reserva = duracaoPorVideo(roteiro({ vertical1: [{ trecho: A, reserva: true }, { trecho: B, reserva: true }] })).find((d) => d.video === "vertical1")!;
    assert.equal(reserva.palavras, sem.palavras);
  });
  it("página marca os dois; montagem aplica os fixos e lista a reserva", () => {
    const r = roteiro({ vertical1: [A, { trecho: B, reserva: true }] });
    const html = renderRoteiroPagina(r);
    assert.match(html, /<del[^>]*>Mais quatro países da Ásia também\.<\/del>/);
    assert.match(html, /<span class="reserva"[^>]*>Isso vale a partir do dia 19/);
    const p = propostaBlocosDoRoteiro(r);
    const f = p.sequencias.find((s) => s.video === "vertical1")!.falas.find((x) => x.id === "H4")!;
    assert.equal(f.cortado, A);
    assert.ok(!f.texto.includes("Ásia"));
    const res = p.cortesReserva.find((c) => c.id === "H4")!;
    assert.equal(res.trecho, B);
    assert.ok(!res.segmentos.join(" ").includes("Ásia") && !res.segmentos.join(" ").includes("dia 19"));
    // O item que a reserva troca é o que já vai ao ar depois do corte fixo (achado do review).
    assert.equal(res.texto, "Isso vale a partir do dia 19, quando a regra sai oficialmente. Fim.");
    assert.deepEqual(res.segmentos, ["Fim."]);
  });
});

describe("#13436 (review): trechos com vírgula encostada, em qualquer ordem", () => {
  const VIRG = "Primeiro isto, depois aquilo, por fim o resto.";
  const VIRG_MEIO = "Primeiro isto, depois aquilo, e mais isso, por fim o resto.";
  function comTexto(texto: string, cortes: unknown): RoteiroFalas {
    const r = roteiro(cortes);
    r.falas.find((x) => x.id === "H4")!.texto = texto;
    return r;
  }
  const h4 = (r: RoteiroFalas) => propostaBlocosDoRoteiro(r).sequencias.find((s) => s.video === "vertical1")!.falas.find((x) => x.id === "H4")!;

  it("o resultado não depende da ordem da lista", () => {
    assert.deepEqual(segmentosSemTrechos(VIRG, ["por fim o resto.", "depois aquilo,"]), ["Primeiro isto."]);
    assert.deepEqual(segmentosSemTrechos(VIRG, ["depois aquilo,", "por fim o resto."]), ["Primeiro isto."]);
    assert.deepEqual(segmentosSemTrechos(VIRG_MEIO, ["e mais isso,", "depois aquilo,"]), ["Primeiro isto", "por fim o resto."]);
    assert.deepEqual(segmentosSemTrechos(VIRG_MEIO, ["depois aquilo,", "e mais isso,"]), ["Primeiro isto", "por fim o resto."]);
  });

  it("validador aceita e a montagem aplica os dois cortes (nunca a fala inteira)", () => {
    for (const cortes of [["por fim o resto.", "depois aquilo,"], ["depois aquilo,", "por fim o resto."]]) {
      const r = comTexto(VIRG, { vertical1: cortes });
      assert.deepEqual(validarRoteiroFalas(r), []);
      assert.equal(h4(r).texto, "Primeiro isto.");
      const d = duracaoPorVideo(r).find((x) => x.video === "vertical1")!;
      const sem = duracaoPorVideo(comTexto(VIRG, undefined)).find((x) => x.video === "vertical1")!;
      assert.equal(sem.palavras - d.palavras, 6);
    }
  });

  it("reserva encostada no corte fixo é localizada no texto original", () => {
    const r = comTexto(VIRG, { vertical1: ["por fim o resto.", { trecho: "depois aquilo,", reserva: true }] });
    assert.deepEqual(validarRoteiroFalas(r), []);
    const p = propostaBlocosDoRoteiro(r);
    const res = p.cortesReserva.filter((c) => c.id === "H4" && c.video === "vertical1");
    assert.equal(res.length, 1);
    assert.equal(res[0].texto, "Primeiro isto, depois aquilo.");
    assert.deepEqual(res[0].segmentos, ["Primeiro isto."]);
    assert.ok(!p.avisos.some((a) => a.startsWith("H4:")));
  });

  it("duas reservas no mesmo pedaço viram uma entrada só (achado P3 do review)", () => {
    const r = roteiro({ vertical1: [{ trecho: A, reserva: true }, { trecho: B, reserva: true }] });
    const res = propostaBlocosDoRoteiro(r).cortesReserva.filter((c) => c.id === "H4" && c.video === "vertical1");
    assert.equal(res.length, 1);
    assert.equal(res[0].texto, TEXTO);
    assert.equal(res[0].trecho, `${A} / ${B}`);
    assert.deepEqual(res[0].segmentos, ["O programa abre hoje.", "Fim."]);
  });
});
