/**
 * #14133: sentinel presente mas sem `outputs` (ou com `outputs` que não é
 * array de strings, ou JSON ilegível) estourava TypeError em `assertSentinel`
 * (`sentinel.outputs.filter`) e o CLI saía 1, o mesmo código de "sentinel
 * ausente": o resume check concluía que o stage não rodou. Agora é
 * `sentinel_malformed`, exit 4, com o caminho e a causa na mensagem.
 * A validação continua rejeitando: nenhum desses casos passa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSentinel, writeSentinel } from "../scripts/lib/pipeline-state.ts";
import {
  describeWaitReason,
  formatMalformedSentinelError,
  SENTINEL_MALFORMED_EXIT,
} from "../scripts/pipeline-sentinel.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-sentinel-14133-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "x", "utf8");
  return dir;
}

function writeRaw(dir: string, step: number, raw: string): string {
  const p = join(dir, "_internal", `.step-${step}-done.json`);
  writeFileSync(p, raw, "utf8");
  return p;
}

function runAssert(dir: string, step: number) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", sentinelCli, "assert", "--edition", "260828", "--step", String(step), "--dir", dir],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { status: r.status, stderr: r.stderr };
}

// O sentinel real do 260828 (escrito à mão por uma sessão), citado na issue.
const SENTINEL_260828 = JSON.stringify({ approved: true, approved_at: "2026-08-27T22:10:00.000Z", gate: "stage4-revisao" });

const MALFORMED: Array<{ name: string; raw: string; detail: RegExp }> = [
  { name: "{} (sem outputs)", raw: "{}", detail: /sem o campo outputs/ },
  { name: "sentinel do 260828 (sem outputs)", raw: SENTINEL_260828, detail: /sem o campo outputs/ },
  { name: "{outputs:null}", raw: JSON.stringify({ outputs: null }), detail: /outputs não é array \(null\)/ },
  { name: '{outputs:"x"}', raw: JSON.stringify({ outputs: "x" }), detail: /outputs não é array \(string\)/ },
  { name: "{outputs:[1]}", raw: JSON.stringify({ outputs: [1] }), detail: /outputs\[0\] não é string \(number\)/ },
  { name: "array no topo", raw: "[]", detail: /não é um objeto JSON \(array\)/ },
  { name: "null no topo", raw: "null", detail: /não é um objeto JSON \(null\)/ },
  { name: "JSON ilegível", raw: "{\"outputs\": [", detail: /JSON ilegível/ },
];

describe("assertSentinel com sentinel malformado (#14133)", () => {
  for (const c of MALFORMED) {
    it(`${c.name} → sentinel_malformed, sem TypeError`, () => {
      const dir = makeEdition();
      try {
        const p = writeRaw(dir, 4, c.raw);
        const r = assertSentinel(dir, 4);
        assert.equal(r.ok, false);
        assert.ok(!r.ok && r.reason === "sentinel_malformed", JSON.stringify(r));
        if (!r.ok && r.reason === "sentinel_malformed") {
          assert.equal(resolve(r.path), resolve(p));
          assert.match(r.detail, c.detail);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("arquivo ausente continua sentinel_missing", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(assertSentinel(dir, 4), { ok: false, reason: "sentinel_missing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sentinel válido continua ok, e outputs ausentes continuam outputs_missing", () => {
    const dir = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md"]);
      assert.deepEqual(assertSentinel(dir, 4), { ok: true });
      writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
      assert.deepEqual(assertSentinel(dir, 4), {
        ok: false,
        reason: "outputs_missing",
        missingOutputs: ["03-social.md"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linha [aguardando] e mensagem de erro nomeiam a causa", () => {
    const r = { ok: false as const, reason: "sentinel_malformed" as const, path: "/x/_internal/.step-4-done.json", detail: "sem o campo outputs" };
    assert.equal(describeWaitReason(r), "sentinel_malformed (sem o campo outputs)");
    const msg = formatMalformedSentinelError(4, r);
    assert.match(msg, /sentinel step 4 presente mas inválido: \/x\/_internal\/\.step-4-done\.json — sem o campo outputs/);
    assert.doesNotMatch(msg, /ausente/);
  });
});

describe("pipeline-sentinel assert com sentinel malformado (CLI, #14133)", () => {
  it("exit de malformado é distinto de 0, 1, 2 e 3", () => {
    assert.ok(![0, 1, 2, 3].includes(SENTINEL_MALFORMED_EXIT));
  });

  for (const c of MALFORMED.filter((m) => /sem outputs|null\}|"x"|ilegível/.test(m.name))) {
    it(`${c.name} → exit ${SENTINEL_MALFORMED_EXIT} com caminho e causa, sem TypeError`, () => {
      const dir = makeEdition();
      try {
        writeRaw(dir, 4, c.raw);
        const { status, stderr } = runAssert(dir, 4);
        assert.equal(status, SENTINEL_MALFORMED_EXIT, stderr);
        assert.match(stderr, /sentinel step 4 presente mas inválido: .*\.step-4-done\.json/);
        assert.match(stderr, c.detail);
        assert.doesNotMatch(stderr, /TypeError/);
        assert.doesNotMatch(stderr, /ausente em/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("arquivo ausente → exit 1 com 'ausente'", () => {
    const dir = makeEdition();
    try {
      const { status, stderr } = runAssert(dir, 4);
      assert.equal(status, 1, stderr);
      assert.match(stderr, /sentinel step 4 ausente em/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sentinel válido → exit 0", () => {
    const dir = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md"]);
      const { status, stderr } = runAssert(dir, 4);
      assert.equal(status, 0, stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
