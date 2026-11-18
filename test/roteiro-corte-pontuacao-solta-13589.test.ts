/**
 * #13589: o trecho que sobra de um corte (#13129) nunca começa com pontuação
 * solta. Caso real da proposta da 261118: o corte parava antes do ponto e o
 * item da vertical saía ". Duas já aconteceram…".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { segmentosSemTrecho, segmentosSemTrechos } from "../scripts/lib/diaria/roteiro-gravacao.ts";

describe("#13589: o que sobra do corte não começa com pontuação solta", () => {
  it("corte no começo que para antes do ponto (caso da 261118)", () => {
    assert.deepEqual(
      segmentosSemTrecho("Três coisas vão mudar o mercado. Duas já aconteceram.", "Três coisas vão mudar o mercado"),
      ["Duas já aconteceram."],
    );
  });

  it("corte no meio que para antes do ponto: o lado de depois sai limpo", () => {
    assert.deepEqual(
      segmentosSemTrecho("O modelo chegou hoje. Ele custa 20 dólares! Duas empresas já usam.", "Ele custa 20 dólares"),
      ["O modelo chegou hoje.", "Duas empresas já usam."],
    );
  });

  it("reticências, interrogação e travessão soltos também saem", () => {
    assert.deepEqual(segmentosSemTrecho("Isso muda tudo… E agora?", "Isso muda tudo"), ["E agora?"]);
    assert.deepEqual(segmentosSemTrecho("Vale a pena? Depende do uso.", "Vale a pena"), ["Depende do uso."]);
    assert.deepEqual(segmentosSemTrecho("O Gemini 4 — que saiu ontem — já está no app.", "O Gemini 4"), ["que saiu ontem — já está no app."]);
  });

  it("pedaço entre dois cortes também sai limpo (#13436)", () => {
    assert.deepEqual(
      segmentosSemTrechos("Primeiro isto. Depois aquilo. Por fim o resto. Fim.", ["Primeiro isto", "Por fim o resto"]),
      ["Depois aquilo.", "Fim."],
    );
  });

  it("número negativo no começo do que sobra fica intacto", () => {
    assert.deepEqual(segmentosSemTrecho("A temperatura caiu: -5 graus hoje.", "A temperatura caiu:"), ["-5 graus hoje."]);
  });
});
