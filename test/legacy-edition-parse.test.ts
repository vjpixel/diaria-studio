/**
 * test/legacy-edition-parse.test.ts (#7569)
 *
 * Os fixtures aqui são reduções de edições REAIS do primeiro ano da
 * diar.ia.br — as três eras de formato que a janela da edição anual
 * atravessa. Cada uma quebrou o parser de um jeito diferente durante a
 * implementação, e é isso que os testes travam:
 *
 *   - **set/2025**: sem cabeçalho, sem régua, link no formato
 *     `Saiba mais: [url](url)`. Zerava quando o anchor exigia o rótulo
 *     dentro dos colchetes.
 *   - **out/2025**: ganha cabeçalho em caixa alta e régua; traz anúncio de
 *     patrocinador entre destaques, que roubava o título do destaque
 *     seguinte.
 *   - **nov/2025**: sem "Por que isso importa" em edição nenhuma, e com o
 *     rótulo do link truncado na origem (`[Aprofu]`). Zerava o mês quando o
 *     "porquê" era obrigatório.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLegacyEditionHtml } from "../scripts/lib/shared/legacy-edition-parse.ts";

/** Monta HTML mínimo — o conversor só precisa de blocos de texto. */
function html(lines: string[]): string {
  return `<html><body>${lines.map((l) => `<p>${l}</p>`).join("")}</body></html>`;
}

const SET_2025 = html([
  "xAI processa ex-engenheiro por roubo de segredos",
  "Alibaba desenvolve chip próprio | Colapso da Builder.ai",
  "1 de setembro de 2025",
  "Bom dia!",
  "Hoje começam a ser vendidos os domínios .ia.br.",
  "Até amanhã!",
  "xAI processa ex-engenheiro por roubo de segredos comerciais do Grok",
  "Feito no Gemini",
  "A empresa de Elon Musk entrou com ação contra o ex-engenheiro Xuechen Li.",
  "Por que isso importa: O caso agrava as tensões entre Musk e a OpenAI.",
  "Saiba mais: [https://reuters.com/musk-xai](https://reuters.com/musk-xai)",
  "Alibaba desenvolve chip próprio de IA",
  "Foto: Cfoto/DDP",
  "O gigante chinês desenvolveu um chip otimizado para inferência.",
  "Por que isso importa: É a resposta da China às sanções dos EUA.",
  "Saiba mais: [https://wsj.com/alibaba-chip](https://wsj.com/alibaba-chip)",
  "Glossário:",
  "Inferência: processo de usar um modelo treinado para gerar respostas.",
  "Gigawatt: unidade de potência equivalente a um bilhão de watts.",
]);

const OUT_2025 = html([
  "OpenAI lança Sora 2",
  "Pesquisa mostra competência do Veo 3 | Brasil anuncia investimento",
  "1 de outubro de 2025",
  "Há 43 anos…",
  "…a Sony lançou no Japão o CDP-101, o primeiro CD player comercial.",
  "PRINCIPAIS NOTÍCIAS",
  "________________________",
  "Sora 2: novo modelo de geração de vídeos",
  "O Sora 2 é a nova geração do modelo da OpenAI que gera vídeos a partir de texto.",
  "[Aprofunde](https://openai.com/index/sora-2/)",
  "________________________",
  "Looking for unbiased, fact-based news? Join 1440 today.",
  "Join over 4 million Americans who start their day with 1440.",
  "[Subscribe to 1440 today.](https://l.join1440.com/bh)",
  "BRASIL",
  "________________________",
  "Governo anuncia investimento de R$ 390 milhões em IA",
  "O Ministério da Gestão e o CPQD assinaram acordo para soluções de IA na gestão pública.",
  "Por que isso importa: Pode democratizar o acesso a benefícios sociais.",
  "[Aprofunde](https://anba.com.br/brazil-invests-in-ai)",
  "PARA ENCERRAR",
  "________________________",
  "[IA é poderosa, mas precisa de parâmetros, diz reitor da USP](https://cnnbrasil.com.br/usp)",
  "[95% das empresas não veem retorno em IA, revela MIT](https://edition.cnn.com/mit)",
]);

const NOV_2025 = html([
  "Projeto quer lançar data centers no espaço",
  "Trabalhos de IA em alta segundo o LinkedIn",
  "5 de novembro de 2025",
  "Em 05 de novembro de 1895, George B. Selden recebeu a patente do Road Engine.",
  "MUNDO",
  "________________________",
  "Google lança Project Suncatcher: satélites com IA e energia solar",
  "Google apresentou um projeto que explora data centers de IA em órbita.",
  "Cada satélite teria arrays solares e chips TPU otimizados.",
  "[Aprofu](https://research.google/blog/space-based-ai)",
  "MUNDO",
  "________________________",
  "LinkedIn Jobs on the Rise 2025: IA lidera crescimento de profissões",
  "O relatório revelou que profissões de IA dominam as 25 posições em ascensão.",
  "[Aprofunde](https://odsc.medium.com/linkedin-jobs)",
]);

describe("set/2025 — sem moldura, link com rótulo fora dos colchetes", () => {
  const { destaques } = parseLegacyEditionHtml(SET_2025, "250901");

  it("extrai os destaques mesmo sem cabeçalho nem régua", () => {
    assert.equal(destaques.length, 2);
    assert.equal(destaques[0].title, "xAI processa ex-engenheiro por roubo de segredos comerciais do Grok");
    assert.equal(destaques[1].title, "Alibaba desenvolve chip próprio de IA");
  });

  it("a URL vem do link de aprofundamento, não do título", () => {
    assert.equal(destaques[0].url, "https://reuters.com/musk-xai");
  });

  it("a saudação e o texto de abertura do editor não viram destaque", () => {
    assert.ok(!destaques.some((d) => /bom dia|domínios \.ia\.br/i.test(d.title)));
  });

  it("legenda de imagem não entra no corpo nem vira título", () => {
    assert.ok(!destaques[0].body.includes("Feito no Gemini"));
    assert.ok(!destaques[1].title.startsWith("Foto:"));
  });

  it("verbete de glossário não é promovido a destaque", () => {
    assert.ok(
      !destaques.some((d) => d.title.startsWith("Inferência") || d.title.startsWith("Gigawatt")),
      "glossário tem a mesma forma de um destaque e precisa da supressão de seção",
    );
  });

  it("separa corpo e porquê", () => {
    assert.equal(destaques[0].why, "O caso agrava as tensões entre Musk e a OpenAI.");
    assert.ok(destaques[0].body.includes("Xuechen Li"));
    assert.ok(!destaques[0].body.includes("Por que isso importa"));
  });
});

describe("out/2025 — com moldura e anúncio de patrocinador", () => {
  const { destaques } = parseLegacyEditionHtml(OUT_2025, "251001");

  it("o anúncio não rouba o título do destaque seguinte", () => {
    assert.ok(
      !destaques.some((d) => /1440|unbiased/i.test(d.title)),
      "o bloco patrocinado fica entre dois destaques e tem a mesma forma",
    );
    assert.ok(destaques.some((d) => d.title.startsWith("Governo anuncia investimento")));
  });

  it("a categoria vem do cabeçalho em caixa alta acima do bloco", () => {
    const brasil = destaques.find((d) => d.title.startsWith("Governo anuncia"));
    assert.equal(brasil?.category, "BRASIL");
  });

  it("a lista do PARA ENCERRAR não vira destaque", () => {
    assert.ok(!destaques.some((d) => /reitor da USP|revela MIT/.test(d.title)));
  });

  it("a efeméride da abertura não vira destaque", () => {
    assert.ok(!destaques.some((d) => /CD player|Sony/.test(d.title)));
    assert.equal(destaques[0].title, "Sora 2: novo modelo de geração de vídeos");
  });
});

describe("nov/2025 — sem 'Por que isso importa' e com rótulo truncado", () => {
  const { destaques } = parseLegacyEditionHtml(NOV_2025, "251105");

  it("destaque sem porquê continua sendo destaque", () => {
    assert.equal(destaques.length, 2);
    assert.equal(destaques[0].why, "");
    assert.ok(destaques[0].body.includes("órbita"));
  });

  it("rótulo truncado na origem ([Aprofu]) ainda é anchor", () => {
    assert.equal(destaques[0].url, "https://research.google/blog/space-based-ai");
  });
});

describe("bordas", () => {
  it("edição sem nenhum link de aprofundamento devolve vazio com aviso", () => {
    const r = parseLegacyEditionHtml(html(["Só um título", "e um parágrafo."]), "x");
    assert.deepEqual(r.destaques, []);
    assert.ok(r.warnings.some((w) => w.includes("nenhum link")));
  });

  it("posições são 1..3 na ordem de leitura", () => {
    const { destaques } = parseLegacyEditionHtml(OUT_2025, "251001");
    assert.deepEqual(destaques.map((d) => d.position), Array.from({ length: destaques.length }, (_, i) => i + 1));
  });

  it("nunca devolve mais de 3 destaques", () => {
    const many = html(
      Array.from({ length: 6 }, (_, i) => [
        "SEÇÃO",
        "________________________",
        `Título número ${i} com tamanho suficiente`,
        "Corpo do destaque com texto real.",
        `[Aprofunde](https://exemplo.com/${i})`,
      ]).flat(),
    );
    assert.equal(parseLegacyEditionHtml(many, "x").destaques.length, 3);
  });
});
