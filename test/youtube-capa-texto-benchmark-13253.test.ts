/**
 * #13253 — benchmark do texto das capas: classificação (palavras, nome do
 * protagonista, relação com o título, modelo sugerido), agregação acima da
 * média × típicas, comparação dentro do canal e o arquivo de medição gravado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAPA_TEXTO_MODELOS,
  capaTextoWords,
  groupStats,
  modeloDivergences,
  namesProtagonist,
  proprioSummary,
  renderMarkdown,
  suggestCapaTextoModelo,
  titleRelation,
  validateMedicao,
  withinChannel,
  type CapaTextoEntry,
  type CapaTextoMedicao,
} from "../scripts/lib/diaria/youtube-capa-texto-benchmark.ts";
import { benchmarkCapas, missingFromMedicao } from "../scripts/youtube-capa-texto-benchmark.ts";

const MEDICAO = "docs/measurements/youtube-capa-texto-benchmark-2026-11-17.json";

const cap = (over: Partial<CapaTextoEntry>): CapaTextoEntry => ({
  id: "v", canal: "@c", lang: "en", grupo: "acima", ratio: 2, views: 100, titulo: "t", texto: "X",
  modelo: "protagonista", diz_assunto: true, visual: "nenhum", ...over,
});

test("capaTextoWords conta como os ganchos: linhas por |, aspas fora, moeda + número = 1", () => {
  assert.equal(capaTextoWords("GOOGLE IS BACK."), 3);
  assert.equal(capaTextoWords("Ensinaram a IA | e foram demitidos"), 6);
  assert.equal(capaTextoWords('"WE CANT FIX THIS"'), 4);
  assert.equal(capaTextoWords("R$ 1 milhão | por dia"), 4);
  assert.equal(capaTextoWords(""), 0);
});

test("namesProtagonist pega nome conhecido, versão colada (GPT-6.1, GPT5) e possessivo; IA genérica não conta", () => {
  assert.equal(namesProtagonist("GOOGLE IS BACK."), true);
  assert.equal(namesProtagonist("GPT-6.1 Terra"), true);
  assert.equal(namesProtagonist("GPT5"), true);
  assert.equal(namesProtagonist("OpenAI's new model"), true);
  assert.equal(namesProtagonist("JEV | IA SEM CHAT"), true);
  assert.equal(namesProtagonist("IA brasileira?"), false);
  assert.equal(namesProtagonist("Golpe da selfie"), false);
  assert.equal(namesProtagonist("WHAT THEY SAW"), false);
  // palavra comum que começa com letras de um nome não vira nome
  assert.equal(namesProtagonist("METAL 3"), false);
});

test("titleRelation: nenhuma palavra de conteúdo em comum complementa; metade ou mais repete", () => {
  assert.equal(titleRelation("BIGGEST LEAP YET.", "GPT-6 Astra Is Finally Here (And It’s REALLY Good)"), "complementa");
  assert.equal(titleRelation("GOOGLE IS BACK.", "Google Just Caught Up (Gemini-4 Argon)"), "repete");
  assert.equal(titleRelation("DEEPSEEK POWER SHIFT", "DeepSeek Just Made Closed AI Look Ridiculous"), "parcial");
  // acento e caixa não importam
  assert.equal(titleRelation("SATÉLITE BRASILEIRO", "Brasil prepara novo satelite brasileiro"), "repete");
  assert.equal(titleRelation("", "qualquer"), "sem-texto");
  // só palavra de função em comum não conta como repetição
  assert.equal(titleRelation("IT IS HERE", "It is what it is"), "complementa");
});

test("suggestCapaTextoModelo segue a ordem citação > alerta > pergunta > nome > número > rótulo > pronome", () => {
  assert.equal(suggestCapaTextoModelo(""), "sem-texto");
  assert.equal(suggestCapaTextoModelo('CEO DO CHATGPT: "PESSOAS VÃO SE QUEIMAR..."'), "citacao");
  assert.equal(suggestCapaTextoModelo("'AUTOMATE THE WORK'"), "citacao");
  assert.equal(suggestCapaTextoModelo("ALERTA"), "alerta");
  assert.equal(suggestCapaTextoModelo("JACOB ALERT"), "alerta");
  assert.equal(suggestCapaTextoModelo("OPUS 5.5: HOW CLOSE TO RSI?"), "pergunta");
  assert.equal(suggestCapaTextoModelo("GOOGLE IS BACK."), "protagonista");
  assert.equal(suggestCapaTextoModelo("6 MONTHS LEFT UNTIL CASTROPHE"), "numero");
  assert.equal(suggestCapaTextoModelo("AI NEWS"), "rotulo");
  assert.equal(suggestCapaTextoModelo("IT FOUND IT"), "enigma");
  assert.equal(suggestCapaTextoModelo("ACONTECEU..."), "enigma");
  // "?" sem palavra antes não é pergunta; sem letra, número solto também não
  assert.equal(suggestCapaTextoModelo("1 2 3 ???"), null);
  // literal, veredito e enigma sem pronome: quem transcreve decide
  assert.equal(suggestCapaTextoModelo("BIGGEST LEAP YET."), null);
  assert.equal(suggestCapaTextoModelo("SATÉLITE BRASILEIRO"), null);
  // a apóstrofe de contração não é citação
  assert.equal(suggestCapaTextoModelo("GOD'S EYE VIEW"), null);
});

test("validateMedicao acusa modelo, visual, grupo, sem-texto incoerente e id repetido", () => {
  const ok: CapaTextoMedicao = { schema_version: 1, coleta: "2026-11-17", capas: [cap({ id: "a" }), cap({ id: "b", texto: "", modelo: "sem-texto", diz_assunto: false })] };
  assert.deepEqual(validateMedicao(ok), []);
  const bad = {
    schema_version: 1,
    coleta: "x",
    capas: [
      cap({ id: "a", modelo: "outro" as never }),
      cap({ id: "a" }),
      cap({ id: "c", visual: "foto" as never, grupo: "meio" as never }),
      cap({ id: "d", texto: "", modelo: "protagonista" }),
      cap({ id: "e", diz_assunto: "sim" as never }),
    ],
  };
  const errs = validateMedicao(bad).join("\n");
  assert.match(errs, /modelo inválido/);
  assert.match(errs, /id repetido/);
  assert.match(errs, /visual inválido/);
  assert.match(errs, /grupo inválido/);
  assert.match(errs, /texto vazio só com modelo sem-texto/);
  assert.match(errs, /diz_assunto não é booleano/);
  assert.deepEqual(validateMedicao(null), ["arquivo não é objeto JSON"]);
});

test("groupStats conta modelos, nome, diz_assunto, assunto identificável pela imagem e mediana de palavras", () => {
  const s = groupStats([
    cap({ texto: "GOOGLE IS BACK.", titulo: "Google Just Caught Up" }),
    cap({ texto: "WHAT THEY SAW", modelo: "enigma", diz_assunto: false, visual: "personagem", titulo: "x" }),
    cap({ texto: "", modelo: "sem-texto", diz_assunto: false, visual: "nenhum" }),
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.modelos.protagonista, 1);
  assert.equal(s.modelos.enigma, 1);
  assert.equal(s.modelos["sem-texto"], 1);
  assert.equal(s.nomeia, 1);
  assert.equal(s.diz_assunto, 1);
  assert.equal(s.assunto_identificavel, 2);
  assert.equal(s.relacao.repete, 1);
  assert.equal(s.relacao.complementa, 1);
  assert.equal(s.relacao["sem-texto"], 1);
  // mediana só das capas com texto (3 e 3 palavras)
  assert.equal(s.palavras_mediana, 3);
});

test("withinChannel compara dentro do canal e ignora canal sem os dois grupos", () => {
  const entries = [
    cap({ canal: "@a", grupo: "acima", modelo: "protagonista" }),
    cap({ canal: "@a", grupo: "tipico", modelo: "pergunta" }),
    cap({ canal: "@b", grupo: "acima", modelo: "protagonista" }),
    cap({ canal: "@b", grupo: "tipico", modelo: "protagonista" }),
    cap({ canal: "@c", grupo: "acima", modelo: "pergunta" }),
  ];
  const [prot, perg] = withinChannel(entries, ["protagonista", "pergunta"]);
  assert.equal(prot.canais, 2);
  assert.equal(prot.delta_medio, 0.5);
  assert.equal(prot.canais_mais, 1);
  assert.equal(prot.canais_menos, 0);
  assert.equal(perg.delta_medio, -0.5);
  assert.equal(perg.canais_menos, 1);
});

test("proprioSummary agrupa as views do nosso canal por modelo, assunto e nome", () => {
  const p = proprioSummary([
    { edicao: "1", titulo: "", texto: "IA brasileira?", views: 200, modelo: "pergunta", diz_assunto: true },
    { edicao: "2", titulo: "", texto: "Caso com espiã?", views: 20, modelo: "pergunta", diz_assunto: false },
    { edicao: "3", titulo: "", texto: "GPT-6.1 Terra", views: 30, modelo: "protagonista", diz_assunto: true },
  ]);
  assert.deepEqual(p.porAssunto.map((r) => [r.chave, r.n, r.views_mediana]), [["diz o assunto", 2, 115], ["não diz o assunto", 1, 20]]);
  assert.deepEqual(p.porNome.find((r) => r.chave === "nomeia empresa/produto"), { chave: "nomeia empresa/produto", n: 1, views_mediana: 30 });
  assert.equal(p.porModelo[0].chave, "pergunta");
});

test("benchmarkCapas e missingFromMedicao cruzam a coleta com a medição", () => {
  const bench = {
    channels: [
      { handle: "@a", lang: "en" as const, status: "ok", ranking: { outliers: [{ id: "x", title: "T", views: 10, ratio: 3.333 }], typical: [{ id: "y", title: "U", views: 3, ratio: 1 }] } },
      { handle: "@b", lang: "pt" as const, status: "error" },
    ],
  };
  const capas = benchmarkCapas(bench);
  assert.deepEqual(capas.map((c) => [c.canal, c.id, c.grupo, c.ratio]), [["@a", "x", "acima", 3.33], ["@a", "y", "tipico", 1]]);
  const med: CapaTextoMedicao = { schema_version: 1, coleta: "d", capas: [cap({ canal: "@a", id: "x" })] };
  assert.deepEqual(missingFromMedicao(med, bench), ["@a y (tipico)"]);
});

test("a medição gravada de 17/11/2026 é válida, cobre 12 canais e 101 capas e renderiza", () => {
  const m = JSON.parse(readFileSync(MEDICAO, "utf8")) as CapaTextoMedicao;
  assert.deepEqual(validateMedicao(m), []);
  assert.equal(m.capas.length, 101);
  assert.equal(new Set(m.capas.map((c) => c.canal)).size, 12);
  assert.equal(m.capas.filter((c) => c.grupo === "acima").length, 65);
  for (const c of m.capas) assert.ok(c.grupo === "acima" ? c.ratio >= 2 : c.ratio < 2, `${c.id} ratio ${c.ratio} incoerente com ${c.grupo}`);
  assert.ok(CAPA_TEXTO_MODELOS.every((k) => typeof k === "string"));
  // a heurística só diverge do julgamento gravado em poucos casos
  assert.ok(modeloDivergences(m.capas).length <= 3, JSON.stringify(modeloDivergences(m.capas)));
  const md = renderMarkdown(m);
  assert.match(md, /\| protagonista \| 25 \(38%\) \| 10 \(28%\) \|/);
  assert.match(md, /Nosso canal/);
});
