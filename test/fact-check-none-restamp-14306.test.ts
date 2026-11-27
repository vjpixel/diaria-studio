/**
 * #14306 — plano NENHUMA com `content_hash` defasado nunca recarimbava.
 *
 * O `content_hash` é do arquivo inteiro e os hashes por unidade não são: uma
 * reordenação que preserva cada unidade (blocos de destaque trocados de
 * posição) muda o arquivo.
 * O plano sai NENHUMA, o passo 2 reaproveitava o `fact-check.json` com o
 * carimbo antigo, e o aviso "fact-check defasado" voltava a cada re-run (só
 * `--full` resolvia). Agora o passo 2 do NENHUMA recarimba com os hashes do
 * plano; edição feita DEPOIS do plano continua saindo defasada.
 *
 * Nunca toca rede real nem `data/` real (mesmo arranjo do teste do #14035).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { computeContentHash } from "../scripts/lib/fact-check-staleness.ts";
import { nonePlanStamps, planScopeForEdition } from "../scripts/run-fact-checker.ts";

const D1_URL = "https://example.com/d1";
const D2_URL = "https://example.com/d2";
const D3_URL = "https://example.com/d3";

function destaque(n: number, url: string, body: string): string[] {
  return [`**DESTAQUE ${n} | 🔬 PESQUISA**`, "", `**[Título do D${n}](${url})**`, "", body, "", "---", ""];
}

/**
 * Newsletter com os blocos dos destaques na ordem pedida. Trocar a posição de
 * dois blocos preserva cada unidade (cada bloco vai inteiro para o seu `d{N}`
 * e os separadores que caem no pool são idênticos) e muda o arquivo inteiro.
 */
function newsletter(o: { order?: number[]; d2?: string } = {}): string {
  const bodies: Record<number, [string, string]> = {
    1: [D1_URL, "Corpo do D1 com 58 empresas."],
    2: [D2_URL, o.d2 ?? "Corpo do D2: só 7% deixariam pagar."],
    3: [D3_URL, "Corpo do D3 com 4 níveis."],
  };
  return [
    "TÍTULO",
    "",
    "Título da edição",
    "",
    "---",
    "Olá! Intro.",
    "",
    "---",
    "",
    ...(o.order ?? [1, 2, 3]).flatMap((n) => destaque(n, ...bodies[n])),
    "RADAR",
    "",
    "**[Item do radar](https://example.com/r1)** grátis por 30 dias.",
    "",
  ].join("\n");
}

const SOCIAL = ["# Social", "", "## d1", "", "Legenda do D1.", "", "## d2", "", "Legenda do D2.", "", "## d3", "", "Legenda do D3.", ""].join(
  "\n",
);

function setupEdition(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fc-14306-")), "261126");
  mkdirSync(join(dir, "_internal", "fact-check-sources"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), newsletter(), "utf8");
  writeFileSync(join(dir, "03-social.md"), SOCIAL, "utf8");
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [{ url: D1_URL }, { url: D2_URL }, { url: D3_URL }] }),
    "utf8",
  );
  return dir;
}

function cleanup(dir: string) {
  rmSync(dirname(dir), { recursive: true, force: true });
}

function runCli(editionDir: string, extra: string[]) {
  const root = join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts", "run-fact-checker.ts"), "--edition-dir", editionDir, ...extra],
    { cwd: root, encoding: "utf8" },
  );
}

const claim = (destaque: number, text: string, context: string) => ({
  destaque,
  claim_type: "number",
  text,
  context,
  sources: ["newsletter"],
  verdict: "SUSTAINED",
});

/** 1º fact-check completo (agente grava, `--input-json` carimba). */
function firstFullCheck(dir: string): string {
  const fcPath = join(dir, "_internal", "fact-check.json");
  writeFileSync(
    fcPath,
    JSON.stringify({
      edition: "261126",
      checked_at: "2026-11-26T10:00:00Z",
      claims: [
        claim(1, "58 empresas", "Corpo do D1 com 58 empresas."),
        claim(2, "7%", "só 7% deixariam pagar"),
        claim(3, "4 níveis", "Corpo do D3 com 4 níveis."),
      ],
    }),
    "utf8",
  );
  const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
  assert.equal(r.status, 0, r.stderr);
  return fcPath;
}

const readFc = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const currentHash = (dir: string) =>
  computeContentHash(readFileSync(join(dir, "02-reviewed.md"), "utf8"), readFileSync(join(dir, "03-social.md"), "utf8"));

describe("#14306: plano NENHUMA recarimba o fact-check reaproveitado", () => {
  it("blocos de destaque trocados de posição: plano NENHUMA, passo 2 recarimba e o aviso de defasado some", () => {
    const dir = setupEdition();
    try {
      const fcPath = firstFullCheck(dir);
      const before = readFc(fcPath);
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ order: [1, 3, 2] }), "utf8");
      assert.notDeepEqual(currentHash(dir), before.content_hash, "o arquivo inteiro mudou");
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "none", "cada unidade ficou igual");

      const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /DEFASADO/);
      const after = readFc(fcPath);
      assert.deepEqual(after.content_hash, scope.content_hash);
      assert.deepEqual(after.content_hash, currentHash(dir));
      assert.deepEqual(after.unit_hashes, before.unit_hashes);
      assert.deepEqual(after.claims, before.claims, "claims reaproveitados intactos");

      // Re-rodar o passo 2 (o loop da issue) segue sem aviso.
      const again = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.doesNotMatch(again.stdout, /DEFASADO/);
    } finally {
      cleanup(dir);
    }
  });

  it("edição DEPOIS do plano NENHUMA continua saindo DEFASADA (recarimba com o plano, não com o atual)", () => {
    const dir = setupEdition();
    try {
      const fcPath = firstFullCheck(dir);
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ order: [1, 3, 2] }), "utf8");
      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "none");
      // Editor mexe no D2 entre o plano e o passo 2.
      writeFileSync(join(dir, "02-reviewed.md"), newsletter({ order: [1, 3, 2], d2: "Corpo do D2: só 9% deixariam pagar." }), "utf8");
      const r = runCli(dir, ["--input-json", fcPath, "--check-blocking"]);
      assert.match(r.stdout, /DEFASADO/);
      assert.deepEqual(readFc(fcPath).content_hash, scope.content_hash);
      assert.deepEqual(planScopeForEdition(dir).units, ["d2"], "o D2 mexido entra no próximo re-run");
    } finally {
      cleanup(dir);
    }
  });

  it("nonePlanStamps só recarimba quando o plano é NENHUMA e as unidades do resultado são as que ele comparou", () => {
    const dir = setupEdition();
    try {
      const internal = join(dir, "_internal");
      const fcPath = firstFullCheck(dir);
      const units = readFc(fcPath).unit_hashes;
      assert.equal(nonePlanStamps(internal, units), null, "sem plano: mantém o carimbo");

      const scope = planScopeForEdition(dir);
      assert.equal(scope.mode, "none");
      assert.deepEqual(nonePlanStamps(internal, units), { content_hash: scope.content_hash, unit_hashes: scope.unit_hashes });

      const other = { ...units, units: { ...units.units, d2: "0000000000000000" } };
      assert.equal(nonePlanStamps(internal, other), null, "fact-check.json diferente do que o plano comparou");
      assert.equal(nonePlanStamps(internal, undefined), null, "resultado sem carimbo por unidade");

      planScopeForEdition(dir, { forceFull: true });
      assert.equal(nonePlanStamps(internal, units), null, "plano COMPLETO não recarimba por este caminho");
    } finally {
      cleanup(dir);
    }
  });
});
