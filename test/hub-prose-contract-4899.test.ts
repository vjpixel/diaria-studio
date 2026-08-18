/**
 * test/hub-prose-contract-4899.test.ts (#4899)
 *
 * O contrato de prosa dos hubs temáticos, exercido em três direções:
 *
 * 1. **Cada regra reprova** um `HubContent` sintético que a viole — inclusive
 *    nas variantes que a auditoria mostrou que uma regex ingênua perde.
 * 2. **Os hubs reais passam**, todos, iterando `HUB_LOADERS` em vez de uma
 *    lista escrita à mão (foi a lista à mão do #4795 que deixou o 4º hub
 *    escapar de um guard por horas, #4926).
 * 3. **Um hub fictício violando cada regra reprova** — é isto, e não o item 2,
 *    que garante que a cobertura é DO CONTRATO e não dos hubs de hoje. Sem
 *    ele, apagar uma regra de `HUB_PROSE_RULES` deixaria a suíte verde.
 *
 * E um caso negativo que vale tanto quanto os positivos: **afirmação sobre o
 * próprio arquivo tem de passar limpa.** "Em 76 edições, o ritmo veio em
 * surtos" é o que a página tem de próprio; um lint que a reprovasse teria
 * virado teto de menção de marca, que é exatamente o desenho que o contrato
 * proíbe (ver docstring de `HUB_PROSE_RULES`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import {
  HUB_PROSE_RULES,
  formatDateLong,
  hubCoverageWindow,
  hubMentionCadenceDays,
  hubTotals,
  matchingDates,
  maxDateGap,
  validateHubContent,
  type HubContent,
} from "../scripts/lib/shared/hub-page.ts";

/** Base VÁLIDA mínima — satisfaz os invariantes estruturais (datas, 6-10
 * perguntas, fontes ordenadas e no domínio de marca) para que qualquer
 * violação reportada venha da prosa, não de outra coisa. */
function baseHub(over: Partial<HubContent> = {}): HubContent {
  return {
    slug: "fixture",
    title: "Tema de Teste",
    metaDescription: "Um tema qualquer no arquivo, de janeiro a fevereiro de 2026: fatos e datas.",
    introHeading: "O que aconteceu com o tema de teste em 2026?",
    introParagraph: "Entre janeiro e fevereiro de 2026, o tema apareceu duas vezes, com um mês de intervalo.",
    sections: [{ heading: "O que mudou no período?", paragraphs: ["Em 15 de janeiro de 2026, algo mudou."] }],
    faq: Array.from({ length: 6 }, (_, i) => ({
      question: `Pergunta ${i + 1} sobre o tema?`,
      answer: `Resposta ${i + 1}, com data absoluta: 15 de janeiro de 2026.`,
    })),
    sourceEditions: [{ date: "2026-02-15", title: "Manchete", url: "https://diar.ia.br/p/edicao" }],
    publishedDate: "2026-02-16",
    updatedDate: "2026-02-16",
    footerNavUtm: { source: "fixture", medium: "test" },
    methodologyNote: "O levantamento vem de 1 edição publicada em fevereiro de 2026; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.",
    ...over,
  };
}

const proseErrors = (hub: HubContent, ruleId?: string) =>
  validateHubContent(hub).filter((e) => e.includes(ruleId ? ` viola ${ruleId}:` : " viola "));

/**
 * #4944 item 1 — checa se `date` aparece no campo `value` no PAPEL de início
 * de janela ("desde {date}", "entre {date} e ...", "de {date} a ...") em vez
 * de só EM QUALQUER LUGAR do texto. Substitui o `value.includes(f)` solto que
 * o teste `#4917` abaixo usava: esse `includes` marcava como correto um campo
 * que citasse a janela ERRADA mas mencionasse a data certa em outro contexto
 * do mesmo campo — furo concreto, não hipotético (a issue #4944 aponta que os
 * `introParagraph` já citam várias datas sem relação com a janela).
 *
 * Duas formas aceitas, cobrindo as 3 construções que os 4 hubs reais usam:
 * - `\b(desde|entre)\b[^.]{0,40}{date}` — "desde {date}?" (introHeading) e
 *   "Entre {date} e ..." / "Entre {dia} de {date}, ..." (introParagraph, a
 *   forma longa do google-gemini inclusa: a janela de 40 chars cobre o "27 de"
 *   entre "Entre" e o mês/ano).
 * - `\bde\s+{date}` — "..., de {date} a {until}: ..." (metaDescription), só
 *   com "de" IMEDIATAMENTE antes da data (sem janela de distância) — um "de"
 *   a 40 chars de distância é comum demais em prosa corrida pra servir de
 *   âncora confiável (qualquer "X de {mês} de {ano}" anterior no mesmo campo
 *   colaria com uma janela larga).
 */
function citesWindowDate(value: string, date: string): boolean {
  const escaped = date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(desde|entre)\\b[^.]{0,40}${escaped}|\\bde\\s+${escaped}`, "i").test(value);
}

describe("#4899 — contrato de prosa dos hubs", () => {
  it("a base do fixture é válida (senão os casos abaixo testariam outra coisa)", () => {
    assert.deepEqual(validateHubContent(baseHub()), []);
  });

  describe("cada regra reprova o que deve reprovar", () => {
    it("heading-sem-marca: marca no H2, na pergunta de FAQ e no introHeading", () => {
      for (const over of [
        { introHeading: "O que aconteceu com o tema, segundo a diar.ia.br?" },
        { sections: [{ heading: "Quanto vale, segundo a cobertura?", paragraphs: ["Fato."] }] } as Partial<HubContent>,
        { faq: baseHub().faq.map((f, i) => (i ? f : { ...f, question: "Em quantas edições a diar.ia.br falou disso?" })) },
      ]) {
        assert.equal(proseErrors(baseHub(over), "heading-sem-marca").length, 1, JSON.stringify(over).slice(0, 90));
      }
    });

    it("heading-sem-marca pega a marca SEM a construção 'segundo a' — o vão da regex original da #4914", () => {
      const hub = baseHub({ faq: baseHub().faq.map((f, i) => (i ? f : { ...f, question: "Em quantas edições a diar.ia.br destacou o tema?" })) });
      assert.equal(proseErrors(hub, "heading-sem-marca").length, 1);
    });

    it("prosa-sem-publicacao-como-sujeito: verbo de cobertura com a publicação no sujeito", () => {
      for (const p of [
        "A diar.ia.br cobriu uma escalada entre as duas empresas.",
        "Em 2026, a diar.ia.br noticiou o lançamento.",
        "A diar.ia.br nunca publicou o número absoluto.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-publicacao-como-sujeito").length, 1, p);
      }
    });

    it("prosa-sem-publicacao-como-sujeito: ORDEM INVERTIDA — verbo antes da marca (#5628)", () => {
      // Falha literal da forma original: a regra ancorava só em "a diar.ia.br
      // <verbo>", nunca em "<verbo> a diar.ia.br" — a ordem de discurso
      // direto que "'X?' perguntou a diar.ia.br em DD/MM" usa.
      for (const p of [
        '"O ChatGPT agora tem anúncios, será tendência?" perguntou a diar.ia.br em 20/01/2026.',
        "Apurou a diar.ia.br que o caso teve desdobramento.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-publicacao-como-sujeito").length, 1, p);
      }
    });

    it("prosa-sem-moldura-de-cobertura: cobertura/arquivo/arco como sujeito de verbo narrativo (#5628)", () => {
      for (const p of [
        "Ao longo de 2026, a cobertura registrou uma virada clara de posicionamento.",
        "O arco fecha 146 dias depois do último curso, de um jeito quase irônico.",
        "Vinte e sete dias depois, a cobertura ampliou o adversário citado.",
        "Em pouco tempo, o arquivo já mostrou um padrão diferente.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-moldura-de-cobertura").length, 1, p);
      }
    });

    it("prosa-sem-moldura-de-cobertura NÃO pega uso como OBJETO (achado só fica visível olhando...)", () => {
      // Mesmo critério do CASO NEGATIVO geral: afirmação sobre o próprio
      // arquivo é o que justifica a página — aqui isso significa "arquivo"/
      // "cobertura" como OBJETO de verbo/preposição, nunca como sujeito.
      for (const p of [
        "Isso só fica visível olhando o arquivo inteiro, não uma edição isolada.",
        "É o ponto mais concreto de toda a cobertura sobre o tema no período.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.deepEqual(proseErrors(hub, "prosa-sem-moldura-de-cobertura"), [], p);
      }
    });

    it("prosa-sem-ponteiro-de-secao: ponteiro sem a palavra 'seção' (#5628)", () => {
      for (const p of [
        "Cada um desses pontos aparece detalhado adiante, com data e link.",
        "O restante do episódio é detalhado a seguir.",
        "Os demais casos estão listados abaixo.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-ponteiro-de-secao").length, 1, p);
      }
    });

    it("prosa-sem-qualificador-atributivo: a moldura 'segundo a…' em PROSA, não só em heading", () => {
      // O gêmeo em heading já existia; em prosa não havia regra, e é onde a
      // construção é mais provável (achado do review da PR #4938).
      for (const p of [
        "Segundo a diar.ia.br, o modelo foi lançado em julho de 2026.",
        "Segundo a cobertura, houve três incidentes no período.",
        "De acordo com a diar.ia.br, a empresa dobrou de valor.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-qualificador-atributivo").length, 1, p);
      }
    });

    it("as variantes que a forma ingênua de cada regra perdia (achados do review)", () => {
      const cases: [string, string][] = [
        // verbo no presente e advérbio/auxiliar interposto
        ["A diar.ia.br cobre o caso desde o início.", "prosa-sem-publicacao-como-sujeito"],
        ["A diar.ia.br já cobriu esse tema antes.", "prosa-sem-publicacao-como-sujeito"],
        ["A diar.ia.br vem cobrindo o caso desde então.", "prosa-sem-publicacao-como-sujeito"],
        ["A diar.ia.br relatou o incidente na semana seguinte.", "prosa-sem-publicacao-como-sujeito"],
        // determinante diferente na moldura de edição
        ["Nessa mesma edição, o modelo foi lançado.", "prosa-sem-moldura-de-edicao"],
        ["Naquela mesma edição, saiu a notícia.", "prosa-sem-moldura-de-edicao"],
        ["Na edição seguinte, o caso teve desdobramento.", "prosa-sem-moldura-de-edicao"],
        // fronteira de palavra: "nesta" não tem \b entre "n" e "esta"
        ["O conteúdo está descrito nesta página.", "prosa-sem-deixis"],
        ["Nesta seção, os fatos aparecem completos.", "prosa-sem-deixis"],
      ];
      for (const [p, ruleId] of cases) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, ruleId).length, 1, `${ruleId} deveria pegar: ${p}`);
      }
    });

    it("prosa-sem-ponteiro-de-secao NÃO pega comparação estatística ('acima da média')", () => {
      // Falso positivo demonstrado no review: prosa densa e numérica é o tom
      // editorial destes hubs, e "acima da média" perto de "seção" não é
      // ponteiro nenhum.
      for (const p of [
        "A seção sobre segurança, cujo crescimento ficou muito acima da média do arquivo, fecha o tema.",
        "A seção trouxe alta de 12%, valor acima da meta anual definida em janeiro.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.deepEqual(proseErrors(hub, "prosa-sem-ponteiro-de-secao"), [], p);
      }
    });

    it("reporta TODAS as ocorrências no mesmo campo, não só a primeira", () => {
      // Com `.exec` o autor consertava a 1ª e descobria a 2ª na rodada
      // seguinte — whack-a-mole (achado do review).
      const hub = baseHub({
        sections: [
          {
            heading: "O que mudou?",
            paragraphs: ["Este hub cobre o início. Mais adiante, neste hub também aparece o fim."],
          },
        ],
      });
      assert.equal(proseErrors(hub, "prosa-sem-deixis").length, 2);
    });

    it("prosa-sem-moldura-de-edicao: fatos ligados pelo recipiente em vez da data", () => {
      for (const p of [
        "Na mesma edição em que saiu o modelo, a empresa venceu na Justiça.",
        "Uma edição inteira tratou do assunto.",
      ]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-moldura-de-edicao").length, 1, p);
      }
    });

    it("prosa-sem-deixis: 'este hub' e 'esta página'", () => {
      for (const p of ["O período coberto por este hub termina aí.", "Esta página é atualizada às vezes."]) {
        const hub = baseHub({ sections: [{ heading: "O que mudou?", paragraphs: [p] }] });
        assert.equal(proseErrors(hub, "prosa-sem-deixis").length, 1, p);
      }
    });

    it("prosa-sem-ponteiro-de-secao pega a forma FROUXA, com palavra entre 'seção' e 'acima'", () => {
      // A forma estrita (/seç(ão|ões) (acima|abaixo)/) perde a 2ª e a 3ª —
      // e eram justamente as 8 do 4º hub (#4926).
      for (const p of [
        "A seção acima detalha a cronologia.",
        "A seção sobre segurança e moderação acima traz o histórico.",
        "As seções abaixo detalham cada ponto.",
      ]) {
        const hub = baseHub({ faq: baseHub().faq.map((f, i) => (i ? f : { ...f, answer: p })) });
        assert.equal(proseErrors(hub, "prosa-sem-ponteiro-de-secao").length, 1, p);
      }
    });
  });

  it("CASO NEGATIVO: afirmação sobre o próprio arquivo passa limpa", () => {
    // Se este teste algum dia falhar, a regra virou teto de menção de marca —
    // que mata o que justifica a existência do hub. Ver docstring de
    // HUB_PROSE_RULES: o contrato proíbe CONSTRUÇÕES, nunca palavras.
    const hub = baseHub({
      sections: [
        {
          heading: "Com que frequência o tema vira notícia?",
          paragraphs: [
            "Em 76 edições da diar.ia.br ao longo de 11 meses, 84 manchetes: o ritmo de lançamento vem em surtos, não em fluxo constante.",
            "Nas 84 manchetes acompanhadas entre agosto de 2025 e agosto de 2026, o padrão se repete.",
          ],
        },
      ],
    });
    assert.deepEqual(proseErrors(hub), []);
  });

  it("um hub fictício que viola TODAS as regras reprova em todas elas", () => {
    // Trava a cobertura no CONTRATO, não nos hubs de hoje: apagar uma regra
    // de HUB_PROSE_RULES faz este teste cair.
    const hub = baseHub({
      introHeading: "O que aconteceu, segundo a diar.ia.br?",
      sections: [
        {
          heading: "Quanto vale, segundo a cobertura?",
          paragraphs: [
            "A diar.ia.br cobriu o caso na mesma edição em que saiu o modelo, e a seção sobre isso acima detalha o período coberto por este hub.",
            "Segundo a diar.ia.br, o modelo foi lançado em julho de 2026. A cobertura registrou o desfecho em agosto.",
          ],
        },
      ],
    });
    // A lista é LITERAL de propósito. Derivá-la de `HUB_PROSE_RULES` tornava
    // este teste tautológico: `validateHubContent` itera o mesmo array, então
    // apagar uma regra encolhia os dois lados e a asserção passava verde —
    // exatamente o contrário do que o teste promete (achado do review da PR
    // #4938). Regra nova no contrato = uma linha aqui, de propósito.
    const EXPECTED_RULE_IDS = [
      "heading-sem-marca",
      "prosa-sem-publicacao-como-sujeito",
      "prosa-sem-qualificador-atributivo",
      "prosa-sem-moldura-de-edicao",
      "prosa-sem-moldura-de-cobertura",
      "prosa-sem-deixis",
      "prosa-sem-ponteiro-de-secao",
    ];
    assert.deepEqual(
      HUB_PROSE_RULES.map((r) => r.id).sort(),
      [...EXPECTED_RULE_IDS].sort(),
      "HUB_PROSE_RULES mudou — atualize EXPECTED_RULE_IDS e o fixture que exercita cada regra",
    );
    const hit = new Set(
      proseErrors(hub)
        .map((e) => EXPECTED_RULE_IDS.find((id) => e.includes(` viola ${id}:`)))
        .filter(Boolean) as string[],
    );
    assert.deepEqual([...hit].sort(), [...EXPECTED_RULE_IDS].sort(), "toda regra do contrato precisa de um caso que a exercite");
  });

  describe("os hubs reais cumprem o contrato — todos os de HUB_LOADERS", () => {
    const slugs = Object.keys(HUB_LOADERS);
    it("o registry tem os hubs esperados", () => {
      assert.ok(slugs.length >= 4, `esperado >= 4 hubs em HUB_LOADERS, veio ${slugs.length}`);
    });
    for (const [slug, load] of Object.entries(HUB_LOADERS)) {
      it(`${slug}: zero violação de prosa`, () => {
        assert.deepEqual(proseErrors(load()), []);
      });
    }
  });

  describe("#4939 — methodologyNote: isenção de prosa-sem-deixis é POR CAMPO, não afrouxamento da regra", () => {
    it("dêixis ('esta página') passa limpa dentro de methodologyNote", () => {
      const hub = baseHub({
        methodologyNote: "Os números desta página vêm do arquivo da diar.ia.br, não de verificação independente.",
      });
      assert.deepEqual(proseErrors(hub, "prosa-sem-deixis"), []);
    });

    it("a MESMA dêixis continua reprovando em introParagraph/sections/faq — a regex não afrouxou", () => {
      for (const over of [
        { introParagraph: "O conteúdo está descrito nesta página, com fatos e datas." },
        { sections: [{ heading: "O que mudou?", paragraphs: ["Nesta seção, os fatos aparecem completos."] }] },
        { faq: baseHub().faq.map((f, i) => (i ? f : { ...f, answer: "Está descrito nesta página." })) },
      ] as Partial<HubContent>[]) {
        assert.equal(proseErrors(baseHub(over), "prosa-sem-deixis").length, 1, JSON.stringify(over).slice(0, 90));
      }
    });

    it("outras regras do contrato (não a isenta) continuam valendo em methodologyNote", () => {
      const hub = baseHub({
        methodologyNote: "A diar.ia.br cobriu o tema com base no próprio arquivo, não em checagem externa.",
      });
      assert.equal(proseErrors(hub, "prosa-sem-publicacao-como-sujeito").length, 1);
    });

    it("validateHubContent reprova um HubContent sem methodologyNote (vazio)", () => {
      const hub = baseHub({ methodologyNote: "" });
      const errors = validateHubContent(hub);
      assert.ok(errors.some((e) => /methodologyNote está vazio/.test(e)), errors.join("; "));
    });

    it("os 4 hubs reais têm methodologyNote não-vazio e derivado de SOURCES (N/janela nunca digitados)", () => {
      for (const [slug, load] of Object.entries(HUB_LOADERS)) {
        const hub = load();
        assert.ok(hub.methodologyNote.trim().length > 0, `${slug}: methodologyNote vazio`);
        const { between } = hubCoverageWindow(hub.sourceEditions);
        assert.match(
          hub.methodologyNote,
          new RegExp(`${hub.sourceEditions.length} edições publicadas entre ${between.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          `${slug}: methodologyNote não cita N/janela computados de SOURCES: "${hub.methodologyNote}"`,
        );
      }
    });
  });

  describe("#4917 — a janela de cobertura é DERIVADA, nunca digitada", () => {
    it("hubCoverageWindow acha min/max sem depender da ordenação", () => {
      const asc = hubCoverageWindow([{ date: "2025-08-29" }, { date: "2026-08-06" }]);
      const desc = hubCoverageWindow([{ date: "2026-08-06" }, { date: "2025-08-29" }]);
      assert.deepEqual(asc, desc);
      assert.equal(asc.between, "agosto de 2025 e agosto de 2026");
      assert.equal(asc.since, "agosto de 2025");
    });

    for (const [slug, load] of Object.entries(HUB_LOADERS)) {
      it(`${slug}: a janela citada em intro/heading/meta bate com a primeira fonte real`, () => {
        // Reprovava antes deste commit em anthropic-claude e openai-chatgpt:
        // os dois diziam "setembro de 2025" com a primeira fonte em 29/08 e
        // 27/08/2025. É o mesmo defeito que a #4895/#4896 consertou uma vez
        // no google-gemini e que voltou nos gêmeos — por isso o guard cobre
        // os 3 campos, não só o parágrafo (o #4896 aprendeu isso na marca).
        const hub = load();
        const { since, firstDate } = hubCoverageWindow(hub.sourceEditions);
        const [y, m, d] = firstDate.split("-");
        // Duas formas aceitas: "agosto de 2025" (mês por extenso) e
        // "27/08/2025" (o google-gemini usa data cheia na intro).
        const accepted = [since, `${d}/${m}/${y}`];
        for (const [field, value] of [
          ["introParagraph", hub.introParagraph],
          ["introHeading", hub.introHeading],
          ["metaDescription", hub.metaDescription],
        ] as const) {
          // #4944 item 1: `citesWindowDate` (não `includes` solto) — a data
          // precisa ocupar o papel de "desde"/"entre"/"de" da alegação de
          // cobertura, não só aparecer em algum lugar do campo.
          assert.ok(
            accepted.some((f) => citesWindowDate(value, f)),
            `${slug}.${field} não cita a data da primeira fonte no papel de "desde"/"entre"/"de" (${accepted.join(" ou ")}): "${value.slice(0, 130)}…"`,
          );
        }
      });
    }

    describe("#4944 item 1 — REGRESSÃO: citesWindowDate reprova o furo do includes solto", () => {
      it("aceita as 3 construções reais que os 4 hubs usam, inclusive a forma longa com dia (google-gemini)", () => {
        const since = "agosto de 2025";
        assert.ok(citesWindowDate(`O que aconteceu com o tema desde ${since}?`, since));
        assert.ok(citesWindowDate(`Tema no arquivo, de ${since} a agosto de 2026: fatos.`, since));
        assert.ok(citesWindowDate(`Entre ${since} e agosto de 2026, o tema apareceu.`, since));
        assert.ok(citesWindowDate(`Entre 27 de ${since}, o tema apareceu.`, since)); // forma longa (betweenLong)
      });

      it("reprova um HubContent sintético que cita a janela errada mas menciona a data certa fora do papel de desde/entre/de", () => {
        // Mesmo defeito que a #4917 achou ao vivo em anthropic-claude/
        // openai-chatgpt (janela errada), mas com a data certa TAMBÉM
        // presente no campo — fora do papel de início. A versão antiga desta
        // checagem (`value.includes(f)`) marcava os 3 campos abaixo como
        // corretos; é exatamente o furo que a issue #4944 item 1 pede pra
        // fechar. Critério de pronto da issue: este teste precisa REPROVAR.
        const sourceEditions = [
          { date: "2025-08-27", title: "Manchete antiga", url: "https://diar.ia.br/p/antiga" },
          { date: "2026-03-10", title: "Manchete recente", url: "https://diar.ia.br/p/recente" },
        ];
        const hub = baseHub({
          sourceEditions,
          // Janela ALEGADA errada ("setembro de 2025") nos 3 campos — a
          // fonte mais antiga real é agosto de 2025.
          introHeading: "O que aconteceu com o tema desde setembro de 2025?",
          introParagraph:
            "Em agosto de 2025 o tema quase não apareceu; entre setembro de 2025 e março de 2026 a cobertura decolou.",
          metaDescription:
            "Tema no arquivo: em agosto de 2025 a cobertura ainda não existia; entre setembro de 2025 e março de 2026, fatos.",
        });
        const { since } = hubCoverageWindow(hub.sourceEditions);
        assert.equal(since, "agosto de 2025");
        for (const [field, value] of [
          ["introHeading", hub.introHeading],
          ["introParagraph", hub.introParagraph],
          ["metaDescription", hub.metaDescription],
        ] as const) {
          assert.equal(
            citesWindowDate(value, since),
            false,
            `${field} deveria REPROVAR: cita a janela errada e "${since}" só aparece fora do papel de desde/entre/de: "${value}"`,
          );
        }
      });
    });
  });

  describe("#4944 item 2 — hubCoverageWindow colapsa janela de 1 mês (sem 'X e X')", () => {
    it("between colapsa quando since === until (mesmo mês/ano, dias diferentes)", () => {
      const { between, isSingleMonth } = hubCoverageWindow([{ date: "2025-08-05" }, { date: "2025-08-20" }]);
      assert.equal(between, "agosto de 2025");
      assert.equal(isSingleMonth, true);
    });

    it("between colapsa com 1 fonte só na lista", () => {
      const { between, isSingleMonth } = hubCoverageWindow([{ date: "2025-08-05" }]);
      assert.equal(between, "agosto de 2025");
      assert.equal(isSingleMonth, true);
    });

    it("between NÃO colapsa quando since !== until (comportamento antigo preservado)", () => {
      const { between, isSingleMonth } = hubCoverageWindow([{ date: "2025-08-05" }, { date: "2026-01-09" }]);
      assert.equal(between, "agosto de 2025 e janeiro de 2026");
      assert.equal(isSingleMonth, false);
    });

    it("os 4 hubs reais não caem no caso de mês único (isSingleMonth false) — não é alcançável hoje, a issue confirma", () => {
      for (const [slug, load] of Object.entries(HUB_LOADERS)) {
        const hub = load();
        assert.equal(
          hubCoverageWindow(hub.sourceEditions).isSingleMonth,
          false,
          `${slug}: caiu no caso de mês único inesperadamente`,
        );
      }
    });
  });

  describe("#4944 item 3 — betweenLong tem teste unitário próprio (não só indireto via google-gemini)", () => {
    it("formatDateLong: dia SEM zero à esquerda", () => {
      assert.equal(formatDateLong("2025-08-05"), "5 de agosto de 2025");
      assert.equal(formatDateLong("2026-01-09"), "9 de janeiro de 2026");
      assert.equal(formatDateLong("2026-01-15"), "15 de janeiro de 2026"); // dia de 2 dígitos não quebra
    });

    it("hubCoverageWindow.betweenLong: forma longa com dia, sem zero à esquerda em nenhuma borda", () => {
      const { betweenLong } = hubCoverageWindow([{ date: "2025-08-05" }, { date: "2026-01-09" }]);
      assert.equal(betweenLong, "5 de agosto de 2025 e 9 de janeiro de 2026");
    });

    it("hubCoverageWindow.betweenLong colapsa pra uma data única quando firstDate === lastDate", () => {
      const { betweenLong } = hubCoverageWindow([{ date: "2025-08-05" }]);
      assert.equal(betweenLong, "5 de agosto de 2025");
    });
  });

  describe("#4944 item 4 — limite conhecido da denylist prosa-sem-publicacao-como-sujeito", () => {
    it("DOCUMENTA (não é bug): 'apurou'/'checou'/'levantou' escapam da denylist hoje", () => {
      // A regra é denylist por desenho (ver docstring de HUB_PROSE_RULES):
      // não pode virar allowlist de verbo, porque proibir a marca perto de
      // QUALQUER verbo pegaria as afirmações legítimas sobre o próprio
      // arquivo que o contrato protege de propósito (ver "CASO NEGATIVO"
      // acima). Os verbos abaixo não estão na lista do pattern
      // (cobr|notici|public|registr|acompanh|destac|inform|relat|flagr|
      // revel|document|report|mostr|mencion) — isso é ACEITO, não um furo a
      // fechar; este teste só existe pra deixar o limite conhecido em vez de
      // implícito (issue #4944 item 4).
      for (const verbo of ["apurou", "checou", "levantou"]) {
        const hub = baseHub({
          sections: [{ heading: "O que mudou?", paragraphs: [`A diar.ia.br ${verbo} o caso com fontes próprias.`] }],
        });
        assert.deepEqual(proseErrors(hub, "prosa-sem-publicacao-como-sujeito"), []);
      }
    });
  });
});

/**
 * #5007 — os 4 helpers irmãos derivados no #4922 (`hubTotals`,
 * `hubMentionCadenceDays`, `maxDateGap`, `matchingDates`) só eram exercitados
 * INDIRETAMENTE, via os 4 hubs reais (`test/build-hub-page.test.ts`/
 * `test/hub-page-drift.test.ts`) — nenhum tinha teste unitário direto contra
 * os casos de borda documentados no próprio docstring (lista vazia, lista de
 * 1 item, e — pra `maxDateGap` — hiato empatado com tie-break "primeira
 * ocorrência"). Nenhum dos 4 hubs reais aciona esses casos hoje (é
 * exatamente por isso que a lacuna não foi pega pelos testes indiretos); um
 * 5º hub futuro, ou uma regeneração que reduza drasticamente o dataset de um
 * hub existente, pode acionar um deles pela 1ª vez em produção sem rede de
 * segurança.
 */
describe("#5007 — testes unitários diretos: hubTotals / hubMentionCadenceDays / maxDateGap / matchingDates", () => {
  describe("hubTotals", () => {
    it("lista vazia -> { totalEditions: 0, totalMentions: 0 }", () => {
      assert.deepEqual(hubTotals([]), { totalEditions: 0, totalMentions: 0 });
    });

    it("lista de 1 item -> totalEditions 1, totalMentions = tamanho de matchedHeadlines desse item", () => {
      assert.deepEqual(hubTotals([{ matchedHeadlines: ["a", "b", "c"] }]), {
        totalEditions: 1,
        totalMentions: 3,
      });
    });

    it("lista de 1 item sem manchetes -> totalMentions 0", () => {
      assert.deepEqual(hubTotals([{ matchedHeadlines: [] }]), { totalEditions: 1, totalMentions: 0 });
    });
  });

  describe("hubMentionCadenceDays", () => {
    it("lista vazia -> lança (delega em hubCoverageWindow, que rejeita sources vazio)", () => {
      assert.throws(() => hubMentionCadenceDays([]), /sources vazio/);
    });

    it("lista de 1 item -> 0 dias (firstDate === lastDate, sem intervalo pra dividir)", () => {
      assert.equal(hubMentionCadenceDays([{ date: "2026-01-15", matchedHeadlines: ["a"] }]), 0);
    });
  });

  describe("matchingDates", () => {
    it("lista vazia -> []", () => {
      assert.deepEqual(matchingDates([], /x/), []);
    });

    it("lista de 1 item, manchete casa o padrão -> [date] daquele item", () => {
      assert.deepEqual(
        matchingDates([{ date: "2026-01-15", matchedHeadlines: ["lançou um modelo novo"] }], /lançou/),
        ["2026-01-15"],
      );
    });

    it("lista de 1 item, manchete NÃO casa o padrão -> []", () => {
      assert.deepEqual(
        matchingDates([{ date: "2026-01-15", matchedHeadlines: ["assunto qualquer"] }], /lançou/),
        [],
      );
    });
  });

  describe("maxDateGap", () => {
    it("lista vazia -> null (documentado no docstring, nunca antes verificado — #5007)", () => {
      assert.equal(maxDateGap([]), null);
    });

    it("lista de 1 item -> null (1 data não tem hiato, documentado, nunca antes verificado — #5007)", () => {
      assert.equal(maxDateGap(["2026-01-15"]), null);
    });

    it("2 datas -> 1 gap, from/to/gapDays corretos", () => {
      assert.deepEqual(maxDateGap(["2026-01-01", "2026-01-11"]), {
        fromDate: "2026-01-01",
        toDate: "2026-01-11",
        gapDays: 10,
      });
    });

    it("hiato empatado (3 datas, 2 gaps de 10 dias cada) -> tie-break é a PRIMEIRA ocorrência do máximo (documentado, nunca antes verificado — #5007)", () => {
      // gaps: 01-01->01-11 (10d), 01-11->01-21 (10d) -- empatados; `best` só
      // troca com `>`, nunca `>=`, então o 1º vence.
      assert.deepEqual(maxDateGap(["2026-01-01", "2026-01-11", "2026-01-21"]), {
        fromDate: "2026-01-01",
        toDate: "2026-01-11",
        gapDays: 10,
      });
    });

    it("hiato empatado no meio de uma lista maior (gaps 5/20/20/3) -> o 1º trecho de tamanho máximo vence", () => {
      // gaps: 01-01->01-06 (5d), 01-06->01-26 (20d), 01-26->02-15 (20d), 02-15->02-18 (3d)
      // -- os dois "20" empatam; o 1º (entre a 2ª e a 3ª data) vence, mesmo
      // aparecendo antes do 2º candidato empatado na varredura.
      assert.deepEqual(
        maxDateGap(["2026-01-01", "2026-01-06", "2026-01-26", "2026-02-15", "2026-02-18"]),
        { fromDate: "2026-01-06", toDate: "2026-01-26", gapDays: 20 },
      );
    });
  });
});
