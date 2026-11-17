import { it } from "node:test";
import assert from "node:assert/strict";
import { avisosTomConversacional } from "../scripts/lib/diaria/roteiro-videos.ts";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";

const roteiro = (texto: string, videos: string[] = ["horizontal"]): RoteiroFalas =>
  ({ falas: [{ id: "H1", bloco: "comentario", texto, videos }] }) as RoteiroFalas;

// Trechos reais da v2 da 261118 (registro escrito).
const V2 = "O Jensen Huang declarou que deixa o cargo de CEO da Nvidia e saiu do conselho da empresa. O governo Trump publicou uma norma nova sobre a exportação de chips de inteligência artificial. O alvo da norma são data centers fora dos Estados Unidos que deixam empresas chinesas usar esses chips. A empresa informou isso não é proibição.";

it("avisa registro escrito da v2 da 261118: verbo formal e vídeo sem marca de fala", () => {
  const avisos = avisosTomConversacional(roteiro(V2));
  assert.ok(avisos.some((a) => /^H1: verbo de relatório \(declarou, publicou, informou\)/.test(a)));
  assert.ok(avisos.some((a) => /sem nenhuma marca de fala/.test(a)));
});

it("a reescrita em tom de conversa (v3) não gera aviso de marca", () => {
  const v3 = "O Jensen Huang largou o cargo de CEO da Nvidia. Saiu do conselho também. O governo Trump soltou uma regra nova pra venda de chips de IA. A ideia é fechar uma brecha: tem empresa chinesa contratando data center fora dos Estados Unidos pra usar esses chips. Calma, não é proibição.";
  assert.deepEqual(avisosTomConversacional(roteiro(v3)), []);
});

it("peça curta sem marca não avisa; vídeo é avaliado só com as falas dele", () => {
  assert.deepEqual(avisosTomConversacional(roteiro("Ele conta o caso.")), []);
  const avisos = avisosTomConversacional(roteiro(V2, ["vertical1"]));
  assert.ok(avisos.some((a) => /^vertical 1:/.test(a)));
  assert.ok(!avisos.some((a) => /^(horizontal|vertical 2):/.test(a)));
});
