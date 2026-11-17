// #13401: a capa do Short vem do roteiro (sem --hook) e o roteiro acusa capa
// de vertical que o gerador recusa, com a mesma regra do gerador.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errosCapaVertical, main } from "../scripts/video-roteiro-blocos.ts";
import { hookHorizontalDoRoteiro, normalizeShortCoverHook, splitHook } from "../scripts/lib/diaria/youtube-thumb.ts";
import { parseRoteiroCapaVideo, resolverHookDaCapa } from "../scripts/lib/diaria/youtube-thumb-roteiro.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261117.json", import.meta.url), "utf8"));
/** A capa real do vertical 1 da 261117: 6 palavras, recusada pelo gerador na publicação. */
const CAPA_REAL_261117 = "A voz do Drauzio é falsa";

function roteiroCom(capas: Partial<Record<"horizontal" | "vertical1" | "vertical2", string>>) {
  const r = structuredClone(FIXTURE);
  for (const [v, capa] of Object.entries(capas)) r.porVideo[v].capa = capa;
  return r;
}

function edicaoCom(roteiro: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "capa-13401-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify(roteiro));
  return dir;
}

function logs() {
  const warn: string[] = [];
  const premissa: string[] = [];
  return { warn, premissa, log: { warn: (m: string) => warn.push(m), premissa: (m: string) => premissa.push(m) } };
}

describe("video-roteiro-blocos acusa capa de vertical fora da regra do gerador (#13401)", () => {
  it("a capa real da 261117 (6 palavras) é erro, com a contagem do gerador", () => {
    assert.throws(() => normalizeShortCoverHook(CAPA_REAL_261117), /6 palavra/);
    const erros = errosCapaVertical(roteiroCom({ vertical1: CAPA_REAL_261117 }));
    assert.equal(erros.length, 1);
    assert.match(erros[0], /^porVideo\.vertical1\.capa \(vertical 1\): .*6 palavra\(s\)/);
  });

  it("5 palavras passam, moeda + número contam como 1 (regra do gerador), e o horizontal não entra", () => {
    assert.deepEqual(errosCapaVertical(FIXTURE), []);
    assert.deepEqual(errosCapaVertical(roteiroCom({ vertical2: "Paga R$ 100 por mês?" })), []);
    assert.deepEqual(errosCapaVertical(roteiroCom({ horizontal: "Seu pai pode cair nessa agora" })), []);
    assert.match(errosCapaVertical(roteiroCom({ vertical2: "Golpe" }))[0], /vertical2\.capa .*1 palavra/);
  });

  it("CLI: exit 2 com [erro], e a proposta sai mesmo assim; capa válida segue exit 0", () => {
    const dir = edicaoCom(roteiroCom({ vertical1: CAPA_REAL_261117 }));
    try {
      const falas = join(dir, "_internal", "roteiro-falas.json");
      const err: string[] = [];
      const out: string[] = [];
      assert.equal(main(["261117", "--falas", falas, "--json"], { err: (s) => err.push(s), out: (s) => out.push(s) }, dir), 2);
      assert.ok(err.some((s) => /^\[erro\] porVideo\.vertical1\.capa/.test(s)));
      assert.ok(JSON.parse(out[0]).duracoes);
      writeFileSync(falas, JSON.stringify(FIXTURE));
      assert.equal(main(["261117", "--falas", falas, "--json"], { err: () => {}, out: () => {} }, dir), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gen-youtube-thumb: gancho da capa vindo do roteiro (#13401)", () => {
  it("Short sem --hook usa porVideo.vertical1.capa, com [premissa] dizendo de onde veio", () => {
    const dir = edicaoCom(FIXTURE);
    try {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir }, l.log), "Drauzio nunca vendeu essa cura");
      assert.equal(l.premissa.length, 1);
      assert.match(l.premissa[0], /porVideo\.vertical1\.capa/);
      assert.ok(l.premissa[0].includes(join(dir, "_internal", "roteiro-falas.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--hook explícito sobrepõe o roteiro, sem premissa", () => {
    const dir = edicaoCom(FIXTURE);
    try {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", hook: "Médico falso, golpe real", editionDir: dir }, l.log), "Médico falso, golpe real");
      assert.deepEqual([l.premissa, l.warn], [[], []]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem roteiro, ou com --video sem --roteiro-capa, fica o comportamento de antes", () => {
    const vazio = mkdtempSync(join(tmpdir(), "capa-13401-vazio-"));
    const dir = edicaoCom(FIXTURE);
    try {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: vazio }, l.log), undefined);
      assert.equal(resolverHookDaCapa({ alvo: "horizontal", editionDir: vazio }, l.log), undefined);
      assert.deepEqual([l.premissa, l.warn], [[], []]);
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir, videoExplicito: true }, l.log), undefined);
      assert.match(l.warn[0], /--roteiro-capa/);
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir, videoExplicito: true, roteiroCapa: "vertical2" }, l.log), "Vídeo do Drauzio vendendo cura?");
    } finally {
      rmSync(vazio, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capa do roteiro que o gerador recusa falha já na resolução, nomeando o campo", () => {
    const dir = edicaoCom(roteiroCom({ vertical1: CAPA_REAL_261117 }));
    try {
      assert.throws(() => resolverHookDaCapa({ alvo: "short", editionDir: dir }, logs().log), /porVideo\.vertical1\.capa.*6 palavra.*passe --hook/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("horizontal sem --hook usa porVideo.horizontal.capa, com mais de 4 palavras em 2 linhas", () => {
    assert.equal(hookHorizontalDoRoteiro("Seu pai pode cair nessa"), "Seu pai pode|cair nessa");
    assert.equal(hookHorizontalDoRoteiro("IA ladra?"), "IA ladra?");
    assert.equal(hookHorizontalDoRoteiro("Confiou no chatbot|e morreu"), "Confiou no chatbot|e morreu");
    assert.doesNotThrow(() => splitHook(hookHorizontalDoRoteiro("Tem paciente largando o remédio")));
    const dir = edicaoCom(FIXTURE);
    try {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "horizontal", editionDir: dir }, l.log), "Tem paciente largando|o remédio");
      assert.match(l.premissa[0], /porVideo\.horizontal\.capa/);
      assert.throws(() => resolverHookDaCapa({ alvo: "horizontal", editionDir: dir, roteiroCapa: "vertical1" }, l.log), /só com --short-cover/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--roteiro-capa aceita só vertical1/vertical2", () => {
    assert.equal(parseRoteiroCapaVideo(undefined), undefined);
    assert.equal(parseRoteiroCapaVideo("vertical2"), "vertical2");
    assert.throws(() => parseRoteiroCapaVideo("horizontal"), /vertical1 ou vertical2/);
  });

  it("CLI --short-cover sem --hook imprime a premissa do roteiro antes de qualquer ffmpeg", () => {
    const dir = edicaoCom(FIXTURE);
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", "--short-cover", "--edition-dir", dir], { cwd: ROOT, encoding: "utf8" });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /\[premissa\] --hook "Drauzio nunca vendeu essa cura": texto da capa do vertical 1 no roteiro/);
      writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify(roteiroCom({ vertical1: CAPA_REAL_261117 })));
      const recusa = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", "--short-cover", "--at", "6", "--edition-dir", dir], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(recusa.status, 0);
      assert.match(recusa.stderr, /porVideo\.vertical1\.capa/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
