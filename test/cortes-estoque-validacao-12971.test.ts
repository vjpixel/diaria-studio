/**
 * #12971: `registrarExtras` engolia qualquer exceção do `addAgendamento` no
 * item que já existia, inclusive a de validação (alvo ou dono inválido), e
 * reportava `mantido` com "já existe com outros dados": o erro real sumia e o
 * item ficava sem o agendamento certo. Regressão: só a divergência de dados
 * vira `mantido`; erro de validação sobe, como no item novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { brtAlvoIso, emptyBanco, type NovoAgendamento } from "../scripts/lib/diaria/agendamentos.ts";
import { registrarExtras } from "../scripts/lib/diaria/cortes-estoque.ts";

const T0 = new Date("2026-11-10T22:00:00Z");
const NOVO: NovoAgendamento = {
  edicao: "261110",
  peca: "corte-nvidia",
  destinos: ["youtube_shorts", "instagram"],
  alvo: brtAlvoIso("261111", "08:00"),
  dono: "/diaria-publica 261111",
  estado: "pendente",
};

describe("registrarExtras: item existente (#12971)", () => {
  const { banco } = registrarExtras(emptyBanco(), [NOVO], T0);

  it("alvo inválido para um item que já existe lança (não vira mantido)", () => {
    assert.throws(() => registrarExtras(banco, [{ ...NOVO, alvo: "amanhã às 8" }], T0), /alvo: instante ISO inválido/);
  });

  it("dono vazio para um item que já existe lança", () => {
    assert.throws(() => registrarExtras(banco, [{ ...NOVO, dono: "  " }], T0), /dono: vazio/);
  });

  it("mesmos dados (destinos em outra ordem) = já registrado; alvo diferente = mantido", () => {
    const igual = registrarExtras(banco, [{ ...NOVO, destinos: [...NOVO.destinos].reverse() }], T0);
    assert.deepEqual(igual.resultados.map((r) => r.status), ["ja-registrado"]);
    const outro = registrarExtras(banco, [{ ...NOVO, alvo: brtAlvoIso("261113", "08:00") }], T0);
    assert.deepEqual(outro.resultados.map((r) => r.status), ["mantido"]);
    assert.equal(outro.banco, banco);
  });
});
