/**
 * #10544 — o #10463 aplicou `publishedOnly` só à leitura do MESMO FATO; a
 * leitura do check de TEMA SECUNDÁRIO (`main()` de check-highlight-themes.ts)
 * seguia lendo o `01-approved.json` cru — item aprovado no gate 1 mas cortado
 * no cap do Stage 2 (fora do `02-reviewed.md`) gerava "SECUNDÁRIO repete
 * tema" contra algo que nenhum leitor recebeu.
 *
 * O defeito estava na chamada dentro de `main()`, então o teste roda a CLI
 * de verdade (subprocess) contra fixtures em tmpdir — testar só
 * `readPastApprovedSecondary` passaria mesmo com o bug.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-highlight-themes.ts");

const PAST_CUT = {
  url: "https://developer.nvidia.com/blog/nemotron-super-vl-agentes",
  title: "NVIDIA Nemotron Super VL acelera agentes multimodais corporativos",
};
const PAST_PUBLISHED = { url: "https://x.ai/news/grok-voice-3", title: "Grok Voice turbina agentes de voz da xAI" };

const CURRENT_RADAR_SAME_AS_CUT = {
  url: "https://blogs.nvidia.com/blog/nemotron-super-vl/",
  title: "NVIDIA Nemotron Super VL acelera agentes multimodais abertos",
};
const CURRENT_RADAR_SAME_AS_PUBLISHED = {
  url: "https://docs.x.ai/developers/models/grok-voice",
  title: "Grok Voice turbina agentes de voz em tempo real",
};

function fixture(withReviewed: boolean): { root: string; editionsDir: string; categorized: string } {
  const root = mkdtempSync(join(tmpdir(), "sec-theme-10544-"));
  const editionsDir = join(root, "editions");
  const past = join(editionsDir, "2610", "261016");
  mkdirSync(join(past, "_internal"), { recursive: true });
  writeFileSync(
    join(past, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [], lancamento: [PAST_PUBLISHED, PAST_CUT], radar: [] }),
  );
  if (withReviewed) {
    // Só o Grok saiu; o Nemotron caiu no cap do Stage 2.
    writeFileSync(join(past, "02-reviewed.md"), `**🚀 LANÇAMENTOS**\n\n**[${PAST_PUBLISHED.title}](${PAST_PUBLISHED.url})**\nTexto.\n`);
  }
  const cur = join(editionsDir, "2610", "261019", "_internal");
  mkdirSync(cur, { recursive: true });
  const categorized = join(cur, "01-categorized.json");
  writeFileSync(
    categorized,
    JSON.stringify({ highlights: [], radar: [CURRENT_RADAR_SAME_AS_CUT, CURRENT_RADAR_SAME_AS_PUBLISHED], lancamento: [] }),
  );
  return { root, editionsDir, categorized };
}

function runCli(editionsDir: string, categorized: string): { secondary_warnings: Array<{ item_url: string; matched_title: string }> } {
  const r = spawnSync(
    process.execPath,
    [
      "--import", "tsx", SCRIPT,
      "--categorized", categorized,
      "--past-editions", join(editionsDir, "nao-existe.md"),
      "--editions-dir", editionsDir,
      "--current-edition", "261019",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe("#10544: tema secundário só contra o que de fato saiu", () => {
  it("item cortado depois do gate 1 não gera aviso secundário; o publicado segue gerando", () => {
    const { root, editionsDir, categorized } = fixture(true);
    try {
      const out = runCli(editionsDir, categorized);
      const urls = out.secondary_warnings.map((w) => w.item_url);
      assert.ok(!urls.includes(CURRENT_RADAR_SAME_AS_CUT.url), "Nemotron cortado em 261016 não é repetição");
      assert.ok(urls.includes(CURRENT_RADAR_SAME_AS_PUBLISHED.url), "Grok publicado em 261016 segue avisando");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem 02-reviewed.md a edição entra inteira (fail-soft conservador)", () => {
    const { root, editionsDir, categorized } = fixture(false);
    try {
      const urls = runCli(editionsDir, categorized).secondary_warnings.map((w) => w.item_url);
      assert.ok(urls.includes(CURRENT_RADAR_SAME_AS_CUT.url));
      assert.ok(urls.includes(CURRENT_RADAR_SAME_AS_PUBLISHED.url));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
