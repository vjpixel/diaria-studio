/**
 * test/render-newsletter-html-cli-esp-4266.test.ts (#4266)
 *
 * Cobre a flag `--esp` de `scripts/render-newsletter-html.ts` NO NÍVEL DO CLI
 * (subprocess real via spawnSync) — os testes em
 * `newsletter-render-html-esp-4266.test.ts` cobrem só a camada de lib
 * (`renderEIA`/`renderHTML` chamados direto). Achado do review automatizado
 * do PR #4267: sem isso, o guard de validação do CLI (a única barreira entre
 * um `--esp` mal-configurado e um envio de produção com merge tag errada)
 * ficava sem nenhum teste — inclusive o caso `--esp` SEM VALOR, que
 * originalmente caía silenciosamente no default "beehiiv" em vez de falhar
 * (bug real, confirmado por repro pelo silent-failure-hunter, corrigido no
 * mesmo commit deste arquivo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");

/**
 * Mesmo fixture mínimo de `render-newsletter-html-no-tty-warn.test.ts` (#2012),
 * mas dentro de uma subpasta "260999" (mesmo AAMMDD-fictício usado pelas
 * fixtures de `renderEIA` em render-newsletter-html.test.ts) — sem isso
 * `edition` (extraído do NOME do diretório via regex `(\d{6})[/\\]?$`) fica
 * "" e `eiaChoice` nunca envolve a imagem no `<a href>` de voto, então NENHUM
 * merge tag (nem Beehiiv nem Brevo) aparece — os asserts abaixo dependem do
 * link de voto existir.
 */
function makeEditionDir(): string {
  const base = mkdtempSync(join(tmpdir(), "diaria-render-esp-"));
  const dir = join(base, "260999");
  mkdirSync(dir, { recursive: true });
  const reviewed = [
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    "**[Título um](https://example.com/1)**",
    "",
    "Corpo do destaque um com contexto suficiente pra render.",
    "",
    "Por que isso importa: razão um.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | RADAR**",
    "",
    "**[Título dois](https://example.com/2)**",
    "",
    "Corpo dois.",
    "",
    "Por que isso importa: razão dois.",
    "",
    "---",
    "",
    "**DESTAQUE 3 | PESQUISA**",
    "",
    "**[Título três](https://example.com/3)**",
    "",
    "Corpo três.",
    "",
    "Por que isso importa: razão três.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  // #4266: precisa de 01-eia.md com credit não-vazio — sem isso `content.eia.credit`
  // fica "" e `includeEia` é false, então `renderEIA`/a merge tag de voto nunca
  // são emitidos (renderHTML) e `renderEiaStandalone` retorna null (--split).
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function run(dirAndArgs: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...dirAndArgs], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

describe("render-newsletter-html CLI — --esp (#4266)", () => {
  it("sem --esp: default beehiiv (regressão)", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "out.html");
      const r = run([dir, "--full", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const html = readFileSync(outPath, "utf8");
      assert.match(html, /\{\{email\}\}/);
      assert.ok(!html.includes("{{ contact.EMAIL }}"));
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it("--esp brevo: merge tag Brevo no HTML gerado", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "out.html");
      const r = run([dir, "--full", "--esp", "brevo", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const html = readFileSync(outPath, "utf8");
      assert.match(html, /\{\{ contact\.EMAIL \}\}/);
      assert.ok(!html.includes("{{email}}"));
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it('--esp=brevo (sintaxe com igual): sai 1 em vez de cair silenciosamente no default beehiiv (2º achado do review #4267 — parseCliArgs não suporta "=" em lugar nenhum do repo)', () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--esp=brevo"]);
      assert.equal(r.status, 1, '--esp=brevo deve falhar explicitamente, não render silenciosamente com merge tag Beehiiv');
      assert.match(r.stderr, /--esp não aceita sintaxe/);
      assert.match(r.stderr, /--esp brevo/, "mensagem deve sugerir a forma correta (espaço, não igual)");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it('--esp com valor inválido (ex: "Brevo" com maiúscula, ou "foo"): sai 1 com mensagem clara', () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--esp", "Brevo"]);
      assert.equal(r.status, 1, "deve falhar — não deve tratar case diferente como válido silenciosamente");
      assert.match(r.stderr, /--esp inválido/);
      assert.match(r.stderr, /Brevo/);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it("--esp SEM VALOR (último argv): sai 1 em vez de cair silenciosamente no default beehiiv (regressão do achado do review #4267)", () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--esp"]);
      assert.equal(r.status, 1, "--esp sem valor deve falhar, não aceitar o default silenciosamente");
      assert.match(r.stderr, /--esp requer um valor/);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it('--esp SEM VALOR seguido de outra flag (ex: "--esp --full"): sai 1 (mesmo bug — parseCliArgs trata --esp como boolean flag nesse caso)', () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--esp", "--full"]);
      assert.equal(r.status, 1, "--esp seguido de outra --flag deve falhar, não interpretar --full como valor nem cair no default");
      assert.match(r.stderr, /--esp requer um valor/);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });

  it("--split + --esp brevo: avisa no stderr que --esp foi ignorado (È IA? standalone continua Beehiiv-only)", () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--split", "--esp", "brevo"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /--split \+ --esp brevo/);
      const eiaHtml = readFileSync(join(dir, "_internal", "newsletter-eia.html"), "utf8");
      assert.match(eiaHtml, /\{\{email\}\}/, "newsletter-eia.html do modo split continua Beehiiv mesmo com --esp brevo");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true }); // remove o tmpdir base inteiro (dir é a subpasta "260999")
    }
  });
});
