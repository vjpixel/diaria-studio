/**
 * decision-label-drift.test.ts (#5589)
 *
 * Trava a lógica pura de `scripts/lib/decision-label-drift.ts`: casamento
 * de padrão de deferimento/decisão em prosa contra a label estrutural
 * esperada. Os dois primeiros blocos reproduzem os casos reais que
 * motivaram a issue (#5586: #5239 e #5125).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectLabelDrift,
  stripHtmlComments,
  DRIFT_PATTERNS,
} from "../scripts/lib/decision-label-drift.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";

describe("detectLabelDrift — casos reais do #5586", () => {
  it("#5239: comentário 'não despachar agora, pré-requisito ainda não atendido' sem not-this-week/next-month → achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 5239,
      labels: ["P2", "enhancement"],
      commentBodies: [
        "Rodada 260817d: não despachar agora, pré-requisito ainda não atendido (aguardando #5230 fechar).",
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "deferred-vague");
    assert.deepEqual(findings[0].expectedLabels, ["not-this-week", "next-month"]);
    assert.equal(findings[0].issueNumber, 5239);
  });

  it("#5125: trade-off-real declarado em prosa sem a label trade-off-real → achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 5125,
      labels: ["P3", "bug"],
      commentBodies: [
        "Não iniciar sem resposta do editor ao item 1 — isto é trade-off-real de produto.",
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "trade-off-real");
    assert.deepEqual(findings[0].expectedLabels, ["trade-off-real"]);
  });
});

describe("detectLabelDrift — label já aplicada não gera achado", () => {
  it("not-this-week presente resolve o padrão deferred-vague", () => {
    const findings = detectLabelDrift({
      issueNumber: 1,
      labels: ["not-this-week"],
      commentBodies: ["Aguardando o próximo ciclo pra retomar isso."],
    });
    assert.deepEqual(findings, []);
  });

  it("trade-off-real presente resolve o padrão trade-off-real", () => {
    const findings = detectLabelDrift({
      issueNumber: 2,
      labels: ["trade-off-real"],
      commentBodies: ["Julgamento: trade-off-real, escalado pro develop."],
    });
    assert.deepEqual(findings, []);
  });

  it("decisao-registrada satisfaz qualquer padrão, mesmo sem a label específica (regressão do falso-positivo do #5589 sobre si mesmo)", () => {
    const findings = detectLabelDrift({
      issueNumber: 5589,
      labels: ["P3", "decisao-registrada"],
      commentBodies: [
        'detecta padrão de deferimento no texto ("aguardando", "não despachar", "pré-requisito não atendido", etc.) — trade-off-real citado como exemplo',
      ],
    });
    assert.deepEqual(findings, []);
  });

  it("qualquer label do any-of já resolve (external-blocker)", () => {
    const findings = detectLabelDrift({
      issueNumber: 3,
      labels: ["beehiiv"],
      commentBodies: ["Bloqueio externo: falta acesso a um painel de terceiro."],
    });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — sem padrão, sem achado", () => {
  it("comentário comum sem nenhuma frase-gatilho não gera achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 4,
      labels: [],
      commentBodies: ["PR #123 aberto, self-review: 0 findings."],
    });
    assert.deepEqual(findings, []);
  });

  it("nenhum comentário → nenhum achado", () => {
    const findings = detectLabelDrift({ issueNumber: 5, labels: [], commentBodies: [] });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — marcador estruturado não conta como prosa", () => {
  it("padrão só dentro de um bloco <!-- --> (marcador) não é reportado como achado de PROSA", () => {
    // Simula um marcador cujo texto legível ("pergunta"/"resposta") NÃO
    // contém frase-gatilho, mas cujo blob base64 poderia colidir por acaso
    // — stripHtmlComments remove o bloco inteiro, então o teste garante que
    // o match só acontece fora dele.
    const findings = detectLabelDrift({
      issueNumber: 6,
      labels: [],
      commentBodies: [
        "<!-- decisao-editor: eyJhIjoiYWd1YXJkYW5kbyBhbGdvIGlycmVsZXZhbnRlIn0= -->\n\nComentário normal, sem gatilho.",
      ],
    });
    assert.deepEqual(findings, []);
  });

  it("stripHtmlComments remove blocos de comentário HTML preservando a prosa ao redor", () => {
    const out = stripHtmlComments("antes <!-- oculto --> depois");
    assert.ok(out.includes("antes"));
    assert.ok(out.includes("depois"));
    assert.ok(!out.includes("oculto"));
  });
});

describe("detectLabelDrift — dedup por (issue, padrão)", () => {
  it("dois comentários casando o mesmo padrão sem label geram só 1 achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 7,
      labels: [],
      commentBodies: [
        "Aguardando resposta do editor.",
        "Ainda aguardando, sem novidade.",
      ],
    });
    assert.equal(findings.length, 1);
  });

  it("label atual satisfaz o padrão independente de qual(is) comentário(s) casaram — não há mecanismo temporal, é sempre o snapshot atual", () => {
    const findings = detectLabelDrift({
      issueNumber: 8,
      labels: ["not-this-week"],
      commentBodies: [
        "Aguardando pré-requisito não atendido ainda.",
        "Aplicada not-this-week — issue agora reflete o estado real.",
      ],
    });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — comentários não-string são ignorados sem lançar", () => {
  it("tolera entrada malformada no array de comentários", () => {
    const findings = detectLabelDrift({
      issueNumber: 9,
      labels: [],
      // @ts-expect-error — testando tolerância a input malformado em runtime
      commentBodies: [null, undefined, 42, "aguardando revisão"],
    });
    assert.equal(findings.length, 1);
  });
});

describe("DRIFT_PATTERNS — catálogo", () => {
  it("todo padrão tem ao menos 1 regex e ao menos 1 label esperada", () => {
    for (const pattern of DRIFT_PATTERNS) {
      assert.ok(pattern.textPatterns.length > 0, `${pattern.id} sem regex`);
      assert.ok(pattern.expectedLabels.length > 0, `${pattern.id} sem label esperada`);
    }
  });

  it("ids são únicos", () => {
    const ids = DRIFT_PATTERNS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

/**
 * #5955 — o caso que motivou o grupo `execution-guard`.
 *
 * Rodada overnight 260823: a #5140 foi pega, tentada e devolvida DUAS vezes,
 * com o motivo escrito em prosa nos dois comentários ("vedada pelo guard de
 * publicação", "fora do escopo do overnight"). Nenhuma label foi aplicada, e
 * `classifyExecTrack` seguiu devolvendo `overnight` — então a rodada seguinte
 * pegaria de novo. O único achado que o catálogo produzia era acidental:
 * `/aguardando/i` casando a CITAÇÃO do nome do marcador `aguardando-ate`, e
 * apontando pra `not-this-week` (que roteia pra Bloqueada, destino errado).
 */
describe("detectLabelDrift — guard de execução (#5955)", () => {
  const COMENTARIO_1 =
    "Rodada overnight 260823: retomando. Código-base já implementado via PRs anteriores — o marcador `aguardando-ate: 2026-08-23` venceu hoje, mas ATIVAR o teste é execução ao vivo de campanha Clarice/Brevo, vedada pelo guard de publicação do overnight.";
  const COMENTARIO_2 =
    "Resta só a Parte 1, que segue fora do escopo do overnight — exige rodar envio real de campanha Clarice, vedado pelo guard de publicação. Precisa do editor ou de sessão com execução autorizada.";

  it("os comentários reais da rodada 260823 na #5140 produzem achado de execution-guard", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: [COMENTARIO_1, COMENTARIO_2],
    });
    const guard = findings.find((f) => f.patternId === "execution-guard");
    assert.ok(guard, "esperava achado execution-guard nos comentários da rodada");
    assert.deepEqual(guard.expectedLabels, ["develop-track", "bloqueio-execucao"]);
    assert.equal(guard.source, "comment");
  });

  it("o 2º comentário SOZINHO (sem a palavra 'aguardando') ainda é detectado", () => {
    // Antes do #5955 este caso não produzia achado nenhum: o catálogo não
    // tinha vocabulário de guard de execução, e o único match do outro
    // comentário vinha da citação do marcador.
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: [COMENTARIO_2],
    });
    assert.deepEqual(
      findings.map((f) => f.patternId),
      ["execution-guard"],
    );
  });

  it("develop-track presente resolve o achado (any-of)", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2", "develop-track"],
      commentBodies: [COMENTARIO_2],
    });
    assert.equal(findings.length, 0);
  });

  it("bloqueio-execucao presente também resolve — é a outra forma durável válida", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2", "bloqueio-execucao"],
      commentBodies: [COMENTARIO_2],
    });
    assert.equal(findings.length, 0);
  });
});

describe("detectLabelDrift — citação do marcador aguardando-ate não é deferimento (#5955)", () => {
  it("citar `aguardando-ate:` sozinho NÃO produz deferred-vague", () => {
    // Falso positivo real: o comentário só explica que o marcador venceu.
    // Gerava achado apontando pra not-this-week/next-month, que roteiam pra
    // Bloqueada — mascarando o drift verdadeiro com um destino errado.
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: ["O marcador `aguardando-ate: 2026-08-23` venceu hoje; as células estão livres."],
    });
    assert.equal(findings.length, 0);
  });

  it("prosa legítima de espera continua casando deferred-vague", () => {
    const findings = detectLabelDrift({
      issueNumber: 42,
      labels: ["P2"],
      commentBodies: ["Pulada nesta rodada: aguardando o pré-requisito #5230 fechar."],
    });
    assert.deepEqual(
      findings.map((f) => f.patternId),
      ["deferred-vague"],
    );
  });
});

/**
 * #5955 — a fonte mais confiável é o `plan.json`, não a prosa do comentário.
 *
 * `motivo` é preenchido por regra da skill em TODA issue `pulada`, enquanto
 * comentar é opcional e o texto é livre. Na rodada 260823 o plano da #5140
 * registrava o veredito com precisão — e ele não saía dali.
 */
describe("detectLabelDrift — prosa vinda do plan.json (#5955)", () => {
  const MOTIVO =
    "ja-implementada: Parte 2 já estava mergeada (PR #5142); Parte 1 segue bloqueada (execução ao vivo)";
  const SCOPE_NOTE =
    "Parte 2 apenas. Parte 1 (ativação do teste de horário) permanece bloqueada — exige rodar envio Clarice ao vivo, vedado pelo guard de publicação.";

  it("motivo/scope_note do plano geram achado mesmo sem comentário nenhum", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: [],
      planTexts: [MOTIVO, SCOPE_NOTE],
    });
    const guard = findings.find((f) => f.patternId === "execution-guard");
    assert.ok(guard, "esperava achado a partir do plan.json");
    assert.equal(guard.source, "plan");
    assert.deepEqual(guard.expectedLabels, ["develop-track", "bloqueio-execucao"]);
  });

  it("quando comentário e plano casam o mesmo padrão, o plano vence a atribuição de fonte", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: ["Segue fora do escopo do overnight."],
      planTexts: [SCOPE_NOTE],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].source, "plan");
  });

  it("planTexts ausente preserva o comportamento anterior (campo opcional)", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2"],
      commentBodies: ["Segue fora do escopo do overnight."],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].source, "comment");
  });

  it("label já aplicada resolve o achado do plano também", () => {
    const findings = detectLabelDrift({
      issueNumber: 5140,
      labels: ["enhancement", "P2", "develop-track"],
      commentBodies: [],
      planTexts: [MOTIVO, SCOPE_NOTE],
    });
    assert.equal(findings.length, 0);
  });
});

describe("DRIFT_PATTERNS — execution-guard não dispara em prosa factual (#5955)", () => {
  // O gate BLOQUEIA a compilação do relatório, então falso positivo aqui
  // trava uma rodada. Estes casos citam vocabulário do grupo sem estar
  // reportando bloqueio nenhum.
  const FACTUAIS = [
    "O envio real saiu às 06:00 BRT com 3.948 contatos, sem incidente.",
    "Confirmado que o envio ao vivo respeitou o split de células do teste.",
    "A issue precisa de um teste de regressão antes do merge.",
  ];
  for (const prosa of FACTUAIS) {
    it(`não gera execution-guard: "${prosa.slice(0, 45)}…"`, () => {
      const findings = detectLabelDrift({
        issueNumber: 1,
        labels: ["P2"],
        commentBodies: [prosa],
      });
      assert.equal(
        findings.filter((f) => f.patternId === "execution-guard").length,
        0,
      );
    });
  }

  it("mas dispara quando o verbo de impedimento está presente", () => {
    const findings = detectLabelDrift({
      issueNumber: 1,
      labels: ["P2"],
      commentBodies: ["Pulada: exige rodar envio real de campanha Clarice."],
    });
    assert.deepEqual(
      findings.map((f) => f.patternId),
      ["execution-guard"],
    );
  });
});

describe("detectLabelDrift — filtro de precisão por track (#5955)", () => {
  const PROSA = "Pulada: vedado pelo guard de publicação, exige envio real.";

  it("currentTrack overnight: reporta normalmente", () => {
    const findings = detectLabelDrift({
      issueNumber: 1,
      labels: ["P2"],
      commentBodies: [PROSA],
      currentTrack: "overnight",
    });
    assert.equal(findings.length, 1);
  });

  for (const track of ["bloqueada", "agendada", "develop", "fora-de-rodada"] as const) {
    it(`currentTrack ${track}: não reporta — label faltante não muda roteamento`, () => {
      const findings = detectLabelDrift({
        issueNumber: 1,
        labels: ["P2"],
        commentBodies: [PROSA],
        currentTrack: track,
      });
      assert.equal(findings.length, 0);
    });
  }

  it("currentTrack omitido preserva o comportamento permissivo do CLI de auditoria", () => {
    const findings = detectLabelDrift({
      issueNumber: 1,
      labels: ["P2"],
      commentBodies: [PROSA],
    });
    assert.equal(findings.length, 1);
  });

  it("casos reais 260823: #4549 (on-hold) e #5917 (aguardando-ate) não travam o gate", () => {
    // Os dois falsos positivos medidos ao vivo no plano da rodada 260823.
    const quatroMilQuinhentosEQuarentaENove = detectLabelDrift({
      issueNumber: 4549,
      labels: ["enhancement", "P3", "external-blocker", "on-hold", "growth"],
      commentBodies: [],
      planTexts: ["bloqueio-externo: aguardando amostras físicas (terceiro)"],
      currentTrack: classifyExecTrack({
        labels: ["enhancement", "P3", "external-blocker", "on-hold", "growth"],
        state: "OPEN",
      }),
    });
    assert.equal(quatroMilQuinhentosEQuarentaENove.length, 0);

    const corpo5917 = "Reunião marcada.\n<!-- aguardando-ate: 2099-01-01 -->\n";
    const cincoMilNovecentosEDezessete = detectLabelDrift({
      issueNumber: 5917,
      labels: ["enhancement", "P2", "growth"],
      commentBodies: [],
      planTexts: ["bloqueio-externo: aguardando reunião 24/08/2026 com Nexo Jornal"],
      currentTrack: classifyExecTrack({
        labels: ["enhancement", "P2", "growth"],
        body: corpo5917,
        state: "OPEN",
      }),
    });
    assert.equal(cincoMilNovecentosEDezessete.length, 0);
  });
});

describe("execution-guard — dois fatores obrigatórios (#5958, achados de review)", () => {
  const hit = (t: string) =>
    detectLabelDrift({ issueNumber: 1, labels: ["P2"], commentBodies: [t] }).some(
      (f) => f.patternId === "execution-guard",
    );

  // Menção de capacidade SEM impedimento — inclui meta-discussão sobre os
  // próprios guards, que é assunto recorrente de issue neste repo.
  const NAO_CASA = [
    "a execução ao vivo do teste A/B ocorreu sem incidentes às 06:00",
    "o guard de publicação está funcionando normalmente, nenhuma issue barrada nesta rodada",
    "revisamos o guard de execução do stage 5 e ele segue correto",
    "o guard de execução deste PR (#5955) ficou mais preciso depois da revisão",
    // Deferimento comum de tempo — é deferred-vague, não guard de execução.
    "essa mudança ficou fora do escopo da rodada anterior por falta de tempo",
    // Negação: a frase afirma que NADA está barrado.
    "isso não impede o envio real de continuar amanhã",
    "nada exige envio real aqui, pode seguir normalmente",
    "não é vedado o envio real neste caso",
    "isso não está fora do escopo do overnight, pode seguir",
    // Colisão com "editor" no sentido de ferramenta — artigo INDEFINIDO.
    "a imagem precisa de um editor gráfico melhor para ajuste fino",
    "esse markdown precisa de um editor de texto que suporte utf-8",
    // Meta-discussão sobre OUTROS guards + verbo fraco: é o falso positivo
    // que sobreviveu ao 1º dois-fatores e motivou a capacidade em 2 níveis
    // (achado de re-review). "guard"/"sessão supervisionada" são vocabulário
    // corrente do repo pra CI, review de PR e gates de stage.
    "o guard de execução deste PR precisa de mais testes antes de mergear",
    "o guard de publicação do stage 5 exige revisão antes de qualquer mudança de threshold",
    "essa issue precisa de sessão supervisionada de review antes do merge",
    // "editor" no sentido de SOFTWARE, agora com artigo definido — o
    // lookahead de `de` é o que separa a ferramenta da pessoa (re-review 3).
    "o texto precisa do editor de vídeo para cortar isso",
    "essa imagem precisa do editor de imagem para cortar",
    "o roteiro precisa do editor de som",
    "essa tarefa precisa de editor gráfico atualizado",
    // Negação por `sem`: a frase afirma que NADA está barrado. Tirar `sem`
    // inteiro da lista de negação reabria este caso (re-review 3).
    "sem barrar o envio real, a rodada segue amanhã",
    // Planejamento comum, não bounce: `depende de` e `disparo real` tinham
    // entrado no catálogo sem nenhum caso real pedindo, e alargavam a
    // superfície exatamente assim (re-review 3).
    "a campanha ao vivo depende de aprovação do budget do trimestre",
    "o disparo real de notificações precisa de rate limit maior",
    // Negação alcançando a frase auto-suficiente.
    "nenhuma sessão precisa do editor amanhã",
    "não, não precisa do editor para isso",
  ];
  for (const prosa of NAO_CASA) {
    it(`não casa: "${prosa.slice(0, 50)}…"`, () => assert.equal(hit(prosa), false));
  }

  const CASA = [
    "ATIVAR o teste é execução ao vivo de campanha Clarice/Brevo, vedada pelo guard de publicação do overnight.",
    "Pulada: exige rodar envio real de campanha Clarice.",
    "isto exige, antes de qualquer coisa, um envio real",
    "Precisa do editor ou de sessão com execução autorizada.",
    // Auto-suficientes: nomeiam a sessão (ou a pessoa) que não consegue.
    "Segue fora do escopo do overnight.",
    "Isso está fora do escopo autônomo desta sessão.",
    // A forma mais curta e mais provável de um bounce — o critério de dois
    // fatores a perdia (achado de re-review). Artigo DEFINIDO separa a pessoa
    // da ferramenta.
    "Precisa do editor.",
    "Precisa do editor decidir isso.",
    // "sem dúvida" é ênfase, não negação do que vem depois: incluir `sem` na
    // lista de negação suprimia este bounce legítimo (achado de re-review).
    "sem dúvida, não consigo fazer envio ao vivo hoje",
  ];
  for (const prosa of CASA) {
    it(`casa: "${prosa.slice(0, 50)}…"`, () => assert.equal(hit(prosa), true));
  }
});

describe("on-hold — guard de negação (#6116)", () => {
  it("#464/#463 real: 'Não fechar como wontfix.' não gera achado (negação, não recomendação)", () => {
    const findings = detectLabelDrift({
      issueNumber: 464,
      labels: ["P3", "bug"],
      commentBodies: ["Comentário de 2026-05-08: Não fechar como wontfix."],
    });
    assert.deepEqual(findings, []);
  });

  it("'Não colocar em on-hold' também não gera achado (2 tokens entre negação e alvo)", () => {
    const findings = detectLabelDrift({
      issueNumber: 463,
      labels: ["P3", "bug"],
      commentBodies: ["Não colocar em on-hold — segue elegível pro overnight."],
    });
    assert.deepEqual(findings, []);
  });

  it("caso positivo real: 'Marcar como wontfix.' sem negação e sem label continua gerando achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 9001,
      labels: ["P3", "bug"],
      commentBodies: ["Decisão do editor: marcar como wontfix, não vale o esforço."],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "on-hold");
    assert.deepEqual(findings[0].expectedLabels, ["on-hold", "wontfix"]);
  });

  it("caso positivo real: 'Vai ficar em on-hold por enquanto.' sem label continua gerando achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 9002,
      labels: ["P2", "enhancement"],
      commentBodies: ["Vai ficar em on-hold por enquanto, sem prazo definido."],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "on-hold");
  });
});

describe("execution-guard — quantificadores continuam limitados (#5958)", () => {
  it("prosa longa não degrada: janela e lookbehind são limitados", () => {
    // A segurança contra backtracking patológico vem dos limites `{0,60}` e
    // `{0,2}`. Um teste de tempo trava a propriedade que importa: se alguém
    // trocar por `*`/`+` num refactor futuro, isto estoura muito antes de
    // alguém notar em produção (o gate roda sobre texto arbitrário de
    // comentário do GitHub).
    const prosaLonga = `${"exige ".repeat(20_000)}envio`;
    const inicio = process.hrtime.bigint();
    detectLabelDrift({ issueNumber: 1, labels: ["P2"], commentBodies: [prosaLonga] });
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    assert.ok(ms < 2_000, `varredura levou ${ms.toFixed(0)}ms — quantificador virou ilimitado?`);
  });
});
