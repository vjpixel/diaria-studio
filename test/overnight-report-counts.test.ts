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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  parseUnitsTable,
  deriveCounts,
  parseTitleCounts,
  compareTitleWithReport,
} from "../scripts/lib/overnight-report-counts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Recorte fiel do report.md da rodada 260816e (13 linhas, 17 issues). */
const REPORT_260816E = `# diar.ia.br overnight 260816e

Rodada estendida. **10 unidades mergeadas em 13 issues fechadas**, 2 reviews consolidados.

## Unidades mergeadas

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
    const rows = parseUnitsTable(REPORT_260816E);
    assert.equal(rows.length, 13);
  });

  it("reconhece lote com múltiplas issues numa linha só", () => {
    const rows = parseUnitsTable(REPORT_260816E);
    const lote = rows.find((r) => r.pr === 5510);
    assert.deepEqual(lote!.issues, [5493, 5495, 5496]);
  });

  it("separa issues (1ª coluna) do PR (2ª coluna)", () => {
    const rows = parseUnitsTable(REPORT_260816E);
    assert.deepEqual(rows[0], { issues: [5471], pr: 5473 });
  });

  it("não confunde cabeçalho nem separador com linha de dados", () => {
    const rows = parseUnitsTable(REPORT_260816E);
    assert.ok(rows.every((r) => r.issues.length > 0));
  });

  it("para na próxima seção — texto posterior não vira linha", () => {
    const rows = parseUnitsTable(REPORT_260816E);
    assert.ok(!rows.some((r) => r.issues.includes(5416) && r.pr === null));
  });

  it("relatório sem a seção → lista vazia (não lança)", () => {
    assert.deepEqual(parseUnitsTable("# relatório\n\nsem tabela aqui.\n"), []);
  });

  it("linha sem PR declarado → pr null", () => {
    const md = "## Unidades mergeadas\n\n| Issue(s) | PR | O quê |\n|---|---|---|\n| #100 | — | sem PR |\n";
    assert.deepEqual(parseUnitsTable(md), [{ issues: [100], pr: null }]);
  });
});

describe("deriveCounts (#5521)", () => {
  it("REGRESSÃO: 260816e são 13 unidades e 17 issues, não 10 e 13", () => {
    const counts = deriveCounts(parseUnitsTable(REPORT_260816E));
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

  it("lê o formato histórico 'N resolvidas'", () => {
    assert.deepEqual(
      parseTitleCounts("diar.ia.br overnight 260816 — 12 resolvidas, 19 puladas, 0 findings"),
      { units: 12, issues: null },
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
    assert.equal(check.ok, false);
    assert.equal(check.problems.length, 2);
    assert.equal(check.suggestion, "13 unidades, 17 issues");
  });

  it("título correto passa", () => {
    const check = compareTitleWithReport(
      "diar.ia.br overnight 260816e — 13 unidades, 17 issues (2 P1), 2 reviews limpos",
      REPORT_260816E,
    );
    assert.equal(check.ok, true);
    assert.deepEqual(check.expected, { units: 13, issues: 17 });
  });

  it("título que declara só unidades e acerta passa (issues não é obrigatório)", () => {
    const check = compareTitleWithReport("overnight 260816e — 13 unidades", REPORT_260816E);
    assert.equal(check.ok, true);
  });

  it("relatório sem tabela → skipped, nunca reprova formato antigo", () => {
    const check = compareTitleWithReport("overnight 260101 — 5 resolvidas", "# rel\n\nprosa.\n");
    assert.equal(check.ok, true);
    assert.equal(check.skipped, true);
  });

  it("só o número errado é apontado quando o outro está certo", () => {
    const check = compareTitleWithReport(
      "overnight 260816e — 13 unidades, 13 issues",
      REPORT_260816E,
    );
    assert.equal(check.ok, false);
    assert.equal(check.problems.length, 1);
    assert.match(check.problems[0], /17 issue/);
  });
});

// ---------------------------------------------------------------------------
// Integração: register-report.ts bloqueia antes de registrar
// ---------------------------------------------------------------------------

describe("register-report.ts: guard de contagem (#5521)", () => {
  let tmpRoot: string;
  let reportPath: string;

  const run = (title: string, kind = "overnight") => {
    try {
      const stdout = execFileSync(
        "npx",
        [
          "tsx",
          join(ROOT, "scripts", "register-report.ts"),
          "--kind", kind,
          "--id", "zz-test-5521",
          "--title", title,
          "--html-path", reportPath,
        ],
        { cwd: ROOT, encoding: "utf-8", stdio: "pipe" },
      );
      return { code: 0, stderr: "", stdout };
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string };
      return { code: err.status, stderr: err.stderr ?? "", stdout: err.stdout ?? "" };
    }
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reg-report-5521-"));
    // Precisa viver dentro do ROOT: register-report resolve --html-path contra ele.
    const dir = join(ROOT, "data", "tmp-test-5521");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), REPORT_260816E, "utf-8");
    reportPath = "data/tmp-test-5521/report.md";
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(join(ROOT, "data", "tmp-test-5521"), { recursive: true, force: true }); } catch { /* ignore */ }
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

  it("kind fora de overnight/develop não é checado (formato diferente)", () => {
    const r = run("edição — 10 unidades, 13 issues", "edicao");
    assert.equal(r.code, 0);
  });
});
