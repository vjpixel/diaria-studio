/**
 * test/backlog-reconcile.test.ts (#6198)
 *
 * Cobre `scripts/lib/backlog-reconcile.ts` — lógica PURA da reconciliação
 * diária do backlog. Os 4 casos usam o texto REAL (corpo/labels) das issues
 * que motivaram a #6198, no estado em que a auditoria de 26/08/2026 (#6191)
 * as encontrou — antes da correção manual ao vivo que a própria #6198
 * documenta ter sido aplicada. Sem chamada de rede: tudo aqui é fixture em
 * memória, mesmo padrão de `test/wait-until-sync.test.ts`/`test/issue-route.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectMarkerDeferralConflict,
  detectInheritedBlockLabel,
  detectOpenChecklistInTerminalIssue,
  detectSiblingBlockLabelInconsistency,
  extractParentRef,
  countOpenCheckboxes,
  splitFindingsByAction,
  type BacklogIssueInput,
} from "../scripts/lib/backlog-reconcile.ts";

const NOW = new Date("2026-08-26T12:00:00Z");

function issue(overrides: Partial<BacklogIssueInput> & Pick<BacklogIssueInput, "number" | "title" | "body" | "labels">): BacklogIssueInput {
  return {
    url: `https://github.com/vjpixel/diaria-studio/issues/${overrides.number}`,
    state: "OPEN",
    ...overrides,
  };
}

describe("detectMarkerDeferralConflict — padrão 1 (marcador futuro + label de deferimento)", () => {
  // Fixture real #5734 — "Reconciliar conversão reportada por painel..."
  // Estado encontrado pela auditoria 26/08 (comentário da própria issue):
  // "a issue ja tinha marcador aguardando-ate futuro E a label not-this-week."
  it("#5734 — marcador futuro (2026-08-28) + not-this-week, sem outra label roteável → fix agendada", () => {
    const i5734 = issue({
      number: 5734,
      title: "Reconciliar conversão reportada por painel × cadastros reais na 1ª semana de campanha",
      labels: ["enhancement", "P2", "growth", "not-this-week"],
      body: [
        "Depende do D0 do teste de 3 canais (#5524).",
        "",
        "<!-- aguardando-ate: 2026-08-28 -->",
      ].join("\n"),
    });

    const finding = detectMarkerDeferralConflict(i5734, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "fix");
    if (finding.action !== "fix") return;
    assert.equal(finding.patternId, "marker-deferral-conflict");
    assert.equal(finding.issue, 5734);
    assert.deepEqual(finding.conflictingLabels, ["not-this-week"]);
    assert.equal(finding.markerDate, "2026-08-28");
    assert.equal(finding.routeTrack, "agendada"); // marcador ainda não passou em 26/08
  });

  // Fixture real #5239 — "Kill switch por custo..."
  it("#5239 — marcador futuro (2026-09-08) + not-this-week, sem outra label roteável → fix agendada", () => {
    const i5239 = issue({
      number: 5239,
      title: "Kill switch por custo: pausar campanha automaticamente quando o custo por leitor degradar",
      labels: ["enhancement", "P3", "not-this-week"],
      body: [
        "Nada disto é acionável enquanto os três canais estiverem com gasto zero.",
        "",
        "<!-- aguardando-ate: 2026-09-08 -->",
      ].join("\n"),
    });

    const finding = detectMarkerDeferralConflict(i5239, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "fix");
    if (finding.action !== "fix") return;
    assert.deepEqual(finding.conflictingLabels, ["not-this-week"]);
    assert.equal(finding.markerDate, "2026-09-08");
    assert.equal(finding.routeTrack, "agendada");
  });
});

describe("detectMarkerDeferralConflict — padrão 2 (on-hold + marcador com a mesma data)", () => {
  // Fixture real #4469 — "Verificar a meta da #4295 em ~29/set/2026..."
  it("#4469 — on-hold + marcador 2026-09-29 (mesma data do Vencimento) → fix agendada", () => {
    const i4469 = issue({
      number: 4469,
      title: "Verificar a meta da #4295 em ~29/set/2026: direct abaixo de 25% dos novos cadastros",
      labels: ["enhancement", "P3", "growth", "on-hold"],
      body: [
        "Fica `on-hold` para não entrar em briefing de overnight antes da hora.",
        "",
        "## Vencimento (guard #5317)",
        "",
        "Vencimento: 2026-09-29",
        "",
        "<!-- aguardando-ate: 2026-09-29 -->",
      ].join("\n"),
    });

    const finding = detectMarkerDeferralConflict(i4469, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "fix");
    if (finding.action !== "fix") return;
    assert.deepEqual(finding.conflictingLabels, ["on-hold"]);
    assert.equal(finding.markerDate, "2026-09-29");
    assert.equal(finding.routeTrack, "agendada");
  });

  // Fixture real #4554 — checkpoint 30/set
  it("#4554 — on-hold + marcador 2026-09-30 → fix agendada", () => {
    const i4554 = issue({
      number: 4554,
      title: "Facebook/Threads/X: checkpoint 30/set com regra de decisao RATIFICADA (07/ago)",
      labels: ["enhancement", "P3", "growth", "on-hold"],
      body: ["Vencimento: 2026-09-30", "", "<!-- aguardando-ate: 2026-09-30 -->"].join("\n"),
    });
    const finding = detectMarkerDeferralConflict(i4554, NOW);
    assert.equal(finding?.action, "fix");
  });

  // Fixture real #4556 — checkpoint retenção 15/09
  it("#4556 — on-hold + marcador 2026-09-15 → fix agendada", () => {
    const i4556 = issue({
      number: 4556,
      title: "Checkpoint 15/09: retenção da coorte de lançamento (21/07-02/08) contra a base antiga",
      labels: ["enhancement", "P3", "growth", "on-hold"],
      body: ["Vencimento: 2026-09-15", "", "<!-- aguardando-ate: 2026-09-15 -->"].join("\n"),
    });
    const finding = detectMarkerDeferralConflict(i4556, NOW);
    assert.equal(finding?.action, "fix");
  });

  it("marcador JÁ EXPIRADO + on-hold sobrevivente → fix overnight (não agendada, marcador não produz mais esse veredito)", () => {
    const expired = issue({
      number: 90001,
      title: "fixture sintética — marcador expirado",
      labels: ["on-hold"],
      body: "<!-- aguardando-ate: 2026-08-01 -->",
    });
    const finding = detectMarkerDeferralConflict(expired, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "fix");
    if (finding.action !== "fix") return;
    assert.equal(finding.routeTrack, "overnight");
  });
});

describe("detectMarkerDeferralConflict — restrição inegociável (nunca corrige sinal isolado/ambíguo)", () => {
  it("marcador + not-this-week + OUTRA label roteável (windows) coexistindo → alarme, nunca fix", () => {
    const ambiguous = issue({
      number: 90002,
      title: "fixture sintética — ambígua",
      labels: ["not-this-week", "windows"],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
    });
    const finding = detectMarkerDeferralConflict(ambiguous, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "alarm");
    if (finding.action !== "alarm") return;
    assert.equal(finding.patternId, "marker-deferral-conflict-ambiguous");
    assert.deepEqual(finding.otherRoutableLabels, ["windows"]);
  });

  it("sem marcador válido → null, mesmo com label de deferimento presente (nada a reconciliar)", () => {
    const noMarker = issue({ number: 90003, title: "sem marcador", labels: ["not-this-week"], body: "sem marcador nenhum aqui" });
    assert.equal(detectMarkerDeferralConflict(noMarker, NOW), null);
  });

  it("marcador sem nenhuma label de deferimento → null (nada contraditório)", () => {
    const onlyMarker = issue({ number: 90004, title: "só marcador", labels: ["enhancement"], body: "<!-- aguardando-ate: 2026-09-01 -->" });
    assert.equal(detectMarkerDeferralConflict(onlyMarker, NOW), null);
  });

  it("issue CLOSED nunca entra (nem quando carrega os dois sinais)", () => {
    const closed = issue({ number: 90005, title: "fechada", labels: ["not-this-week"], body: "<!-- aguardando-ate: 2026-09-01 -->", state: "CLOSED" });
    assert.equal(detectMarkerDeferralConflict(closed, NOW), null);
  });

  it("wontfix + marcador → ALARME, nunca fix (veredito 'nunca' vence data 'ainda não')", () => {
    // `wontfix` foi incluído no conjunto auto-corrigível "por simetria" com
    // `on-hold`, sem fixture. A simetria não se sustenta: `on-hold`/
    // `not-this-week`/`next-month` dizem "agora não", e o marcador de data os
    // contradiz de forma resolvível. `wontfix` diz "nunca" — num conflito, o
    // candidato a obsoleto é o MARCADOR, e remover a label ressuscitaria
    // trabalho descartado de propósito. Self-review do #6198, rodada 260826.
    const wontfixed = issue({
      number: 90010,
      title: "fixture sintética — wontfix com marcador",
      labels: ["wontfix"],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
    });
    const finding = detectMarkerDeferralConflict(wontfixed, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "alarm", "wontfix NUNCA pode virar correção automática");
    if (finding.action !== "alarm") return;
    assert.equal(finding.patternId, "marker-wontfix-conflict");
    assert.deepEqual(finding.conflictingLabels, ["wontfix"]);
  });

  it("wontfix junto de outra label de deferimento continua alarme (wontfix domina)", () => {
    // Sem esta guarda, `on-hold` cairia no caminho de fix e a remoção levaria
    // `wontfix` junto no mesmo `routeIssue`.
    const both = issue({
      number: 90011,
      title: "fixture sintética — wontfix + on-hold",
      labels: ["wontfix", "on-hold"],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
    });
    const finding = detectMarkerDeferralConflict(both, NOW);
    assert.ok(finding);
    assert.equal(finding.action, "alarm");
    if (finding.action !== "alarm") return;
    assert.equal(finding.patternId, "marker-wontfix-conflict");
  });

  it("idempotência: rodar contra o estado JÁ CORRIGIDO (label removida, marcador só) não acha nada de novo", () => {
    const alreadyFixed = issue({ number: 5734, title: "já corrigida", labels: ["enhancement", "P2", "growth"], body: "<!-- aguardando-ate: 2026-08-28 -->" });
    assert.equal(detectMarkerDeferralConflict(alreadyFixed, NOW), null);
  });
});

describe("extractParentRef", () => {
  it("casa 'Fatia de #N' (convenção real das issues #6184-#6187)", () => {
    assert.equal(extractParentRef("Fatia de #463 — ver a tabela de decomposição por eixo de dado lá."), 463);
  });

  it("casa 'Fatia de **#N**' (bold markdown, convenção real de #6187)", () => {
    assert.equal(extractParentRef("Fatia de **#463**.\n\n## Por que é o item que impede a recaída"), 463);
  });

  it("casa 'Desdobrada da #N' (convenção real de #5734)", () => {
    assert.equal(extractParentRef("Desdobrada da **#5500** (fechada), cujo escopo..."), 5500);
  });

  it("casa 'Desdobrada de #N'", () => {
    assert.equal(extractParentRef("Desdobrada de #123, item pendente."), 123);
  });

  it("null quando não há referência de decomposição", () => {
    assert.equal(extractParentRef("Issue independente, sem mãe."), null);
  });
});

describe("detectInheritedBlockLabel — padrão 3 (label de bloqueio herdada de mãe pra filha, sempre ALARME)", () => {
  // Fixture real #6187 ("feat(#463): cache HÍBRIDO permanente...") no estado
  // em que a auditoria 26/08 a encontrou: filha carregando `kit-migration`
  // herdada do bloqueio da migração inteira (label da mãe #463), mesmo o
  // escopo da fatia sendo, no próprio corpo, "100% código local".
  it("#6187 herda kit-migration da mãe #463 → alarme (nunca correção)", () => {
    const child = issue({
      number: 6187,
      title: "feat(#463): cache HÍBRIDO permanente — as 259 edições Beehiiv não têm como migrar pro Kit",
      labels: ["enhancement", "P2", "diaria", "kit-migration"],
      body: "Fatia de **#463** — ver a tabela de decomposição por eixo de dado lá.",
    });
    const parent = { number: 463, labels: ["enhancement", "P2", "diaria", "mensal", "epic-guarda-chuva", "kit-migration"] };

    const finding = detectInheritedBlockLabel(child, parent);
    assert.ok(finding);
    assert.equal(finding.action, "alarm");
    assert.equal(finding.patternId, "inherited-block-label");
    assert.equal(finding.parentNumber, 463);
    assert.deepEqual(finding.sharedLabels, ["kit-migration"]);
  });

  it("sem referência a mãe → null mesmo com label de bloqueio presente", () => {
    const noParentRef = issue({ number: 90006, title: "sem mãe", labels: ["kit-migration"], body: "issue independente" });
    assert.equal(detectInheritedBlockLabel(noParentRef, { number: 1, labels: ["kit-migration"] }), null);
  });

  it("mãe não compartilha a label → null (não é herança, é coincidência de bloqueio próprio)", () => {
    const child = issue({ number: 90007, title: "bloqueio próprio", labels: ["external-blocker"], body: "Fatia de #1" });
    const parent = { number: 1, labels: ["kit-migration"] }; // mãe tem OUTRA label de bloqueio
    assert.equal(detectInheritedBlockLabel(child, parent), null);
  });

  it("parent null (mãe não resolvida) → null, nunca alarma sobre o que não confirmou", () => {
    const child = issue({ number: 90008, title: "mãe não resolvida", labels: ["kit-migration"], body: "Fatia de #999999" });
    assert.equal(detectInheritedBlockLabel(child, null), null);
  });

  it("idempotência: rodar contra o estado JÁ CORRIGIDO (kit-migration removida) não acha nada de novo", () => {
    const fixed = issue({ number: 6187, title: "já corrigida", labels: ["enhancement", "P2", "diaria"], body: "Fatia de **#463**." });
    const parent = { number: 463, labels: ["enhancement", "P2", "diaria", "mensal", "epic-guarda-chuva"] };
    assert.equal(detectInheritedBlockLabel(fixed, parent), null);
  });
});

describe("countOpenCheckboxes / detectOpenChecklistInTerminalIssue — padrão 4 (checkbox aberto em issue terminal, sempre ALARME)", () => {
  it("conta só checkboxes ABERTOS, ignora os marcados", () => {
    const body = ["- [ ] item pendente 1", "- [x] item feito", "- [X] item feito maiúsculo", "- [ ] item pendente 2"].join("\n");
    assert.equal(countOpenCheckboxes(body), 2);
  });

  // Fixture real #6047 ("Parte da migração Beehiiv → Kit... Esta issue é o
  // gate de todo o resto") no estado em que a auditoria 26/08 a encontrou:
  // um item de checklist ainda aberto ("Render de HTML em broadcast"),
  // enquanto a issue já classificava fora-de-rodada (epic/gate-guarda-chuva)
  // e por isso nada a revisitava.
  it("#6047 — issue fora-de-rodada com checkbox aberto → alarme", () => {
    const i6047 = issue({
      number: 6047,
      title: "Parte da migração Beehiiv → Kit — gate de todo o resto",
      labels: ["enhancement", "P2", "epic-guarda-chuva"],
      body: [
        "## 2. Feature parity",
        "",
        "- [x] Cliques por link, por post, via API? SIM",
        "- [ ] Render de HTML em broadcast: bate com o nosso? — ainda não verificado ao vivo",
      ].join("\n"),
    });
    const finding = detectOpenChecklistInTerminalIssue(i6047, "fora-de-rodada");
    assert.ok(finding);
    assert.equal(finding.action, "alarm");
    assert.equal(finding.patternId, "open-checklist-in-terminal-issue");
    assert.equal(finding.openCheckboxCount, 1);
  });

  it("issue overnight (não terminal) com checkbox aberto → null, o overnight ainda vai revisitar sozinho", () => {
    const notTerminal = issue({ number: 90009, title: "ainda elegível", labels: [], body: "- [ ] item pendente" });
    assert.equal(detectOpenChecklistInTerminalIssue(notTerminal, "overnight"), null);
  });

  it("issue terminal SEM checkbox aberto → null", () => {
    const allDone = issue({ number: 90010, title: "tudo feito", labels: ["epic-guarda-chuva"], body: "- [x] item feito" });
    assert.equal(detectOpenChecklistInTerminalIssue(allDone, "fora-de-rodada"), null);
  });

  it("issue CLOSED nunca entra, mesmo terminal com checkbox aberto", () => {
    const closed = issue({ number: 90011, title: "fechada", labels: [], body: "- [ ] item", state: "CLOSED" });
    assert.equal(detectOpenChecklistInTerminalIssue(closed, "fora-de-rodada"), null);
  });

  it("idempotência: rodar contra o estado JÁ CORRIGIDO (issue fechada, decisao-registrada) não acha nada de novo", () => {
    const fixed = issue({ number: 6047, title: "já corrigida", labels: ["enhancement", "P2", "diaria", "decisao-registrada"], body: "- [x] tudo feito agora", state: "CLOSED" });
    assert.equal(detectOpenChecklistInTerminalIssue(fixed, "fora-de-rodada"), null);
  });
});

describe("detectSiblingBlockLabelInconsistency — padrão 5 (#6201 item 7, sempre ALARME)", () => {
  // Fixtures reais: as 4 filhas da #463 no estado em que a auditoria de
  // 26/08 (#6191) as encontrou, ANTES da correção manual — #6185/#6186
  // (bloqueio real, cliques/stats) e #6187 (SEM bloqueio real, cache local
  // puro — falso positivo) carregavam `kit-migration`; #6184 (metadados,
  // também sem bloqueio real) ficou SEM a label, por omissão, não por
  // decisão. É exatamente essa assimetria entre #6184 e as outras 3 que o
  // padrão 5 detecta mecanicamente, sem julgar qual lado está "certo".
  const d6184 = issue({
    number: 6184,
    title: "feat(#463): migrar leitura de METADADOS e CONTEÚDO para Kit (dedup, arquivo, entidades, hubs)",
    labels: ["enhancement", "P2", "diaria"],
    body: "Fatia de **#463** (camada de leitura Beehiiv → Kit). Eixo **metadados + conteúdo**.",
  });
  const d6185 = issue({
    number: 6185,
    title: "feat(#463): migrar CLIQUES POR LINK para Kit — confirmar campos com clique real",
    labels: ["enhancement", "P1", "diaria", "mensal", "kit-migration"],
    body: "Fatia de **#463** — eixo cliques por link.",
  });
  const d6186 = issue({
    number: 6186,
    title: "feat(#463): migrar STATS AGREGADO para Kit — confirmar semântica de click_rate antes de usar",
    labels: ["enhancement", "P2", "diaria", "kit-migration"],
    body: "Fatia de **#463** — eixo stats agregado.",
  });
  const d6187 = issue({
    number: 6187,
    title: "feat(#463): cache HÍBRIDO permanente — as 259 edições Beehiiv não têm como migrar pro Kit",
    labels: ["enhancement", "P2", "diaria", "kit-migration"],
    body: "Fatia de **#463** — ver a tabela de decomposição por eixo de dado lá.",
  });

  it("#6184 (sem kit-migration) vs #6185/#6186/#6187 (com) → 1 alarme, listando os dois lados", () => {
    const findings = detectSiblingBlockLabelInconsistency([d6184, d6185, d6186, d6187]);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.action, "alarm");
    assert.equal(f.patternId, "sibling-block-label-inconsistency");
    assert.equal(f.parentNumber, 463);
    assert.equal(f.label, "kit-migration");
    assert.deepEqual(f.withLabel.map((s) => s.number).sort((a, b) => a - b), [6185, 6186, 6187]);
    assert.deepEqual(f.withoutLabel.map((s) => s.number), [6184]);
  });

  it("issue CLOSED não entra no agrupamento (estado real: #6187 foi corrigida e fechada)", () => {
    const closedD6187 = { ...d6187, state: "CLOSED" };
    const findings = detectSiblingBlockLabelInconsistency([d6184, d6185, d6186, closedD6187]);
    // Só #6185/#6186 restam abertas com a label, #6184 aberta sem — ainda
    // é inconsistência (2 com, 1 sem), só que sem #6187 no achado.
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].withLabel.map((s) => s.number).sort((a, b) => a - b), [6185, 6186]);
    assert.deepEqual(findings[0].withoutLabel.map((s) => s.number), [6184]);
  });

  it("estado JÁ CORRIGIDO por eixo continua alarmando ENQUANTO a mãe não reconhecer a assimetria", () => {
    // A assimetria de label ENTRE eixos é o estado CORRETO permanente de uma
    // decomposição por eixo — não uma contradição a resolver por edição de
    // label. Por isso o alarme continua achando aqui: sem reconhecimento, a
    // pergunta "essa diferença é intencional?" segue aberta.
    //
    // O caminho de convergência é o marcador na MÃE (teste seguinte), não
    // mexer nas filhas. Sem ele este alarme nunca zeraria — que é o
    // anti-padrão que a #6199 removeu do alarme de on-hold na mesma rodada
    // ("alarme que sempre acha ensina a ser ignorado").
    const fixed6184 = d6184; // nunca teve a label — correto, sem bloqueio real
    const fixed6187 = { ...d6187, labels: ["enhancement", "P2", "diaria"] }; // label removida — correto, sem bloqueio real
    const findings = detectSiblingBlockLabelInconsistency([fixed6184, d6185, d6186, fixed6187]);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].withLabel.map((s) => s.number).sort((a, b) => a - b), [6185, 6186]);
    assert.deepEqual(findings[0].withoutLabel.map((s) => s.number).sort((a, b) => a - b), [6184, 6187]);
  });

  it("marcador `sibling-block-reviewed` no corpo da MÃE silencia — é o que dá convergência", () => {
    const fixed6187 = { ...d6187, labels: ["enhancement", "P2", "diaria"] };
    const mae = issue({
      number: 463,
      title: "épica: camada de leitura",
      labels: ["enhancement", "epic-guarda-chuva"],
      body: "decomposta por eixo\n<!-- sibling-block-reviewed: kit-migration -->",
    });
    const findings = detectSiblingBlockLabelInconsistency([mae, d6184, d6185, d6186, fixed6187]);
    assert.deepEqual(findings, []);
  });

  it("o marcador é POR LABEL: reconhecer kit-migration não silencia external-blocker", () => {
    // Assimetria futura numa label DIFERENTE é informação nova, e silenciar a
    // mãe inteira a esconderia.
    const mae = issue({
      number: 463,
      title: "épica: camada de leitura",
      labels: ["enhancement", "epic-guarda-chuva"],
      body: "<!-- sibling-block-reviewed: kit-migration -->",
    });
    const a = { ...d6184, labels: [...d6184.labels, "external-blocker"] };
    const findings = detectSiblingBlockLabelInconsistency([mae, a, d6185, d6186, d6187]);
    const labels = findings.map((f) => f.label);
    assert.ok(!labels.includes("kit-migration"), "kit-migration devia estar silenciada");
    assert.ok(labels.includes("external-blocker"), "external-blocker é assimetria nova, tem que aparecer");
  });

  it("mãe ausente do conjunto (fechada/fora da janela) não silencia por omissão", () => {
    const fixed6187 = { ...d6187, labels: ["enhancement", "P2", "diaria"] };
    const findings = detectSiblingBlockLabelInconsistency([d6184, d6185, d6186, fixed6187]);
    assert.equal(findings.length, 1, "sem corpo de mãe pra ler, o alarme segue o caminho normal");
  });

  it("unanimidade (todas com, ou todas sem) não é achado", () => {
    const allWith = detectSiblingBlockLabelInconsistency([d6185, d6186, d6187]);
    assert.deepEqual(allWith, []);
    const allWithout = detectSiblingBlockLabelInconsistency([
      d6184,
      { ...d6185, labels: ["enhancement", "P1", "diaria", "mensal"] },
    ]);
    assert.deepEqual(allWithout, []);
  });

  it("mãe com só 1 filha referenciando-a não gera achado (precisa de ≥2 pra 'inconsistência' fazer sentido)", () => {
    assert.deepEqual(detectSiblingBlockLabelInconsistency([d6184]), []);
  });

  it("issues sem referência de mãe (extractParentRef null) nunca entram em nenhum grupo", () => {
    const standalone = issue({ number: 90009, title: "sem mãe", labels: ["kit-migration"], body: "issue independente" });
    assert.deepEqual(detectSiblingBlockLabelInconsistency([standalone]), []);
  });
});

describe("splitFindingsByAction", () => {
  it("separa fixes de alarmes em duas listas, sem misturar", () => {
    const fix = detectMarkerDeferralConflict(
      issue({ number: 1, title: "a", labels: ["not-this-week"], body: "<!-- aguardando-ate: 2026-09-01 -->" }),
      NOW,
    );
    const alarm = detectInheritedBlockLabel(
      issue({ number: 2, title: "b", labels: ["kit-migration"], body: "Fatia de #3" }),
      { number: 3, labels: ["kit-migration"] },
    );
    assert.ok(fix && alarm);
    const { fixes, alarms } = splitFindingsByAction([fix, alarm]);
    assert.equal(fixes.length, 1);
    assert.equal(alarms.length, 1);
    assert.equal(fixes[0].issue, 1);
    assert.equal(alarms[0].issue, 2);
  });
});
