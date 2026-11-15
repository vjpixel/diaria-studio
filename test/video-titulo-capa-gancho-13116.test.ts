/**
 * test/video-titulo-capa-gancho-13116.test.ts — #13116 (critérios decididos
 * com o editor em 15/11/2026, no roteiro da 261116).
 *
 * O roteiro da 261116 saiu com três problemas corrigidos na conversa: gancho
 * de ~10 s com o que importa no fim, título do vertical quase igual ao gancho
 * e capa em pergunta sem sujeito ("Inventa cinco vezes menos?"). Os avisos:
 *   1. `avisosGanchoETitulo` (video-roteiro-blocos): gancho do vertical com
 *      mais de ~8 palavras antes do 1º ponto; título que repete o gancho;
 *   2. `scoreCapaHook` (suggest-capa-hooks): capa do Short sem sujeito
 *      reconhecível; repetição conferida também contra o título do vídeo,
 *      não só o do D1 (na 261116 o D1 era outro assunto).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { avisosGanchoETitulo, primeiraFrase, ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";
import { formatCapaSuggestions, hasRecognizableSubject, scoreCapaHook } from "../scripts/lib/diaria/youtube-capa-hooks.ts";
import { parseSuggestArgs, readRoteiroTitles } from "../scripts/suggest-capa-hooks.ts";
import { main as roteiroBlocosMain } from "../scripts/video-roteiro-blocos.ts";

/** Forma do roteiro da 261116 antes da correção na conversa (texto ilustrativo). */
const ROTEIRO_RUIM: RoteiroFalas = {
  edicao: "261116",
  porVideo: {
    horizontal: { titulo: "Google Busca com IA: as respostas inventam menos", capa: "Inventa cinco vezes menos?" },
    vertical1: { titulo: "A busca do Google inventa cinco vezes menos", capa: "Inventa cinco vezes menos?" },
  },
  falas: [
    {
      id: "H1",
      bloco: "gancho",
      texto: "Segundo um estudo novo que comparou várias ferramentas durante meses, a busca do Google inventa cinco vezes menos. E isso muda como você pesquisa.",
      videos: ["horizontal", "vertical1"],
    },
    { id: "H2", bloco: "resumo", texto: "O estudo comparou as respostas.", videos: ["horizontal", "vertical1"] },
  ],
};

/** A versão corrigida: gancho curto, título com o assunto, gancho com a tensão. */
const ROTEIRO_BOM: RoteiroFalas = {
  edicao: "261116",
  porVideo: {
    horizontal: { titulo: "Google Busca com IA: as respostas inventam menos", capa: "Sua busca erra menos" },
    vertical1: { titulo: "A busca do Google ficou mais confiável", capa: "Google inventa menos" },
  },
  falas: [
    { id: "H1", bloco: "gancho", texto: "Sua pesquisa agora erra menos. Mas não confia cego.", videos: ["horizontal", "vertical1"] },
    { id: "H2", bloco: "resumo", texto: "O estudo comparou as respostas.", videos: ["horizontal", "vertical1"] },
  ],
};

describe("#13116 (4): o gancho do vertical chega ao ponto em ~3 s", () => {
  it("primeiraFrase corta no primeiro ponto seguido de espaço, sem cortar número decimal", () => {
    assert.equal(primeiraFrase("Caiu 1.5 vezes. Depois subiu."), "Caiu 1.5 vezes.");
    assert.equal(primeiraFrase("Sem ponto nenhum"), "Sem ponto nenhum");
  });

  it("gancho longo antes do 1º ponto avisa no vertical, nunca no horizontal", () => {
    const avisos = avisosGanchoETitulo(ROTEIRO_RUIM);
    const longo = avisos.filter((a) => a.includes("palavras até o primeiro ponto"));
    assert.equal(longo.length, 1, avisos.join("\n"));
    assert.match(longo[0], /^H1: o gancho do vertical 1 leva 18 palavras/);
    assert.match(longo[0], /~7 s a 150 palavras\/min/);
  });

  it("o roteiro corrigido não avisa nada", () => {
    assert.deepEqual(avisosGanchoETitulo(ROTEIRO_BOM), []);
  });
});

describe("#13116 (1): título e gancho, mesma promessa com palavras diferentes", () => {
  it("título do vertical que repete o gancho avisa", () => {
    const avisos = avisosGanchoETitulo(ROTEIRO_RUIM);
    assert.ok(avisos.some((a) => a.startsWith("vertical 1: o título repete o gancho H1")), avisos.join("\n"));
  });

  it("título igual à primeira frase do gancho avisa mesmo com poucas palavras de conteúdo", () => {
    const r: RoteiroFalas = {
      porVideo: { vertical2: { titulo: "Faz isso hoje" } },
      falas: [{ id: "V2-gancho", bloco: "gancho", texto: "Faz isso hoje.", videos: ["vertical2"], gravarAParte: true }],
    };
    assert.ok(avisosGanchoETitulo(r).some((a) => a.startsWith("vertical 2: o título repete o gancho V2-gancho")));
  });

  it("a CLI video-roteiro-blocos imprime os avisos sem mudar o exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-13116-"));
    try {
      const path = join(dir, "roteiro-falas.json");
      writeFileSync(path, JSON.stringify(ROTEIRO_RUIM));
      const err: string[] = [];
      assert.equal(roteiroBlocosMain(["261116", "--falas", path], { out: () => {}, err: (s) => err.push(s) }), 0);
      assert.ok(err.some((l) => l.startsWith("[aviso] H1: o gancho do vertical 1")), err.join("\n"));
      assert.ok(err.some((l) => l.startsWith("[aviso] vertical 1: o título repete o gancho")), err.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13116 (3): a capa do vertical se explica sozinha", () => {
  it("sujeito reconhecível: nome conhecido, pronome que fala com quem vê, nome próprio no meio", () => {
    assert.equal(hasRecognizableSubject("Inventa cinco vezes menos?"), false);
    assert.equal(hasRecognizableSubject("Google inventa menos"), true);
    assert.equal(hasRecognizableSubject("Sua Busca erra menos"), true);
    assert.equal(hasRecognizableSubject("Demitidos pela IA"), true);
    assert.equal(hasRecognizableSubject("Treinou o|substituto da Petrobras?"), true);
  });

  it("capa do Short sem sujeito leva aviso, e ele aparece na lista para o editor", () => {
    const d1 = { title: "Busca do Google erra menos que chatbots, diz estudo" };
    const sem = scoreCapaHook("Inventa cinco vezes menos?", d1);
    assert.ok(sem.short_hook, "cabe no Short");
    assert.match(sem.short_warning ?? "", /sem sujeito reconhecível/);
    const com = scoreCapaHook("Sua busca erra menos", d1);
    assert.equal(com.short_warning, null);
    assert.match(formatCapaSuggestions([sem], d1), /aviso no Short: sem sujeito/);
  });
});

describe("#13116: a capa é conferida contra o título do vídeo, não só o do D1", () => {
  // Na 261116 o D1 do 02-reviewed.md era outro assunto que o do vídeo.
  const d1 = { title: "OpenAI anuncia novo plano para empresas" };
  const videoTitle = "Google Busca com IA: as respostas inventam menos";

  it("sem o título do vídeo a repetição passa; com ele, é trecho literal", () => {
    const so = scoreCapaHook("as respostas inventam menos", d1);
    assert.equal(so.violations.length, 0, so.violations.join("; "));
    const com = scoreCapaHook("as respostas inventam menos", d1, "agente", { titles: [videoTitle] });
    assert.ok(com.violations.some((v) => /trecho literal do título do vídeo/.test(v)), com.violations.join("; "));
  });

  it("repetição parcial do título do vídeo penaliza e diz de qual título", () => {
    const s = scoreCapaHook("Respostas do Google inventam?", d1, "agente", { titles: [videoTitle] });
    assert.match(s.notes.join(" "), /repete o título do vídeo/);
  });

  it("--title é repetível; sem ele, os títulos vêm do roteiro-falas.json", () => {
    assert.deepEqual(parseSuggestArgs(["261116", "--title", "A", "--title=B"]).titles, ["A", "B"]);
    const dir = mkdtempSync(join(tmpdir(), "capa-13116-"));
    try {
      const warns: string[] = [];
      assert.deepEqual(readRoteiroTitles(dir, (w) => warns.push(w)), []);
      assert.equal(warns.length, 0);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), "{");
      assert.deepEqual(readRoteiroTitles(dir, (w) => warns.push(w)), []);
      assert.equal(warns.length, 1);
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(ROTEIRO_BOM));
      assert.deepEqual(readRoteiroTitles(dir, (w) => warns.push(w)), [
        "Google Busca com IA: as respostas inventam menos",
        "A busca do Google ficou mais confiável",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
