/**
 * test/weekly-video-override-13820.test.ts (#13820)
 *
 * Vídeo da semana escolhido por flag (`--video-edition`/`--video-url`), mesmo de
 * edição fora da janela, e a escolha sobrevive à re-seleção do pós-gate.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyVideoOverride,
  readVideoOverrideMarker,
  resolveVideoOverride,
} from "../scripts/lib/weekly-video-override.ts";
import { resolveVideoCarry } from "../scripts/select-linkedin-weekly.ts";
import { applyVideoOverrideArg } from "../scripts/render-linkedin-weekly.ts";
import {
  chosenStackVideo,
  dropStaleStackCopyVideoDescription,
  runCircleStack,
  type RunCircleStackDeps,
} from "../scripts/publish-circle-stack.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const OLD_URL = "https://youtu.be/aaaaaaaaaaa";
const NEW_URL = "https://youtu.be/bbbbbbbbbbb";

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "vo13820-"));
  dirs.push(root);
  const ed = join(root, "data/editions/2611/261112/_internal");
  mkdirSync(ed, { recursive: true });
  writeFileSync(join(ed, "05-video-url.txt"), NEW_URL + "\n");
  writeFileSync(join(ed, "05-youtube-published.json"), JSON.stringify({ videoId: "bbbbbbbbbbb", title: "Claude Code pode ter vazado suas senhas" }));
  return root;
}

describe("resolveVideoOverride", () => {
  it("resolve título e URL pela edição, fora da janela", () => {
    const root = setup();
    const r = resolveVideoOverride({ editionsRoot: join(root, "data/editions"), videoEdition: "261112" });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.video, { title: "Claude Code pode ter vazado suas senhas", url: NEW_URL, editionDate: "261112" });
  });
  it("--video-url sozinho acha a edição pelo id", () => {
    const root = setup();
    const r = resolveVideoOverride({ editionsRoot: join(root, "data/editions"), videoUrl: NEW_URL });
    assert.ok(r.ok && r.video.editionDate === "261112");
  });
  it("recusa edição sem vídeo e URL de outro vídeo", () => {
    const root = setup();
    assert.equal(resolveVideoOverride({ editionsRoot: join(root, "data/editions"), videoEdition: "261113" }).ok, false);
    assert.equal(resolveVideoOverride({ editionsRoot: join(root, "data/editions"), videoEdition: "261112", videoUrl: OLD_URL }).ok, false);
  });
});

describe("applyVideoOverride", () => {
  it("troca de vídeo descarta pitch e description; mesmo vídeo mantém", () => {
    const marker = { editionDate: "261112", url: NEW_URL };
    const video = { title: "t", url: NEW_URL, editionDate: "261112" };
    const trocado = applyVideoOverride({ video: { title: "x", url: OLD_URL, editionDate: "261116", pitch: "p", description: "d" } }, { video, marker });
    assert.equal((trocado.selection.video as { pitch?: string }).pitch, undefined);
    assert.equal(trocado.invalidated.length, 2);
    const igual = applyVideoOverride({ video: { ...video, pitch: "p" } }, { video, marker });
    assert.equal((igual.selection.video as { pitch?: string }).pitch, "p");
    assert.deepEqual(igual.invalidated, []);
  });
});

describe("re-seleção pós-gate preserva o override (select-linkedin-weekly)", () => {
  it("sem flag, reaplica video + videoOverride gravados; com --video-auto, solta", () => {
    const root = setup();
    const sel = join(root, "ln-selection.json");
    const video = { title: "t", url: NEW_URL, editionDate: "261112", pitch: "frase" };
    writeFileSync(sel, JSON.stringify({ video, videoOverride: { editionDate: "261112", url: NEW_URL } }));
    const carry = resolveVideoCarry(sel, join(root, "data/editions"), []);
    assert.deepEqual(carry.video, video);
    assert.deepEqual(readVideoOverrideMarker(carry), { editionDate: "261112", url: NEW_URL });
    assert.deepEqual(resolveVideoCarry(sel, join(root, "data/editions"), ["--video-auto"]), {});
  });
  it("vídeo automático (sem marcador) não é carregado", () => {
    const root = setup();
    const sel = join(root, "ln-selection.json");
    writeFileSync(sel, JSON.stringify({ video: { title: "t", url: OLD_URL, editionDate: "261116" } }));
    assert.deepEqual(resolveVideoCarry(sel, join(root, "data/editions"), []), {});
  });
  it("flag grava o vídeo da edição fora da janela", () => {
    const root = setup();
    const sel = join(root, "ln-selection.json");
    writeFileSync(sel, JSON.stringify({ video: { title: "x", url: OLD_URL, editionDate: "261116", pitch: "velha" } }));
    const carry = resolveVideoCarry(sel, join(root, "data/editions"), ["--video-edition", "261112"]);
    assert.equal((carry.video as { url: string }).url, NEW_URL);
    assert.equal((carry.video as { pitch?: string }).pitch, undefined);
  });
});

describe("render e Stack", () => {
  it("render: --video-edition regrava ln-selection.json e descarta a frase", () => {
    const root = setup();
    const dir = join(root, "data/weekly/26w47/_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ln-selection.json"),
      JSON.stringify({ cycle: "26w47", headlines: [], useMelhor: null, weeklyEditions: [], video: { title: "x", url: OLD_URL, editionDate: "261116", pitch: "velha" } }),
    );
    const r = applyVideoOverrideArg(root, "26w47", ["--video-edition", "261112"]);
    assert.ok(r.applied && r.invalidated.length === 1);
    const out = JSON.parse(readFileSync(join(dir, "ln-selection.json"), "utf8"));
    assert.equal(out.video.url, NEW_URL);
    assert.equal(out.video.pitch, undefined);
    assert.equal(out.videoOverride.editionDate, "261112");
  });
  it("Stack: marcador gravado vence o mais visto no --reselect", () => {
    const root = setup();
    const sel = join(root, "circle-stack-selection.json");
    writeFileSync(sel, JSON.stringify({ video: { title: "t", url: NEW_URL, editionDate: "261112" }, videoOverride: { editionDate: "261112", url: NEW_URL } }));
    const c = chosenStackVideo([], sel, root, new Map());
    assert.equal(c?.video.url, NEW_URL);
    assert.equal(chosenStackVideo(["--video-auto"], sel, root, new Map()), null);
  });
});

describe("review da PR #13857", () => {
  it("finding 1: troca de vídeo remove videoDescription do circle-stack-copy.json", () => {
    const root = setup();
    const copyPath = join(root, "circle-stack-copy.json");
    writeFileSync(copyPath, JSON.stringify({ cycle: "26w47", opening: "o", notes: [], videoDescription: "sobre o vídeo velho" }));
    const warns = captureWarnSync(() => assert.equal(dropStaleStackCopyVideoDescription(copyPath), true));
    const out = JSON.parse(readFileSync(copyPath, "utf8"));
    assert.equal(out.videoDescription, undefined);
    assert.equal(out.opening, "o");
    assert.ok(warns.some((w) => /stack-writer/.test(w)));
    assert.equal(dropStaleStackCopyVideoDescription(copyPath), false);
    assert.equal(dropStaleStackCopyVideoDescription(join(root, "ausente.json")), false);
  });
  it("finding 1: runCircleStack com --video-edition na seleção gravada invalida a descrição do copy", async () => {
    const root = setup();
    const internal = join(root, "data/weekly/26w43/_internal");
    mkdirSync(internal, { recursive: true });
    const selPath = join(internal, "circle-stack-selection.json");
    const copyPath = join(internal, "circle-stack-copy.json");
    const stored = {
      cycle: "26w43",
      contentWindow: [],
      weeklyEditions: [],
      editionsWithoutEdition: [],
      destaques: [],
      lancamentos: [],
      useMelhor: [],
      radar: [],
      warnings: [],
      video: { title: "x", url: OLD_URL, editionDate: "261116", description: "velha" },
    };
    writeFileSync(selPath, JSON.stringify(stored));
    writeFileSync(copyPath, JSON.stringify({ cycle: "26w43", opening: "o", notes: [], videoDescription: "velha" }));
    await quiet(() =>
      runCircleStack(["--publish-monday", "261026", "--data-root", root, "--video-edition", "261112"], stackDeps()).catch(() => undefined),
    );
    const sel = JSON.parse(readFileSync(selPath, "utf8"));
    assert.equal(sel.video.url, NEW_URL);
    assert.equal(JSON.parse(readFileSync(copyPath, "utf8")).videoDescription, undefined);
  });
  it("finding 2: marcador sem video avisa em vez de sumir em silêncio", () => {
    const root = setup();
    const sel = join(root, "ln-selection.json");
    writeFileSync(sel, JSON.stringify({ videoOverride: { editionDate: "261112", url: NEW_URL } }));
    let carry: Record<string, unknown> = { x: 1 };
    const warns = captureWarnSync(() => {
      carry = resolveVideoCarry(sel, join(root, "data/editions"), []);
    });
    assert.deepEqual(carry, {});
    assert.ok(warns.some((w) => /videoOverride/.test(w) && /--video-edition 261112/.test(w)));
  });
  it("finding 3: --video-auto + --publish sem --reselect na seleção gravada é recusado antes de qualquer envio", async () => {
    const root = setup();
    const internal = join(root, "data/weekly/26w43/_internal");
    mkdirSync(internal, { recursive: true });
    const selPath = join(internal, "circle-stack-selection.json");
    const before = JSON.stringify({ video: { title: "t", url: NEW_URL, editionDate: "261112" }, videoOverride: { editionDate: "261112", url: NEW_URL } });
    writeFileSync(selPath, before);
    await assert.rejects(
      runCircleStack(["--publish-monday", "261026", "--data-root", root, "--video-auto", "--publish"], stackDeps()),
      /--video-auto com --publish exige --reselect/,
    );
    assert.equal(readFileSync(selPath, "utf8"), before, "a seleção não foi tocada");
  });
});

function stackDeps(): RunCircleStackDeps {
  return {
    rootDir: resolve(import.meta.dirname, ".."),
    platformConfig: { circle_stack: { enabled: true } },
    env: {},
    translateCall: () => JSON.stringify({ items: [] }),
    send: async () => {
      throw new Error("não deveria enviar");
    },
    ghRun: () => ({ status: 0, stdout: "[]", stderr: "" }),
    topVideo: async () => null,
  };
}

function captureWarnSync(fn: () => void): string[] {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

async function quiet(fn: () => Promise<unknown>): Promise<void> {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, o);
  }
}
