/**
 * #12589: `whatsappUrl` (e `metaDescriptionSuggestion`) de
 * `_internal/stage4-capture-state.json` sobreviviam à troca do D1 no Stage 4.
 * Edição 261109: o `swap-destaques` trocou Nubank por Nvidia no D1 e o gate
 * seguiu mostrando o link de compartilhamento da notícia do Nubank.
 *
 * Cobre o helper `invalidateStage4D1Capture` e os 2 caminhos de CLI mais
 * usados no gate (`swap-destaques.ts` e `reorder-destaques.ts`): trocar o D1
 * zera os 2 valores; trocar só D2/D3 os preserva.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  invalidateStage4D1Capture,
  readStage4CaptureState,
  writeStage4CaptureState,
} from "../scripts/lib/stage4-capture-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STALE_URL =
  "https://diar.ia.br/p/nubank-demite-30-apos-ia-cortar-fila-de-fraudes?utm_source=whatsapp&utm_medium=share&utm_campaign=261109";

function runCli(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function approved(): Record<string, unknown> {
  return {
    highlights: [
      { rank: 1, score: 90, bucket: "lancamento", url: "https://example.com/d1", title_options: ["Nubank demite 30% após IA cortar fila de fraudes"] },
      { rank: 2, score: 80, bucket: "radar", url: "https://example.com/d2", title_options: ["Título D2"] },
      { rank: 3, score: 70, bucket: "radar", url: "https://example.com/d3", title_options: ["Título D3"] },
    ],
    radar: [{ url: "https://example.com/radar-0", title: "Item RADAR 0" }],
    lancamento: [],
    use_melhor: [],
    video: [],
    runners_up: [],
  };
}

function reviewedMd(): string {
  return `Intro.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Nubank demite 30% após IA cortar fila de fraudes](https://example.com/d1)**

${"A".repeat(300)}

---

**DESTAQUE 2 | 📡 RADAR**

**[Título D2](https://example.com/d2)**

${"B".repeat(300)}

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Título D3](https://example.com/d3)**

${"C".repeat(300)}

---

**📡 RADAR**

[Link radar](https://example.com/r)
`;
}

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "d1-capture-12589-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "01-approved.json"), JSON.stringify(approved(), null, 2));
  writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify(approved(), null, 2));
  writeFileSync(join(dir, "02-reviewed.md"), reviewedMd());
  writeStage4CaptureState(dir, { whatsappUrl: STALE_URL, metaDescriptionSuggestion: "Nubank demite 30%." });
  return dir;
}

describe("invalidateStage4D1Capture (#12589)", () => {
  it("zera whatsappUrl e metaDescriptionSuggestion e reporta o arquivo", () => {
    const dir = makeEdition();
    try {
      const r = invalidateStage4D1Capture(dir);
      assert.ok(r.rewritten?.endsWith("stage4-capture-state.json"));
      assert.match(r.message ?? "", /#12589/);
      const s = readStage4CaptureState(dir);
      assert.equal(s.whatsappUrl, null);
      assert.equal(s.metaDescriptionSuggestion, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-op quando o estado nunca foi gravado (não cria o arquivo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-capture-12589-empty-"));
    try {
      assert.deepEqual(invalidateStage4D1Capture(dir), {});
      assert.equal(existsSync(join(dir, "_internal", "stage4-capture-state.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-op quando os 2 campos já são null", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-capture-12589-null-"));
    try {
      writeStage4CaptureState(dir, { whatsappUrl: null, metaDescriptionSuggestion: null });
      assert.deepEqual(invalidateStage4D1Capture(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swap-destaques.ts não deixa o whatsappUrl do D1 antigo (#12589)", () => {
  it("trocar o D1 zera whatsappUrl/metaDescriptionSuggestion", () => {
    const dir = makeEdition();
    try {
      const r = runCli("swap-destaques.ts", [
        "--edition", "261109",
        "--edition-dir", dir,
        "--d1-url", "https://example.com/nvidia",
        "--d1-title", "Nvidia: CEO admite caso com suposta espiã",
        "--drop",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const s = readStage4CaptureState(dir);
      assert.equal(s.whatsappUrl, null, "whatsappUrl do D1 antigo sobreviveu ao swap");
      assert.equal(s.metaDescriptionSuggestion, null);
      const out = JSON.parse(r.stdout) as { warnings: string[] };
      assert.ok(out.warnings.some((w) => w.includes("#12589")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trocar só o D2 preserva os valores do D1", () => {
    const dir = makeEdition();
    try {
      const r = runCli("swap-destaques.ts", [
        "--edition", "261109",
        "--edition-dir", dir,
        "--d2-url", "https://example.com/novo-d2",
        "--d2-title", "Novo D2",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const s = readStage4CaptureState(dir);
      assert.equal(s.whatsappUrl, STALE_URL);
      assert.equal(s.metaDescriptionSuggestion, "Nubank demite 30%.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reorder-destaques.ts não deixa o whatsappUrl do D1 antigo (#12589)", () => {
  it("reorder que muda o D1 zera os valores", () => {
    const dir = makeEdition();
    try {
      const r = runCli("reorder-destaques.ts", ["--edition", "261109", "--edition-dir", dir, "--new-order", "2,1,3"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readStage4CaptureState(dir).whatsappUrl, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reorder que mantém o D1 preserva os valores", () => {
    const dir = makeEdition();
    try {
      const r = runCli("reorder-destaques.ts", ["--edition", "261109", "--edition-dir", dir, "--new-order", "1,3,2"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readStage4CaptureState(dir).whatsappUrl, STALE_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não toca o estado", () => {
    const dir = makeEdition();
    try {
      const r = runCli("reorder-destaques.ts", [
        "--edition", "261109", "--edition-dir", dir, "--new-order", "2,1,3", "--dry-run",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readStage4CaptureState(dir).whatsappUrl, STALE_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
