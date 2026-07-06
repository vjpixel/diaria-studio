import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, cpSync, symlinkSync } from "node:fs";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import {
  aammddToIso,
  isWithinPendingWindow,
  extractUrlsFromApproved,
} from "../scripts/merge-local-pending.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("aammddToIso (#863)", () => {
  it("converte AAMMDD pra ISO", () => {
    assert.equal(aammddToIso("260507"), "2026-05-07");
    assert.equal(aammddToIso("251231"), "2025-12-31");
    assert.equal(aammddToIso("260101"), "2026-01-01");
  });
});

describe("isWithinPendingWindow — anchor em today, não em edition (#863)", () => {
  // Cenário base: today=2026-05-07, current=260510 (edition agendada 3d à frente)
  const anchor = "2026-05-07";
  const current = "2026-05-10";

  it("inclui edição da última semana relativa a today (window=5)", () => {
    // 260504 = 2026-05-04 = 3 dias antes do anchor (today). Dentro de window=5.
    assert.equal(
      isWithinPendingWindow("2026-05-04", current, anchor, 5),
      true,
    );
  });

  it("exclui edição fora da window relativa a today", () => {
    // 260501 = 2026-05-01 = 6 dias antes do anchor. Fora de window=5.
    assert.equal(
      isWithinPendingWindow("2026-05-01", current, anchor, 5),
      false,
    );
  });

  it("exclui a própria edição corrente", () => {
    assert.equal(
      isWithinPendingWindow("2026-05-10", current, anchor, 5),
      false,
    );
  });

  it("exclui edições futuras (após current)", () => {
    assert.equal(
      isWithinPendingWindow("2026-05-15", current, anchor, 5),
      false,
    );
  });

  it("inclui edição no boundary exato do cutoff (cutoff <= edition)", () => {
    // anchor 2026-05-07 - 5d = 2026-05-02. Edição em 2026-05-02 é incluída.
    assert.equal(
      isWithinPendingWindow("2026-05-02", current, anchor, 5),
      true,
    );
  });

  it("regression #863: anchor=today vs anchor=edition produz resultados diferentes", () => {
    // current = 260520 (edição agendada 13d à frente).
    // anchor=today (2026-05-07): cutoff = 2026-05-02. Edição 260504 INCLUÍDA.
    // anchor=edition (2026-05-20): cutoff = 2026-05-15. Edição 260504 EXCLUÍDA.
    const futureCurrent = "2026-05-20";
    const editionIso = "2026-05-04";

    assert.equal(
      isWithinPendingWindow(editionIso, futureCurrent, "2026-05-07", 5),
      true,
      "anchor=today inclui pending de 3d atrás (correto per #863)",
    );

    assert.equal(
      isWithinPendingWindow(editionIso, futureCurrent, "2026-05-20", 5),
      false,
      "anchor=edition exclui pending de 16d 'atrás' relativo à edição (bug pré-#863)",
    );
  });

  it("daysAgo math também muda com anchor — pendings flagged stale relativo a today", () => {
    // Verificação implícita: cutoff math é determinista, mesma semântica que daysAgo
    // (que main() agora computa contra anchor — testado via smoke porque é dentro de main).
    // Documenta o comportamento aqui pra contrato:
    const oneDayMs = 24 * 60 * 60 * 1000;
    const anchorMs = new Date(anchor + "T00:00:00Z").getTime();
    const editionMs = new Date("2026-05-04T00:00:00Z").getTime();
    const daysAgo = Math.round((anchorMs - editionMs) / oneDayMs);
    assert.equal(daysAgo, 3, "edição de 3d atrás relativa ao anchor");
  });
});

describe("extractUrlsFromApproved — buckets #1629 (#1659)", () => {
  function writeApproved(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "mlp-"));
    const p = join(dir, "01-approved.json");
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }

  it("regression #1659: extrai URLs dos buckets novos radar/use_melhor/video", () => {
    const p = writeApproved({
      lancamento: [{ url: "https://x.com/lanc" }],
      radar: [{ url: "https://x.com/radar1" }, { url: "https://x.com/radar2" }],
      use_melhor: [{ url: "https://x.com/um" }],
      video: [{ url: "https://x.com/vid" }],
      highlights: [{ url: "https://x.com/h1" }],
      runners_up: [{ article: { url: "https://x.com/ru" } }],
    });
    const urls = extractUrlsFromApproved(p);
    for (const u of [
      "https://x.com/lanc",
      "https://x.com/radar1",
      "https://x.com/radar2",
      "https://x.com/um",
      "https://x.com/vid",
      "https://x.com/h1",
      "https://x.com/ru",
    ]) {
      assert.ok(urls.includes(u), `bucket URL faltando: ${u} — got: ${urls.join(", ")}`);
    }
  });

  it("ainda extrai buckets legacy (pesquisa/noticias/tutorial) de edições pré-#1629", () => {
    const p = writeApproved({
      pesquisa: [{ url: "https://x.com/pesq" }],
      noticias: [{ url: "https://x.com/not" }],
      tutorial: [{ url: "https://x.com/tut" }],
    });
    assert.deepEqual(
      extractUrlsFromApproved(p).sort(),
      ["https://x.com/not", "https://x.com/pesq", "https://x.com/tut"],
    );
  });

  it("retorna [] quando o arquivo não existe", () => {
    assert.deepEqual(
      extractUrlsFromApproved(join(tmpdir(), "nonexistent-mlp-dir", "01-approved.json")),
      [],
    );
  });
});

// #2463/#3024: main() precisa detectar edições pending no layout NESTED novo
// ({AAMM}/{AAMMDD}), não só no flat legado — regressão do bug corrigido em
// #3024 (readdirSync raso só enxergava flat).
describe("merge-local-pending.ts CLI — layout flat + nested (#3024)", () => {
  it("detecta edição pending no layout NESTED", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "mlp-nested-"));
    try {
      cpSync(resolve(ROOT, "scripts"), join(sandboxRoot, "scripts"), { recursive: true });
      cpSync(resolve(ROOT, "package.json"), join(sandboxRoot, "package.json"));
      cpSync(resolve(ROOT, "tsconfig.json"), join(sandboxRoot, "tsconfig.json"));
      if (existsSync(resolve(ROOT, "node_modules"))) {
        try {
          symlinkSync(
            resolve(ROOT, "node_modules"),
            join(sandboxRoot, "node_modules"),
            isWindows ? "junction" : "dir",
          );
        } catch {
          cpSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), {
            recursive: true,
          });
        }
      }
      // Edição NESTED, aprovada localmente (Stage 1 completo), não publicada.
      const nestedInternal = join(sandboxRoot, "data/editions/2605/260505/_internal");
      mkdirSync(nestedInternal, { recursive: true });
      writeFileSync(
        join(nestedInternal, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://x.com/pending-nested" }] }),
      );

      const out = execFileSync(
        NPX,
        [
          "tsx",
          "scripts/merge-local-pending.ts",
          "--current",
          "260507",
          "--editions-dir",
          "data/editions/",
          "--window-days",
          "5",
          "--anchor-iso",
          "2026-05-07",
        ],
        { cwd: sandboxRoot, stdio: "pipe", shell: isWindows },
      ).toString();
      const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as {
        pending_found: number;
        injected: number;
      };
      assert.equal(result.pending_found, 1, "deve detectar a edição nested como pending");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
