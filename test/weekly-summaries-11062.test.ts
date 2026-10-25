/**
 * #11062 (opção a): validação do resumo por item da retro semanal.
 * Fixtures = os 8 resumos aprovados pelo editor em 25/10/2026 (retro 261024)
 * e os "Por que isso importa" crus que eles substituíram.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateWeeklySummary,
  weeklySummaryWarnings,
  resolveWeeklySummaries,
  readWeeklySummaries,
  significantWords,
} from "../scripts/lib/weekly-summaries.ts";
import { formatInstagramWeekly, formatFacebookWeekly } from "../scripts/lib/format-weekly-social.ts";

const APPROVED: [string, string][] = [
  ["Meta admite que seus óculos gravaram sem comando", "Revisores contratados para treinar a IA da empresa viram usuários em situações íntimas."],
  ["Seu cargo de júnior sobreviveria na Anthropic?", "A fatia de vagas técnicas júnior nas contratações caiu de 27% para 9%, e os agentes dos funcionários já trabalham seis vezes mais horas que eles."],
  ["Você já viu IA mentir. Já viu roubar?", "Um modelo de pesquisa da OpenAI gastou a cripto de uma carteira alheia para terminar uma tarefa, escondeu isso dos pesquisadores e só foi pego três meses depois."],
  ["Claude projetou proteínas contra veneno de escorpião", "Foram 318 mil projetos em 64 horas. Dos 211 testados em laboratório, 17 se ligaram às toxinas, mas ainda não é um antiveneno."],
  ["Falhas no PHP colocam a internet em alerta global", "Os bugs passaram mais de dez anos despercebidos, e no Brasil a Anatel e tribunais federais tiraram o SEI do ar por precaução."],
  ["Mistral desafia ElevenLabs com voz mais barata", "O Voxtral 3 monta atendentes que falam português e fazem ligações por US$ 0,04 o minuto."],
  ["CFM dá ao médico a palavra final sobre a máquina", "Dois em cada três médicos já usam IA no consultório, e hospitais passam a responder pela auditoria desses sistemas."],
  ["NVIDIA põe agente para rodar no seu PC, sem nuvem", "Os modelos são abertos e cabem em placas RTX de 24 GB, então pesquisar, escrever e depurar código acontece no próprio computador."],
];

describe("validateWeeklySummary (#11062)", () => {
  for (const [title, summary] of APPROVED) {
    it(`aprovado pelo editor passa: "${title}"`, () => {
      assert.deepEqual(validateWeeklySummary(title, summary), []);
    });
  }

  it("why cru que repete o título é barrado (Meta/óculos)", () => {
    const p = validateWeeklySummary(
      "Meta admite que seus óculos gravaram sem comando",
      "Óculos com câmera ficam no rosto o dia inteiro, e uma gravação acionada sem comando registra quem usa e quem está por perto.",
    );
    assert.ok(p.some((x) => /repete o título/.test(x)), p.join(" | "));
  });

  for (const loose of [
    "O modelo questionou a ética do atalho, seguiu mesmo assim e a omissão passou três meses sem ser notada.",
    "Avanços como esse aceleram a busca por moléculas que podem virar remédio.",
    "São dados internos de uma das empresas que desenvolvem os próprios agentes.",
    "Isso muda quem é contratado.",
  ]) {
    it(`anáfora solta vira aviso (não barra): "${loose.slice(0, 30)}…"`, () => {
      assert.equal(weeklySummaryWarnings(loose).length, 1);
    });
  }

  it("mais de 2 frases é barrado", () => {
    const p = validateWeeklySummary("Título", "Primeira frase curta. Segunda frase curta. Terceira frase curta.");
    assert.ok(p.some((x) => /3 frases/.test(x)));
  });

  it("passar de 200 caracteres é barrado", () => {
    const p = validateWeeklySummary("Título", "Palavra ".repeat(40).trim() + ".");
    assert.ok(p.some((x) => /200 caracteres/.test(x)));
  });

  it("vazio é barrado", () => {
    assert.deepEqual(validateWeeklySummary("Título", "  "), ["resumo vazio"]);
  });

  it("nomear o mesmo ator do título (1 palavra) não conta como repetir", () => {
    assert.deepEqual(validateWeeklySummary("Anthropic testa agente novo", "A Anthropic liberou o teste para 5 mil empresas nos Estados Unidos."), []);
  });

  it("significantWords ignora acento, caixa e palavras curtas", () => {
    assert.deepEqual(significantWords("Óculos da Meta gravaram"), ["oculos", "gravaram"]);
  });
});

describe("resolveWeeklySummaries / readWeeklySummaries (#11062)", () => {
  it("separa válidos, ausentes e inválidos", () => {
    const items = [
      { url: "a", title: "Meta admite que seus óculos gravaram sem comando" },
      { url: "b", title: "Falhas no PHP colocam a internet em alerta global" },
      { url: "c", title: "Título sem resumo" },
      { url: "d", title: "Mistral desafia ElevenLabs com voz mais barata" },
    ];
    const r = resolveWeeklySummaries(
      items,
      new Map([
        ["a", APPROVED[0][1]],
        ["b", "Esse problema é grave."],
        ["c", ""],
        ["d", "A Mistral desafia a ElevenLabs com uma voz bem mais barata."],
      ]),
    );
    assert.deepEqual([...r.ok.keys()], ["a", "b"]);
    assert.deepEqual(r.missing, ["Título sem resumo"]);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0].url, "d");
    assert.equal(r.warnings[0].url, "b", "anáfora solta é aviso, não invalida");
  });

  it("arquivo ausente → null; corrompido → lança (nunca vira 'sem resumo' em silêncio)", () => {
    const dir = mkdtempSync(join(tmpdir(), "weekly-summaries-"));
    try {
      assert.equal(readWeeklySummaries(join(dir, "nao-existe.json")), null);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ não é json");
      assert.throws(() => readWeeklySummaries(bad), /corrompido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("format-weekly-social: summary tem precedência sobre why (#11062)", () => {
  const item = { title: "Título X", why: "Por que importa cru. Segunda frase.", body: "Corpo.", summary: "Resumo novo com fato. Segunda frase curta." };
  it("Instagram usa o resumo inteiro", () => {
    const c = formatInstagramWeekly([item], "highlights");
    assert.match(c, /1\. Título X\nResumo novo com fato\. Segunda frase curta\./);
    assert.doesNotMatch(c, /Por que importa cru/);
  });
  it("Facebook usa o resumo inteiro", () => {
    assert.match(formatFacebookWeekly([item], "highlights"), /Resumo novo com fato\. Segunda frase curta\./);
  });
  it("sem resumo, cai no why (comportamento antigo, só com --allow-why-fallback no publisher)", () => {
    assert.match(formatInstagramWeekly([{ ...item, summary: undefined }], "highlights"), /Por que importa cru\./);
  });
});
