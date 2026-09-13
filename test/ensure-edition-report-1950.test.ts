/**
 * test/ensure-edition-report-1950.test.ts (#1950)
 *
 * Garante que o refresh-dedup gera o `edition-report.html` quando uma edição
 * publicada não tem o relatório (caso publish manual / Stage 4 interrompido —
 * caso 260608). Cobre: gera-quando-falta, idempotência, e safety (sem edition
 * dir local → no-op).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEditionReport } from "../scripts/refresh-dedup.ts";
import { getReportById } from "../scripts/studio-ui/studio-reports.ts";

// ROOT do repo real — `ensureEditionReport`/`writeEditionReport` sempre
// registram via `registerReport(ROOT, ...)` usando o ROOT REAL do script
// (nunca o `root` fake deste teste, ver nota no 1º teste abaixo), então é
// nele que `data/reports/index.jsonl` precisa ser lido/limpo.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const roots: string[] = [];
function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "ensure-report-"));
  roots.push(r);
  return r;
}
after(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

const post = (pub: string) => ({ id: "p", published_at: pub } as never);

describe("ensureEditionReport (#1950)", () => {
  it("gera edition-report.html quando a edição publicada não tem", () => {
    const root = tmpRoot();
    const dir = join(root, "260608");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    // #4478 achado 1 (defesa em profundidade, fleet review #4383): notify:false
    // explícito — este teste chama ensureEditionReport/writeEditionReport
    // in-process (sem passar por CLI/--no-email), e `writeReportFile` registra
    // via `registerReport(ROOT, ...)` usando o `ROOT` REAL do script (nunca o
    // `root` fake deste teste) — sem a flag, um `npm test` local numa máquina
    // com data/.credentials.json configurado bateria no Gmail real (o fix
    // sistêmico em defaultHasCredentials/studio-reports.ts já cobre o caso
    // geral, mas este caller específico também ganha a flag explícita).
    const gen = ensureEditionReport(root, post("2026-06-08T09:00:00Z"), false);
    assert.equal(gen, true);
    assert.ok(existsSync(join(dir, "_internal", "edition-report.html")));
    // manifest md5 também escrito (#1579)
    assert.ok(existsSync(join(dir, "_internal", ".edition-report-md5.txt")));
  });

  it("#7960 (item 4 da #7957): SEM passar `notify`, o próprio default de ensureEditionReport (false) vale — nenhum e-mail é disparado", () => {
    // Achado do fleet review da PR #8077 (pr-test-analyzer, criticidade 9/10):
    // o teste acima (e todo o resto da suíte de #4478/#7960) sempre passou
    // `notify: false` EXPLÍCITO como defesa em profundidade — nunca exercitou
    // o default PRÓPRIO de `ensureEditionReport` de fato. Esse default é um
    // elo independente na cadeia (`ensureEditionReport` -> `writeEditionReport`
    // -> `registerReport`, cada um com seu próprio parâmetro `notify = false`)
    // — um teste no nível de `registerReport` sozinho não pegaria uma
    // regressão aqui, porque os dois níveis acima já repassam um valor
    // explícito adiante. Este é o caminho exato que a PR cita como a mudança
    // de comportamento real: edição publicada manualmente / Stage 4
    // interrompido (#5521: uma auditoria chegou a disparar ~50 e-mails de
    // uma vez por engano nesse tipo de caminho).
    //
    // Data de edição exclusiva deste teste (não usada em nenhum outro arquivo
    // de teste nem em produção) — o registro real acontece em
    // `data/reports/index.jsonl` no ROOT do repo (nunca no `root` fake),
    // então precisa de um id que não colida com nada e seja limpo no final.
    const root = tmpRoot();
    const edition = "290909";
    const dir = join(root, edition);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const reportId = `edicao-${edition}`;

    try {
      const gen = ensureEditionReport(root, post("2029-09-09T09:00:00Z")); // notify OMITIDO de propósito
      assert.equal(gen, true, "relatório tem que ser gerado normalmente");
      assert.ok(existsSync(join(dir, "_internal", "edition-report.html")));

      const entry = getReportById(REPO_ROOT, reportId);
      assert.ok(entry, "registro no Studio tem que existir mesmo sem notificar");
      assert.equal(
        entry?.notified,
        false,
        "`notified` tem que ficar false quando `notify` é omitido — se isto falhar, o default de " +
          "ensureEditionReport/writeEditionReport/registerReport regrediu pra `true` e o editor voltaria " +
          "a receber e-mail de relatório de edição publicada manualmente sem nenhum teste quebrar antes desta linha",
      );
    } finally {
      // Limpa a entrada real de data/reports/index.jsonl — mesmo padrão de
      // afterEach de test/overnight-report-counts.test.ts (registro real,
      // sincronizado por OneDrive, não pode sobrar lixo de teste).
      const registryPath = join(REPO_ROOT, "data", "reports", "index.jsonl");
      if (existsSync(registryPath)) {
        const kept = readFileSync(registryPath, "utf-8")
          .split("\n")
          .filter((l) => !l.includes(reportId));
        writeFileSync(registryPath, kept.join("\n"), "utf-8");
      }
    }
  });

  it("é idempotente — não regenera se o relatório já existe", () => {
    const root = tmpRoot();
    const dir = join(root, "260608");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-report.html"), "<html>existente</html>", "utf8");
    const gen = ensureEditionReport(root, post("2026-06-08T09:00:00Z"));
    assert.equal(gen, false);
  });

  it("não cria nada quando a edição não existe local (scheduling futuro)", () => {
    const root = tmpRoot();
    const gen = ensureEditionReport(root, post("2099-01-01T00:00:00Z"));
    assert.equal(gen, false);
    assert.ok(!existsSync(join(root, "990101")));
  });
});
