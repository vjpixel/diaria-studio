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
  loadPublishedAammddFromRaw,
  isPublished,
} from "../scripts/merge-local-pending.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #3207: monta um sandbox isolado (scripts/ + package.json + tsconfig.json +
 * node_modules) pra invocar o CLI real via subprocess — mesmo padrão do teste
 * "layout flat + nested" (#3024) acima. Extraído em helper pra reusar entre
 * os testes de cross-check `--past-raw`.
 */
function setupSandbox(): string {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "mlp-pastraw-"));
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
  return sandboxRoot;
}

function runMergeLocalPending(sandboxRoot: string, extraArgs: string[]): {
  pending_found: number;
  injected: number;
  editions?: Array<{ yymmdd: string; days_ago: number; url_count: number }>;
} {
  const out = execFileSync(
    NPX,
    ["tsx", "scripts/merge-local-pending.ts", ...extraArgs],
    { cwd: sandboxRoot, stdio: "pipe", shell: isWindows },
  ).toString();
  return JSON.parse(out.trim().split("\n").pop() ?? "{}");
}

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

describe("loadPublishedAammddFromRaw — cross-check contra past-editions-raw.json (#3207)", () => {
  function writeRaw(posts: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "mlp-raw-"));
    const p = join(dir, "past-editions-raw.json");
    writeFileSync(p, JSON.stringify(posts), "utf8");
    return p;
  }

  it("mapeia published_at pra AAMMDD via timezone BR (mesma conversão de refresh-past-editions.ts)", () => {
    const p = writeRaw([
      { id: "1", title: "A", published_at: "2026-07-06T12:00:00Z" },
      { id: "2", title: "B", published_at: "2026-07-07T12:00:00Z" },
    ]);
    const set = loadPublishedAammddFromRaw(p);
    assert.ok(set.has("260706"), `esperava 260706 no set — got: ${[...set].join(", ")}`);
    assert.ok(set.has("260707"), `esperava 260707 no set — got: ${[...set].join(", ")}`);
    assert.equal(set.size, 2);
  });

  it("retorna Set vazio quando o arquivo não existe (fail-soft)", () => {
    const set = loadPublishedAammddFromRaw(
      join(tmpdir(), "nonexistent-mlp-raw-dir", "past-editions-raw.json"),
    );
    assert.equal(set.size, 0);
  });

  it("retorna Set vazio quando o JSON é inválido (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlp-raw-bad-"));
    const p = join(dir, "past-editions-raw.json");
    writeFileSync(p, "{ not valid json", "utf8");
    assert.equal(loadPublishedAammddFromRaw(p).size, 0);
  });

  it("ignora posts sem published_at", () => {
    const p = writeRaw([{ id: "1", title: "sem data" }]);
    assert.equal(loadPublishedAammddFromRaw(p).size, 0);
  });
});

describe("isPublished — local OR raw (#3207)", () => {
  it("regression #3207: edição publicada em outra sessão (sem 05-published.json local) é detectada via raw", () => {
    const editionDir = mkdtempSync(join(tmpdir(), "mlp-ed-"));
    // Sem 05-published.json local — simula publicação em outra sessão/máquina
    // (o cenário exato do incidente 260710: 260706/260707 publicadas via
    // sessão paralela, sem 05-published.json local nunca escrito).
    const publishedInRaw = new Set(["260706"]);
    assert.equal(isPublished(editionDir, "260706", publishedInRaw), true);
  });

  it("edição não publicada em lugar nenhum (nem local, nem raw) retorna false", () => {
    const editionDir = mkdtempSync(join(tmpdir(), "mlp-ed-"));
    assert.equal(isPublished(editionDir, "260710", new Set<string>()), false);
  });

  it("preserva a detecção local pré-existente: 05-published.json com status published", () => {
    const editionDir = mkdtempSync(join(tmpdir(), "mlp-ed-"));
    writeFileSync(
      join(editionDir, "05-published.json"),
      JSON.stringify({ status: "published" }),
      "utf8",
    );
    // raw vazio (não passado / não encontrado) — a detecção precisa vir só do local.
    assert.equal(isPublished(editionDir, "260710", new Set<string>()), true);
  });

  it("preserva a detecção local pré-existente: 05-published.json com status != published retorna false", () => {
    const editionDir = mkdtempSync(join(tmpdir(), "mlp-ed-"));
    writeFileSync(
      join(editionDir, "05-published.json"),
      JSON.stringify({ status: "draft" }),
      "utf8",
    );
    assert.equal(isPublished(editionDir, "260710", new Set<string>()), false);
  });
});

// #3207: reproduz o incidente 260710 fim-a-fim via CLI real (não só as unidades
// puras acima) — garante que main() de fato lê --past-raw e propaga pro isPublished.
describe("merge-local-pending.ts CLI — --past-raw cross-check (#3207)", () => {
  it("regression #3207: edição sem 05-published.json local mas presente em past-editions-raw.json NÃO é reportada como pending", () => {
    const sandboxRoot = setupSandbox();
    try {
      // 260706: Stage 1 completo local, SEM 05-published.json — publicada
      // em outra sessão/máquina (o caso real do incidente).
      const publishedInternal = join(sandboxRoot, "data/editions/2607/260706/_internal");
      mkdirSync(publishedInternal, { recursive: true });
      writeFileSync(
        join(publishedInternal, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://x.com/d1-260706" }] }),
      );

      // 260708: Stage 1 completo local, SEM 05-published.json, e SEM entrada
      // correspondente no past-raw — deve continuar pending (comportamento
      // pré-#3207 preservado pra edições de fato não publicadas).
      const stillPendingInternal = join(sandboxRoot, "data/editions/2607/260708/_internal");
      mkdirSync(stillPendingInternal, { recursive: true });
      writeFileSync(
        join(stillPendingInternal, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://x.com/d1-260708" }] }),
      );

      // past-editions-raw.json — fonte Beehiiv REST (gerada por refresh-dedup),
      // já mostra 260706 publicada.
      const dataDir = join(sandboxRoot, "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "past-editions-raw.json"),
        JSON.stringify([
          {
            id: "post-260706",
            title: "Testei a Alexa+ por uma semana: o que mudou",
            web_url: "https://diaria.beehiiv.com/p/testei-a-alexa-por-uma-semana-o-que-mudou",
            published_at: "2026-07-06T12:00:00Z",
          },
        ]),
      );

      const result = runMergeLocalPending(sandboxRoot, [
        "--current", "260710",
        "--editions-dir", "data/editions/",
        "--window-days", "5",
        "--anchor-iso", "2026-07-10",
        "--past-raw", "data/past-editions-raw.json",
      ]);

      assert.equal(
        result.pending_found,
        1,
        `só 260708 deve sobrar como pending — got: ${JSON.stringify(result)}`,
      );
      const yymmdds = (result.editions ?? []).map((e) => e.yymmdd);
      assert.ok(
        !yymmdds.includes("260706"),
        "260706 (publicada via raw, sem 05-published.json local) não deve aparecer como pending",
      );
      assert.ok(
        yymmdds.includes("260708"),
        "260708 (não publicada em lugar nenhum) deve continuar pending",
      );
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("sem --past-raw e sem data/past-editions-raw.json no sandbox, cai no comportamento local-only pré-#3207", () => {
    const sandboxRoot = setupSandbox();
    try {
      const editionInternal = join(sandboxRoot, "data/editions/2607/260708/_internal");
      mkdirSync(editionInternal, { recursive: true });
      writeFileSync(
        join(editionInternal, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://x.com/d1-260708" }] }),
      );
      // Nenhum data/past-editions-raw.json no sandbox — loadPublishedAammddFromRaw
      // cai no DEFAULT_PAST_RAW_PATH, que também não existe → Set vazio, fail-soft.
      const result = runMergeLocalPending(sandboxRoot, [
        "--current", "260710",
        "--editions-dir", "data/editions/",
        "--window-days", "5",
        "--anchor-iso", "2026-07-10",
      ]);
      assert.equal(result.pending_found, 1, "sem past-raw disponível, comportamento é local-only");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
