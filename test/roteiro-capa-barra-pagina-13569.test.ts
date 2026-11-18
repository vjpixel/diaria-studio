// #13569: o roteiro da 261118 saiu com a capa do vertical 1 de 6 palavras
// ("Eu previ o aperto dos EUA"); o render-roteiro-video só avisava com [erro]
// e gravava a página, e a capa foi recusada só na publicação. Agora a capa fora
// da regra do gerador barra a página (exit 4, nada gravado), inclusive na
// iteração (página anterior intacta) e na página de tópicos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as renderMain } from "../scripts/render-roteiro-video.ts";
import { EXIT_CAPA_FORA_DA_REGRA } from "../scripts/video-roteiro-blocos.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261117.json", import.meta.url), "utf8"));
/** A capa real do vertical 1 da 261118: 6 palavras, recusada só na publicação. */
const CAPA_REAL_261118 = "Eu previ o aperto dos EUA";

function comEdicao(capaV1: string, fn: (dir: string, falas: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "capa-13569-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const r = structuredClone(FIXTURE);
    r.porVideo.vertical1.capa = capaV1;
    const falas = join(dir, "_internal", "roteiro-falas.json");
    writeFileSync(falas, JSON.stringify(r));
    fn(dir, falas);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function render(dir: string, args: string[]) {
  const err: string[] = [];
  const out: string[] = [];
  const code = renderMain(["261118", ...args], { err: (s) => err.push(s), out: (s) => out.push(s) }, dir);
  return { code, err, out };
}

describe("render-roteiro-video barra capa fora da regra (#13569)", () => {
  it("capa de vertical com 6 palavras: exit 4, [erro] com a contagem, página não gravada", () => {
    comEdicao(CAPA_REAL_261118, (dir, falas) => {
      const pagina = join(dir, "pagina.html");
      const r = render(dir, ["--falas", falas, "--out", pagina, "--sem-topicos"]);
      assert.equal(r.code, EXIT_CAPA_FORA_DA_REGRA);
      assert.ok(r.err.some((s) => /^\[erro\] porVideo\.vertical1\.capa .*6 palavra\(s\); a regra é 2 a 5/.test(s)), r.err.join("\n"));
      assert.ok(r.err.some((s) => /página não gerada.*#13569/.test(s)));
      assert.equal(existsSync(pagina), false);
      assert.deepEqual(r.out, []);
    });
  });

  it("na iteração (editor ajustou a capa para 6 palavras), a página publicada antes fica intacta", () => {
    comEdicao(CAPA_REAL_261118, (dir, falas) => {
      const pagina = join(dir, "pagina.html");
      const anterior = "<!-- artifact: https://claude.ai/artifact/x -->\n<p>versão anterior</p>";
      writeFileSync(pagina, anterior);
      const r = render(dir, ["--falas", falas, "--out", pagina]);
      assert.equal(r.code, EXIT_CAPA_FORA_DA_REGRA);
      assert.equal(readFileSync(pagina, "utf8"), anterior);
    });
  });

  it("a página de tópicos também não sai com a capa fora da regra", () => {
    comEdicao(CAPA_REAL_261118, (dir, falas) => {
      const pagina = join(dir, "topicos.html");
      const r = render(dir, ["--falas", falas, "--out", pagina, "--topicos"]);
      assert.equal(r.code, EXIT_CAPA_FORA_DA_REGRA);
      assert.equal(existsSync(pagina), false);
    });
  });

  it("a mesma capa encurtada para 5 palavras gera a página (exit 0)", () => {
    comEdicao("Previ o aperto dos EUA", (dir, falas) => {
      const pagina = join(dir, "pagina.html");
      const r = render(dir, ["--falas", falas, "--out", pagina, "--artifact-url", "https://claude.ai/artifact/x"]);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.ok(existsSync(pagina));
      assert.ok(!r.err.some((s) => s.startsWith("[erro]")));
    });
  });
});
