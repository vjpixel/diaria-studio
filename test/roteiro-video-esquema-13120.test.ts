/**
 * test/roteiro-video-esquema-13120.test.ts — #13116, #13120, #13128, #13129, #13130, #13132.
 *
 * Fixture: o `roteiro-falas.json` real da 261116 (test/fixtures/roteiro-video/),
 * a edição em que esses ajustes foram feitos à mão na conversa. `completo()`
 * acrescenta a ele o que a 261116 só tinha em prosa nas notas da página:
 *   - `tela` nas falas com texto de tela (#13120);
 *   - o corte da H4 só no vertical 1 e os de reserva da H10f (vertical 1) e
 *     do exemplo da H13 (vertical 2) (#13129);
 *   - a ordem do vertical 1 com a H10 antes da H10c (#13128);
 *   - as fontes de fora do D1 (#13132).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segmentosSemTrecho, validarRoteiroFalas, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import {
  avisosDuracao,
  avisosGanchoETitulo,
  duracaoPorVideo,
  propostaBlocosDoRoteiro,
  readRoteiroFontes,
  readRoteiroHorizontal,
  ROTEIRO_FALAS_FILE,
  roteiroDuracaoConfigFrom,
  roteiroPecas,
  ROTEIRO_DURACAO_DEFAULT,
} from "../scripts/lib/diaria/roteiro-videos.ts";
import { artifactUrlDe, renderRoteiroPagina } from "../scripts/lib/diaria/roteiro-pagina.ts";
import { factCheckItemsSha256, factCheckSection, type FactCheckItem } from "../scripts/lib/diaria/video-fact-check.ts";
import { main as renderMain } from "../scripts/render-roteiro-video.ts";
import { main as blocosMain } from "../scripts/video-roteiro-blocos.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const base = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));

const H4_FIM = "e em outros serviços da empresa";
const H10F_2A = "Pra pergunta rápida, nem precisa do app: a Busca do Google já resolve.";
const H13_EXEMPLO = 'Em vez de "restaurante domingo vegano", escreve: "restaurante pra oito pessoas, aberto domingo, com opção vegana perto de mim".';

function completo(): RoteiroFalas {
  const r = base();
  const fala = (id: string) => {
    const f = r.falas.find((x) => x.id === id);
    assert.ok(f, `fixture sem ${id}`);
    return f;
  };
  fala("H4").tela = "App do Gemini · Busca do Google · AI Studio · API · Sheets";
  fala("H4").cortes = { vertical1: H4_FIM };
  fala("H6").tela = "Artificial Analysis Intelligence Index\nHydrogen 51 × Argon 50";
  fala("H6").fontes = [{ url: "https://artificialanalysis.ai/models", sustenta: "Hydrogen 51, Argon 50 no índice" }];
  fala("H10").tela = "Argon 30/09 · Carbon 28/10 · Hydrogen 12/11";
  fala("H10f").cortes = { vertical1: { trecho: H10F_2A, reserva: true } };
  fala("H13").cortes = { vertical2: { trecho: H13_EXEMPLO, reserva: true } };
  r.porVideo!.vertical1!.ordem = ["H1", "H4", "H6", "H10", "H10c", "H10f", "V1-CTA"];
  r.notas = ["Repetição de propósito: no horizontal, a H16 retoma o dado da H7. Não corte."];
  return r;
}

describe("#13120/#13128/#13129/#13132: esquema retrocompatível", () => {
  it("a fixture da 261116, sem os campos novos, segue válida", () => {
    assert.deepEqual(validarRoteiroFalas(base()), []);
  });
  it("o roteiro completo, com tela, cortes, ordem, fontes e notas, é válido", () => {
    assert.deepEqual(validarRoteiroFalas(completo()), []);
  });
  it("ordem com fala faltando, sobrando ou repetida é recusada", () => {
    const r = completo();
    r.porVideo!.vertical1!.ordem = ["H1", "H4", "H6", "H10", "H10", "H10f", "V1-CTA", "H13"];
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /ordem repete: H10/);
    assert.match(p, /não traz falas do vertical 1: H10c/);
    assert.match(p, /não estão no vertical 1: H13/);
  });
  it("ordem no horizontal é recusada", () => {
    const r = base();
    r.porVideo!.horizontal!.ordem = ["H1"];
    assert.match(validarRoteiroFalas(r).join("\n"), /horizontal\.ordem/);
  });
  it("corte com trecho que não está no texto, em vídeo que não usa a fala, ou da fala inteira é recusado", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho inexistente" };
    r.falas.find((f) => f.id === "H3")!.cortes = { vertical1: "O Google" };
    const h10f = r.falas.find((f) => f.id === "H10f")!;
    h10f.cortes = { vertical1: h10f.texto };
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /H4\.cortes\.vertical1: trecho não aparece/);
    assert.match(p, /H3\.cortes\.vertical1: a fala não está no vertical 1/);
    assert.match(p, /H10f\.cortes\.vertical1: o trecho é a fala inteira/);
  });
  it("corte no horizontal é recusado: o horizontal fica com a fala inteira", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.cortes = { horizontal: H4_FIM };
    assert.match(validarRoteiroFalas(r).join("\n"), /H4\.cortes\.horizontal: o horizontal fica com a fala inteira/);
  });
  it("corte no meio de uma palavra ou de trecho repetido é recusado", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "Hydro" };
    // "o tom, o formato e as regras": "o" aparece mais de uma vez como palavra.
    r.falas.find((f) => f.id === "H14")!.cortes = { vertical2: "o" };
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /H4\.cortes\.vertical1: trecho não aparece no texto da fala como palavras inteiras/);
    assert.match(p, /H14\.cortes\.vertical2: o trecho aparece \d+ vezes/);
  });
  it("fala de abertura num vertical é recusada", () => {
    const r = base();
    r.falas.find((f) => f.id === "H2")!.videos.push("vertical1");
    assert.match(validarRoteiroFalas(r).join("\n"), /H2: bloco abertura não existe nos verticais/);
  });
  it("seta em qualquer texto que chega ao leitor é recusada, com o campo (#9721)", () => {
    const r = base();
    r.falas[0].texto = "Antes → depois.";
    r.porVideo!.vertical2!.capa = "Google ← Busca";
    r.notas = ["a → b"];
    assert.match(validarRoteiroFalas(r).join("\n"), /seta .*H1\.texto, porVideo\.vertical2\.capa, notas\[0\]/);
  });
  it("tela com seta é recusada (#9721)", () => {
    const r = base();
    r.falas[0].tela = "Antes → depois";
    assert.match(validarRoteiroFalas(r).join("\n"), /seta/);
  });
  it("fonte sem URL http(s) ou sem o que sustenta é recusada", () => {
    const r = base();
    r.falas[0].fontes = [{ url: "artificialanalysis.ai", sustenta: "" }];
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /fontes\[0\]\.url/);
    assert.match(p, /fontes\[0\]\.sustenta/);
  });
});

describe("#13129: o trecho cortado e o que sobra", () => {
  it("corte que leva o ponto final junto: o que sobra termina com ponto", () => {
    assert.deepEqual(segmentosSemTrecho("A lançou X, e isso muda tudo.", "e isso muda tudo."), ["A lançou X."]);
  });
  it("corte no meio de uma frase não força ponto nem maiúscula", () => {
    assert.deepEqual(segmentosSemTrecho("O modelo, que custa 20 dólares, chegou hoje.", "que custa 20 dólares,"), ["O modelo", "chegou hoje."]);
  });
  it("corte no fim: o que sobra ganha o ponto final", () => {
    const h4 = base().falas.find((f) => f.id === "H4")!.texto;
    assert.deepEqual(segmentosSemTrecho(h4, H4_FIM), ["O Gemini 4 Hydrogen já está liberado pra todo mundo no app do Gemini, na Busca do Google."]);
  });
  it("corte de uma frase inteira no fim", () => {
    const h10f = base().falas.find((f) => f.id === "H10f")!.texto;
    assert.deepEqual(segmentosSemTrecho(h10f, H10F_2A), ["Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini."]);
  });
  it("corte no meio vira dois trechos", () => {
    assert.deepEqual(segmentosSemTrecho("Primeiro isto. Depois aquilo. Por fim o resto.", "Depois aquilo."), ["Primeiro isto.", "Por fim o resto."]);
  });
  it("o corte e a página pulam a ocorrência dentro de palavra, como o validador (review do contínuo)", () => {
    assert.deepEqual(segmentosSemTrecho("Hydrogen saiu. Hydro também.", "Hydro"), ["Hydrogen saiu.", "também."]);
    const r = base();
    const h4 = r.falas.find((f) => f.id === "H4")!;
    h4.texto = "Hydrogen saiu. Hydro também.";
    h4.cortes = { vertical1: "Hydro" };
    assert.deepEqual(validarRoteiroFalas(r), []);
    assert.match(renderRoteiroPagina(r), /Hydrogen saiu\. <del[^>]*>Hydro<\/del>/);
  });
  it("trecho ausente = null; trecho = fala inteira = []", () => {
    assert.equal(segmentosSemTrecho("Uma fala.", "outra"), null);
    assert.deepEqual(segmentosSemTrecho("Uma fala.", "Uma fala."), []);
  });
});

describe("#13116: título do vertical 1 = o do horizontal quando ausente", () => {
  it("vertical 1 sem título herda o do horizontal; a capa continua própria", () => {
    const r = base();
    delete r.porVideo!.vertical1!.titulo;
    const p = roteiroPecas(r);
    assert.equal(p.vertical1?.titulo, "Google te dá Gemini 4 Hydrogen de graça");
    assert.equal(p.vertical1?.capa, "Sua Busca mudou de IA");
    assert.equal(propostaBlocosDoRoteiro(r).screenTitle, "Google te dá Gemini 4 Hydrogen de graça");
  });
  it("vertical 2 nunca herda", () => {
    const r = base();
    delete r.porVideo!.vertical2!.titulo;
    assert.equal(roteiroPecas(r).vertical2?.titulo, undefined);
  });
  it("capa de vertical sem sujeito gera aviso; a da 261116 não", () => {
    assert.ok(!avisosGanchoETitulo(base()).some((a) => /sujeito/.test(a)));
    const r = base();
    r.porVideo!.vertical1!.capa = "Inventa cinco vezes menos?";
    assert.ok(avisosGanchoETitulo(r).some((a) => /vertical 1: a capa .* sujeito/.test(a)));
  });
});

describe("#13128/#13129: a proposta de blocos segue a ordem e os cortes", () => {
  it("vertical 1 na ordem declarada: H10 antes da H10c, e a H10c vira item próprio dele", () => {
    const p = propostaBlocosDoRoteiro(completo());
    const v1 = p.sequencias.find((s) => s.video === "vertical1")!;
    assert.equal(v1.ordemDeclarada, true);
    assert.deepEqual(v1.falas.map((f) => f.id), ["H1", "H4", "H6", "H10", "H10c", "H10f", "V1-CTA"]);
    const coment = p.blocks.comentario!.map((it) => ({ t: it.text.slice(0, 25), targets: it.targets }));
    const h10c = coment.filter((c) => c.t.startsWith("O Google entrega"));
    assert.equal(h10c.length, 2, "a H10c aparece duas vezes: na posição do horizontal e na do vertical 1");
    assert.deepEqual(h10c[0].targets, ["youtube"]);
    assert.deepEqual(h10c[1].targets, ["outras-redes"]);
    const iH10 = coment.findIndex((c) => c.t.startsWith("Em seis semanas"));
    assert.ok(coment.indexOf(h10c[1]) > iH10, "no vertical 1 a H10c vem depois da H10");
  });
  it("sem ordem declarada, a proposta não duplica item (retrocompatível)", () => {
    const p = propostaBlocosDoRoteiro(base());
    const textos = p.blocks.comentario!.map((it) => it.text);
    assert.equal(new Set(textos).size, textos.length);
  });
  it("corte do vertical 1 sai aplicado nele; o horizontal fica intacto", () => {
    const p = propostaBlocosDoRoteiro(completo());
    const h4v1 = p.sequencias.find((s) => s.video === "vertical1")!.falas.find((f) => f.id === "H4")!;
    assert.equal(h4v1.cortado, H4_FIM);
    assert.ok(!h4v1.texto.includes("outros serviços"));
    const h4h = p.sequencias.find((s) => s.video === "horizontal")!.falas.find((f) => f.id === "H4")!;
    assert.ok(h4h.texto.includes("outros serviços"));
    assert.ok(p.blocks.resumo!.some((it) => it.text.includes("outros serviços")), "o horizontal mantém a H4 inteira");
    const resumoCurto = p.blocks.resumo_curto!.map((it) => it.text);
    assert.ok(resumoCurto.includes("O Gemini 4 Hydrogen já está liberado pra todo mundo no app do Gemini, na Busca do Google."));
  });
  it("cortes de reserva ficam fora da proposta, listados com a economia", () => {
    const p = propostaBlocosDoRoteiro(completo());
    assert.deepEqual(p.cortesReserva.map((c) => [c.video, c.id]), [["vertical1", "H10f"], ["vertical2", "H13"]]);
    assert.ok(p.cortesReserva.every((c) => c.economiaS > 0));
    const h13 = p.sequencias.find((s) => s.video === "vertical2")!.falas.find((f) => f.id === "H13")!;
    assert.ok(h13.texto.includes("restaurante"), "o corte de reserva não entra sozinho");
  });
  it("as fontes das falas saem na proposta (#13132)", () => {
    assert.deepEqual(propostaBlocosDoRoteiro(completo()).fontes.map((f) => f.id), ["H6"]);
  });
  it("readRoteiroFontes lê as fontes da edição para o fact-check da fala; sem roteiro = []", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-fontes-"));
    try {
      const avisos: string[] = [];
      const warn = (m: string) => void avisos.push(m);
      const ausente = readRoteiroFontes(dir, warn);
      assert.equal(ausente.status, "ausente");
      assert.equal(ausente.fontes.length, 0);
      assert.equal(avisos.length, 0);
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(completo()));
      const ok = readRoteiroFontes(dir, warn);
      assert.equal(ok.status, "ok");
      assert.deepEqual(ok.fontes.map((f) => [f.fala, f.url]), [["H6", "https://artificialanalysis.ai/models"]]);
      assert.match(ok.fontes[0].texto, /51 pontos/);
      // Um corte desatualizado invalida o roteiro, mas não tira as fontes do fact-check.
      const r = completo();
      r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho que sumiu" };
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(r));
      const inv = readRoteiroFontes(dir, warn);
      assert.equal(inv.status, "invalido");
      assert.equal(inv.fontes.length, 1);
      assert.ok(inv.problemas.some((x) => /H4\.cortes/.test(x)));
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), "{");
      const ileg = readRoteiroFontes(dir, warn);
      assert.equal(ileg.status, "ilegivel");
      assert.equal(ileg.fontes.length, 0);
      assert.ok(avisos.some((a) => /ilegível.*#13132/.test(a)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("ordem que cruza blocos gera aviso", () => {
    const r = completo();
    r.porVideo!.vertical1!.ordem = ["H4", "H1", "H6", "H10", "H10c", "H10f", "V1-CTA"];
    assert.ok(propostaBlocosDoRoteiro(r).avisos.some((a) => /ordem declarada põe H1/.test(a)));
  });
});

describe("#13130: duração estimada por vídeo", () => {
  it("261116: horizontal ~3 min 22 s, vertical 1 ~62 s e vertical 2 ~61 s, como a página calculada à mão", () => {
    // A conta à mão era só a fala; a pausa da vinheta entrou depois (#13239 item 5), por isso aqui sem ela.
    const d = Object.fromEntries(duracaoPorVideo(base(), { ...ROTEIRO_DURACAO_DEFAULT, pausaVinhetaS: 0 }).map((x) => [x.video, x]));
    assert.equal(d.horizontal.segundos, 202);
    assert.equal(d.vertical1.segundos, 62);
    assert.equal(d.vertical2.segundos, 61);
    assert.equal(d.vertical1.foraDoAlvo, true);
    assert.equal(d.horizontal.foraDoAlvo, false);
  });
  it("vertical acima de 60 s avisa, com os cortes de reserva primeiro na sugestão", () => {
    const avisos = avisosDuracao(completo());
    const v2 = avisos.find((a) => a.startsWith("vertical 2"));
    assert.ok(v2, avisos.join("\n"));
    assert.match(v2, /acima do alvo de 1 min.*corte de reserva da H13/);
  });
  it("o corte que não é de reserva entra na conta", () => {
    const sem = duracaoPorVideo(base()).find((x) => x.video === "vertical1")!.segundos;
    const com = duracaoPorVideo(completo()).find((x) => x.video === "vertical1")!.segundos;
    assert.ok(com < sem);
  });
  it("os alvos vêm da config, com default (e aviso) para valor inválido", () => {
    const avisos: string[] = [];
    const cfg = roteiroDuracaoConfigFrom(
      { publishing: { video: { roteiro: { alvo_s: { vertical1: 75, vertical2: "x", vertical_1: 9 }, palavras_por_minuto: 0 } } } },
      (m) => void avisos.push(m),
    );
    assert.ok(avisos.some((a) => /alvo_s\.vertical2 inválido/.test(a)));
    assert.ok(avisos.some((a) => /palavras_por_minuto inválido/.test(a)));
    assert.ok(avisos.some((a) => /alvo_s\.vertical_1: vídeo desconhecido/.test(a)));
    assert.equal(cfg.alvoS.vertical1, 75);
    assert.equal(cfg.alvoS.vertical2, ROTEIRO_DURACAO_DEFAULT.alvoS.vertical2);
    assert.equal(cfg.palavrasPorMinuto, ROTEIRO_DURACAO_DEFAULT.palavrasPorMinuto);
    assert.ok(!avisosDuracao(base(), cfg).some((a) => a.startsWith("vertical 1")));
  });
  it("horizontal muito curto avisa", () => {
    const r = base();
    r.falas = r.falas.filter((f) => f.id === "H1" || !f.videos.includes("horizontal"));
    assert.ok(avisosDuracao(r).some((a) => /horizontal com .* abaixo da faixa/.test(a)));
  });
});

describe("#13120: a página gerada do JSON", () => {
  const html = renderRoteiroPagina(completo());
  it("traz a caixa Gravação no topo e as Notas para a edição no fim", () => {
    const iGrav = html.indexOf('aria-label="Gravação"');
    const iRoteiro = html.indexOf('id="roteiro"');
    const iNotas = html.indexOf('aria-label="Notas para a edição"');
    assert.ok(iGrav > 0 && iGrav < iRoteiro && iRoteiro < iNotas);
    assert.match(html, /Repetição de propósito/);
  });
  it("box Na tela ao lado da fala, e empilhado no celular", () => {
    assert.match(html, /<div class="row"><p class="fala"><span class="id">H6<\/span>[^<]+<\/p><aside class="tela"><b>Na tela<\/b>Artificial Analysis Intelligence Index<br>Hydrogen 51 × Argon 50<\/aside><\/div>/);
    assert.match(html, /@media \(max-width: 640px\) \{ \.row \{ grid-template-columns: 1fr/);
  });
  it("vertical 1 na ordem declarada, com o corte riscado só nele", () => {
    const v1 = html.slice(html.indexOf('aria-label="vertical 1"'), html.indexOf('aria-label="vertical 2"'));
    assert.ok(v1.indexOf(">H10<") < v1.indexOf(">H10c<"));
    assert.match(v1, /<del[^>]*>e em outros serviços da empresa<\/del>/);
    const h = html.slice(html.indexOf('aria-label="horizontal"'), html.indexOf('aria-label="vertical 1"'));
    assert.ok(h.indexOf(">H10c<") < h.indexOf(">H10<"));
    assert.ok(!h.includes("<del"));
  });
  it("durações calculadas e falas de cada vertical na caixa Gravação", () => {
    // 3 min 22 s de fala + a pausa da vinheta (#13239 item 5).
    assert.match(html, /<b>Horizontal:<\/b> cerca de 3 min 23 s\./);
    assert.match(html, /Vertical 1, a notícia:<\/b> cerca de [^.]+\. Falas: H1, H4, H6, H10, H10c, H10f, V1-CTA \(à parte\)\./);
  });
  it("fontes e cortes de reserva nas notas", () => {
    assert.match(html, /Fontes fora do D1.*H6: <a href="https:\/\/artificialanalysis.ai\/models">/);
    assert.match(html, /Cortes de reserva:.*H10f.*H13/);
    assert.match(html, /Ordem no vertical 1:<\/b> H1, H4, H6, H10, H10c, H10f, V1-CTA/);
  });
  it("nunca sai seta; texto com seta derruba o render (#9721)", () => {
    assert.ok(!/[→←]/.test(html));
    const r = base();
    r.notas = ["Antes → depois"];
    assert.throws(() => renderRoteiroPagina(r), /seta/);
  });
  it("escapa HTML do texto", () => {
    const r = base();
    r.falas[0].texto = "A <b>IA</b> & cia.";
    assert.match(renderRoteiroPagina(r), /A &lt;b&gt;IA&lt;\/b&gt; &amp; cia\./);
  });
});

describe("#13132 (review): trocar uma fonte do roteiro torna o fact-check da fala velho", () => {
  const items = [{ id: "comentario.0", block: "comentario", index: 0, text: "O Hydrogen marcou 51.", start: 0, end: 2, versions: ["youtube"] }] as unknown as FactCheckItem[];
  const fonte = { fala: "H6", url: "https://artificialanalysis.ai/models", sustenta: "Hydrogen 51" };
  it("sem fontes, o hash é o de antes (fact-check.json já gravado continua valendo)", () => {
    assert.equal(factCheckItemsSha256(items, []), factCheckItemsSha256(items));
  });
  it("fonte nova, trocada ou removida muda o hash, e a seção avisa que o fact-check está velho", () => {
    const comFonte = factCheckItemsSha256(items, [fonte]);
    assert.notEqual(comFonte, factCheckItemsSha256(items));
    assert.notEqual(comFonte, factCheckItemsSha256(items, [{ ...fonte, sustenta: "Hydrogen 54" }]));
    const fc = { mode: "video" as const, edition: "261116", items_sha256: comFonte, claims: [] };
    assert.equal(factCheckSection(fc, items, [fonte]).stale, false);
    assert.equal(factCheckSection(fc, items, []).stale, true);
  });
});

describe("#13132 (review): a publicação não perde o título por um problema em outro campo", () => {
  it("readRoteiroHorizontal usa título e capa do horizontal mesmo com o roteiro inválido, com aviso", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-horizontal-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const r = completo();
      r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho que sumiu" };
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(r));
      const avisos: string[] = [];
      assert.deepEqual(readRoteiroHorizontal(dir, (m) => void avisos.push(m)), { titulo: "Google te dá Gemini 4 Hydrogen de graça", capa: "Já está na sua Busca" });
      assert.ok(avisos.some((a) => /inválido.*uso o título e a capa do horizontal/.test(a)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLIs: render-roteiro-video e video-roteiro-blocos", () => {
  function tmp(): { dir: string; falas: string; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-13120-"));
    mkdirSync(join(dir, "root"));
    const falas = join(dir, "roteiro-falas.json");
    writeFileSync(falas, JSON.stringify(completo()));
    return { dir, falas, out: join(dir, "roteiro-d1.html") };
  }
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it("render grava a página e preserva o link do artefato da página anterior", () => {
    const t = tmp();
    try {
      writeFileSync(t.out, "<!-- artifact: https://claude.ai/artifact/abc -->\n<title>velho</title>");
      const c = io();
      assert.equal(renderMain(["261116", "--falas", t.falas, "--out", t.out], c.io, join(t.dir, "root")), 0);
      const html = readFileSync(t.out, "utf8");
      assert.equal(artifactUrlDe(html), "https://claude.ai/artifact/abc");
      assert.match(html, /<title>Roteiro D1 261116<\/title>/);
      assert.ok(c.err.some((e) => /\[aviso\] vertical 2 com/.test(e)));
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
  it("render sem roteiro-falas.json sai 3 sem gravar", () => {
    const t = tmp();
    try {
      const c = io();
      assert.equal(renderMain(["261116", "--falas", join(t.dir, "nao-existe.json"), "--out", t.out], c.io, join(t.dir, "root")), 3);
      assert.throws(() => readFileSync(t.out));
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
  it("render recusa --artifact-url que quebraria o comentário HTML; o link é achado mesmo fora da 1ª linha", () => {
    const t = tmp();
    try {
      const c = io();
      assert.equal(renderMain(["261116", "--falas", t.falas, "--out", t.out, "--artifact-url", "https://x/a-->b"], c.io, join(t.dir, "root")), 2);
      assert.equal(artifactUrlDe("<!-- artifact: https://x/a-->b -->"), null);
      assert.equal(artifactUrlDe("﻿<!doctype html>\n<!-- artifact: https://claude.ai/artifact/z -->"), "https://claude.ai/artifact/z");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
  it("render repete os avisos da proposta de blocos (ordem que cruza blocos)", () => {
    const t = tmp();
    try {
      const r = completo();
      r.porVideo!.vertical1!.ordem = ["H4", "H1", "H6", "H10", "H10c", "H10f", "V1-CTA"];
      writeFileSync(t.falas, JSON.stringify(r));
      const c = io();
      assert.equal(renderMain(["261116", "--falas", t.falas, "--stdout"], c.io, join(t.dir, "root")), 0);
      assert.ok(c.err.some((e) => /ordem declarada põe H1/.test(e)));
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
  it("render recusa JSON inválido sem gravar", () => {
    const t = tmp();
    try {
      const r = completo();
      r.porVideo!.vertical1!.ordem = ["H1"];
      writeFileSync(t.falas, JSON.stringify(r));
      const c = io();
      assert.equal(renderMain(["261116", "--falas", t.falas, "--out", t.out], c.io, join(t.dir, "root")), 2);
      assert.throws(() => readFileSync(t.out));
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
  it("blocos imprime as durações e lê os alvos da config", () => {
    const t = tmp();
    try {
      writeFileSync(join(t.dir, "root", "platform.config.json"), JSON.stringify({ publishing: { video: { roteiro: { alvo_s: { vertical2: 90 } } } } }));
      const c = io();
      assert.equal(blocosMain(["261116", "--falas", t.falas, "--json"], c.io, join(t.dir, "root")), 0);
      const j = JSON.parse(c.out.join(""));
      assert.equal(j.duracoes.find((d: { video: string }) => d.video === "vertical2").alvoS, 90);
      assert.ok(!c.err.some((e) => /vertical 2 com/.test(e)));
      assert.equal(j.cortesReserva.length, 2);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
