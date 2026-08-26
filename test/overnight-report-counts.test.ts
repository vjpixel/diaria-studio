/**
 * test/overnight-report-counts.test.ts (#5521)
 *
 * Regressão para a divergência entre o assunto do e-mail de relatório e o
 * conteúdo do próprio relatório.
 *
 * Caso de origem (rodada 260816e, 17/08/2026): assunto anunciou
 * "10 unidades, 13 issues fechadas" para um relatório cuja tabela "Unidades
 * mergeadas" tinha 13 linhas cobrindo 17 issues.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  parseUnitsTable,
  deriveCounts,
  parseTitleCounts,
  compareTitleWithReport,
  isTitleOk,
} from "../scripts/lib/overnight-report-counts.ts";
import { registerReport } from "../scripts/studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Recorte fiel do report.md da rodada 260816e (13 linhas, 17 issues). */
const REPORT_260816E = `# diar.ia.br overnight 260816e

Rodada estendida. **10 unidades mergeadas em 13 issues fechadas**, 2 reviews consolidados.

## Unidades mergeadas

<!-- unidades-mergeadas -->
| Issue(s) | PR | O quê |
|---|---|---|
| #5471 | #5473 | 1m-ter fora de ordem no Stage 1 |
| #5434 (P1) | #5479 | Lock cross-processo no Stage 0 |
| #5472 + #5416 | #5477 | Fix validador LinkedIn (#5416 fica aberta) |
| #5475 | #5481 | capture-stage-usage.ts silencioso vira warn |
| #5427 + #5474 | #5483 | \`-safeBackup-\` ignorado + SOFT_STALE_MS |
| #5476 | #5485 | Gate mecânico de re-triagem |
| #5484 | #5488 | Regra de viés de autoria |
| #5489 | #5491 | Fix de flakiness em file-lock.test.ts |
| #5490 | #5492 | Gráfico de taxa de abertura |
| #5493 + #5495 (P1) + #5496 | #5510 | Núcleo de medição CAC |
| #5494 | #5508 | Alarme de aquisição |
| #5498 | #5509 | Instrumentação GTM |
| #5505 | #5511 | Doc Meta Ads |

Todos os 13 PRs: CI verde.

## Estado final da fila

Nesta rodada: 13 issues fechadas.
`;

describe("parseUnitsTable (#5521)", () => {
  it("extrai as 13 linhas da tabela do 260816e", () => {
    const { found, rows } = parseUnitsTable(REPORT_260816E);
    assert.equal(found, true);
    assert.equal(rows.length, 13);
  });

  it("reconhece lote com múltiplas issues numa linha só", () => {
    const lote = parseUnitsTable(REPORT_260816E).rows.find((r) => r.pr === 5510);
    assert.deepEqual(lote!.issues, [5493, 5495, 5496]);
  });

  it("separa a coluna de issues da coluna de PR", () => {
    assert.deepEqual(parseUnitsTable(REPORT_260816E).rows[0], { issues: [5471], pr: 5473 });
  });

  it("não confunde cabeçalho nem separador com linha de dados", () => {
    assert.ok(parseUnitsTable(REPORT_260816E).rows.every((r) => r.issues.length > 0));
  });

  it("para no fim do bloco — texto posterior não vira linha", () => {
    const { rows } = parseUnitsTable(REPORT_260816E);
    assert.ok(!rows.some((r) => r.issues.includes(5416) && r.pr === null));
  });

  it("relatório sem marcador → found:false (não lança)", () => {
    assert.deepEqual(parseUnitsTable("# relatório\n\nsem tabela aqui.\n"), {
      found: false,
      rows: [],
    });
  });

  it("linha sem PR declarado → pr null", () => {
    const md = "<!-- unidades-mergeadas -->\n| Issue(s) | PR | O quê |\n|---|---|---|\n| #100 | — | sem PR |\n";
    assert.deepEqual(parseUnitsTable(md).rows, [{ issues: [100], pr: null }]);
  });

  // #5521: a âncora é o MARCADOR, não o título da seção — os relatórios reais
  // usam meia dúzia de títulos diferentes pra essa mesma tabela.
  for (const heading of ["## Resolvidas", "## Destravadas e mergeadas", "### Resolvidas — 5 PRs"]) {
    it(`REGRESSÃO: acha a tabela sob o título real "${heading}"`, () => {
      const md = `${heading}

<!-- unidades-mergeadas -->
| Issue(s) | PR | O quê |
|---|---|---|
| #5471 | #5473 | x |
`;
      const { found, rows } = parseUnitsTable(md);
      assert.equal(found, true);
      assert.equal(rows.length, 1);
    });
  }

  it("REGRESSÃO: tabela SEM o marcador não é conferida (evita falso positivo em formato legado)", () => {
    // Formato real do 260811: a coluna rotulada "Issues fechadas" traz
    // DESCRIÇÃO, e as issues estão sob "Unidade". Adivinhar por nome de coluna
    // casava a tabela errada; sem marcador, o certo é não conferir.
    const md = [
      "## Resolvidas",
      "",
      "| Unidade | PR | Issues fechadas |",
      "|---|---|---|",
      "| #4557 | #4964 | guard de drift |",
    ].join("\n");
    assert.equal(parseUnitsTable(md).found, false);
  });

  it("REGRESSÃO: marcador presente mas sem linha legível → found:true, rows vazio", () => {
    // O guard TEM que saber que a tabela existia, senão vira no-op silencioso
    // justamente quando o formato quebrou.
    const md = "<!-- unidades-mergeadas -->\n| Issue(s) | PR | O quê |\n|---|---|---|\n| (nenhuma) | — | x |\n";
    assert.deepEqual(parseUnitsTable(md), { found: true, rows: [] });
  });

  it("aceita número cru (sem #) na coluna de issues", () => {
    const md = "<!-- unidades-mergeadas -->\n| Issue(s) | PR | O quê |\n|---|---|---|\n| 5471 | 5473 | x |\n";
    assert.deepEqual(parseUnitsTable(md).rows, [{ issues: [5471], pr: 5473 }]);
  });

  it("não confunde a tabela de custo com a de unidades", () => {
    const md = "## Custo\n\n| unidade | tokens |\n|---|---|\n| #5471 | 169249 |\n";
    assert.equal(parseUnitsTable(md).found, false);
  });
});

describe("deriveCounts (#5521)", () => {
  it("REGRESSÃO: 260816e são 13 unidades e 17 issues, não 10 e 13", () => {
    const counts = deriveCounts(parseUnitsTable(REPORT_260816E).rows);
    assert.deepEqual(counts, { units: 13, issues: 17 });
  });

  it("conta issue repetida em duas linhas uma vez só", () => {
    const rows = [
      { issues: [10, 11], pr: 1 },
      { issues: [11], pr: 2 },
    ];
    assert.deepEqual(deriveCounts(rows), { units: 2, issues: 2 });
  });

  it("tabela vazia → zeros", () => {
    assert.deepEqual(deriveCounts([]), { units: 0, issues: 0 });
  });
});

describe("parseTitleCounts (#5521)", () => {
  it("lê 'N unidades' e 'M issues'", () => {
    assert.deepEqual(
      parseTitleCounts("diar.ia.br overnight 260816e — 10 unidades, 13 issues fechadas (2 P1)"),
      { units: 10, issues: 13 },
    );
  });

  it("REGRESSÃO: 'N resolvidas' é ambíguo e NÃO vira unidades", () => {
    // A 1ª versão lia isso como unidades; a convenção real do projeto
    // ("28 issues resolvidas (26 PRs)") mostra que conta ISSUES. Ler como
    // unidade dava falso positivo em toda rodada com lote.
    assert.deepEqual(
      parseTitleCounts("diar.ia.br overnight 260816 — 12 resolvidas, 19 puladas, 0 findings"),
      { units: null, issues: null },
    );
  });

  it("lê 'N PRs mergeadas' como unidades", () => {
    const c = parseTitleCounts("diar.ia.br develop 260816b — 3 PRs mergeadas, 6 issues avançadas");
    assert.deepEqual(c, { units: 3, issues: 6 });
  });

  it("título sem números → ambos null (nada a conferir)", () => {
    assert.deepEqual(parseTitleCounts("diar.ia.br overnight 260816d — fila já esvaziada"), {
      units: null,
      issues: null,
    });
  });
});

describe("compareTitleWithReport (#5521)", () => {
  it("REGRESSÃO: o título real do 260816e é reprovado nos dois números", () => {
    const check = compareTitleWithReport(
      "diar.ia.br overnight 260816e — 10 unidades, 13 issues fechadas (2 P1), 2 reviews limpos",
      REPORT_260816E,
    );
    assert.equal(check.kind, "checked");
    assert.ok(!isTitleOk(check));
    assert.equal(check.problems.length, 2);
    assert.equal(check.kind === "checked" && check.suggestion, "13 unidades, 17 issues");
  });

  it("título correto passa", () => {
    const check = compareTitleWithReport(
      "diar.ia.br overnight 260816e — 13 unidades, 17 issues (2 P1), 2 reviews limpos",
      REPORT_260816E,
    );
    assert.ok(isTitleOk(check));
    assert.deepEqual(check.kind === "checked" && check.expected, { units: 13, issues: 17 });
  });

  it("título que declara só unidades e acerta passa (issues não é obrigatório)", () => {
    const check = compareTitleWithReport("overnight 260816e — 13 unidades", REPORT_260816E);
    assert.ok(isTitleOk(check));
  });

  it("relatório sem tabela → skipped, nunca reprova formato antigo", () => {
    const check = compareTitleWithReport("overnight 260101 — 5 unidades", "# rel\n\nprosa.\n");
    assert.ok(isTitleOk(check));
    assert.equal(check.kind, "skipped");
  });

  it("só o número errado é apontado quando o outro está certo", () => {
    const check = compareTitleWithReport(
      "overnight 260816e — 13 unidades, 13 issues",
      REPORT_260816E,
    );
    assert.ok(!isTitleOk(check));
    assert.equal(check.problems.length, 1);
    assert.match(check.problems[0], /17 issue/);
  });
});

// ---------------------------------------------------------------------------
// Integração: register-report.ts bloqueia antes de registrar
// ---------------------------------------------------------------------------

describe("register-report.ts: guard de contagem (#5521)", () => {
  let reportDir: string;
  let reportPath: string;

  /**
   * Roda o CLI real.
   *
   * `DIARIA_TEST_CREDENTIALS_PATH` aponta pra um caminho inexistente de
   * propósito (#4478): sem isso, um caminho que chegue até `registerReport`
   * dispararia e-mail REAL pro editor em toda máquina com credencial Gmail
   * configurada. Este arquivo já cometeu esse erro uma vez — a versão anterior
   * exercitava o kind `edicao` (fora de `COUNT_CHECKED_KINDS`), que atravessa o
   * guard e registra de verdade, poluindo `data/reports/index.jsonl` (que é
   * sincronizado por OneDrive entre as máquinas e alimenta o /relatorios real).
   * Os casos abaixo só exercitam caminhos que saem ANTES de registrar.
   */
  const run = (title: string, kind = "overnight", htmlPath = reportPath) => {
    // `process.execPath` + `--import tsx` e não `npx` (#6206): no Windows o
    // executável é `npx.cmd`, e `spawnSync` sem `shell: true` responde ENOENT
    // com `status: -1` — o teste então comparava `-1 !== 1` e falhava como se o
    // guard não tivesse bloqueado, quando na verdade o script nunca rodou.
    // Este é o mesmo idioma que `pipeline-sentinel-legacy-cutoff.test.ts` já
    // usa, e ainda evita a camada extra de resolução do `npx`.
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts", "register-report.ts"),
        "--kind", kind,
        "--id", "zz-test-5521",
        "--title", title,
        "--html-path", htmlPath,
      ],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, DIARIA_TEST_CREDENTIALS_PATH: "/nonexistent-5521" },
      },
    );
    return { code: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
  };

  beforeEach(() => {
    // Precisa viver dentro do ROOT (register-report resolve --html-path contra
    // ele), então NÃO há isolamento por tmpdir aqui — daí o sufixo aleatório,
    // pra duas execuções concorrentes não disputarem o mesmo diretório.
    const suffix = mkdtempSync(join(tmpdir(), "reg-5521-")).split("-").pop();
    reportDir = join(ROOT, "data", `tmp-test-5521-${suffix}`);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "report.md"), REPORT_260816E, "utf-8");
    reportPath = `data/tmp-test-5521-${suffix}/report.md`;
  });

  const registryPath = join(ROOT, "data", "reports", "index.jsonl");

  /** Linhas deste teste que porventura tenham sido registradas. */
  const registeredLines = (): string[] => {
    if (!existsSync(registryPath)) return [];
    return readFileSync(registryPath, "utf-8")
      .split("\n")
      .filter((l) => l.includes("zz-test-5521"));
  };

  afterEach(() => {
    try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // `data/reports/index.jsonl` é o registro REAL (sincronizado por OneDrive,
    // alimenta o /relatorios do editor). O caminho "relatório ausente" abaixo
    // chega a `registerReport` de propósito — então limpar é obrigatório.
    if (existsSync(registryPath)) {
      const kept = readFileSync(registryPath, "utf-8")
        .split("\n")
        .filter((l) => !l.includes("zz-test-5521"));
      writeFileSync(registryPath, kept.join("\n"), "utf-8");
    }
  });

  it("REGRESSÃO: título divergente sai 1 e não registra nada", () => {
    const r = run("diar.ia.br overnight 260816e — 10 unidades, 13 issues fechadas");
    assert.equal(r.code, 1, "guard tem que bloquear, não passar fail-soft");
    assert.match(r.stderr, /não bate/);
    assert.match(r.stderr, /13 unidades, 17 issues/);
    assert.equal(r.stdout.trim(), "", "não pode imprimir URL de relatório registrado");
  });

  it("mensagem de erro diz que nada foi registrado e nenhum e-mail saiu", () => {
    const r = run("overnight — 10 unidades");
    assert.match(r.stderr, /nada foi registrado, nenhum e-mail saiu/);
  });

  it("relatório ausente: avisa que NÃO conferiu em vez de pular calado", () => {
    const r = run("overnight — 10 unidades", "overnight", "data/nao-existe-5521/report.md");
    assert.match(r.stderr, /AVISO: título NÃO conferido/);
    // Documenta o comportamento real: sem relatório em disco não há o que
    // conferir, então o registro PROSSEGUE (fail-soft) — só que ruidosamente.
    assert.equal(r.code, 0);
  });

  it("REGRESSÃO: relatório sem o marcador avisa que a conferência não rodou", () => {
    const semMarcador = join(reportDir, "sem-marcador.md");
    writeFileSync(semMarcador, "# rel\n\n## Resolvidas\n\n| Issue | PR |\n|---|---|\n| #1 | #2 |\n", "utf-8");
    const r = run("overnight — 10 unidades", "overnight", `${reportPath.replace("report.md", "sem-marcador.md")}`);
    assert.match(r.stderr, /marcador/);
    assert.match(r.stderr, /NÃO conferido/);
  });

  it("REGRESSÃO: o caminho que BLOQUEIA não chega a registrar nada", () => {
    run("diar.ia.br overnight 260816e — 10 unidades, 13 issues fechadas");
    assert.deepEqual(
      registeredLines(),
      [],
      "title divergente tem que sair antes de tocar data/reports/index.jsonl",
    );
  });
});

// ---------------------------------------------------------------------------
// #5521 (re-review): o guard tem que valer no caminho DOCUMENTADO
// ---------------------------------------------------------------------------

describe("template de --title dos SKILLs é conferível (#5521)", () => {
  const SKILLS = [
    ".claude/skills/diaria-overnight/SKILL.md",
    ".claude/skills/diaria-develop/SKILL.md",
  ];

  /**
   * REGRESSÃO do achado mais grave do re-review: o guard existia, era anunciado
   * como "único ponto não fail-soft", e mesmo assim NÃO conferia nada no
   * caminho que os próprios SKILLs mandam o coordenador seguir — os templates
   * usavam "N resolvidas"/"N destravadas", vocabulário que `parseTitleCounts`
   * ignora de propósito. Um guard que só protege caminhos que ninguém percorre
   * é pior que guard nenhum: passa a falsa sensação de proteção.
   */
  for (const skill of SKILLS) {
    it(`${skill}: o template de --title declara contagem conferível`, () => {
      const md = readFileSync(join(ROOT, skill), "utf-8");
      const linha = md.split("\n").find((l) => l.includes('--title "diar.ia.br'));
      assert.ok(linha, "template de --title não encontrado no SKILL");

      // O template usa placeholders ({U}, {X}); trocar por números pra parsear.
      const comNumeros = linha.replace(/\{[A-Za-z]+\}/g, "7");
      const counts = parseTitleCounts(comNumeros);
      assert.ok(
        counts.units !== null || counts.issues !== null,
        `template não declara contagem conferível: ${linha.trim()}`,
      );
    });
  }
});

describe("título sem contagem conferível é reprovado (#5521)", () => {
  const REPORT = [
    "<!-- unidades-mergeadas -->",
    "| Issue(s) | PR | O quê |",
    "|---|---|---|",
    "| #5471 | #5473 | x |",
    "| #5472 | #5477 | y |",
  ].join("\n");

  it("REGRESSÃO: 'N resolvidas' não passa mais como aprovação silenciosa", () => {
    const check = compareTitleWithReport(
      "diar.ia.br overnight 260817 — 3 resolvidas, 1 pulada, 2 findings",
      REPORT,
    );
    assert.ok(!isTitleOk(check), "título não-conferível não pode passar como coerente");
    assert.match(check.problems[0], /nenhuma contagem conferível/);
  });

  it("declarar só issues já basta", () => {
    assert.ok(isTitleOk(compareTitleWithReport("overnight — 2 issues", REPORT)));
  });

  it("relatório sem marcador continua passando (não há o que conferir)", () => {
    const check = compareTitleWithReport("overnight — 3 resolvidas", "# rel\n\nprosa.\n");
    assert.ok(isTitleOk(check));
    assert.equal(check.kind, "skipped");
  });
});

// ---------------------------------------------------------------------------
// #5521: 1 e-mail por rodada + --no-email
// ---------------------------------------------------------------------------

describe("registerReport: e-mail único por rodada (#5521)", () => {
  let tmpRoot: string;

  const input = (title: string) => ({
    kind: "overnight" as const,
    sessionId: "260817",
    title,
    htmlPath: "data/overnight/260817/report.md",
  });

  /** Deps injetadas: nunca tocam rede nem credencial real. */
  const deps = {
    hasCredentials: () => true,
    resolveEditorEmail: () => "editor@exemplo.test",
    sendMail: async () => ({ ok: true }),
  } as unknown as Parameters<typeof registerReport>[2];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reg-notify-"));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: re-registro da MESMA rodada não manda e-mail de novo", async () => {
    // A rodada 260816e mandou 4 e-mails, todos se apresentando como definitivos;
    // a 260816 mandou o mesmo assunto 2x em 80s. Como o registro é upsert e a
    // URL deriva do id, o link do 1º e-mail já aponta pra versão atual.
    const first = registerReport(tmpRoot, input("overnight 260817 — 1 unidades, 1 issues"), deps);
    assert.equal(first.ok, true);
    assert.deepEqual(await first.emailDispatch, { sent: true });

    const second = registerReport(tmpRoot, input("overnight 260817 — 4 unidades, 6 issues"), deps);
    assert.equal(second.ok, true, "o registro em si tem que ser atualizado");
    assert.deepEqual(await second.emailDispatch, { sent: false, skipped: "already-notified" });
  });

  it("REGRESSÃO: registro com notify:false NÃO consome a notificação (Stage 6)", async () => {
    // O Stage 6 registra o MESMO `edicao-{AAMMDD}` 2×: 6b-6 com notify:false
    // (HTML descartável, só pra fechar o invariante do stage) e 6b-8 com o
    // default true — é a 2ª que manda o relatório diário pro editor. Dedup por
    // "já existe entrada" engolia justamente esse e-mail.
    const primeira = registerReport(tmpRoot, input("descartável — 1 unidades"), deps, false);
    assert.deepEqual(await primeira.emailDispatch, { sent: false, skipped: "notify-disabled" });

    const segunda = registerReport(tmpRoot, input("final — 1 unidades"), deps);
    assert.deepEqual(
      await segunda.emailDispatch,
      { sent: true },
      "a chamada final do Stage 6 TEM que notificar",
    );
  });

  it("REGRESSÃO: envio que FALHA não queima a notificação — o retry tenta de novo", async () => {
    // `notified` é gravado antes do disparo (que é assíncrono). Sem desfazer
    // em caso de falha, uma queda de rede marcaria a rodada como notificada
    // para sempre e o e-mail sumiria em silêncio.
    const semCredencial = {
      hasCredentials: () => false,
      resolveEditorEmail: () => "editor@exemplo.test",
      sendMail: async () => ({ ok: true }),
    } as unknown as Parameters<typeof registerReport>[2];

    const falhou = registerReport(tmpRoot, input("tentativa 1 — 1 unidades"), semCredencial);
    assert.deepEqual(await falhou.emailDispatch, { sent: false, skipped: "no-credentials" });

    const retry = registerReport(tmpRoot, input("tentativa 2 — 1 unidades"), deps);
    assert.deepEqual(
      await retry.emailDispatch,
      { sent: true },
      "com credencial de volta, o retry TEM que enviar",
    );
  });

  it("rodada DIFERENTE continua mandando e-mail", async () => {
    await registerReport(tmpRoot, input("a — 1 unidades"), deps).emailDispatch;
    const outra = registerReport(
      tmpRoot,
      { ...input("b — 1 unidades"), sessionId: "260818" },
      deps,
    );
    assert.deepEqual(await outra.emailDispatch, { sent: true });
  });

  it("notify:false (o --no-email do CLI) nunca manda", async () => {
    const r = registerReport(tmpRoot, input("x — 1 unidades"), deps, false);
    assert.deepEqual(await r.emailDispatch, { sent: false, skipped: "notify-disabled" });
  });
});
