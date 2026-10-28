/**
 * #11497 — `swap-destaque.ts --promote bucket:idx` aplicava o MESMO índice a
 * `01-approved.json` e a `01-approved-capped.json`, mas o bucket tem tamanho e
 * ordem diferentes nos dois. Edição 261029: `--promote radar:2 --demote d1`
 * promoveu a matéria certa (Lula) no approved (radar com 77 itens) e a errada
 * (CNN, índice 2 do radar de 5 itens do capped) no capped, que é o que o
 * writer-destaque lê. Agora o item do capped é localizado pela URL e os dois
 * highlights[] são conferidos depois da troca.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBucketIndexByUrl, highlightUrlDivergence } from "../scripts/swap-destaque.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LULA = "https://example.com/lula-ia-brasileira";
const CNN = "https://example.com/cnn-fragilidade-internet";

const HIGHLIGHTS = [
  { rank: 1, bucket: "radar", url: "https://example.com/d1", title: "D1 original" },
  { rank: 2, bucket: "radar", url: "https://example.com/d2", title: "D2" },
  { rank: 3, bucket: "lancamento", url: "https://example.com/d3", title: "D3" },
];

/** Radar longo no approved (Lula no índice 2). */
const APPROVED = {
  highlights: HIGHLIGHTS,
  runners_up: [],
  lancamento: [],
  radar: [
    { url: "https://example.com/r0", title: "Radar 0" },
    { url: "https://example.com/r1", title: "Radar 1" },
    { url: LULA, title: "Reeleito, Lula fala em criar IA brasileira" },
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/extra-${i}`, title: `Extra ${i}` })),
    { url: CNN, title: "IA expôs a fragilidade da internet" },
  ],
  use_melhor: [],
  video: [],
};

/** Radar cortado no capped, em outra ordem (CNN no índice 2, Lula no 4). */
const CAPPED = {
  highlights: HIGHLIGHTS,
  runners_up: [],
  lancamento: [],
  radar: [
    { url: "https://example.com/r0", title: "Radar 0" },
    { url: "https://example.com/r1", title: "Radar 1" },
    { url: CNN, title: "IA expôs a fragilidade da internet" },
    { url: "https://example.com/extra-0", title: "Extra 0" },
    { url: `${LULA}/`, title: "Reeleito, Lula fala em criar IA brasileira" },
  ],
  use_melhor: [],
  video: [],
};

function makeEdition(capped: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-11497-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(APPROVED, null, 2));
  writeFileSync(join(internal, "01-approved-capped.json"), JSON.stringify(capped, null, 2));
  return dir;
}

function run(dir: string, extra: string[] = []): { status: number; stderr: string } {
  try {
    execFileSync(
      process.execPath,
      [
        "--import", "tsx", resolve(ROOT, "scripts", "swap-destaque.ts"),
        "--edition", "261029", "--edition-dir", dir,
        "--promote", "radar:2", "--demote", "d1", ...extra,
      ],
      { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { stderr?: string; status?: number };
    return { status: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

const read = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(dir, "_internal", name), "utf8")) as {
    highlights: { url?: string; article?: { url?: string } }[];
    radar: { url: string }[];
  };
const hUrl = (h: { url?: string; article?: { url?: string } }) => h.url ?? h.article?.url;

describe("swap-destaque --promote com buckets de tamanho diferente (#11497)", () => {
  it("promove a MESMA matéria nos dois arquivos (cenário 261029)", () => {
    const dir = makeEdition(CAPPED);
    try {
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      const approved = read(dir, "01-approved.json");
      const capped = read(dir, "01-approved-capped.json");
      assert.equal(hUrl(approved.highlights[0]), LULA);
      assert.match(String(hUrl(capped.highlights[0])), /lula-ia-brasileira/);
      // A Lula saiu do radar do capped; a CNN continua lá.
      assert.ok(!capped.radar.some((it) => it.url.includes("lula-ia-brasileira")));
      assert.ok(capped.radar.some((it) => it.url === CNN));
      // O D1 rebaixado volta ao radar nos dois.
      assert.equal(capped.radar[0].url, "https://example.com/d1");
      assert.equal(approved.radar[0].url, "https://example.com/d1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("item ausente do bucket no capped: destaque recebe o item do approved, com aviso", () => {
    const capped = { ...CAPPED, radar: CAPPED.radar.filter((it) => !it.url.includes("lula")) };
    const dir = makeEdition(capped);
    try {
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      const out = read(dir, "01-approved-capped.json");
      assert.equal(hUrl(out.highlights[0]), LULA);
      assert.ok(out.radar.some((it) => it.url === CNN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("highlights[] já divergentes entre os arquivos: aborta com exit 1 sem gravar nada", () => {
    const capped = {
      ...CAPPED,
      highlights: [HIGHLIGHTS[0], { ...HIGHLIGHTS[1], url: "https://example.com/outro-d2" }, HIGHLIGHTS[2]],
    };
    const dir = makeEdition(capped);
    const before = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
    try {
      const r = run(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /divergem/);
      assert.match(r.stderr, /D2:/);
      assert.equal(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("helpers puros (#11497)", () => {
  it("findBucketIndexByUrl compara por URL canônica e devolve -1 quando falta", () => {
    assert.equal(findBucketIndexByUrl(CAPPED, "radar", LULA), 4);
    assert.equal(findBucketIndexByUrl(APPROVED, "radar", LULA), 2);
    assert.equal(findBucketIndexByUrl(CAPPED, "radar", "https://example.com/nada"), -1);
    assert.equal(findBucketIndexByUrl(CAPPED, "inexistente", LULA), -1);
  });

  it("highlightUrlDivergence aponta posição e tamanho", () => {
    assert.deepEqual(highlightUrlDivergence(APPROVED, CAPPED), []);
    const d = highlightUrlDivergence(APPROVED, { highlights: [HIGHLIGHTS[1]] });
    assert.equal(d.length, 2);
    assert.match(d[0], /1 em 01-approved-capped/);
    assert.match(d[1], /^D1:/);
  });
});
