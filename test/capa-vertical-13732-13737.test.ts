// #13732: o roteiro da 261119 gravou a capa do vertical 2 com 7 palavras
// ("GPT-6.2 Sol faz slide no seu modelo") quando o teto ainda era 5, e a capa
// só foi recusada na publicação. O teto passou a 7 no #13620 (decisão do editor
// de 18/11/2026); estes testes travam que a checagem do roteiro (render da
// página, exit 4) cobre o vertical 2 como cobre o vertical 1, nos dois lados
// do teto novo.
//
// #13737: com 6-7 palavras a fonte do gancho vertical cai; a fonte é medida
// contra a largura da capa vertical (não a do horizontal), fonte efetiva
// pequena vira [aviso], e quebra explícita 5+2/2+5 tem mensagem própria.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { main as renderMain } from "../scripts/render-roteiro-video.ts";
import { EXIT_CAPA_FORA_DA_REGRA } from "../scripts/video-roteiro-blocos.ts";
import { errosCapaDoRoteiro } from "../scripts/lib/diaria/youtube-thumb-roteiro.ts";
import {
  buildHookSvg,
  composeShortCover,
  composeShortCoverOverlay,
  hookFontSize,
  normalizeShortCoverHook,
  SHORT_HOOK_MIN_EFFECTIVE_FONT,
  shortHookSmallFontWarning,
  splitHook,
} from "../scripts/lib/diaria/youtube-thumb.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261117.json", import.meta.url), "utf8"));
/** Capa real do vertical 2 da 261119 (7 palavras), recusada na publicação com o teto 5. */
const CAPA_V2_261119 = "GPT-6.2 Sol faz slide no seu modelo";
/** A mesma capa com 1 palavra a mais: fora do teto 7. */
const CAPA_V2_OITO = "GPT-6.2 Sol faz o slide no seu modelo";
/** Capas reais de 6 palavras do vertical 1 (261117 e 261118). */
const CAPAS_REAIS_SEIS = ["A voz do Drauzio é falsa", "Eu previ o aperto dos EUA"];
const PALAVRAS_LONGAS = "Superinteligência descontrolada transforma humanidade completamente agora";

function comEdicao(capas: { vertical1?: string; vertical2?: string }, fn: (dir: string, falas: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "capa-13732-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const r = structuredClone(FIXTURE);
    if (capas.vertical1 !== undefined) r.porVideo.vertical1.capa = capas.vertical1;
    if (capas.vertical2 !== undefined) r.porVideo.vertical2.capa = capas.vertical2;
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
  const code = renderMain(["261119", ...args], { err: (s) => err.push(s), out: (s) => out.push(s) }, dir);
  return { code, err, out };
}

describe("checagem da capa do roteiro cobre o vertical 2 (#13732)", () => {
  it("errosCapaDoRoteiro: a capa real de 7 palavras da 261119 passa no vertical 2; 8 palavras é erro nomeando o vertical 2", () => {
    const base = structuredClone(FIXTURE);
    base.porVideo.vertical2.capa = CAPA_V2_261119;
    assert.deepEqual(errosCapaDoRoteiro(base), []);
    base.porVideo.vertical2.capa = CAPA_V2_OITO;
    const erros = errosCapaDoRoteiro(base);
    assert.equal(erros.length, 1);
    assert.match(erros[0], /^porVideo\.vertical2\.capa \(vertical 2\): .*8 palavra\(s\); a regra é 2 a 7/);
  });

  it("render-roteiro-video: vertical 2 com 8 palavras barra a página (exit 4, nada gravado)", () => {
    comEdicao({ vertical2: CAPA_V2_OITO }, (dir, falas) => {
      const pagina = join(dir, "pagina.html");
      const r = render(dir, ["--falas", falas, "--out", pagina, "--sem-topicos"]);
      assert.equal(r.code, EXIT_CAPA_FORA_DA_REGRA);
      assert.ok(r.err.some((s) => /^\[erro\] porVideo\.vertical2\.capa .*8 palavra\(s\)/.test(s)), r.err.join("\n"));
      assert.equal(existsSync(pagina), false);
    });
  });

  it("render-roteiro-video: as capas de 7 palavras nos dois verticais geram a página (exit 0)", () => {
    comEdicao({ vertical1: CAPA_V2_261119, vertical2: CAPA_V2_261119 }, (dir, falas) => {
      const pagina = join(dir, "pagina.html");
      const r = render(dir, ["--falas", falas, "--out", pagina, "--artifact-url", "https://claude.ai/artifact/x"]);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.ok(existsSync(pagina));
    });
  });
});

describe("capa vertical de 6-7 palavras: fonte, aviso e quebra explícita (#13737)", () => {
  it("hookFontSize mede contra a largura pedida: a vertical (960) dá fonte maior que a do horizontal (800)", () => {
    const parts = splitHook(normalizeShortCoverHook(CAPA_V2_261119));
    assert.ok(hookFontSize(parts, 960) > hookFontSize(parts), `${hookFontSize(parts, 960)} vs ${hookFontSize(parts)}`);
    // o default segue sendo a do horizontal
    assert.equal(hookFontSize(parts), hookFontSize(parts, 800));
    const size = hookFontSize(parts, 960);
    assert.match(buildHookSvg(normalizeShortCoverHook(CAPA_V2_261119), "middle", 960), new RegExp(`font-size="${size}"`));
  });

  it("shortHookSmallFontWarning: avisa abaixo do piso e cala no piso ou acima", () => {
    assert.equal(shortHookSmallFontWarning("IA ladra?", SHORT_HOOK_MIN_EFFECTIVE_FONT), undefined);
    const w = shortHookSmallFontWarning("linha um|linha dois", 40);
    assert.match(w ?? "", /"linha um linha dois" saiu com fonte efetiva de ~40px .*encurte a capa.*#13737/);
  });

  it("render: 6 e 7 palavras reais não avisam fonte pequena; palavras longas avisam", async () => {
    for (const h of [...CAPAS_REAIS_SEIS, CAPA_V2_261119]) {
      const r = await composeShortCoverOverlay({ hook: h });
      assert.ok(!r.warnings.some((w) => /fonte efetiva/.test(w)), `${h}: ${r.warnings.join("; ")}`);
    }
    const longa = await composeShortCoverOverlay({ hook: PALAVRAS_LONGAS });
    assert.ok(longa.warnings.some((w) => /fonte efetiva de ~\d+px/.test(w)), longa.warnings.join("; "));
  });

  it("composeShortCover com 7 palavras: capa 1080x1920 sem aviso de fonte pequena", async () => {
    const frame = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
    const { jpeg, warnings } = await composeShortCover({ frame, hook: CAPA_V2_261119 });
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
    assert.ok(!warnings.some((w) => /fonte efetiva/.test(w)), warnings.join("; "));
  });

  it("capas reais de 6 palavras quebram em 3|3", () => {
    assert.equal(normalizeShortCoverHook(CAPAS_REAIS_SEIS[0]), "A voz do|Drauzio é falsa");
    assert.equal(normalizeShortCoverHook(CAPAS_REAIS_SEIS[1]), "Eu previ o|aperto dos EUA");
    assert.equal(normalizeShortCoverHook(CAPA_V2_261119), "GPT-6.2 Sol faz slide|no seu modelo");
  });

  it("quebra explícita 5+2 e 2+5: mensagem própria da capa vertical, dizendo o que fazer", () => {
    for (const [hook, linha] of [
      ["GPT-6.2 Sol faz slide no|seu modelo", 1],
      ["GPT-6.2 Sol|faz slide no seu modelo", 2],
    ] as const) {
      assert.throws(
        () => normalizeShortCoverHook(hook),
        (e: Error) => {
          assert.match(e.message, new RegExp(`^linha ${linha} da capa vertical .*5 palavra\\(s\\); na capa vertical cada linha leva até 4`));
          assert.match(e.message, /tire a quebra "\|" para a divisão automática \(#13737\)/);
          assert.doesNotMatch(e.message, /#11740/);
          return true;
        },
      );
    }
    // 4|3 explícito segue aceito
    assert.equal(normalizeShortCoverHook("GPT-6.2 Sol faz slide|no seu modelo"), "GPT-6.2 Sol faz slide|no seu modelo");
  });

  it("3 linhas explícitas: mensagem da capa vertical", () => {
    assert.throws(() => normalizeShortCoverHook("Um dois|três quatro|cinco"), /capa vertical .*3 linhas; a capa vertical leva no máximo 2 \(#13737\)/);
  });
});
