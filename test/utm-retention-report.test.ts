/**
 * Teste de PROCESSO pra `scripts/utm-retention-report.ts` — cobre a
 * composição de `main()`, que `test/utm-retention.test.ts` (lógica pura) não
 * exercita. Achado do PR #5643 (issue #5650): dois P0 na composição
 * (`readSnapshotSubscribers` não lança com diretório ausente; "nenhum braço
 * medido" saía exit 0) foram corrigidos ali só à mão, sem teste travando a
 * regressão.
 *
 * Segue o padrão já usado por `test/cac-report.test.ts` para scripts CLI
 * deste repo: `main()` é exportado com um parâmetro `snapshotRoot` opcional
 * (fixture em tmpdir) e chamado DIRETO no processo de teste — não via
 * `child_process` — porque `main()` nunca chama `process.exit` (só seta
 * `process.exitCode` e retorna), então não há risco de matar o test runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../scripts/utm-retention-report.ts";

/** Roda `main()` capturando `process.exitCode` sem vazar pro resto da
 *  suíte — mesmo padrão de `test/cac-report.test.ts` (save/restore). */
function runMain(argv: string[], snapshotRoot: string): number | undefined {
  const before = process.exitCode;
  process.exitCode = undefined;
  main(argv, snapshotRoot);
  const exit = process.exitCode;
  process.exitCode = before;
  return exit;
}

function subscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "x@example.com",
    status: "active",
    created: 1_760_000_000,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: null,
    ...overrides,
  });
}

/** Cria `{root}/{date}/subscribers.jsonl` com as linhas dadas. */
function writeSnapshot(root: string, date: string, lines: string[]): void {
  const dir = join(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("utm-retention-report main() — contrato de exit code (#5650)", () => {
  it("snapshot inexistente -> exit 1 (não 0, não 3)", () => {
    const root = mkdtempSync(join(tmpdir(), "utm-retention-report-nosnap-"));
    try {
      // Diretório do snapshot nunca é criado.
      const exit = runMain(["--snapshot", "2026-09-16"], root);
      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--desde depois de --ate -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "utm-retention-report-invwin-"));
    try {
      writeSnapshot(root, "2026-09-16", [subscriberLine({ utm_source: "meta-ads" })]);
      const exit = runMain(
        ["--snapshot", "2026-09-16", "--desde", "2026-09-15", "--ate", "2026-09-01"],
        root,
      );
      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data malformada em --desde -> exit 1 com mensagem limpa, não stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "utm-retention-report-baddate-"));
    try {
      writeSnapshot(root, "2026-09-16", [subscriberLine({ utm_source: "meta-ads" })]);

      const originalError = console.error;
      const errLines: string[] = [];
      console.error = (msg?: unknown) => {
        errLines.push(String(msg));
      };
      let exit: number | undefined;
      try {
        exit = runMain(["--snapshot", "2026-09-16", "--desde", "não-é-uma-data"], root);
      } finally {
        console.error = originalError;
      }

      assert.equal(exit, 1);
      // Nenhuma linha de erro deve carregar um stack trace cru (frame "at ").
      for (const line of errLines) {
        assert.doesNotMatch(line, /\n\s*at /, "mensagem de erro não deveria vazar stack trace");
      }
      assert.ok(
        errLines.some((l) => l.startsWith("erro: ")),
        "deveria imprimir uma mensagem de erro limpa prefixada por 'erro: '",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshot válido sem nenhum braço medido -> exit 3 (incompleto)", () => {
    const root = mkdtempSync(join(tmpdir(), "utm-retention-report-incompleto-"));
    try {
      // Nenhum subscriber com utm_source de nenhum braço cadastrado
      // (google-ads/microsoft-ads/meta-ads) — todos os braços ficam sem
      // denominador.
      writeSnapshot(root, "2026-09-16", [
        subscriberLine({ utm_source: "direct", referring_site: "" }),
        subscriberLine({ utm_source: "", referring_site: "" }),
      ]);
      const exit = runMain(["--snapshot", "2026-09-16"], root);
      assert.equal(exit, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshot com todos os braços atribuídos e retenção saudável -> exit 0 (passa)", () => {
    const root = mkdtempSync(join(tmpdir(), "utm-retention-report-passa-"));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(subscriberLine({ email: `google-${i}@example.com`, utm_source: "google-ads", status: "active" }));
        lines.push(subscriberLine({ email: `msft-${i}@example.com`, utm_source: "microsoft-ads", status: "active" }));
        lines.push(subscriberLine({ email: `meta-${i}@example.com`, utm_source: "meta-ads", status: "active" }));
      }
      writeSnapshot(root, "2026-09-16", lines);
      const exit = runMain(["--snapshot", "2026-09-16", "--json"], root);
      assert.equal(exit, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "filtro de janela: assinante sem `created` é descartado e contado em semCreated, nunca assumido dentro",
    () => {
      const root = mkdtempSync(join(tmpdir(), "utm-retention-report-semcreated-"));
      try {
        const lines: string[] = [];
        for (let i = 0; i < 5; i++) {
          lines.push(subscriberLine({ email: `google-${i}@example.com`, utm_source: "google-ads" }));
          lines.push(subscriberLine({ email: `msft-${i}@example.com`, utm_source: "microsoft-ads" }));
          lines.push(subscriberLine({ email: `meta-${i}@example.com`, utm_source: "meta-ads" }));
        }
        // Assinante sem `created` (campo omitido) — dentro do range de datas
        // do teste caso fosse (erroneamente) assumido dentro da janela.
        lines.push(
          JSON.stringify({
            email: "sem-created@example.com",
            status: "active",
            utm_source: "google-ads",
            utm_medium: "",
            utm_campaign: "",
            referring_site: "",
            stats: null,
          }),
        );
        writeSnapshot(root, "2026-09-16", lines);

        const originalLog = console.log;
        const outLines: string[] = [];
        console.log = (msg?: unknown) => {
          outLines.push(String(msg));
        };
        let exit: number | undefined;
        try {
          exit = runMain(
            ["--snapshot", "2026-09-16", "--desde", "2025-10-01", "--ate", "2025-10-31", "--json"],
            root,
          );
        } finally {
          console.log = originalLog;
        }

        assert.equal(exit, 0);
        const jsonOut = outLines.join("\n");
        const parsed = JSON.parse(jsonOut);
        assert.equal(parsed.semCreated, 1, "o assinante sem `created` deveria ser descartado e contado");

        // O braço google-ads não deveria ter sido inflado pelo assinante sem
        // `created` — 5 atribuídos (i=0..4), não 6.
        const googleArm = parsed.arms.find((a: { utmSource: string }) => a.utmSource === "google-ads");
        assert.ok(googleArm, "braço google-ads deveria existir no output");
        assert.equal(googleArm.atribuidos, 5);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
