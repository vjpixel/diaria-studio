/**
 * test/video-roteiro-ordem-cortes-13128.test.ts — lote do roteiro de vídeo
 * (#13128, #13129, #13130, #13132, #13120), com o roteiro da 261116, em que
 * tudo isto ficou só nas notas da página, digitado à mão:
 *   - #13128: o vertical 1 tinha H10 antes de H10c, ao contrário do horizontal;
 *   - #13129: "e em outros serviços da empresa" saía da H4 só no vertical 1, e
 *     os cortes de reserva (2ª frase da H10f, exemplo da H13) só se passasse;
 *   - #13130: a duração foi recalculada à mão a cada versão (56 a 62 s);
 *   - #13132: as fontes fora do D1 ficavam em prosa e a montagem não as recebia;
 *   - #13120: o box "Na tela" ao lado de cada fala foi montado à mão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemInTarget, parseBlocksFile, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import { validarRoteiroFalas, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import {
  ALVOS_ROTEIRO_DEFAULT,
  aplicarCortes,
  alvosRoteiroFrom,
  avisosDuracao,
  fontesDoRoteiro,
  mesclarOrdens,
  propostaBlocosDoRoteiro,
  readRoteiroFontes,
  renderPropostaBlocos,
  resolverPeca,
  ROTEIRO_FALAS_FILE,
} from "../scripts/lib/diaria/roteiro-videos.ts";
import { renderRoteiroPagina } from "../scripts/lib/diaria/roteiro-pagina.ts";
import { artifactLineOf, main as renderMain } from "../scripts/render-roteiro-video.ts";
import { main as blocosMain } from "../scripts/video-roteiro-blocos.ts";

const H10F = "Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini. Pra pergunta rápida, nem precisa do app: a Busca do Google já resolve.";
const H13 =
  'Um: na Busca, escreve como você escreveria pro ChatGPT, com a dúvida inteira, em vez de palavra-chave. Em vez de "restaurante domingo vegano", escreve: "restaurante pra oito pessoas, aberto domingo, com opção vegana perto de mim".';

/** O roteiro da 261116 (resumido), com o que a página só tinha nas notas agora no JSON. */
function roteiro261116(): RoteiroFalas {
  return {
    edicao: "261116",
    veiculos: ["blog do Google"],
    porVideo: {
      horizontal: { titulo: "Google te dá Gemini 4 Hydrogen de graça", capa: "Já está na sua Busca" },
      vertical1: { titulo: "Google te dá Gemini 4 Hydrogen de graça", capa: "Sua Busca mudou de IA", ordem: ["H1", "H4", "H6", "H10", "H10c", "H10f", "V1-CTA"] },
      vertical2: { titulo: "Novo Gemini: 3 dicas pra usar melhor", capa: "Google: para de usar palavra-chave" },
    },
    falas: [
      { id: "H1", bloco: "gancho", texto: "A IA da sua Busca do Google mudou. O modelo novo, o menor da família, ultrapassou um modelo maior da própria empresa.", videos: ["horizontal", "vertical1"] },
      { id: "H2", bloco: "abertura", texto: "Oi! Eu sou o Pixel, editor da diar.ia.br.", videos: ["horizontal"] },
      {
        id: "H4",
        bloco: "resumo",
        texto: "O Gemini 4 Hydrogen já está liberado pra todo mundo no app do Gemini, na Busca do Google e em outros serviços da empresa.",
        videos: ["horizontal", "vertical1", "vertical2"],
        tela: "App do Gemini · Busca do Google · AI Studio · API · Sheets",
        cortes: { vertical1: " e em outros serviços da empresa" },
      },
      {
        id: "H6",
        bloco: "resumo",
        texto: "Num índice independente que compara a inteligência dos modelos de IA, o Hydrogen marcou 51 pontos. O Gemini 4 Argon marcou 50.",
        videos: ["horizontal", "vertical1"],
        tela: "Artificial Analysis Intelligence Index\nHydrogen 51 × Argon 50",
        fontes: [{ url: "https://artificialanalysis.ai/models", sustenta: "Hydrogen 51 e Argon 50 no índice" }],
      },
      { id: "H10c", bloco: "comentario", texto: "O Google entrega o Hydrogen de graça, na Busca e no app. A OpenAI não libera um modelo desse nível no plano gratuito.", videos: ["horizontal", "vertical1"] },
      { id: "H10", bloco: "comentario", texto: "Em seis semanas, o Google lançou três modelos, e o menor já passou o Argon, o do meio.", videos: ["horizontal", "vertical1"], tela: "Argon 30/09 · Carbon 28/10 · Hydrogen 12/11" },
      {
        id: "H10f",
        bloco: "comentario",
        texto: H10F,
        videos: ["horizontal", "vertical1"],
        cortes: { vertical1: { trecho: "Pra pergunta rápida, nem precisa do app: a Busca do Google já resolve.", reserva: true } },
      },
      { id: "H13", bloco: "comentario", texto: H13, videos: ["horizontal", "vertical2"], cortes: { vertical2: { trecho: 'Em vez de "restaurante domingo vegano", escreve: "restaurante pra oito pessoas, aberto domingo, com opção vegana perto de mim".', reserva: true } } },
      { id: "V1-CTA", bloco: "cta_vertical", texto: "As três dicas pra tirar mais dele estão no vídeo completo, no YouTube da diar.ia.br.", videos: ["vertical1"], gravarAParte: true },
      { id: "V2-G", bloco: "gancho", texto: "A IA do Google mudou. Agora vale pedir diferente.", videos: ["vertical2"], gravarAParte: true },
    ],
    fatosChecados: [
      { fato: "Hydrogen no nível do Claude Sonnet 5.5 e do GPT-6.1 Terra", situacao: "confirmado", fonte: "Artificial Analysis" },
      { fato: "mapa Pro/Flash/Flash-Lite", situacao: "contraditorio", correcao: "o Hydrogen sucede o Flash" },
    ],
    excluidos: [{ ponto: "preço da API", motivo: "fala com quem não programa" }],
  };
}

/** O que a montagem monta numa sequência: blocos na ordem dela, itens filtrados pelo escopo. */
function textosDaSequencia(blocks: Record<string, Array<{ text: string; targets?: string[] }>>, spec: SequenceSpec): string[] {
  return spec.order.flatMap((k) => (blocks[k] ?? []).filter((it) => itemInTarget(it, spec)).map((it) => it.text));
}

describe("#13128: ordem própria por vertical", () => {
  it("o validador acusa id faltando, sobrando e repetido; só nos verticais", () => {
    const r = roteiro261116();
    assert.deepEqual(validarRoteiroFalas(r), []);
    r.porVideo!.vertical1!.ordem = ["H1", "H4", "H4", "H13", "H10c", "H10f", "V1-CTA"];
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /ordem: id repetido: H4/);
    assert.match(p, /sobrando\): H13/);
    assert.match(p, /faltando\): H6, H10/);
    const h = roteiro261116();
    h.porVideo!.horizontal!.ordem = ["H1"];
    assert.match(validarRoteiroFalas(h).join("\n"), /horizontal\.ordem: só nos verticais/);
  });

  it("a proposta sai na ordem declarada e o blocks.json monta o vertical 1 nela, sem mexer no horizontal", () => {
    const p = propostaBlocosDoRoteiro(roteiro261116());
    const v1 = p.sequencias.find((s) => s.video === "vertical1")!;
    assert.deepEqual(v1.falas.map((f) => f.id), ["H1", "H4", "H6", "H10", "H10c", "H10f", "V1-CTA"]);
    const parsed = parseBlocksFile({ edition: "261116", blocks: p.blocks, sequences: p.sequences, screenTitle: p.screenTitle });
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
    const [specH, specV] = p.sequences!;
    const blocks = p.blocks as Record<string, Array<{ text: string; targets?: string[] }>>;
    const v1Com = textosDaSequencia(blocks, specV).filter((t) => /seis semanas|entrega o Hydrogen/.test(t));
    assert.deepEqual(v1Com.map((t) => (t.includes("seis semanas") ? "H10" : "H10c")), ["H10", "H10c"]);
    const hCom = textosDaSequencia(blocks, specH).filter((t) => /seis semanas|entrega o Hydrogen/.test(t));
    assert.deepEqual(hCom.map((t) => (t.includes("seis semanas") ? "H10" : "H10c")), ["H10c", "H10"]);
  });

  it("mesclarOrdens: cada sequência filtrada devolve a própria ordem", () => {
    const m = mesclarOrdens([
      { chave: "a", textos: ["1", "2", "3", "4"] },
      { chave: "b", textos: ["3", "1", "4"] },
      { chave: "c", textos: ["5", "2"] },
    ]);
    for (const [k, esperado] of [["a", ["1", "2", "3", "4"]], ["b", ["3", "1", "4"]], ["c", ["5", "2"]]] as const) {
      assert.deepEqual(m.filter((x) => x.chaves.has(k)).map((x) => x.text), esperado);
    }
  });

  it("ordem que cruza blocos avisa (a montagem monta bloco a bloco)", () => {
    const r = roteiro261116();
    r.porVideo!.vertical1!.ordem = ["H1", "H10", "H4", "H6", "H10c", "H10f", "V1-CTA"];
    assert.ok(propostaBlocosDoRoteiro(r).avisos.some((a) => a.includes("ordem cruza blocos")));
  });
});

describe("#13129: corte parcial por vertical", () => {
  it("aplicarCortes: corte no fim limpa a pontuação; no meio deixa duas partes", () => {
    assert.deepEqual(aplicarCortes("A, B e C.", [" e C"]), { texto: "A, B.", partes: ["A, B."] });
    const meio = aplicarCortes("Primeiro isto, depois aquilo, e por fim o resto.", ["depois aquilo, "]);
    assert.equal(meio.texto, "Primeiro isto, e por fim o resto.");
    assert.deepEqual(meio.partes, ["Primeiro isto", "e por fim o resto."]);
  });

  it("o validador confere que o trecho existe, que o vídeo usa a fala e que sobra fala", () => {
    const r = roteiro261116();
    r.falas[2].cortes = { vertical1: "trecho que não existe", vertical2: r.falas[2].texto } as never;
    (r.falas[1] as { cortes?: unknown }).cortes = { horizontal: "Oi!" };
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /não está no texto da fala/);
    assert.match(p, /tiram a fala inteira/);
    assert.match(p, /falas\[1\]\.cortes\.horizontal: só vertical1\|vertical2/);
  });

  it("o corte sai no vertical 1 e o horizontal fica com a fala inteira, nos blocos da montagem", () => {
    const p = propostaBlocosDoRoteiro(roteiro261116());
    const [specH, specV] = p.sequences!;
    const blocks = p.blocks as Record<string, Array<{ text: string; targets?: string[] }>>;
    const h4H = textosDaSequencia(blocks, specH).find((t) => t.startsWith("O Gemini 4 Hydrogen"));
    const h4V = textosDaSequencia(blocks, specV).find((t) => t.startsWith("O Gemini 4 Hydrogen"));
    assert.ok(h4H?.endsWith("e em outros serviços da empresa."));
    assert.equal(h4V, "O Gemini 4 Hydrogen já está liberado pra todo mundo no app do Gemini, na Busca do Google.");
    assert.match(renderPropostaBlocos(p), /cortado aqui: " e em outros serviços da empresa"/);
  });

  it("o corte de reserva só entra acima do alvo", () => {
    const r = roteiro261116();
    // Folgado (alvo alto): a H10f fica inteira.
    const folgado = resolverPeca(r, "vertical1", { ...ALVOS_ROTEIRO_DEFAULT, vertical1S: 120 });
    assert.equal(folgado.reservasAplicadas.length, 0);
    assert.equal(folgado.falas.find((f) => f.fala.id === "H10f")!.texto, H10F);
    // Apertado (alvo baixo): a 2ª frase da H10f sai.
    const apertado = resolverPeca(r, "vertical1", { ...ALVOS_ROTEIRO_DEFAULT, vertical1S: 20 });
    assert.deepEqual(apertado.reservasAplicadas.map((x) => x.id), ["H10f"]);
    assert.equal(apertado.falas.find((f) => f.fala.id === "H10f")!.texto, "Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini.");
    // O horizontal nunca aplica corte.
    assert.equal(resolverPeca(r, "horizontal", { ...ALVOS_ROTEIRO_DEFAULT, horizontalS: 1 }).falas.find((f) => f.fala.id === "H10f")!.texto, H10F);
  });
});

describe("#13130: duração estimada por vídeo", () => {
  it("palavras ÷ ritmo do config; vertical acima do alvo avisa com sugestão; horizontal fora da faixa avisa", () => {
    const r = roteiro261116();
    const alvos = { ...ALVOS_ROTEIRO_DEFAULT, vertical2S: 10 };
    const v2 = resolverPeca(r, "vertical2", alvos);
    assert.ok(v2.palavras > 0);
    assert.ok(Math.abs(v2.segundos - (v2.palavras / 150) * 60) < 1e-9);
    const avisos = avisosDuracao([resolverPeca(r, "horizontal", alvos), v2], alvos);
    assert.ok(avisos.some((a) => a.startsWith("vertical 2:") && a.includes("acima do alvo de 10 s") && a.includes("cortes de reserva já aplicados")));
    assert.ok(avisos.some((a) => a.startsWith("horizontal:") && a.includes("fora de")), "o horizontal resumido fica bem abaixo de 3 min");
  });

  it("alvos vêm do config; inválido cai no default com aviso", () => {
    assert.deepEqual(alvosRoteiroFrom({}).alvos, ALVOS_ROTEIRO_DEFAULT);
    const { alvos, avisos } = alvosRoteiroFrom({ publishing: { video: { roteiro: { vertical1_s: 55, palavras_por_minuto: "rápido" } } } });
    assert.equal(alvos.vertical1S, 55);
    assert.equal(alvos.palavrasPorMinuto, 150);
    assert.ok(avisos.some((a) => a.includes("palavras_por_minuto inválido")));
    const cfg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.deepEqual(alvosRoteiroFrom(cfg).avisos, [], "o platform.config.json do repo traz publishing.video.roteiro válido");
  });

  it("video-roteiro-blocos imprime a duração dos três vídeos", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-13130-"));
    try {
      const path = join(dir, "roteiro-falas.json");
      writeFileSync(path, JSON.stringify(roteiro261116()));
      const err: string[] = [];
      assert.equal(blocosMain(["261116", "--falas", path], { out: () => {}, err: (s) => err.push(s) }), 0);
      for (const v of ["horizontal", "vertical 1", "vertical 2"]) assert.ok(err.some((l) => l.startsWith(`[duração] ${v}:`)), v);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13132: fontes por fala, fatos checados e pontos de fora", () => {
  it("o validador aceita os campos e acusa o malformado", () => {
    const r = roteiro261116();
    r.falas[3].fontes = [{ url: "artificialanalysis.ai", sustenta: "" }];
    (r as { fatosChecados: unknown }).fatosChecados = [{ fato: "x", situacao: "talvez" }];
    (r as { excluidos: unknown }).excluidos = [{ ponto: "y" }];
    const p = validarRoteiroFalas(r).join("\n");
    assert.match(p, /fontes\[0\]\.url deve ser URL/);
    assert.match(p, /fontes\[0\]\.sustenta ausente/);
    assert.match(p, /fatosChecados\[0\]\.situacao/);
    assert.match(p, /excluidos\[0\]\.motivo ausente/);
  });

  it("as fontes chegam ao fact-check da montagem pelo roteiro-falas.json da edição", () => {
    assert.deepEqual(fontesDoRoteiro(roteiro261116()).map((f) => [f.fala, f.url]), [["H6", "https://artificialanalysis.ai/models"]]);
    const dir = mkdtempSync(join(tmpdir(), "roteiro-13132-"));
    try {
      const warns: string[] = [];
      assert.deepEqual(readRoteiroFontes(dir, (w) => warns.push(w)), []);
      assert.equal(warns.length, 0, "sem roteiro = silêncio");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(roteiro261116()));
      assert.equal(readRoteiroFontes(dir, (w) => warns.push(w))[0].sustenta, "Hydrogen 51 e Argon 50 no índice");
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), "{");
      assert.deepEqual(readRoteiroFontes(dir, (w) => warns.push(w)), []);
      assert.ok(warns.some((w) => w.includes("ilegível")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13120: página gerada do JSON, com o box Na tela", () => {
  const html = renderRoteiroPagina(roteiro261116(), { versao: "v5", artifactLine: "<!-- artifact: https://claude.ai/artifact/abc -->" });

  it("box Na tela ao lado da fala nos três vídeos, empilhado no celular", () => {
    const telas = html.match(/<aside class="tela"><b>Na tela<\/b>App do Gemini/g) ?? [];
    assert.equal(telas.length, 3, "a H4 está nos três vídeos");
    assert.match(html, /Hydrogen 51 × Argon 50/);
    assert.match(html, /Artificial Analysis Intelligence Index<br>Hydrogen/);
    assert.match(html, /@media \(max-width: 640px\) \{ \.row \{ grid-template-columns: 1fr/);
  });

  it("o corte aparece riscado só no vertical; a duração é calculada; a ordem do vertical 1 vale", () => {
    const secoes = html.split(/<section class="sheet"/);
    const [horizontal, vertical1] = [secoes[1], secoes[2]];
    assert.ok(!horizontal.includes("<del"));
    assert.match(vertical1, /<del title="cortado neste vídeo"> e em outros serviços da empresa<\/del>/);
    assert.ok(vertical1.indexOf("Em seis semanas") < vertical1.indexOf("O Google entrega o Hydrogen"));
    assert.ok(horizontal.indexOf("Em seis semanas") > horizontal.indexOf("O Google entrega o Hydrogen"));
    assert.match(html, /<li><b>Vertical 1, a notícia:<\/b> cerca de \d+ s \(alvo ~60 s\)/);
  });

  it("notas: ordem, cortes, fontes, fatos checados e pontos de fora; link do artifact no topo", () => {
    assert.ok(html.startsWith("<!-- artifact: https://claude.ai/artifact/abc -->\n"));
    assert.match(html, /Ordem no vertical 1:<\/b> H1, H4, H6, H10, H10c, H10f, V1-CTA/);
    assert.match(html, /Cortes no vertical 1:<\/b> H4, " e em outros serviços da empresa" \(sempre\); H10f, "Pra pergunta rápida/);
    assert.match(html, /<a href="https:\/\/artificialanalysis.ai\/models">Hydrogen 51 e Argon 50 no índice<\/a>/);
    assert.match(html, /mapa Pro\/Flash\/Flash-Lite \(contraditório; corrigido para: o Hydrogen sucede o Flash\)/);
    assert.match(html, /preço da API: fala com quem não programa/);
  });

  it("render-roteiro-video grava a página e mantém a linha do artifact da anterior", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-13120-"));
    try {
      const falas = join(dir, "roteiro-falas.json");
      const out = join(dir, "roteiro-d1.html");
      writeFileSync(falas, JSON.stringify(roteiro261116()));
      writeFileSync(out, "<!-- artifact: https://claude.ai/artifact/xyz -->\n<p>velha</p>");
      assert.equal(renderMain(["261116", "--falas", falas, "--out", out], { out: () => {}, err: () => {} }), 0);
      const novo = readFileSync(out, "utf8");
      assert.equal(artifactLineOf(novo), "<!-- artifact: https://claude.ai/artifact/xyz -->");
      assert.ok(!novo.includes("velha"));
      assert.equal(renderMain(["261116", "--falas", join(dir, "nao-existe.json"), "--out", out], { out: () => {}, err: () => {} }), 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tela vazia é recusada pelo validador; tela presente não", () => {
    const r = roteiro261116();
    assert.deepEqual(validarRoteiroFalas(r), []);
    r.falas[0].tela = "  ";
    assert.match(validarRoteiroFalas(r).join("\n"), /falas\[0\]\.tela deve ser texto não vazio/);
  });
});

