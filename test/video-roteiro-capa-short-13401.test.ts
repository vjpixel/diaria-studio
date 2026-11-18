// #13401: a capa do YouTube vem do roteiro (sem --hook) e o roteiro acusa capa
// que o gerador recusa, com a mesma regra do gerador.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CAPA_FORA_DA_REGRA, main } from "../scripts/video-roteiro-blocos.ts";
import { main as renderMain } from "../scripts/render-roteiro-video.ts";
import { hookHorizontalDoRoteiro, normalizeShortCoverHook, splitHook } from "../scripts/lib/diaria/youtube-thumb.ts";
import { errosCapaDoRoteiro, hookDaCapa, parseRoteiroCapaVideo, resolverHookDaCapa } from "../scripts/lib/diaria/youtube-thumb-roteiro.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261117.json", import.meta.url), "utf8"));
/** Capa do vertical 1 da 261117 esticada para 8 palavras (a real tinha 6, que o teto 7 de 18/11/2026 passou a aceitar). */
const CAPA_REAL_261117 = "A voz do Drauzio no vídeo é falsa";
const NOVE_PALAVRAS = "Seu pai pode cair nesse golpe com voz falsa";

function roteiroCom(capas: Partial<Record<"horizontal" | "vertical1" | "vertical2", string>>) {
  const r = structuredClone(FIXTURE);
  for (const [v, capa] of Object.entries(capas)) r.porVideo[v].capa = capa;
  return r;
}

function edicaoCom(roteiro: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "capa-13401-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "roteiro-falas.json"), typeof roteiro === "string" ? roteiro : JSON.stringify(roteiro));
  return dir;
}

function comEdicao(roteiro: unknown, fn: (dir: string) => void): void {
  const dir = edicaoCom(roteiro);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function logs() {
  const warn: string[] = [];
  const premissa: string[] = [];
  return { warn, premissa, log: { warn: (m: string) => warn.push(m), premissa: (m: string) => premissa.push(m) } };
}

describe("capas do roteiro com a regra do gerador (#13401)", () => {
  it("vertical: a capa real da 261117 (8 palavras) é erro, com a contagem do gerador", () => {
    assert.throws(() => normalizeShortCoverHook(CAPA_REAL_261117), /8 palavra/);
    const erros = errosCapaDoRoteiro(roteiroCom({ vertical1: CAPA_REAL_261117 }));
    assert.equal(erros.length, 1);
    assert.match(erros[0], /^porVideo\.vertical1\.capa \(vertical 1\): .*8 palavra\(s\).*--short-cover recusa/);
  });

  it("vertical: 5 palavras passam, moeda + número contam como 1, 1 palavra é erro", () => {
    assert.deepEqual(errosCapaDoRoteiro(FIXTURE), []);
    assert.deepEqual(errosCapaDoRoteiro(roteiroCom({ vertical2: "Paga R$ 100 por mês?" })), []);
    assert.match(errosCapaDoRoteiro(roteiroCom({ vertical2: "Golpe" }))[0], /vertical2\.capa .*1 palavra/);
  });

  it("horizontal: 9 palavras e 1 palavra são erro; até 8 em 2 linhas passa; moeda fica colada ao número", () => {
    assert.match(errosCapaDoRoteiro(roteiroCom({ horizontal: NOVE_PALAVRAS }))[0], /^porVideo\.horizontal\.capa \(horizontal\): .*gen-youtube-thumb\.ts recusa/);
    assert.match(errosCapaDoRoteiro(roteiroCom({ horizontal: "Golpe" }))[0], /^porVideo\.horizontal\.capa/);
    assert.match(errosCapaDoRoteiro(roteiroCom({ horizontal: "R$ 100" }))[0], /^porVideo\.horizontal\.capa/);
    assert.deepEqual(errosCapaDoRoteiro(roteiroCom({ horizontal: "Seu pai pode cair nessa agora" })), []);
    assert.equal(hookDaCapa("horizontal", "Custa R$ 100 por mês agora"), "Custa R$ 100 por|mês agora");
    assert.equal(hookHorizontalDoRoteiro("Seu pai pode cair nessa"), "Seu pai pode|cair nessa");
    assert.equal(hookHorizontalDoRoteiro("IA ladra?"), "IA ladra?");
    assert.equal(hookHorizontalDoRoteiro("Confiou no chatbot|e morreu"), "Confiou no chatbot|e morreu");
    assert.doesNotThrow(() => splitHook(hookHorizontalDoRoteiro("Tem paciente largando o remédio")));
  });
});

describe("video-roteiro-blocos: capa fora da regra é exit 4, nunca 2 (#13401)", () => {
  const rodar = (dir: string) => {
    const err: string[] = [];
    const out: string[] = [];
    const code = main(["261117", "--falas", join(dir, "_internal", "roteiro-falas.json"), "--json"], { err: (s) => err.push(s), out: (s) => out.push(s) }, dir);
    return { code, err, out };
  };

  it("contrato: JSON válido + capa de vertical de 8 palavras = exit 4 com a proposta impressa", () => {
    assert.equal(EXIT_CAPA_FORA_DA_REGRA, 4);
    comEdicao(roteiroCom({ vertical1: CAPA_REAL_261117 }), (dir) => {
      const r = rodar(dir);
      assert.equal(r.code, 4);
      assert.ok(r.err.some((s) => /^\[erro\] porVideo\.vertical1\.capa/.test(s)));
      assert.ok(JSON.parse(r.out[0]).duracoes, "a proposta sai inteira");
    });
  });

  it("capa do horizontal fora da regra também é exit 4; capas válidas, exit 0; JSON inválido segue 2", () => {
    comEdicao(roteiroCom({ horizontal: NOVE_PALAVRAS }), (dir) => {
      const r = rodar(dir);
      assert.equal(r.code, 4);
      assert.ok(r.err.some((s) => /^\[erro\] porVideo\.horizontal\.capa/.test(s)));
    });
    comEdicao(FIXTURE, (dir) => assert.equal(rodar(dir).code, 0));
    comEdicao({ falas: "x" }, (dir) => assert.equal(rodar(dir).code, 2));
  });

  it("render-roteiro-video mostra o mesmo [erro] e, desde o #13569, não grava a página (exit 4)", () => {
    comEdicao(roteiroCom({ vertical1: CAPA_REAL_261117, horizontal: NOVE_PALAVRAS }), (dir) => {
      const err: string[] = [];
      const out: string[] = [];
      const pagina = join(dir, "pagina.html");
      const code = renderMain(["261117", "--falas", join(dir, "_internal", "roteiro-falas.json"), "--out", pagina], { err: (s) => err.push(s), out: (s) => out.push(s) }, dir);
      assert.equal(code, EXIT_CAPA_FORA_DA_REGRA);
      assert.ok(err.some((s) => /^\[erro\] porVideo\.vertical1\.capa/.test(s)));
      assert.ok(err.some((s) => /^\[erro\] porVideo\.horizontal\.capa/.test(s)));
      assert.equal(existsSync(pagina), false);
      assert.deepEqual(out, []);
    });
  });
});

describe("gen-youtube-thumb: gancho da capa vindo do roteiro (#13401)", () => {
  it("Short sem --hook usa porVideo.vertical1.capa já normalizada, com [premissa] dizendo de onde veio", () => {
    comEdicao(FIXTURE, (dir) => {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir }, l.log), "Drauzio nunca vendeu|essa cura");
      assert.equal(l.premissa.length, 1);
      assert.match(l.premissa[0], /porVideo\.vertical1\.capa/);
      assert.ok(l.premissa[0].includes(join(dir, "_internal", "roteiro-falas.json")));
    });
  });

  it("--hook explícito sobrepõe o roteiro; com --roteiro-capa no Short, avisa que ele foi ignorado", () => {
    comEdicao(FIXTURE, (dir) => {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", hook: "Médico falso, golpe real", editionDir: dir }, l.log), "Médico falso, golpe real");
      assert.deepEqual([l.premissa, l.warn], [[], []]);
      assert.equal(resolverHookDaCapa({ alvo: "short", hook: "Médico falso, golpe real", editionDir: dir, roteiroCapa: "vertical2" }, l.log), "Médico falso, golpe real");
      assert.match(l.warn[0], /--roteiro-capa vertical2 ignorado/);
    });
  });

  it("--roteiro-capa no horizontal lança mesmo com --hook", () => {
    assert.throws(() => resolverHookDaCapa({ alvo: "horizontal", hook: "IA ladra?", editionDir: ROOT, roteiroCapa: "vertical1" }, logs().log), /só com --short-cover/);
  });

  it("roteiro ausente, ou --video sem --roteiro-capa: o comportamento de antes", () => {
    const vazio = mkdtempSync(join(tmpdir(), "capa-13401-vazio-"));
    try {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: vazio }, l.log), undefined);
      assert.equal(resolverHookDaCapa({ alvo: "horizontal", editionDir: vazio }, l.log), undefined);
      assert.deepEqual([l.premissa, l.warn], [[], []]);
    } finally {
      rmSync(vazio, { recursive: true, force: true });
    }
    comEdicao(FIXTURE, (dir) => {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir, videoExplicito: true }, l.log), undefined);
      assert.match(l.warn[0], /nenhuma capa do roteiro aplicada.*--roteiro-capa/);
      assert.equal(resolverHookDaCapa({ alvo: "short", editionDir: dir, videoExplicito: true, roteiroCapa: "vertical2" }, l.log), "Vídeo do Drauzio|vendendo cura?");
    });
  });

  it("roteiro presente mas ilegível, inválido ou sem o campo: lança nomeando arquivo e campo e pedindo --hook", () => {
    comEdicao("{ quebrado", (dir) => {
      assert.throws(() => resolverHookDaCapa({ alvo: "short", editionDir: dir }, logs().log), /roteiro-falas\.json ilegível .*porVideo\.vertical1\.capa.*--hook/);
    });
    comEdicao({ falas: "x" }, (dir) => {
      assert.throws(() => resolverHookDaCapa({ alvo: "short", editionDir: dir }, logs().log), /roteiro-falas\.json inválido .*porVideo\.vertical1\.capa.*--hook/);
    });
    const semCapa = structuredClone(FIXTURE);
    delete semCapa.porVideo.vertical1.capa;
    comEdicao(semCapa, (dir) => {
      assert.throws(() => resolverHookDaCapa({ alvo: "short", editionDir: dir }, logs().log), /sem porVideo\.vertical1\.capa: passe --hook/);
    });
  });

  it("capa do roteiro que o gerador recusa falha já na resolução, nomeando o campo (Short e horizontal)", () => {
    comEdicao(roteiroCom({ vertical1: CAPA_REAL_261117, horizontal: NOVE_PALAVRAS }), (dir) => {
      assert.throws(() => resolverHookDaCapa({ alvo: "short", editionDir: dir }, logs().log), /porVideo\.vertical1\.capa.*8 palavra.*passe --hook/);
      assert.throws(() => resolverHookDaCapa({ alvo: "horizontal", editionDir: dir }, logs().log), /porVideo\.horizontal\.capa\).*passe --hook/);
    });
  });

  it("horizontal sem --hook usa porVideo.horizontal.capa, com mais de 4 palavras em 2 linhas", () => {
    comEdicao(FIXTURE, (dir) => {
      const l = logs();
      assert.equal(resolverHookDaCapa({ alvo: "horizontal", editionDir: dir }, l.log), "Tem paciente largando|o remédio");
      assert.match(l.premissa[0], /porVideo\.horizontal\.capa/);
    });
  });

  it("--roteiro-capa aceita só vertical1/vertical2", () => {
    assert.equal(parseRoteiroCapaVideo(undefined), undefined);
    assert.equal(parseRoteiroCapaVideo("vertical2"), "vertical2");
    assert.throws(() => parseRoteiroCapaVideo("horizontal"), /vertical1 ou vertical2/);
  });

  it("CLI --short-cover sem --hook imprime a premissa do roteiro antes de qualquer ffmpeg; capa recusada para antes", () => {
    comEdicao(FIXTURE, (dir) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", "--short-cover", "--edition-dir", dir], { cwd: ROOT, encoding: "utf8" });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /\[premissa\] --hook "Drauzio nunca vendeu\|essa cura": texto da capa do vertical 1 no roteiro/);
      writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify(roteiroCom({ vertical1: CAPA_REAL_261117 })));
      const recusa = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", "--short-cover", "--at", "6", "--edition-dir", dir], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(recusa.status, 0);
      assert.match(recusa.stderr, /porVideo\.vertical1\.capa/);
      const semValor = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", "--hook", "IA ladra?", "--portrait", "x.png", "--edition-dir", dir, "--roteiro-capa"], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(semValor.status, 0);
      assert.match(semValor.stderr, /--roteiro-capa exige o valor/);
    });
  });
});
