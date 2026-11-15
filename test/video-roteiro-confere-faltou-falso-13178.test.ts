/**
 * test/video-roteiro-confere-faltou-falso-13178.test.ts (#13178)
 *
 * Na conferência da gravação da 261117, `video-roteiro-confere.ts` deu `faltou`
 * para H5, H10c, H13d e V2-G, as quatro ditas com outras palavras e listadas
 * como "trechos sem fala correspondente". A segunda passada
 * (`scripts/lib/diaria/roteiro-gravacao.ts`, `resgatarFala`) procura a fala
 * nesses trechos por radical e números antes de dar `faltou`.
 *
 * Fixture: a transcrição e o roteiro pré-gravação reais da 261117, copiados
 * de `data/editions/2611/261117/_internal/` para
 * `test/fixtures/roteiro-gravacao-261117-13178/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  conferirGravacao,
  mesmoRadical,
  validarRoteiroFalas,
  type RoteiroFalas,
} from "../scripts/lib/diaria/roteiro-gravacao.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test/fixtures/roteiro-gravacao-261117-13178");
const ROTEIRO_261117 = JSON.parse(readFileSync(join(FIX, "roteiro-falas-pre-gravacao.json"), "utf8")) as RoteiroFalas;
const TRANS_261117 = readFileSync(join(FIX, "gravacao-transcricao.txt"), "utf8");

function porId(r: ReturnType<typeof conferirGravacao>, id: string) {
  const f = r.falas.find((x) => x.id === id);
  assert.ok(f, `fala ${id} ausente`);
  return f;
}

describe("#13178: fala reformulada não sai faltou (fixture 261117)", () => {
  it("a fixture é um roteiro válido", () => {
    assert.deepEqual(validarRoteiroFalas(ROTEIRO_261117), []);
  });

  const r = conferirGravacao(ROTEIRO_261117, TRANS_261117);

  for (const id of ["H5", "H10c", "H13d", "V2-G"]) {
    it(`${id} sai diferente-mas-cabe, resgatada e para confirmar`, () => {
      const f = porId(r, id);
      assert.equal(f.veredito, "diferente-mas-cabe", `${f.veredito} ${f.cobertura} ${f.motivos.join("; ")}`);
      assert.equal(f.resgatada, true);
      assert.equal(f.confirmar, true);
      assert.ok(f.trecho.length > 0);
    });
  }

  it("os trechos casados são os ditos na gravação", () => {
    assert.match(porId(r, "H5").trecho, /agência Lupa pesquisou vídeos de 2017/);
    assert.match(porId(r, "H10c").trecho, /dois, três ou quatro remédios/);
    assert.match(porId(r, "H13d").trecho, /canal oficial do médico/);
    assert.match(porId(r, "V2-G").trecho, /vendendo cura/);
  });

  it("número que mudou na reformulação vira ressalva, não regravar (H5: 750)", () => {
    const h5 = porId(r, "H5");
    assert.deepEqual(h5.numerosAusentes, ["750"]);
    assert.ok(h5.motivos.some((m) => /750/.test(m) && /conferir se muda o sentido/.test(m)));
  });

  it("os trechos resgatados saem da lista de trechos sem fala", () => {
    for (const t of r.trechosSemFala) {
      assert.doesNotMatch(t, /agência Lupa pesquisou/);
      assert.doesNotMatch(t, /dois, três ou quatro remédios/);
      assert.doesNotMatch(t, /vendendo cura/);
    }
  });

  it("nenhuma fala da 261117 sobra como faltou", () => {
    assert.deepEqual(r.falas.filter((f) => f.veredito === "faltou").map((f) => f.id), []);
  });
});

describe("#13178: faltou genuíno continua faltou", () => {
  it("sem o trecho da H10c na transcrição, a H10c sai faltou", () => {
    const trans = TRANS_261117.replace(/Esses golpes também tiram vantagem[^?]*\?/, "");
    assert.notEqual(trans, TRANS_261117, "o trecho da H10c tem de estar na fixture");
    const h10c = porId(conferirGravacao(ROTEIRO_261117, trans), "H10c");
    assert.equal(h10c.veredito, "faltou", `${h10c.veredito} "${h10c.trecho}"`);
    assert.notEqual(h10c.resgatada, true);
  });

  it("trecho sem fala sobre outro assunto não resgata a fala que faltou", () => {
    const roteiro: RoteiroFalas = {
      falas: [
        { id: "H1", texto: "O banco lançou um assistente de IA para os clientes.", videos: ["horizontal"] },
        { id: "H2", texto: "Tratar diabetes costuma pedir dois, três, quatro remédios por dia.", videos: ["horizontal"] },
      ],
    };
    const trans =
      "o banco lançou um assistente de IA para os clientes. " +
      "Agora deixa eu ajustar a luz aqui, acho que a câmera desligou de novo, espera um pouco que eu já volto.";
    const r = conferirGravacao(roteiro, trans);
    assert.equal(porId(r, "H1").veredito, "ok");
    assert.equal(porId(r, "H2").veredito, "faltou");
    assert.equal(r.pronto, false);
  });

  it("resgate não rouba palavra de fala já casada", () => {
    // #12781: H2 só tem palavras de H1 e H3, que foram gravadas; nada sobra sem dono.
    const roteiro: RoteiroFalas = {
      falas: [
        { id: "H1", texto: "O banco lançou um assistente de IA para os clientes.", videos: ["horizontal"] },
        { id: "H2", texto: "O assistente de IA atende os clientes do banco.", videos: ["horizontal"] },
        { id: "H3", texto: "Os clientes reclamam que o atendimento piorou desde então.", videos: ["horizontal"] },
      ],
    };
    const r = conferirGravacao(roteiro, "o banco lançou um assistente de IA para os clientes os clientes reclamam que o atendimento piorou desde então");
    assert.equal(porId(r, "H2").veredito, "faltou");
  });

  it("fala resgatada com o veículo citado no trecho sai regravar", () => {
    const roteiro: RoteiroFalas = {
      veiculos: ["The Verge"],
      falas: [
        { id: "H1", texto: "O banco lançou um assistente de IA para os clientes.", videos: ["horizontal"] },
        { id: "H2", texto: "Tratar diabetes costuma pedir dois, três, quatro remédios por dia.", videos: ["horizontal"] },
      ],
    };
    const trans =
      "o banco lançou um assistente de IA para os clientes. " +
      "Tem gente que se trata, segundo o The Verge, com dois, três ou quatro remédios.";
    const h2 = porId(conferirGravacao(roteiro, trans), "H2");
    assert.equal(h2.resgatada, true);
    assert.equal(h2.veredito, "regravar");
    assert.deepEqual(h2.veiculosCitados, ["The Verge"]);
  });
});

describe("mesmoRadical (#13178)", () => {
  it("casa flexão e radical comum", () => {
    assert.ok(mesmoRadical("falsas", "falsos"));
    assert.ok(mesmoRadical("cansada", "cansaco"));
    assert.ok(mesmoRadical("pai", "pais"));
    assert.ok(mesmoRadical("nove", "9"));
  });
  it("não casa palavra diferente nem número diferente", () => {
    assert.ok(!mesmoRadical("video", "vida"));
    assert.ok(!mesmoRadical("750", "75"));
    assert.ok(!mesmoRadical("seu", "sua"));
  });
});
