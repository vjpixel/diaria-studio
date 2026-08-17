/**
 * issue-exec-track.test.ts (#5462)
 *
 * Trava a tabela de precedência de `classifyExecTrack` — que é a parte fácil
 * de quebrar por acidente, porque cada regra nova tem uma ordem "óbvia" que
 * quase sempre é outra.
 *
 * O teste mais importante do arquivo não é nenhum caso de bloqueio: é
 * "ambiguidade textual → overnight". Ele existe pra impedir que alguém
 * reintroduza o `AMBIGUITY_RE` que este módulo substituiu, mandando pro
 * develop uma issue que o briefing do overnight destrava em 30 segundos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecTrack,
  parseWaitUntil,
  EXEC_TRACK_LABELS,
  EXEC_TRACK_UI,
  type ExecTrack,
} from "../scripts/lib/issue-exec-track.ts";

/** Data fixa — nenhum teste deste arquivo pode depender do relógio real. */
const NOW = new Date("2026-08-16T12:00:00Z");

function track(labels: string[], body = ""): ExecTrack {
  return classifyExecTrack({ labels, body, now: NOW });
}

describe("classifyExecTrack — default", () => {
  it("issue sem label nenhuma é overnight", () => {
    assert.equal(track([]), "overnight");
  });

  it("issue só com prioridade/tipo é overnight", () => {
    assert.equal(track(["bug", "P1", "stage-0"]), "overnight");
  });
});

describe("classifyExecTrack — ambiguidade NÃO classifica (regressão #5462)", () => {
  // O AMBIGUITY_RE antigo (studio-issues.ts) casava com os 4 corpos abaixo e
  // mandava todos pra "ambigua". Dois deles são trade-off real (develop), dois
  // são escolha técnica trivial (briefing do overnight) — e nada no texto
  // distingue. Por isso o classificador não olha o corpo em busca disso.
  const CORPOS = [
    "precisamos decidir entre design system e documentar",
    "trade-off: CSS-only vs JS",
    "escolher entre formato A ou B de log",
    "qual abordagem usar pro cache",
  ];

  for (const body of CORPOS) {
    it(`"${body.slice(0, 32)}..." → overnight (briefing triará)`, () => {
      assert.equal(track([], body), "overnight");
    });
  }

  it("vira develop só quando o overnight JÁ julgou e gravou a label", () => {
    assert.equal(track(["trade-off-real"], CORPOS[0]), "develop");
  });

  it("volta pro overnight quando o develop remove a label após decidir", () => {
    // develop/SKILL.md:70 — "posta a decisão como comentário durável na
    // issue, remove a ambiguidade (→ elegível)". Sem esta volta a issue
    // ficaria presa em develop para sempre depois de já decidida.
    assert.equal(track([], CORPOS[0]), "overnight");
  });
});

describe("classifyExecTrack — máquina", () => {
  it("label windows → develop", () => {
    assert.equal(track(["windows"]), "develop");
  });

  it("label server → overnight (é a máquina onde o overnight já roda)", () => {
    assert.equal(track(["server"]), "overnight");
  });

  it("label local aposentada é ignorada, não classifica", () => {
    // Aposentada em 16/08/2026: ambígua entre windows e server, segue
    // existindo no GitHub só pelas issues fechadas que a carregam.
    assert.equal(track(["local"]), "overnight");
  });
});

describe("classifyExecTrack — bloqueio", () => {
  for (const label of ["external-blocker", "kit-migration", "beehiiv", "bloqueio-execucao"]) {
    it(`label ${label} → bloqueada`, () => {
      assert.equal(track([label]), "bloqueada");
    });
  }

  for (const label of ["not-this-week", "next-month"]) {
    it(`label ${label} (deferimento vago) → bloqueada`, () => {
      assert.equal(track([label]), "bloqueada");
    });
  }
});

describe("classifyExecTrack — marcador aguardando-ate", () => {
  it("data futura → bloqueada", () => {
    assert.equal(track([], "<!-- aguardando-ate: 2026-09-01 -->"), "bloqueada");
  });

  it("data passada → desarma sozinho, volta pro fluxo normal", () => {
    assert.equal(track([], "<!-- aguardando-ate: 2026-08-01 -->"), "overnight");
  });

  it("data passada não ressuscita issue com bloqueio real", () => {
    assert.equal(track(["external-blocker"], "<!-- aguardando-ate: 2026-08-01 -->"), "bloqueada");
  });

  it("data passada preserva a restrição de máquina", () => {
    assert.equal(track(["windows"], "<!-- aguardando-ate: 2026-08-01 -->"), "develop");
  });

  it("marcador malformado é ignorado, não prende a issue", () => {
    assert.equal(track([], "<!-- aguardando-ate: amanhã -->"), "overnight");
    assert.equal(track([], "<!-- aguardando-ate: 2026-13-45 -->"), "overnight");
  });

  // Dia que passa na regex (01-31) mas não existe no mês. `new Date` não
  // rejeita: rola pro mês seguinte em silêncio (2026-02-30 → 2026-03-02).
  // Sem a checagem de round-trip o sistema usaria uma data diferente da que
  // o editor escreveu, sem erro em lugar nenhum.
  for (const invalida of ["2026-02-30", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31"]) {
    it(`${invalida} não existe no calendário → ignorado, sem rollover mudo`, () => {
      assert.equal(parseWaitUntil(`<!-- aguardando-ate: ${invalida} -->`), null);
      assert.equal(track([], `<!-- aguardando-ate: ${invalida} -->`), "overnight");
    });
  }

  it("29 de fevereiro é aceito em ano bissexto e recusado fora dele", () => {
    assert.ok(parseWaitUntil("<!-- aguardando-ate: 2028-02-29 -->"));
    assert.equal(parseWaitUntil("<!-- aguardando-ate: 2027-02-29 -->"), null);
  });

  it("marcador em linha própria entre parágrafos é encontrado", () => {
    const body = "Contexto longo.\n\n<!-- aguardando-ate: 2026-09-01 -->\n\nMais prosa.";
    assert.equal(track([], body), "bloqueada");
  });

  it("marcador indentado em linha própria ainda conta", () => {
    assert.equal(track([], "texto\n   <!-- aguardando-ate: 2026-09-01 -->   \nmais"), "bloqueada");
  });

  // Regressão do falso positivo achado rodando o classificador contra o
  // backlog real (#5462): a issue que INTRODUZIU o marcador caiu em
  // `bloqueada`, porque o corpo dela documenta o mecanismo citando o marcador
  // em prosa. Sem a âncora de linha, toda issue que menciona o mecanismo se
  // auto-bloqueia — e some do filtro Overnight sem sinal nenhum.
  describe("citação em prosa NÃO bloqueia (regressão #5462)", () => {
    it("marcador citado inline no meio de uma frase", () => {
      const body = "Usar `<!-- aguardando-ate: 2026-09-01 -->` no corpo, no espírito de issue-decisions.ts.";
      assert.equal(track([], body), "overnight");
    });

    it("marcador citado dentro de bloco de código com prefixo de diff", () => {
      const body = "```\n- const RE = /x/;\n+ <!-- aguardando-ate: 2026-09-01 --> exemplo\n```";
      assert.equal(track([], body), "overnight");
    });

    it("marcador seguido de texto na mesma linha não conta", () => {
      assert.equal(track([], "<!-- aguardando-ate: 2026-09-01 --> ver também o item 3"), "overnight");
    });

    it("marcador precedido de texto na mesma linha não conta", () => {
      assert.equal(track([], "exemplo: <!-- aguardando-ate: 2026-09-01 -->"), "overnight");
    });

    it("corpo que documenta E usa o marcador: a linha própria vence", () => {
      const body = [
        "Escreva `<!-- aguardando-ate: AAAA-MM-DD -->` pra adiar.",
        "",
        "<!-- aguardando-ate: 2026-09-01 -->",
      ].join("\n");
      assert.equal(track([], body), "bloqueada");
    });
  });
});

describe("classifyExecTrack — resolvida por prosa/alarme (#5532)", () => {
  it("label decisao-registrada sozinha → fora-de-rodada", () => {
    assert.equal(track(["decisao-registrada"]), "fora-de-rodada");
  });

  it("label alarm sozinha → fora-de-rodada", () => {
    assert.equal(track(["alarm"]), "fora-de-rodada");
  });

  it("decisao-registrada + trade-off-real (caso real #4555) → develop, não fora-de-rodada", () => {
    // #4555 carrega as duas labels: a decisão registrada fechou só o PERFIL
    // do parceiro, mas a prospecção em si é trabalho real de develop
    // (trade-off editorial de qual parceiro escolher). Reclassificar como
    // fora-de-rodada só por ganhar a checagem de decisao-registrada estaria
    // errado — ainda sobra trabalho de verdade, só que não é código.
    assert.equal(track(["decisao-registrada", "trade-off-real"]), "develop");
  });

  it("decisao-registrada + windows → develop (outra label já classifica)", () => {
    assert.equal(track(["decisao-registrada", "windows"]), "develop");
  });

  it("alarm + external-blocker → bloqueada (bloqueio real vence)", () => {
    assert.equal(track(["alarm", "external-blocker"]), "bloqueada");
  });

  it("decisao-registrada + on-hold → fora-de-rodada (mesma resposta, motivo diferente)", () => {
    assert.equal(track(["decisao-registrada", "on-hold"]), "fora-de-rodada");
  });
});

describe("classifyExecTrack — alarme de evento passado (#5553)", () => {
  it("label alarm-evento sozinha → overnight (não existe em nenhum outro conjunto)", () => {
    assert.equal(track(["alarm-evento"]), "overnight");
  });

  it("alarm + alarm-evento (par real, emitido junto por ensureAlarmIssue) → overnight, NÃO fora-de-rodada", () => {
    // Regressão do bug que motivou a issue: sem uma checagem própria pra
    // `alarm-evento` ANTES de `RESOLVED_BY_PROSE_LABELS`, a label `alarm`
    // companheira sozinha bastaria pra classificar fora-de-rodada — exatamente
    // o comportamento que enterrou o #5525 antes deste fix.
    assert.equal(track(["alarm", "alarm-evento"]), "overnight");
  });

  it("alarm SEM alarm-evento (alarme de estado) continua fora-de-rodada — comportamento pré-#5553 preservado", () => {
    assert.equal(track(["alarm"]), "fora-de-rodada");
  });

  it("alarm-evento + external-blocker → bloqueada (bloqueio real vence, mesma precedência de `alarm`)", () => {
    assert.equal(track(["alarm", "alarm-evento", "external-blocker"]), "bloqueada");
  });

  it("alarm-evento + windows → develop (máquina vence, checado antes de alarm-evento)", () => {
    assert.equal(track(["alarm", "alarm-evento", "windows"]), "develop");
  });

  it("alarm-evento + on-hold → fora-de-rodada (editor tirou de circulação vence tudo)", () => {
    assert.equal(track(["alarm", "alarm-evento", "on-hold"]), "fora-de-rodada");
  });
});

describe("classifyExecTrack — precedência", () => {
  it("fora-de-rodada vence bloqueio", () => {
    assert.equal(track(["on-hold", "external-blocker"]), "fora-de-rodada");
  });

  it("fora-de-rodada vence máquina", () => {
    assert.equal(track(["wontfix", "windows"]), "fora-de-rodada");
  });

  it("bloqueio vence máquina", () => {
    // Uma issue windows E bloqueada por credencial não é "trabalho do
    // develop": nem o editor presente destrava sem a credencial.
    assert.equal(track(["windows", "external-blocker"]), "bloqueada");
  });

  it("bloqueio vence trade-off-real", () => {
    assert.equal(track(["trade-off-real", "beehiiv"]), "bloqueada");
  });

  // As 4 acima cruzam label×label. O marcador de data é um branch
  // estruturalmente diferente (valor parseado, não `Set.has`), então precisa
  // do seu próprio cruzamento com os tiers vizinhos.
  const FUTURO = "<!-- aguardando-ate: 2026-09-01 -->";

  it("data futura vence máquina (windows + espera → bloqueada)", () => {
    assert.equal(track(["windows"], FUTURO), "bloqueada");
  });

  it("data futura vence trade-off-real", () => {
    assert.equal(track(["trade-off-real"], FUTURO), "bloqueada");
  });

  it("fora-de-rodada vence data futura", () => {
    assert.equal(track(["on-hold"], FUTURO), "fora-de-rodada");
    assert.equal(track(["wontfix"], FUTURO), "fora-de-rodada");
  });

  it("marcador com a data de HOJE não bloqueia — a espera terminou", () => {
    // Comparação é estrita (`>`), então `waitUntil === now` libera. Um
    // marcador "até hoje" significa que hoje já é o dia de voltar à fila.
    const hoje = new Date("2026-08-16T00:00:00Z");
    assert.equal(
      classifyExecTrack({ labels: [], body: "<!-- aguardando-ate: 2026-08-16 -->", now: hoje }),
      "overnight",
    );
  });
});

describe("parseWaitUntil", () => {
  it("extrai a data em UTC", () => {
    const d = parseWaitUntil("<!-- aguardando-ate: 2026-09-01 -->");
    assert.equal(d?.toISOString(), "2026-09-01T00:00:00.000Z");
  });

  it("tolera espaçamento variável e caixa alta", () => {
    assert.ok(parseWaitUntil("<!--aguardando-ate:2026-09-01-->"));
    assert.ok(parseWaitUntil("<!--   AGUARDANDO-ATE:   2026-09-01   -->"));
  });

  it("null quando ausente, vazio, ou body nulo", () => {
    assert.equal(parseWaitUntil("sem marcador"), null);
    assert.equal(parseWaitUntil(""), null);
    assert.equal(parseWaitUntil(null), null);
    assert.equal(parseWaitUntil(undefined), null);
  });
});

describe("EXEC_TRACK_LABELS", () => {
  it("cobre os 4 valores do tipo", () => {
    const tracks: ExecTrack[] = ["overnight", "develop", "bloqueada", "fora-de-rodada"];
    for (const t of tracks) {
      assert.equal(typeof EXEC_TRACK_LABELS[t], "string");
      assert.ok(EXEC_TRACK_LABELS[t].length > 0);
    }
    assert.equal(Object.keys(EXEC_TRACK_LABELS).length, tracks.length);
  });
});

describe("EXEC_TRACK_UI — vocabulário servido ao front", () => {
  // Este é o guard que impede a 2ª fonte de verdade voltar: `triagem.js`
  // renderiza A PARTIR daqui (via `data.execTrackUi`), em vez de redeclarar os
  // 4 valores. Antes disso, um 5º valor quebraria o build do servidor (pelo
  // `Record<ExecTrack, string>`) e passaria silencioso no cliente, caindo no
  // fallback sem tradução nem tooltip.
  it("tem uma entrada por valor do tipo, com label e explicação preenchidas", () => {
    assert.equal(EXEC_TRACK_UI.length, Object.keys(EXEC_TRACK_LABELS).length);
    for (const entry of EXEC_TRACK_UI) {
      assert.equal(entry.label, EXEC_TRACK_LABELS[entry.track]);
      assert.ok(entry.explain.length > 0, `${entry.track} sem explicação`);
    }
  });

  it("está na ordem de precedência do classificador, não alfabética", () => {
    // A legenda é lida de cima pra baixo pra entender por que uma issue com 2
    // sinais caiu onde caiu — ordem alfabética destruiria essa leitura.
    assert.deepEqual(
      EXEC_TRACK_UI.map((e) => e.track),
      ["overnight", "develop", "bloqueada", "fora-de-rodada"],
    );
  });

  it("nenhuma explicação repetida — cada valor diz algo próprio", () => {
    const explains = new Set(EXEC_TRACK_UI.map((e) => e.explain));
    assert.equal(explains.size, EXEC_TRACK_UI.length);
  });
});
