import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, hostname } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveEffort,
  buildReviewInstruction,
  isOvernightRoundActive,
  logEffortDecision,
  REVIEW_AGENT,
  REVIEW_FLEET_MAX,
  DEFAULT_EFFORT,
  EFFORT_DIFF_LINE_THRESHOLD,
  extractCreatedPrUrl,
  isGhPrCreateCommand,
  shouldEmitReviewInstruction,
  resolveEmitDecision,
  logSuppressedReviewInstruction,
} from "../.claude/hooks/pr-create-review.mjs";

// #2754/#3322/#3326: overnight (token-sensitive) sempre resolveu /code-review
// low via branch-prefix (#2754) ou guard de sessão ativa (#3322). #3326
// (260711) estendeu esse `low` pra default GERAL; #4234 (260728) devolveu o
// default pra `max` a pedido do editor ("por enquanto"), preservando intacto o
// desconto de overnight. O que NUNCA mudou nesse vai-e-vem: overnight resolve
// `low`, e estado indeterminado (gh indisponível, PR sem número reconhecível na
// URL, checkRoundActive lançando erro) resolve `max` como fail-safe — os testes
// abaixo travam essas duas pontas via DEFAULT_EFFORT, então uma troca futura da
// constante mexe num teste só.
// Regressão do PR que introduziu a branch-detection original — sem isso, todo
// PR (inclusive overnight/*) voltaria a pagar o custo do review multi-agente
// max por cima do self-review interno da skill.
//
// Todos os testes de resolveEffort injetam `checkRoundActive: () => false`
// explicitamente — sem isso, o default real (isOvernightRoundActive) leria
// `data/overnight/` do disco desta máquina, tornando o teste dependente de
// estado externo (uma rodada overnight genuinamente em progresso na máquina
// que roda a suíte mudaria o resultado).
const noActiveRound = () => false;
const activeRound = () => true;

describe("resolveEffort (#2754)", () => {
  it("branch overnight/* → low, sem warning", () => {
    const execFn = () => "overnight/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.warning, null);
  });

  it("branch overnight/batch-social-1234 → low (prefixo, não match exato)", () => {
    const execFn = () => "overnight/batch-social-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
  });

  // #3326 tinha fixado `low` aqui; #4234 devolveu o default pra `max` a pedido
  // do editor ("por enquanto"). Desde #4813, o caminho "sem sinal de overnight"
  // não vai mais direto pro DEFAULT_EFFORT — resolve por tamanho de diff. Estes
  // dois fixtures usam um `execFn` de UM só argumento (ignora `args`), então a
  // MESMA string de branch também é devolvida pra chamada de
  // `additions,deletions` — não é JSON válido, `getDiffLineCount` cai no catch
  // e retorna `null`, e É ISSO que faz o teste cair no ramo "tamanho
  // desconhecido" (reason "default"), não um diff grande implícito. Deixado
  // explícito via a asserção de `reason` abaixo — sem ela, um bug que fizesse
  // `getDiffLineCount` interpretar a string do branch como diff "grande" por
  // acidente passaria batido aqui.
  it("branch develop/fix-1234, sem rodada ativa, tamanho de diff desconhecido → DEFAULT_EFFORT", () => {
    const execFn = () => "develop/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.warning, null);
    assert.equal(result.reason, "default");
  });

  it("branch sem prefixo especial (manual), sem rodada ativa, tamanho de diff desconhecido → DEFAULT_EFFORT", () => {
    const execFn = () => "fix-something\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.warning, null);
    assert.equal(result.reason, "default");
  });

  // #4234: trava o VALOR da constante. É o único teste que precisa mudar quando
  // o editor reverter a decisão provisória — o resto da suíte se ajusta sozinho.
  it("DEFAULT_EFFORT é `max` (decisão provisória do editor, #4234)", () => {
    assert.equal(DEFAULT_EFFORT, "max");
  });

  // #4234: o risco concreto de mexer no default é levar junto o desconto de
  // overnight (#2754/#3322) — que é o caminho token-sensível e NÃO deve seguir
  // DEFAULT_EFFORT. Com o default em `max` os dois valores diferem, então este
  // teste passa a distinguir de verdade (entre #3326 e #4234 era tautológico).
  it("desconto de overnight sobrevive ao default: branch overnight/* → low ≠ DEFAULT_EFFORT", () => {
    const execFn = () => "overnight/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.notEqual(result.effort, DEFAULT_EFFORT);
  });

  it("gh indisponível/erro → fail-safe max", () => {
    const execFn = () => {
      throw new Error("gh: command not found");
    };
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.warning, null);
  });

  it("URL sem número de PR reconhecível → fail-safe max (nem chama execFn)", () => {
    let called = false;
    const execFn = () => {
      called = true;
      return "overnight/fix-1\n";
    };
    const result = resolveEffort("https://github.com/o/r/not-a-pr-url", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(called, false, "não deveria invocar gh sem número de PR");
  });

  // O discriminador aqui é o `warning`, não o effort: um false-positive no
  // `startsWith` faria o early-return `{effort:"low", warning:null}` disparar
  // ANTES do checkRoundActive, engolindo o warning. Checar o warning pega essa
  // regressão em qualquer DEFAULT_EFFORT — inclusive no período #3326→#4234, em
  // que ambos os caminhos resolviam "low" e o effort sozinho nada distinguia.
  it("branch com substring 'overnight' mas não como prefixo, com rodada ativa → low COM warning (evita false-positive no startsWith)", () => {
    const execFn = () => "feature/overnight-related-refactor\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
    assert.equal(result.effort, "low");
    assert.match(result.warning, /não usa o prefixo overnight\//);
  });

  // #3322: guard determinístico independente de naming — regressão direta do
  // incidente #3321 (rodada 260710: ~50 PRs, zero com prefixo overnight/,
  // gating nunca disparou low a noite inteira).
  describe("guard de sessão ativa (#3322)", () => {
    it("branch sem prefixo overnight/ + rodada ativa → low, COM warning", () => {
      const execFn = () => "fix-3321-branch-naming\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
      assert.equal(result.effort, "low");
      assert.match(result.warning, /não usa o prefixo overnight\//);
      assert.match(result.warning, /#3321/);
    });

    it("branch overnight/* + rodada ativa → low, SEM warning (naming já correto, nada a avisar)", () => {
      const execFn = () => "overnight/fix-1234\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
      assert.equal(result.effort, "low");
      assert.equal(result.warning, null);
    });

    // Sem prefixo overnight/ e sem rodada ativa, não é o guard quem resolve:
    // cai no DEFAULT_EFFORT de resolveEffort, sem passar pelo branch de warning.
    it("branch sem prefixo + SEM rodada ativa → DEFAULT_EFFORT (não é o guard quem resolve)", () => {
      const execFn = () => "fix-something\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
      assert.equal(result.effort, DEFAULT_EFFORT);
      assert.equal(result.warning, null);
    });

    // #3326: max sobrevive só como fail-safe de estado indeterminado — não mais
    // "a mesma direção do default geral" (que agora é low). checkRoundActive
    // lançando erro é capturado pelo catch-all de resolveEffort, que mantém max
    // deliberadamente mesmo com low sendo o default em todo o resto.
    it("checkRoundActive lançando erro → fail-safe max (única sobra do max fora do estado normal)", () => {
      const execFn = () => "fix-something\n";
      const throwingCheck = () => {
        throw new Error("disco indisponível");
      };
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, throwingCheck);
      assert.equal(result.effort, "max");
    });
  });
});

// #4813 (generaliza #4243): effort por tamanho de diff virou o critério
// PRIMÁRIO pra toda PR sem sinal de overnight, não mais um piso barato só pra
// diffs triviais. Limiar original 300 (EFFORT_DIFF_LINE_THRESHOLD), decisão do
// editor registrada em
// https://github.com/vjpixel/diaria-studio/issues/4813#issuecomment-5235991770
// — mediana de 497 linhas / p90 1.375 medidos na própria issue, 34% dos PRs
// recentes abaixo de 300 linhas.
//
// #5420 (260816): limiar subiu de 300 para 500 — a mediana de agosto (497
// linhas) já caía no fleet caro de 5 agentes com o limiar em 300; o editor
// revisitou a decisão com esse dado novo e escolheu a outra opção que o #4813
// já tinha discutido (500). Ver `EFFORT_DIFF_LINE_THRESHOLD` no hook pra
// justificativa completa. Este bloco trava: diff pequeno (< limiar) → low;
// diff grande CONHECIDO (≥ limiar) → max explícito com reason "diff_grande"
// (distinto de "default"); e qualquer falha ao obter o tamanho do diff cai no
// DEFAULT_EFFORT normal (reason "default") — nunca em "pular o review".
//
// `execFn` aqui precisa discriminar por chamada (branch vs. diff stats),
// diferente dos mocks acima (que ignoram os args): resolveEffort agora faz
// duas chamadas de `gh` quando não há sinal de overnight.
describe("resolveEffort — effort por tamanho de diff (#4813, generaliza #4243; limiar 500 desde #5420)", () => {
  function makeExecFn({ branch = "develop/fix-4813\n", diff } = {}) {
    return (_cmd, args) => {
      if (args.includes("additions,deletions")) {
        if (diff === undefined) throw new Error("gh pr view --json additions,deletions failed");
        return diff;
      }
      return branch;
    };
  }

  it("diff pequeno (< limiar) → low, mesmo com DEFAULT_EFFORT configurado como max", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: 1, deletions: 0 }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.notEqual(result.effort, DEFAULT_EFFORT);
    assert.equal(result.warning, null);
    assert.equal(result.reason, "diff_pequeno");
  });

  // Regressão de comportamento mais importante do #4813 (e ainda válida pós
  // #5420, com o limiar em 500): uma faixa média de linhas, que ANTES do
  // #4813 caía direto no DEFAULT_EFFORT/fleet de 5 agentes (só o piso <50 do
  // #4243 rebaixava pra low), resolve `low` — prova que o alargamento do
  // limiar de fato mudou o comportamento da faixa média, não só preservou o
  // antigo piso.
  it("diff de 190 linhas (faixa média, bem acima do antigo piso de 50 e abaixo do limiar atual) → low", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: 150, deletions: 40 }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "diff_pequeno");
  });

  it("diff de exatamente 1 linha abaixo do limiar → low, reason diff_pequeno", () => {
    const execFn = makeExecFn({
      diff: JSON.stringify({ additions: EFFORT_DIFF_LINE_THRESHOLD - 1, deletions: 0 }),
    });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "diff_pequeno");
  });

  it("diff exatamente no limiar (500 linhas, #5420) → NÃO é pequeno (limiar é exclusivo), resolve max/DEFAULT_EFFORT explícito por tamanho", () => {
    const execFn = makeExecFn({
      diff: JSON.stringify({ additions: EFFORT_DIFF_LINE_THRESHOLD, deletions: 0 }),
    });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.reason, "diff_grande");
  });

  // #5420: os dois lados concretos do limiar de 500 pedidos na decisão do
  // editor — 400 linhas (abaixo) e 600 linhas (acima) — travados com números
  // literais (não relativos à constante), pra uma futura troca da constante
  // não conseguir mascarar uma regressão na REGRA (o teste acima, relativo a
  // `EFFORT_DIFF_LINE_THRESHOLD`, já cobre "no limiar" e "1 abaixo do limiar"
  // pra qualquer valor da constante; estes dois cobrem os valores que a
  // própria issue usou como exemplo).
  it("diff de 400 linhas (#5420, abaixo do limiar de 500) → low", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: 250, deletions: 150 }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "diff_pequeno");
  });

  it("diff de 600 linhas (#5420, acima do limiar de 500) → max", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: 400, deletions: 200 }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.reason, "diff_grande");
  });

  it("diff grande com tamanho conhecido (1000 linhas) → max, reason diff_grande (distinto de default)", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: 700, deletions: 300 }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.warning, null);
    assert.equal(result.reason, "diff_grande");
    assert.notEqual(result.reason, "default");
  });

  it("falha ao obter o tamanho do diff (gh lança erro) → resolve o DEFAULT_EFFORT, reason default, nunca 'skip'", () => {
    const execFn = makeExecFn({}); // diff undefined → a chamada de stats lança
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.reason, "default");
  });

  it("falha ao obter o tamanho do diff (JSON malformado) → resolve o DEFAULT_EFFORT, reason default, nunca 'skip'", () => {
    const execFn = (_cmd, args) => (args.includes("additions,deletions") ? "not valid json" : "develop/fix-4813\n");
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.reason, "default");
  });

  it("campos additions/deletions não-numéricos → tratado como falha, resolve o DEFAULT_EFFORT, reason default", () => {
    const execFn = makeExecFn({ diff: JSON.stringify({ additions: "n/a", deletions: null }) });
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.reason, "default");
  });

  it("branch overnight/* já resolve low sem sequer checar o tamanho do diff", () => {
    let diffChecked = false;
    const execFn = (_cmd, args) => {
      if (args.includes("additions,deletions")) {
        diffChecked = true;
        return JSON.stringify({ additions: 500, deletions: 500 });
      }
      return "overnight/fix-1234\n";
    };
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(diffChecked, false, "não deveria checar o diff quando o branch overnight/* já resolveu low");
  });
});

// #5156: resolveEffort repassa `sessionId` pro `checkRoundActive` injetado —
// garante que o dado chega até o guard de sessão ativa, mesmo com o wrapper
// default reordenando os parâmetros pra não corromper repoRoot/machineTag/now
// de isOvernightRoundActive (ver comentário no próprio resolveEffort).
describe("resolveEffort — repassa sessionId pro checkRoundActive (#5156)", () => {
  it("checkRoundActive injetado recebe o sessionId passado a resolveEffort", () => {
    const execFn = () => "fix-something\n";
    let receivedSessionId;
    const checkRoundActive = (sid) => {
      receivedSessionId = sid;
      return true;
    };
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, checkRoundActive, "sessao-xyz");
    assert.equal(receivedSessionId, "sessao-xyz");
    assert.equal(result.effort, "low");
  });

  it("sessionId omitido → checkRoundActive recebe undefined (não quebra mocks que ignoram o argumento)", () => {
    const execFn = () => "fix-something\n";
    let receivedSessionId = "not-called";
    const checkRoundActive = (sid) => {
      receivedSessionId = sid;
      return false;
    };
    resolveEffort("https://github.com/o/r/pull/1", execFn, checkRoundActive);
    assert.equal(receivedSessionId, undefined);
  });
});

describe("buildReviewInstruction (#2754)", () => {
  // O texto de `low` já alegou coisas que o default vigente desmentia, nas duas
  // direções. Sob #3326 (low = default geral) ele não podia falar em overnight,
  // porque low valia pra PR manual também. Sob #4234 (max = default) é o
  // inverso: `low` só é alcançável pelo desconto de overnight (#2754/#3322), e
  // chamá-lo de "#3326 default" mentia pro próprio agente que recebe a string —
  // além de mandar "peça max explicitamente" quando max JÁ é o default.
  // Achado do comment-analyzer na PR #4242.
  it("effort=low atribui o low ao desconto de overnight, sem alegar ser o default", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.match(msg, /LOW effort/);
    assert.match(msg, /overnight token-discount/);
    assert.doesNotMatch(msg, /#3326 default/);
  });

  // #4034: `/code-review` deixou de ser invocável via Skill tool (gate de
  // plataforma) — a instrução passou a pedir dispatch via Agent tool, nunca
  // mais `/code-review {effort} --comment` (que o Skill tool rejeitaria).
  it("instrui dispatch via Agent tool, não mais via Skill /code-review (#4034)", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.doesNotMatch(msg, /\/code-review low --comment/);
    assert.match(msg, /dispatch an Agent/i);
    assert.match(msg, /general-purpose/);
    assert.match(msg, /model:sonnet/);
  });

  it("effort=max menciona ULTRACODE / maximum effort", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "max");
    assert.doesNotMatch(msg, /\/code-review max --comment/);
    assert.match(msg, /ULTRACODE/);
    assert.match(msg, /MAXIMUM effort/);
  });

  it("nunca sugere cloud ultra, em nenhum effort", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction("https://github.com/o/r/pull/1", effort);
      assert.match(msg, /Do NOT use cloud `ultra`/);
    }
  });

  // #5304: o desconto do `low` é UM agente em vez do fleet, nunca um relatório
  // mais raso. A frase antiga ("report only a few high-confidence findings",
  // herdada do #3326) é um filtro de severidade que Sonnet 5 / Opus 5 obedecem
  // LITERALMENTE — o agente acha os mesmos bugs e deixa de reportar os que
  // julga abaixo da barra, derrubando o recall MEDIDO. Virou risco real quando
  // o #5251 fez "sem findings de alta confiança" ser a condição de auto-merge
  // e o #4813 (limiar 300 originalmente, 500 desde #5420) fez o `low` pegar
  // todo diff abaixo do limiar. Este teste existe pra frase não voltar por
  // descuido.
  it("effort=low NÃO filtra por severidade nem confiança (#5304)", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.doesNotMatch(msg, /only a few high-confidence findings/);
    assert.doesNotMatch(msg, /report only/i);
    assert.match(msg, /report every finding/i);
    assert.match(msg, /do not filter for importance or confidence/i);
    // o desconto continua existindo — só mudou de eixo
    assert.match(msg, /ONE agent instead of the fleet/i);
  });

  it("todo effort exige tag de confiança e severidade por finding (#5304)", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction("https://github.com/o/r/pull/1", effort);
      assert.match(msg, /confidence \(alta\/média\/baixa\)/);
      assert.match(msg, /severity \(P0\.\.P3\)/);
      // o ranqueamento é do consumidor (gate do #5251), não do agente
      assert.match(msg, /SEPARATE downstream step/);
    }
  });

  // #3322
  it("warning ausente (default) → nenhuma nota extra no texto", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.doesNotMatch(msg, /\[aviso:/);
  });

  it("warning presente → aparece anexado ao final da instrução", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low", "branch divergente do padrão");
    assert.match(msg, /\[aviso: branch divergente do padrão\]$/);
  });
});

// #4234: o dispatch passou a usar os agentes do plugin pr-review-toolkit
// (opção (b) do plano do #4034, verificada em 260728). O nome é PREFIXADO pelo
// plugin — `code-reviewer` puro, como o plano do #4034 supunha, resolve
// `Agent type not found`. Estes testes travam justamente o que uma regressão
// silenciosa quebraria: o prefixo, o fallback e a distinção low/max.
describe("buildReviewInstruction — agentes do pr-review-toolkit (#4234)", () => {
  const PR = "https://github.com/o/r/pull/1";

  it("nome do agente é prefixado pelo plugin, nunca `code-reviewer` solto", () => {
    assert.equal(REVIEW_AGENT, "pr-review-toolkit:code-reviewer");
    const msg = buildReviewInstruction(PR, "low");
    assert.match(msg, /pr-review-toolkit:code-reviewer/);
    // sem prefixo em nenhum lugar: `(?<!pr-review-toolkit:)code-reviewer`
    assert.doesNotMatch(msg, /(?<!pr-review-toolkit:)code-reviewer/);
  });

  it("effort=low dispatcha UM agente — nenhum membro do fleet max aparece", () => {
    const msg = buildReviewInstruction(PR, "low");
    assert.match(msg, /ONE Agent/);
    for (const agent of REVIEW_FLEET_MAX) {
      assert.ok(!msg.includes(agent), `low não deveria citar ${agent}`);
    }
  });

  it("effort=max dispatcha o fleet completo em paralelo", () => {
    const msg = buildReviewInstruction(PR, "max");
    assert.match(msg, /IN PARALLEL/);
    assert.match(msg, /pr-review-toolkit:code-reviewer/);
    for (const agent of REVIEW_FLEET_MAX) {
      assert.ok(msg.includes(agent), `max deveria citar ${agent}`);
    }
  });

  // O plugin vem do marketplace por máquina: sessão cloud / clone fresco não o
  // tem, mesmo com `enabledPlugins` versionado. Sem esta instrução o hook
  // deixaria a PR sem review nenhum, em silêncio — a regressão exata que o
  // #4034 documentou como "degradação de qualidade invisível".
  it("todo effort carrega o fallback pro general-purpose com rubrico inline", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction(PR, effort);
      assert.match(msg, /Agent type \.\.\. not found/);
      assert.match(msg, /general-purpose/);
      assert.match(msg, /correctness, simplification\/efficiency, test-coverage, security/);
    }
  });

  // Achado do review da própria PR #4238: o fallback precisa preservar a
  // PROFUNDIDADE, não só existir. Sem isso um `max` degradado (plugin ausente —
  // justamente sessão cloud / clone fresco) produzia instrução idêntica à de
  // `low`: review raso sob o effort mais caro, em silêncio.
  it("fallback preserva a profundidade do effort — max carrega instrução extra que low não tem", () => {
    const low = buildReviewInstruction(PR, "low");
    const max = buildReviewInstruction(PR, "max");
    assert.match(max, /Keep MAXIMUM depth in that degraded path too/);
    assert.doesNotMatch(low, /Keep MAXIMUM depth/);
    assert.match(max, /read every changed file, not just the diff hunks/);
  });

  // O agente do plugin tem toolset completo e revisa `git diff` unstaged por
  // default — duas armadilhas: revisar o diff errado, e churnar um checkout
  // compartilhado com o coordenador (incidentes 260703/260708).
  it("todo effort exige escopo de diff explícito e agente read-only", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction(PR, effort);
      assert.match(msg, /UNSTAGED changes, which are not this PR/);
      assert.match(msg, /READ-ONLY/);
      assert.match(msg, /no `git checkout`/);
    }
  });
});

// #3322: isOvernightRoundActive lida com o disco de verdade (via repoRoot/machineTag/now
// injetados), não com o hook em si. O marker é um arquivo dedicado por máquina
// (`data/overnight/.active-session-{tag}.json`) — não `plan.json` — então cada teste só
// precisa escrever esse único arquivo, sem se preocupar com "qual dir é mais recente"
// (a limitação que motivou uma raiz tmpdir isolada por caso na revisão anterior deste
// teste não existe mais aqui, mas mantemos raízes isoladas por clareza/hermeticidade).
describe("isOvernightRoundActive (#3322)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(tmpdir(), `pr-create-review-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }

  function writeMarker(root, tag, marker) {
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `.active-session-${tag}.json`), JSON.stringify(marker), "utf8");
  }

  const NOW = Date.parse("2026-07-11T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("sem marker no disco → false", () => {
    assert.equal(isOvernightRoundActive(freshRoot(), "host-a", NOW), false);
  });

  it("marker fresco (started_at recente) → true", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), true);
  });

  it("marker de OUTRA máquina (tag diferente no filename) → false, mesmo fresco", () => {
    const root = freshRoot();
    writeMarker(root, "host-b", { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  it("marker mais velho que MAX_SESSION_AGE_MS (24h) → false (round abandonado não fica ativo pra sempre)", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - 25 * ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  // Achado da verificação adversarial pós-redesign: sem o guard `ageMs >= 0`, um
  // started_at no FUTURO (clock skew, marker corrompido/editado à mão) produz idade
  // negativa, que passa trivialmente em `<= MAX_SESSION_AGE_MS` — invertendo a
  // direção de fail-safe (deveria cair em "não confirmado como ativo", não fingir
  // certeza sobre um marker corrompido — #3326: essa direção nunca foi sobre
  // low/max diretamente, é sobre não afirmar "rodada ativa" com dado duvidoso;
  // o efeito em max/low mudou desde #3326, mas essa direção da função não).
  it("marker com started_at no FUTURO → false (clock skew/corrupção não pode virar 'ativo')", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW + 10 * ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);

    const rootFarFuture = freshRoot();
    writeMarker(rootFarFuture, "host-a", { started_at: new Date(NOW + 1000 * 24 * ONE_HOUR_MS).toISOString() }); // ~1000 dias no futuro
    assert.equal(isOvernightRoundActive(rootFarFuture, "host-a", NOW), false);
  });

  it("marker no limite (23h59) ainda conta como fresco; 24h01 já não conta", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - (24 * ONE_HOUR_MS - 60_000)).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), true);

    const root2 = freshRoot();
    writeMarker(root2, "host-a", { started_at: new Date(NOW - (24 * ONE_HOUR_MS + 60_000)).toISOString() });
    assert.equal(isOvernightRoundActive(root2, "host-a", NOW), false);
  });

  it("started_at ausente/malformado → false (nunca finge que está ativo por dado corrompido)", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: "not-a-real-date" });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);

    const root2 = freshRoot();
    writeMarker(root2, "host-a", {});
    assert.equal(isOvernightRoundActive(root2, "host-a", NOW), false);
  });

  it("JSON malformado no marker → fail-safe false", () => {
    const root = freshRoot();
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".active-session-host-a.json"), "{not valid json", "utf8");
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  // Regressão direta do bug encontrado na revisão do PR: a versão anterior desta função
  // resolvia a raiz do repo a partir de `import.meta.url` (localização do PRÓPRIO arquivo
  // do hook), que aponta pro WORKTREE quando o hook roda de dentro de um worktree
  // linkado (exatamente o contexto de todo subagente implementador do overnight,
  // `isolation: "worktree"`) — e o worktree não tem a junction `data/`. A cobertura
  // dessa regressão específica (via `git rev-parse --git-common-dir` real, dentro de um
  // worktree real) está fora do escopo de um teste unitário puro (exige um worktree git
  // de verdade) — foi verificada manualmente durante a revisão deste PR. Este teste cobre
  // só a metade testável em unidade: `repoRoot` é sempre um parâmetro explícito, nunca
  // hardcoded, então o caller (produção: `resolveMainRepoRoot()`) é livre de resolver
  // corretamente sem exigir mudança nesta função.
  it("repoRoot é sempre parâmetro explícito — não há caminho hardcoded pro checkout principal", () => {
    const root = freshRoot();
    writeMarker(root, "any-tag", { started_at: new Date(NOW).toISOString() });
    assert.equal(isOvernightRoundActive(root, "any-tag", NOW), true);
    assert.equal(isOvernightRoundActive(freshRoot(), "any-tag", NOW), false);
  });

  // #5156: marker session-aware — mesma garantia de retrocompat e o caso
  // explícito pedido pela issue ("overnight autônomo ativo + PR de OUTRA
  // sessão → não deve resolver o desconto low").
  describe("session-aware (#5156)", () => {
    it("marker SEM session_id (formato antigo) → true independente de callerSessionId (retrocompat)", () => {
      const root = freshRoot();
      writeMarker(root, "host-a", { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() });
      assert.equal(isOvernightRoundActive(root, "host-a", NOW, "sessao-develop-xyz"), true);
      assert.equal(isOvernightRoundActive(root, "host-a", NOW, undefined), true);
    });

    it("marker COM session_id + callerSessionId da MESMA sessão → true", () => {
      const root = freshRoot();
      writeMarker(root, "host-a", {
        started_at: new Date(NOW - ONE_HOUR_MS).toISOString(),
        session_id: "sessao-overnight-abc",
      });
      assert.equal(isOvernightRoundActive(root, "host-a", NOW, "sessao-overnight-abc"), true);
    });

    it("marker COM session_id + callerSessionId de OUTRA sessão (develop em paralelo) → false", () => {
      const root = freshRoot();
      writeMarker(root, "host-a", {
        started_at: new Date(NOW - ONE_HOUR_MS).toISOString(),
        session_id: "sessao-overnight-abc",
      });
      assert.equal(isOvernightRoundActive(root, "host-a", NOW, "sessao-develop-xyz"), false);
    });

    it("marker COM session_id + callerSessionId ausente → false, nunca finge identidade", () => {
      const root = freshRoot();
      writeMarker(root, "host-a", {
        started_at: new Date(NOW - ONE_HOUR_MS).toISOString(),
        session_id: "sessao-overnight-abc",
      });
      assert.equal(isOvernightRoundActive(root, "host-a", NOW, undefined), false);
    });
  });
});

// #4252: a issue pede um dado de custo de 1-2 rodadas completas com
// DEFAULT_EFFORT=max antes de decidir se reverte pra `low` — mas descobriu, ao
// ser escrita, que nada hoje registra qual effort foi resolvido por PR nem
// quantos agentes rodaram (`resolveEffort` decide, o hook emite a instrução,
// nenhum dos dois loga). Este bloco cobre a instrumentação (opção 2 da issue):
// `reason` em `resolveEffort` identifica QUAL ramo decidiu, e `logEffortDecision`
// grava isso em `data/run-log.jsonl` no mesmo formato de `scripts/log-event.ts`.
// Não decide o valor de DEFAULT_EFFORT nem fecha a #4252 — só fecha a lacuna de
// instrumentação que ela descreve.
describe("resolveEffort — campo `reason` (#4252)", () => {
  it("branch overnight/* → low, reason branch_overnight", () => {
    const execFn = () => "overnight/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "branch_overnight");
  });

  it("sessão overnight ativa (sem prefixo na branch) → low, reason sessao_overnight_ativa", () => {
    const execFn = () => "fix-3321-branch-naming\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "sessao_overnight_ativa");
  });

  it("diff pequeno (< limiar) → low, reason diff_pequeno", () => {
    const execFn = (_cmd, args) =>
      args.includes("additions,deletions")
        ? JSON.stringify({ additions: 1, deletions: 0 })
        : "develop/fix-4813\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.reason, "diff_pequeno");
  });

  it("branch normal, sem rodada ativa, diff grande CONHECIDO (≥ limiar) → max, reason diff_grande", () => {
    const execFn = (_cmd, args) =>
      args.includes("additions,deletions")
        ? JSON.stringify({ additions: 700, deletions: 300 })
        : "develop/fix-4813\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, DEFAULT_EFFORT);
    assert.equal(result.effort, "max");
    assert.equal(result.reason, "diff_grande");
  });

  it("URL sem número de PR → max, reason pr_sem_numero", () => {
    const execFn = () => "overnight/fix-1\n";
    const result = resolveEffort("https://github.com/o/r/not-a-pr-url", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.reason, "pr_sem_numero");
  });

  it("estado indeterminado (gh lança erro) → max, reason estado_indeterminado", () => {
    const execFn = () => {
      throw new Error("gh: command not found");
    };
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.reason, "estado_indeterminado");
  });
});

describe("logEffortDecision (#4252)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `pr-create-review-hook-effort-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  function readLoggedEvents(root) {
    const logPath = join(root, "data", "run-log.jsonl");
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("grava um evento no formato de scripts/log-event.ts (timestamp, edition, stage, agent, level, message, details)", () => {
    const root = freshRoot();
    logEffortDecision(
      { prUrl: "https://github.com/o/r/pull/42", effort: "low", reason: "branch_overnight" },
      { repoRoot: root },
    );
    const [event] = readLoggedEvents(root);
    assert.equal(typeof event.timestamp, "string");
    assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
    assert.equal(event.edition, null);
    assert.equal(event.stage, null);
    assert.equal(event.agent, "code-review");
    assert.equal(event.level, "info");
    assert.equal(event.message, "effort_resolved");
    assert.deepEqual(event.details, { pr: "42", effort: "low", motivo: "branch_overnight", agentes: 1 });
  });

  it("effort=max conta 5 agentes (REVIEW_AGENT + REVIEW_FLEET_MAX)", () => {
    const root = freshRoot();
    logEffortDecision(
      { prUrl: "https://github.com/o/r/pull/7", effort: "max", reason: "default" },
      { repoRoot: root },
    );
    const [event] = readLoggedEvents(root);
    assert.equal(event.details.agentes, REVIEW_FLEET_MAX.length + 1);
    assert.equal(event.details.agentes, 5);
  });

  it("URL sem número de PR reconhecível → details.pr é null, não lança", () => {
    const root = freshRoot();
    assert.doesNotThrow(() =>
      logEffortDecision(
        { prUrl: "https://github.com/o/r/not-a-pr-url", effort: "max", reason: "pr_sem_numero" },
        { repoRoot: root },
      ),
    );
    const [event] = readLoggedEvents(root);
    assert.equal(event.details.pr, null);
  });

  it("é append-only — duas chamadas escrevem duas linhas, sem sobrescrever a anterior", () => {
    const root = freshRoot();
    logEffortDecision({ prUrl: "https://github.com/o/r/pull/1", effort: "low", reason: "diff_pequeno" }, { repoRoot: root });
    logEffortDecision({ prUrl: "https://github.com/o/r/pull/2", effort: "max", reason: "default" }, { repoRoot: root });
    const events = readLoggedEvents(root);
    assert.equal(events.length, 2);
    assert.equal(events[0].details.pr, "1");
    assert.equal(events[1].details.pr, "2");
  });

  it("cria data/ se ainda não existir (worktree/tmpdir sem a pasta)", () => {
    const root = freshRoot(); // freshRoot() nunca cria o diretório — só reserva o path
    assert.doesNotThrow(() =>
      logEffortDecision({ prUrl: "https://github.com/o/r/pull/1", effort: "low", reason: "branch_overnight" }, { repoRoot: root }),
    );
    assert.equal(readLoggedEvents(root).length, 1);
  });

  // Fail-soft (mesmo contrato do resto do hook): uma falha ao logar (ex: disco
  // cheio, permissão negada) nunca pode lançar nem bloquear a criação da PR ou
  // a instrução de review — só o logging é perdido.
  it("appendFn lançando erro é engolido — nunca propaga", () => {
    const throwingAppend = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    assert.doesNotThrow(() =>
      logEffortDecision(
        { prUrl: "https://github.com/o/r/pull/1", effort: "low", reason: "branch_overnight" },
        { repoRoot: freshRoot(), appendFn: throwingAppend },
      ),
    );
  });

  it("mkdirFn lançando erro é engolido — nunca propaga", () => {
    const throwingMkdir = () => {
      throw new Error("EACCES: permission denied");
    };
    assert.doesNotThrow(() =>
      logEffortDecision(
        { prUrl: "https://github.com/o/r/pull/1", effort: "low", reason: "branch_overnight" },
        { repoRoot: freshRoot(), mkdirFn: throwingMkdir },
      ),
    );
  });
});

// Cenários fim-a-fim pedidos pela unidade #4252: resolveEffort → logEffortDecision,
// para os 4 casos citados no dispatch (branch overnight/* → low; diff trivial → low;
// branch normal com diff grande → max; estado indeterminado → max). Simula o que o
// entrypoint CLI do hook faz na prática (ver o handler `process.stdin.on("end", ...)`
// no final de pr-create-review.mjs), sem tocar disco real fora do tmpdir injetado.
describe("resolveEffort + logEffortDecision — cenários fim-a-fim (#4252)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `pr-create-review-hook-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  function readLoggedEvent(root) {
    const logPath = join(root, "data", "run-log.jsonl");
    return JSON.parse(readFileSync(logPath, "utf8").trim().split("\n")[0]);
  }

  function runAndLog(prUrl, execFn, checkRoundActive, root) {
    const { effort, reason } = resolveEffort(prUrl, execFn, checkRoundActive);
    logEffortDecision({ prUrl, effort, reason }, { repoRoot: root });
    return effort;
  }

  it("branch overnight/* → low, evento loga effort=low motivo=branch_overnight agentes=1", () => {
    const root = freshRoot();
    const execFn = () => "overnight/fix-4252\n";
    const effort = runAndLog("https://github.com/o/r/pull/100", execFn, noActiveRound, root);
    assert.equal(effort, "low");
    const event = readLoggedEvent(root);
    assert.deepEqual(event.details, { pr: "100", effort: "low", motivo: "branch_overnight", agentes: 1 });
  });

  it("diff pequeno (< limiar, #4813/#5420) → low, evento loga motivo=diff_pequeno agentes=1", () => {
    const root = freshRoot();
    const execFn = (_cmd, args) =>
      args.includes("additions,deletions")
        ? JSON.stringify({ additions: 10, deletions: 5 })
        : "develop/fix-4252\n";
    const effort = runAndLog("https://github.com/o/r/pull/101", execFn, noActiveRound, root);
    assert.equal(effort, "low");
    const event = readLoggedEvent(root);
    assert.deepEqual(event.details, { pr: "101", effort: "low", motivo: "diff_pequeno", agentes: 1 });
  });

  it("branch normal com diff grande CONHECIDO (≥ limiar, #4813/#5420), sem rodada ativa → max, evento loga motivo=diff_grande agentes=5", () => {
    const root = freshRoot();
    const execFn = (_cmd, args) =>
      args.includes("additions,deletions")
        ? JSON.stringify({ additions: 700, deletions: 300 })
        : "fix-something-manual\n";
    const effort = runAndLog("https://github.com/o/r/pull/102", execFn, noActiveRound, root);
    assert.equal(effort, "max");
    const event = readLoggedEvent(root);
    assert.deepEqual(event.details, { pr: "102", effort: "max", motivo: "diff_grande", agentes: 5 });
  });

  it("estado indeterminado (gh indisponível) → max, evento loga motivo=estado_indeterminado agentes=5", () => {
    const root = freshRoot();
    const execFn = () => {
      throw new Error("gh: command not found");
    };
    const effort = runAndLog("https://github.com/o/r/pull/103", execFn, noActiveRound, root);
    assert.equal(effort, "max");
    const event = readLoggedEvent(root);
    assert.deepEqual(event.details, { pr: "103", effort: "max", motivo: "estado_indeterminado", agentes: 5 });
  });
});

// #5161 fleet review item 11 (pr-test-analyzer, opcional/P2): o wrapper
// DEFAULT de `checkRoundActive` (`(sid) => isOvernightRoundActive(undefined,
// undefined, undefined, sid)`) nunca é exercitado de ponta a ponta em nenhum
// teste existente — todos os ~20 call sites acima injetam um mock explícito
// (`noActiveRound`/`activeRound`/similar). O default real resolve
// `repoRoot`/`machineTag`/`now` via `resolveMainRepoRoot()` (git real),
// `localMachineTag()` (hostname real) e `Date.now()` — sem cobertura, um bug
// na FIAÇÃO desses 3 defaults (não na lógica pura de `isOvernightRoundActive`,
// já coberta acima) passaria despercebido.
//
// Escrever o marker no PATH REAL do repo principal (`data/overnight/`) seria
// perigoso aqui: esta é uma junction OneDrive compartilhada entre TODOS os
// worktrees e sessões desta máquina — sujar `.active-session-{hostname real}.json`
// contaminaria coordenação de produção de uma rodada overnight/develop
// genuinamente em andamento. Em vez disso, isolamos via `process.chdir()`
// pra dentro de um repo git TEMPORÁRIO — `resolveMainRepoRoot()` (chamada sem
// argumentos pelo default de `isOvernightRoundActive`) resolve `git
// rev-parse --git-common-dir` relativo a `process.cwd()`, então isto redireciona
// a resolução inteira pro tmpdir isolado, sem tocar nada real. `hostname()`
// sozinho já é o mesmo valor real que `localMachineTag()` usaria — só
// replicamos a sanitização (idêntica, função tão pequena que os hooks
// self-contained já a duplicam entre si por design, ver docblocks deles).
describe("resolveEffort — checkRoundActive DEFAULT real, fim-a-fim (#5161 item 11)", () => {
  function sanitizedHostname() {
    try {
      return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    } catch {
      return "unknown";
    }
  }

  function withIsolatedGitCwd(run) {
    const tmpRoot = mkdtempSync(join(tmpdir(), "pr-create-review-default-checkround-"));
    const originalCwd = process.cwd();
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: tmpRoot, timeout: 10_000 });
      process.chdir(tmpRoot);
      return run(tmpRoot);
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it("marker fresco (formato antigo, sem session_id) escrito em disco real → resolveEffort(prUrl, execFn) SÓ com 2 args reflete o marker (low)", () => {
    withIsolatedGitCwd((tmpRoot) => {
      const tag = sanitizedHostname();
      const markerDir = join(tmpRoot, "data", "overnight");
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(
        join(markerDir, `.active-session-${tag}.json`),
        JSON.stringify({ started_at: new Date().toISOString() }),
        "utf8",
      );

      const execFn = (_cmd, args) => {
        if (args[0] === "pr" && args[1] === "view" && args.includes("headRefName")) return "fix-manual\n";
        throw new Error(`execFn inesperado neste teste: ${args.join(" ")}`);
      };

      // Só 2 args — exercita o default de checkRoundActive de verdade, não um mock.
      const result = resolveEffort("https://github.com/o/r/pull/999", execFn);
      assert.equal(result.effort, "low");
      assert.equal(result.reason, "sessao_overnight_ativa");
    });
  });

  it("nenhum marker em disco → resolveEffort(prUrl, execFn) SÓ com 2 args não confunde 'ausente' com 'ativo'", () => {
    withIsolatedGitCwd(() => {
      const execFn = (_cmd, args) => {
        if (args[0] === "pr" && args[1] === "view" && args.includes("headRefName")) return "fix-manual\n";
        if (args[0] === "pr" && args[1] === "view" && args.includes("additions,deletions")) {
          return JSON.stringify({ additions: 700, deletions: 300 }); // diff grande, evita cair em diff_pequeno
        }
        throw new Error(`execFn inesperado neste teste: ${args.join(" ")}`);
      };
      const result = resolveEffort("https://github.com/o/r/pull/998", execFn);
      assert.equal(result.effort, "max");
      assert.equal(result.reason, "diff_grande");
    });
  });
});

// #6298: o hook disparou o fleet completo de review para um `gh pr comment`
// isolado — a saída dele (`.../pull/6282#issuecomment-5427611867`) casava o
// regex antigo, que só olhava até o número da PR e ignorava o fragmento
// depois. Estes testes travam os dois fixes: (1) `extractCreatedPrUrl`
// rejeita URL de comentário/review pelo sufixo de fragmento; (2)
// `isGhPrCreateCommand` reconfere que o comando é de fato `gh pr create`,
// espelhando `isGhPrMergeCommand` do hook irmão `block-gh-pr-merge-subagent.mjs`.
describe("extractCreatedPrUrl (#6298 fix 1)", () => {
  it("URL limpa de PR recém-criada → extrai normalmente", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    assert.equal(extractCreatedPrUrl(resp), "https://github.com/vjpixel/diaria-studio/pull/6282");
  });

  it("URL de gh pr comment (#issuecomment-N) → null, nunca extrai (regressão direta do #6298)", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#issuecomment-5427611867";
    assert.equal(extractCreatedPrUrl(resp), null);
  });

  it("URL de comentário inline de review (#discussion_r<id>) → null", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#discussion_r1234567890";
    assert.equal(extractCreatedPrUrl(resp), null);
  });

  it("URL de review (#pullrequestreview-<id>) → null", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#pullrequestreview-9876543210";
    assert.equal(extractCreatedPrUrl(resp), null);
  });

  it("não produz match truncado (ex: .../pull/628) quando o número completo tem sufixo de comentário", () => {
    const resp = "criei em https://github.com/o/r/pull/6282#issuecomment-1 — revisar depois";
    assert.equal(extractCreatedPrUrl(resp), null);
  });

  it("tool_response não-string (objeto serializado) → null sem lançar", () => {
    assert.equal(extractCreatedPrUrl(undefined), null);
    assert.equal(extractCreatedPrUrl(null), null);
  });

  it("saída sem nenhuma URL de PR (ex: --help) → null", () => {
    assert.equal(extractCreatedPrUrl("Usage: gh pr create [flags]"), null);
  });
});

describe("isGhPrCreateCommand (#6298 fix 2; contrato de 3 estados desde o fleet review pós-#6298, finding #1)", () => {
  it('comando standalone gh pr create → "create"', () => {
    assert.equal(isGhPrCreateCommand("gh pr create --title x --body y"), "create");
  });

  it('gh pr create depois de separador (&&) → "create"', () => {
    assert.equal(isGhPrCreateCommand("git push && gh pr create --title x"), "create");
  });

  it('gh pr comment → "not-create" (o comando real do incidente #6298)', () => {
    assert.equal(isGhPrCreateCommand("gh pr comment 6282 --body-file /tmp/body.md"), "not-create");
  });

  it('gh pr create citado dentro de --body de OUTRO comando → "not-create"', () => {
    const cmd = `gh pr comment 6282 --body "rode gh pr create depois disso"`;
    assert.equal(isGhPrCreateCommand(cmd), "not-create");
  });

  it('gh pr create citado dentro de --body com newline LITERAL dentro das aspas → "not-create" (#5805-style)', () => {
    // Mesmo caso que a docstring de isGhPrMergeCommand descreve: um --body com
    // newline literal DENTRO das aspas duplas — stripQuotedSpans varre char a
    // char (não linha a linha), então o span aberto pelo `"` só fecha no `"`
    // seguinte, mesmo atravessando quebras de linha.
    const cmd = 'gh pr comment 6282 --body "medi X e Y\ngh pr create nao deveria disparar aqui\nfim"';
    assert.equal(isGhPrCreateCommand(cmd), "not-create");
  });

  // Finding #1 do fleet review pós-#6298 (confiança alta, P2): antes desta
  // mudança, `command` ausente resolvia o MESMO `false` que um comando
  // reconhecido como NÃO sendo `gh pr create` — colapsando "sei que não é"
  // com "não sei". Este teste é a regressão direta: os dois casos agora
  // resolvem estados DIFERENTES, e nenhum dos dois é o boolean antigo.
  it('command não-string → "unknown", distinto de "not-create" (finding #1: ausência ≠ negação)', () => {
    assert.equal(isGhPrCreateCommand(undefined), "unknown");
    assert.equal(isGhPrCreateCommand(null), "unknown");
    assert.notEqual(isGhPrCreateCommand(undefined), isGhPrCreateCommand("gh pr comment 1"));
  });
});

describe("shouldEmitReviewInstruction (#6298 — combina os dois fixes)", () => {
  it("(a) URL de comentário → null, nenhuma instrução, mesmo com comando ausente", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#issuecomment-5427611867";
    assert.equal(shouldEmitReviewInstruction(resp, undefined), null);
  });

  it("(b) URL de PR limpa + comando gh pr create → instrução emitida (URL retornada) como hoje", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    const prUrl = shouldEmitReviewInstruction(resp, "gh pr create --title x --body y");
    assert.equal(prUrl, "https://github.com/vjpixel/diaria-studio/pull/6282");
  });

  it("(c) gh pr create citado dentro de --body de outro comando → não dispara, mesmo com URL de PR limpa no tool_response", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    const cmd = `gh pr comment 6282 --body "gh pr create nao deveria disparar aqui"`;
    assert.equal(shouldEmitReviewInstruction(resp, cmd), null);
  });

  it("(d) payload sem command (undefined) → dispara (fail-safe permissivo, decide só pela URL)", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    assert.equal(shouldEmitReviewInstruction(resp, undefined), "https://github.com/vjpixel/diaria-studio/pull/6282");
  });

  it("comando real gh pr comment (payload verdadeiro do incidente #6298) → null mesmo se a URL não tivesse fragmento", () => {
    // Defesa em profundidade: mesmo que fix 1 falhasse (URL sem fragmento por
    // algum motivo), fix 2 sozinho já barra pelo comando.
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    assert.equal(shouldEmitReviewInstruction(resp, "gh pr comment 6282 --body-file /tmp/body.md"), null);
  });
});

// Finding #2 do fleet review pós-#6298 (confiança alta, P2): resolveEmitDecision
// expõe o motivo que shouldEmitReviewInstruction escondia atrás de um `null`
// só — os 3 motivos indistinguíveis (nenhuma URL, URL de comentário/review,
// comando não é gh pr create) agora resolvem `reason` diferentes.
describe("resolveEmitDecision (#6298 finding #2 — motivo de supressão observável)", () => {
  it('nenhuma URL de PR na saída → { prUrl: null, reason: "no_pr_url" }', () => {
    const result = resolveEmitDecision("Usage: gh pr create [flags]", undefined);
    assert.deepEqual(result, { prUrl: null, reason: "no_pr_url" });
  });

  it('URL de comentário (#issuecomment-N) → { prUrl: null, reason: "comment_or_review_url" }', () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#issuecomment-5427611867";
    const result = resolveEmitDecision(resp, undefined);
    assert.deepEqual(result, { prUrl: null, reason: "comment_or_review_url" });
  });

  it('URL de review (#pullrequestreview-N) → reason "comment_or_review_url"', () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282#pullrequestreview-9876543210";
    const result = resolveEmitDecision(resp, undefined);
    assert.equal(result.reason, "comment_or_review_url");
  });

  it('URL limpa + comando NÃO é gh pr create → { prUrl: null, reason: "not_gh_pr_create" }', () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    const result = resolveEmitDecision(resp, "gh pr comment 6282 --body-file /tmp/body.md");
    assert.deepEqual(result, { prUrl: null, reason: "not_gh_pr_create" });
  });

  it('URL limpa + comando gh pr create → { prUrl, reason: "ok" }', () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    const result = resolveEmitDecision(resp, "gh pr create --title x --body y");
    assert.deepEqual(result, { prUrl: "https://github.com/vjpixel/diaria-studio/pull/6282", reason: "ok" });
  });

  it('URL limpa + comando ausente (unknown) → { prUrl, reason: "ok" } (permissivo, nunca not_gh_pr_create)', () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    const result = resolveEmitDecision(resp, undefined);
    assert.deepEqual(result, { prUrl: "https://github.com/vjpixel/diaria-studio/pull/6282", reason: "ok" });
  });

  it("shouldEmitReviewInstruction continua um wrapper fino — mesma URL/null que resolveEmitDecision().prUrl", () => {
    const resp = "https://github.com/vjpixel/diaria-studio/pull/6282\n";
    assert.equal(
      shouldEmitReviewInstruction(resp, "gh pr create --title x"),
      resolveEmitDecision(resp, "gh pr create --title x").prUrl,
    );
    assert.equal(
      shouldEmitReviewInstruction("no url here", undefined),
      resolveEmitDecision("no url here", undefined).prUrl,
    );
  });
});

describe("logSuppressedReviewInstruction (#6298 finding #2)", () => {
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `pr-create-review-hook-suppressed-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  function readLoggedEvents(root: string) {
    const logPath = join(root, "data", "run-log.jsonl");
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("grava reason + comando truncado no formato de scripts/log-event.ts", () => {
    const root = freshRoot();
    logSuppressedReviewInstruction(
      { reason: "not_gh_pr_create", command: "gh pr comment 1 --body x" },
      { repoRoot: root },
    );
    const [event] = readLoggedEvents(root);
    assert.equal(event.agent, "code-review");
    assert.equal(event.level, "info");
    assert.equal(event.message, "review_instruction_suppressed");
    assert.deepEqual(event.details, { reason: "not_gh_pr_create", command: "gh pr comment 1 --body x" });
  });

  it("command ausente → details.command é null, não lança", () => {
    const root = freshRoot();
    assert.doesNotThrow(() =>
      logSuppressedReviewInstruction({ reason: "no_pr_url", command: undefined }, { repoRoot: root }),
    );
    const [event] = readLoggedEvents(root);
    assert.equal(event.details.command, null);
  });

  it("command gigante é truncado em 500 chars", () => {
    const root = freshRoot();
    const hugeCommand = "gh pr comment 1 --body " + "x".repeat(1000);
    logSuppressedReviewInstruction({ reason: "not_gh_pr_create", command: hugeCommand }, { repoRoot: root });
    const [event] = readLoggedEvents(root);
    assert.equal(event.details.command.length, 500);
  });

  it("é fail-soft: appendFn lançando erro nunca propaga", () => {
    assert.doesNotThrow(() =>
      logSuppressedReviewInstruction(
        { reason: "no_pr_url", command: undefined },
        {
          repoRoot: freshRoot(),
          appendFn: () => {
            throw new Error("ENOSPC: no space left on device");
          },
        },
      ),
    );
  });

  it("é fail-soft: mkdirFn lançando erro nunca propaga", () => {
    assert.doesNotThrow(() =>
      logSuppressedReviewInstruction(
        { reason: "no_pr_url", command: undefined },
        {
          repoRoot: freshRoot(),
          mkdirFn: () => {
            throw new Error("EACCES: permission denied");
          },
        },
      ),
    );
  });

  it("cria data/ se ainda não existir (worktree/tmpdir sem a pasta)", () => {
    const root = freshRoot();
    logSuppressedReviewInstruction({ reason: "no_pr_url", command: undefined }, { repoRoot: root });
    assert.equal(readLoggedEvents(root).length, 1);
  });
});

// Finding #3 do fleet review pós-#6298 (confiança média, P2): a fiação
// `payload.tool_input?.command` no entrypoint CLI é referência NOVA nesta PR
// e nunca era exercitada fim-a-fim — toda a suíte acima chama as funções
// exportadas diretamente, nunca o hook como PROCESSO real lendo JSON do
// stdin. Se o nome/caminho do campo estivesse errado no payload real emitido
// pelo harness, o hook degradaria pro caminho permissivo e o #6298
// reapareceria em produção com a suíte inteira verde. Spawna o hook via
// `node` de verdade, alimentando o payload pelo stdin, e confere o stdout.
//
// Isolamento: `resolveMainRepoRoot()`/`resolveEffort` chamam `git` sem `cwd`
// explícito, herdando o cwd do processo — sem isolar, o subprocesso real
// escreveria em `data/run-log.jsonl` da junction OneDrive COMPARTILHADA
// (mesmo risco documentado no describe "checkRoundActive DEFAULT real"
// acima). Por isso cada teste roda com `cwd` apontando pra um repo git
// TEMPORÁRIO — `resolveMainRepoRoot()` resolve `git rev-parse
// --git-common-dir` relativo a esse cwd, redirecionando toda escrita de log
// pro tmpdir isolado.
describe("hook como processo real, fim-a-fim (#6298 fleet review, finding #3)", () => {
  const HOOK_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".claude",
    "hooks",
    "pr-create-review.mjs",
  );
  const roots: string[] = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function isolatedGitRoot() {
    const root = mkdtempSync(join(tmpdir(), "pr-create-review-e2e-"));
    roots.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
    return root;
  }

  function runHook(payload: unknown, cwd: string) {
    return spawnSync(process.execPath, [HOOK_PATH], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  it("(a) payload de gh pr comment com URL de #issuecomment- → stdout vazio, sem additionalContext", () => {
    const root = isolatedGitRoot();
    const payload = {
      session_id: "sessao-teste-e2e",
      tool_input: { command: "gh pr comment 6282 --body-file /tmp/body.md" },
      tool_response: "https://github.com/vjpixel/diaria-studio/pull/6282#issuecomment-5427611867\n",
    };
    const result = runHook(payload, root);
    assert.equal(result.status, 0);
    assert.equal((result.stdout ?? "").trim(), "");
  });

  it("(b) payload de gh pr create com URL limpa → stdout com additionalContext", () => {
    const root = isolatedGitRoot();
    const payload = {
      session_id: "sessao-teste-e2e",
      tool_input: { command: "gh pr create --title x --body y" },
      tool_response: "https://github.com/vjpixel/diaria-studio/pull/6282\n",
    };
    const result = runHook(payload, root);
    assert.equal(result.status, 0);
    const stdout = (result.stdout ?? "").trim();
    assert.ok(stdout.length > 0, "esperava stdout não-vazio com additionalContext");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext, /pull\/6282/);
  });
});
