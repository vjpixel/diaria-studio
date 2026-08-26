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
  classifyExecTrackWithRule,
  parseWaitUntil,
  EXEC_TRACK_LABELS,
  EXEC_TRACK_UI,
  type ExecTrack,
  EXEC_TRACK_MATCH_CATALOG,
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

describe("classifyExecTrack — state CLOSED (#5948, regressão do dashboard overnight-track)", () => {
  it("issue fechada sem label nenhuma → fora-de-rodada, nunca overnight", () => {
    assert.equal(
      classifyExecTrack({ labels: [], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
  });

  it("issue fechada vence QUALQUER outra label — checado antes de tudo", () => {
    // #5926: caso real da issue — fechada, mas ainda carregava labels que,
    // sem o guard de state, a mandariam pra bloqueada/develop/agendada em
    // vez de sumir da fila de vez.
    assert.equal(
      classifyExecTrack({ labels: ["bug", "P1"], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
    assert.equal(
      classifyExecTrack({ labels: ["windows"], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
    assert.equal(
      classifyExecTrack({
        labels: [],
        body: "<!-- aguardando-ate: 2026-09-01 -->",
        now: NOW,
        state: "CLOSED",
      }),
      "fora-de-rodada",
    );
  });

  it("state ausente não classifica CLOSED — comportamento normal preservado", () => {
    assert.equal(classifyExecTrack({ labels: [], body: "", now: NOW }), "overnight");
  });

  it("state OPEN não classifica CLOSED — comportamento normal preservado", () => {
    assert.equal(
      classifyExecTrack({ labels: [], body: "", now: NOW, state: "OPEN" }),
      "overnight",
    );
  });
});

describe("classifyExecTrack — develop-track: bloqueio humano sem data (#5948)", () => {
  it("label develop-track sozinha → develop", () => {
    assert.equal(track(["develop-track"]), "develop");
  });

  it("develop-track nunca é overnight, mesmo sem nenhuma outra label", () => {
    assert.notEqual(track(["develop-track"]), "overnight");
  });

  it("bloqueio real (BLOCKED_LABELS) vence develop-track", () => {
    assert.equal(track(["develop-track", "external-blocker"]), "bloqueada");
  });

  it("marcador de data futura vence develop-track (vira agendada, não develop)", () => {
    assert.equal(
      track(["develop-track"], "<!-- aguardando-ate: 2026-09-01 -->"),
      "agendada",
    );
  });

  it("fora-de-rodada vence develop-track", () => {
    assert.equal(track(["on-hold", "develop-track"]), "fora-de-rodada");
  });

  it("issue fechada com develop-track → fora-de-rodada (state vence tudo)", () => {
    assert.equal(
      classifyExecTrack({ labels: ["develop-track"], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
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

describe("classifyExecTrack — credencial-escopo (#5694)", () => {
  it("external-blocker sozinho → bloqueada (comportamento atual, sem regressão)", () => {
    assert.equal(track(["external-blocker"]), "bloqueada");
  });

  it("external-blocker + credencial-escopo → develop (credencial já existe, só falta escopo)", () => {
    assert.equal(track(["external-blocker", "credencial-escopo"]), "develop");
  });

  it("credencial-escopo sozinha (sem external-blocker) não classifica nada — overnight", () => {
    assert.equal(track(["credencial-escopo"]), "overnight");
  });

  it("credencial-escopo não destrava outra label de BLOCKED_LABELS (kit-migration continua bloqueada)", () => {
    assert.equal(track(["kit-migration", "credencial-escopo"]), "bloqueada");
  });

  it("credencial-escopo não destrava beehiiv", () => {
    assert.equal(track(["beehiiv", "credencial-escopo"]), "bloqueada");
  });

  it("credencial-escopo não destrava bloqueio-execucao", () => {
    assert.equal(track(["bloqueio-execucao", "credencial-escopo"]), "bloqueada");
  });

  it("external-blocker + credencial-escopo + outra label de bloqueio real → bloqueada (o outro bloqueio vence)", () => {
    assert.equal(track(["external-blocker", "credencial-escopo", "kit-migration"]), "bloqueada");
  });

  it("fora-de-rodada vence external-blocker + credencial-escopo", () => {
    assert.equal(track(["on-hold", "external-blocker", "credencial-escopo"]), "fora-de-rodada");
  });

  it("deferimento vago (not-this-week) vence external-blocker + credencial-escopo", () => {
    assert.equal(track(["external-blocker", "credencial-escopo", "not-this-week"]), "bloqueada");
  });

  it("marcador de data futura vence external-blocker + credencial-escopo (mesmo comportamento de windows/trade-off-real, #5682)", () => {
    assert.equal(
      track(["external-blocker", "credencial-escopo"], "<!-- aguardando-ate: 2026-09-01 -->"),
      "agendada",
    );
  });
});

describe("classifyExecTrack — marcador aguardando-ate", () => {
  it("data futura → agendada (#5682, era bloqueada antes)", () => {
    assert.equal(track([], "<!-- aguardando-ate: 2026-09-01 -->"), "agendada");
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
    assert.equal(track([], body), "agendada");
  });

  it("marcador indentado em linha própria ainda conta", () => {
    assert.equal(track([], "texto\n   <!-- aguardando-ate: 2026-09-01 -->   \nmais"), "agendada");
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
      assert.equal(track([], body), "agendada");
    });
  });
});

// Os 7 casos (a)-(g) listados na seção "Arquivos" do #5682, nomeados 1:1 com
// o texto da issue — alguns já cobertos acima por outros describes, repetidos
// aqui como bloco único e citável.
describe("classifyExecTrack — casos (a)-(g) do #5682", () => {
  it("(a) marcador futuro → agendada", () => {
    assert.equal(track([], "<!-- aguardando-ate: 2026-09-01 -->"), "agendada");
  });

  it("(b) marcador passado → overnight (comportamento atual, não pode regredir)", () => {
    assert.equal(track([], "<!-- aguardando-ate: 2026-08-01 -->"), "overnight");
  });

  it("(c) external-blocker + marcador futuro → bloqueada (bloqueio vence)", () => {
    assert.equal(track(["external-blocker"], "<!-- aguardando-ate: 2026-09-01 -->"), "bloqueada");
  });

  it("(d) not-this-week + marcador futuro → agendada (data vence sobre deferimento vago)", () => {
    assert.equal(track(["not-this-week"], "<!-- aguardando-ate: 2026-09-01 -->"), "agendada");
  });

  it("(e) not-this-week sozinho → bloqueada (não virou agendada)", () => {
    assert.equal(track(["not-this-week"]), "bloqueada");
  });

  it("(f) on-hold sozinho → fora-de-rodada (não virou agendada)", () => {
    assert.equal(track(["on-hold"]), "fora-de-rodada");
  });

  it("(g) marcador citado inline em prosa continua ignorado (guard do #5462)", () => {
    const body = "Usar `<!-- aguardando-ate: 2026-09-01 -->` no corpo, no espírito de issue-decisions.ts.";
    assert.equal(track([], body), "overnight");
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

describe("classifyExecTrack — EPIC guarda-chuva e ambígua-sem-direção (#5968)", () => {
  it("label epic-guarda-chuva sozinha → fora-de-rodada", () => {
    assert.equal(track(["epic-guarda-chuva"]), "fora-de-rodada");
  });

  it("label sem-direcao-acionavel sozinha → fora-de-rodada", () => {
    assert.equal(track(["sem-direcao-acionavel"]), "fora-de-rodada");
  });

  it("issue sem nenhuma das duas labels novas continua overnight (sem regressão)", () => {
    assert.equal(track(["bug", "P2"]), "overnight");
    assert.equal(track([]), "overnight");
  });

  it("epic-guarda-chuva + enhancement/P1 (caso real #5116) → fora-de-rodada", () => {
    assert.equal(track(["enhancement", "P1", "growth", "epic-guarda-chuva"]), "fora-de-rodada");
  });

  it("sem-direcao-acionavel + bug/P2 (caso real #5959) → fora-de-rodada", () => {
    assert.equal(track(["bug", "P2", "sem-direcao-acionavel"]), "fora-de-rodada");
  });

  it("bloqueio real vence epic-guarda-chuva", () => {
    assert.equal(track(["epic-guarda-chuva", "external-blocker"]), "bloqueada");
  });

  it("bloqueio real vence sem-direcao-acionavel", () => {
    assert.equal(track(["sem-direcao-acionavel", "kit-migration"]), "bloqueada");
  });

  it("windows vence epic-guarda-chuva (vira develop, não fora-de-rodada)", () => {
    assert.equal(track(["epic-guarda-chuva", "windows"]), "develop");
  });

  it("trade-off-real vence sem-direcao-acionavel (vira develop)", () => {
    assert.equal(track(["sem-direcao-acionavel", "trade-off-real"]), "develop");
  });

  it("on-hold (fora-de-rodada de 1ª checagem) vence as duas — mesma resposta, motivo diferente", () => {
    assert.equal(track(["on-hold", "epic-guarda-chuva"]), "fora-de-rodada");
    assert.equal(track(["on-hold", "sem-direcao-acionavel"]), "fora-de-rodada");
  });

  it("marcador de data futura vence as duas (vira agendada, não fora-de-rodada)", () => {
    assert.equal(
      track(["epic-guarda-chuva"], "<!-- aguardando-ate: 2026-09-01 -->"),
      "agendada",
    );
    assert.equal(
      track(["sem-direcao-acionavel"], "<!-- aguardando-ate: 2026-09-01 -->"),
      "agendada",
    );
  });

  it("issue fechada com qualquer uma das duas → fora-de-rodada (state vence tudo)", () => {
    assert.equal(
      classifyExecTrack({ labels: ["epic-guarda-chuva"], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
    assert.equal(
      classifyExecTrack({
        labels: ["sem-direcao-acionavel"],
        body: "",
        now: NOW,
        state: "CLOSED",
      }),
      "fora-de-rodada",
    );
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

  it("data futura vence máquina (windows + espera → agendada, #5682)", () => {
    // Pré-#5682 isso caía em bloqueada (checagem de data vinha antes de
    // máquina, mas devolvia bloqueada). Agora devolve agendada — bloqueio
    // REAL continua vencendo (ver teste abaixo), máquina não é bloqueio real.
    assert.equal(track(["windows"], FUTURO), "agendada");
  });

  it("data futura vence trade-off-real (→ agendada, #5682)", () => {
    assert.equal(track(["trade-off-real"], FUTURO), "agendada");
  });

  it("bloqueio real vence data futura (→ bloqueada, não agendada)", () => {
    assert.equal(track(["external-blocker"], FUTURO), "bloqueada");
    assert.equal(track(["kit-migration"], FUTURO), "bloqueada");
  });

  it("data futura vence deferimento vago (not-this-week/next-month → agendada)", () => {
    // Critério do #5682: quem escreveu uma data disse algo mais específico
    // que "not-this-week" — a data vence.
    assert.equal(track(["not-this-week"], FUTURO), "agendada");
    assert.equal(track(["next-month"], FUTURO), "agendada");
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
  it("cobre os 5 valores do tipo (#5682 acrescenta agendada)", () => {
    const tracks: ExecTrack[] = ["overnight", "develop", "agendada", "bloqueada", "fora-de-rodada"];
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
  // 5 valores. Antes disso, um 6º valor quebraria o build do servidor (pelo
  // `Record<ExecTrack, string>`) e passaria silencioso no cliente, caindo no
  // fallback sem tradução nem tooltip.
  it("tem uma entrada por valor do tipo, com label e explicação preenchidas", () => {
    assert.equal(EXEC_TRACK_UI.length, Object.keys(EXEC_TRACK_LABELS).length);
    for (const entry of EXEC_TRACK_UI) {
      assert.equal(entry.label, EXEC_TRACK_LABELS[entry.track]);
      assert.ok(entry.explain.length > 0, `${entry.track} sem explicação`);
    }
  });

  it("está na ordem de leitura (anda sozinho hoje → não anda nunca), não alfabética nem de precedência", () => {
    // #5682: `agendada` entra entre `develop` e `bloqueada` — anda sozinha
    // *depois*, na data; não é o inverso estrito da precedência do
    // classificador (que checa `bloqueada` antes de `agendada`).
    assert.deepEqual(
      EXEC_TRACK_UI.map((e) => e.track),
      ["overnight", "develop", "agendada", "bloqueada", "fora-de-rodada"],
    );
  });

  it("nenhuma explicação repetida — cada valor diz algo próprio", () => {
    const explains = new Set(EXEC_TRACK_UI.map((e) => e.explain));
    assert.equal(explains.size, EXEC_TRACK_UI.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #6200 — matched: qual regra da cadeia de precedência decidiu o track.
// Cada teste abaixo confere UM caso da cadeia, garantindo que `matched` seja
// o prefixo `category:detail` correto — não só o `track` (a parte fácil).
describe("classifyExecTrackWithRule — matched (#6200)", () => {
  it("state CLOSED → state:closed", () => {
    const r = classifyExecTrackWithRule({ labels: ["bug"], body: "", now: NOW, state: "CLOSED" });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "state:closed");
  });

  it("label on-hold → label:on-hold", () => {
    const r = classifyExecTrackWithRule({ labels: ["on-hold"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:on-hold");
  });

  it("label wontfix → label:wontfix", () => {
    const r = classifyExecTrackWithRule({ labels: ["wontfix"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:wontfix");
  });

  it("label external-blocker → label:external-blocker (bloqueio real)", () => {
    const r = classifyExecTrackWithRule({ labels: ["external-blocker"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:external-blocker");
  });

  it("label kit-migration → label:kit-migration", () => {
    const r = classifyExecTrackWithRule({ labels: ["kit-migration"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:kit-migration");
  });

  it("label beehiiv → label:beehiiv", () => {
    const r = classifyExecTrackWithRule({ labels: ["beehiiv"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:beehiiv");
  });

  it("label bloqueio-execucao → label:bloqueio-execucao", () => {
    const r = classifyExecTrackWithRule({ labels: ["bloqueio-execucao"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:bloqueio-execucao");
  });

  it("marcador aguardando-ate futuro → marker:aguardando-ate", () => {
    const r = classifyExecTrackWithRule({ labels: [], body: "<!-- aguardando-ate: 2026-09-01 -->", now: NOW });
    assert.equal(r.track, "agendada");
    assert.equal(r.matched, "marker:aguardando-ate");
  });

  it("label not-this-week → label:not-this-week (2ª checagem bloqueada)", () => {
    const r = classifyExecTrackWithRule({ labels: ["not-this-week"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:not-this-week");
  });

  it("label next-month → label:next-month", () => {
    const r = classifyExecTrackWithRule({ labels: ["next-month"], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, "label:next-month");
  });

  it("label windows → label:windows", () => {
    const r = classifyExecTrackWithRule({ labels: ["windows"], body: "", now: NOW });
    assert.equal(r.track, "develop");
    assert.equal(r.matched, "label:windows");
  });

  it("label trade-off-real → label:trade-off-real", () => {
    const r = classifyExecTrackWithRule({ labels: ["trade-off-real"], body: "", now: NOW });
    assert.equal(r.track, "develop");
    assert.equal(r.matched, "label:trade-off-real");
  });

  it("external-blocker + credencial-escopo → label:credencial-escopo", () => {
    const r = classifyExecTrackWithRule({ labels: ["external-blocker", "credencial-escopo"], body: "", now: NOW });
    assert.equal(r.track, "develop");
    assert.equal(r.matched, "label:credencial-escopo");
  });

  it("label develop-track → label:develop-track", () => {
    const r = classifyExecTrackWithRule({ labels: ["develop-track"], body: "", now: NOW });
    assert.equal(r.track, "develop");
    assert.equal(r.matched, "label:develop-track");
  });

  it("label alarm-evento → label:alarm-evento", () => {
    const r = classifyExecTrackWithRule({ labels: ["alarm-evento"], body: "", now: NOW });
    assert.equal(r.track, "overnight");
    assert.equal(r.matched, "label:alarm-evento");
  });

  it("label decisao-registrada → label:decisao-registrada", () => {
    const r = classifyExecTrackWithRule({ labels: ["decisao-registrada"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:decisao-registrada");
  });

  it("label alarm → label:alarm", () => {
    const r = classifyExecTrackWithRule({ labels: ["alarm"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:alarm");
  });

  it("label epic-guarda-chuva → label:epic-guarda-chuva", () => {
    const r = classifyExecTrackWithRule({ labels: ["epic-guarda-chuva"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:epic-guarda-chuva");
  });

  it("label sem-direcao-acionavel → label:sem-direcao-acionavel", () => {
    const r = classifyExecTrackWithRule({ labels: ["sem-direcao-acionavel"], body: "", now: NOW });
    assert.equal(r.track, "fora-de-rodada");
    assert.equal(r.matched, "label:sem-direcao-acionavel");
  });

  it("nada combina → default (overnight por omissão)", () => {
    const r = classifyExecTrackWithRule({ labels: ["bug", "P2"], body: "", now: NOW });
    assert.equal(r.track, "overnight");
    assert.equal(r.matched, "default");
  });

  it("ambiguidade textual → default (não é trade-off real sem label)", () => {
    const r = classifyExecTrackWithRule({ labels: [], body: "precisamos decidir entre X e Y", now: NOW });
    assert.equal(r.track, "overnight");
    assert.equal(r.matched, "default");
  });
});

describe("classifyExecTrack — assinatura antiga preservada (#6200)", () => {
  it("continua devolvendo só ExecTrack (string), sem matched", () => {
    const result = classifyExecTrack({ labels: ["trade-off-real"], body: "", now: NOW });
    assert.equal(result, "develop");
    assert.equal(typeof result, "string");
  });
});

// #6200 — guard de CONTRATO da união `ExecTrackMatch`, verificado em tempo de
// COMPILAÇÃO (`npx tsc --noEmit`), não em runtime.
//
// Por que existe: os testes de `matched` acima já asseriam cada valor que o
// classificador produz, e mesmo assim `"label:develop-track"` ficou de fora da
// união — porque `ExecTrackResult.matched` é tipado `string` (escape hatch
// deliberado: o valor é montado como `label:${nome}` em runtime). Com isso, a
// união pôde divergir do runtime sem nenhum teste quebrar, e o docstring ainda
// classificou `develop-track` como `bloqueada` (ele roteia pra `develop`).
//
// O catálogo vive em `scripts/lib/issue-exec-track.ts` (EXEC_TRACK_MATCH_CATALOG),
// não aqui: `tsconfig.json` inclui só `scripts/**/*.ts`, então anotação de tipo
// escrita em `test/` não é verificada por `npx tsc --noEmit`. Lá o catálogo é
// `readonly ExecTrackMatch[]` e quebra a compilação se a união encolher; aqui
// conferimos o outro lado — que o runtime não emita nada fora dele.

describe("ExecTrackMatch — união cobre todo valor que o runtime emite (#6200)", () => {
  it("todo `matched` produzido pelo classificador está no catálogo tipado", () => {
    // Cada entrada exercita a regra que produz aquele `matched`, fechando o
    // loop entre runtime e união: o array acima não compila se a união
    // encolher, e este teste falha se o runtime emitir algo fora dela.
    const casos: Array<{ labels: string[]; body?: string; state?: "OPEN" | "CLOSED" }> = [
      { labels: [], state: "CLOSED" },
      { labels: ["on-hold"] },
      { labels: ["wontfix"] },
      { labels: ["external-blocker"] },
      { labels: ["kit-migration"] },
      { labels: ["beehiiv"] },
      { labels: ["bloqueio-execucao"] },
      { labels: [], body: "<!-- aguardando-ate: 2099-01-01 -->" },
      { labels: ["not-this-week"] },
      { labels: ["next-month"] },
      { labels: ["windows"] },
      { labels: ["trade-off-real"] },
      { labels: ["external-blocker", "credencial-escopo"] },
      { labels: ["develop-track"] },
      { labels: ["alarm-evento"] },
      { labels: ["decisao-registrada"] },
      { labels: ["alarm"] },
      { labels: ["epic-guarda-chuva"] },
      { labels: ["sem-direcao-acionavel"] },
      { labels: [] },
    ];

    for (const caso of casos) {
      const r = classifyExecTrackWithRule({
        labels: caso.labels,
        body: caso.body ?? "",
        now: NOW,
        state: caso.state,
      });
      assert.ok(
        (EXEC_TRACK_MATCH_CATALOG as readonly string[]).includes(r.matched),
        `matched "${r.matched}" (labels: ${JSON.stringify(caso.labels)}) fora da união ExecTrackMatch`,
      );
    }
  });
});
