/**
 * test/build-link-ctr-guard-e2e.test.ts (#4836, review do PR #4850)
 *
 * Os testes unitários de `ctr-rebuild-guard.ts` provam que as funções puras
 * estão certas. Não provam nada sobre o produto real: `build-link-ctr.ts`
 * recusando destruir cliques. O review do PR encontrou TRÊS formas de a
 * propriedade de segurança falhar sem nenhum teste notar — todas na wiring,
 * nenhuma na função pura:
 *
 *   1. o caminho "schema changed" reescrevia tudo sem passar pela guarda
 *      (não exigia `--full`, e CRLF no cabeçalho já bastava como gatilho);
 *   2. trocar a ordem dos argumentos de `assessClickLoss` no call site inverte
 *      o veredicto e autoriza a escrita destrutiva;
 *   3. CSV ilegível virava "nada a perder".
 *
 * Este arquivo executa o CLI de verdade (`spawnNpx`, mesmo padrão de
 * `test/check-dedup-freshness.test.ts`) contra um `data/` sintético em tmpdir.
 * NUNCA toca o `data/` real — cada caso monta seu próprio diretório.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { spawnNpx } from "./_helpers/spawn-npx.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "build-link-ctr.ts");

const HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,section,origin";

/** Post cacheado com a assinatura EXATA do incidente #4836: agregado > 0, stats.clicks vazio. */
function postDegradado(id: string, title: string, publishDateSec: number, agregado: number) {
  return {
    id,
    title,
    status: "confirmed",
    publish_date: publishDateSec,
    content: { free: { email: `<a href="https://exemplo.com/${id}">Matéria ${id}</a>` } },
    stats: {
      email: { unique_opens: 100, unique_verified_clicks: agregado, clicks: agregado },
      clicks: [],
    },
  };
}

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctr-guard-e2e-"));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Monta um cwd isolado com `data/beehiiv-cache/posts/` e um CSV existente.
 * `eol` permite reproduzir o gatilho de CRLF sem mexer em mais nada.
 */
function montarCaso(nome: string, opts: { csvLinhas: string[]; header?: string; eol?: string }): string {
  const dir = path.join(tmpRoot, nome);
  fs.mkdirSync(path.join(dir, "data", "beehiiv-cache", "posts"), { recursive: true });

  // Publicado bem no passado — o cutoff de 7 dias (MIN_AGE_DAYS_FOR_CLICKS) tem
  // que estar satisfeito, senão o post é pulado e o CSV sai vazio por outro motivo.
  const post = postDegradado("p1", "Edição Teste", Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000), 10);
  fs.writeFileSync(
    path.join(dir, "data", "beehiiv-cache", "posts", "p1.json"),
    JSON.stringify(post),
    "utf8",
  );

  const eol = opts.eol ?? "\n";
  const conteudo = [opts.header ?? HEADER, ...opts.csvLinhas].join(eol) + eol;
  fs.writeFileSync(path.join(dir, "data", "link-ctr-table.csv"), conteudo, "utf8");

  return dir;
}

function rodar(cwd: string, args: string[] = []) {
  return spawnNpx(["tsx", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function lerCsv(cwd: string): string {
  return fs.readFileSync(path.join(cwd, "data", "link-ctr-table.csv"), "utf8");
}

function backups(cwd: string): string[] {
  return fs.readdirSync(path.join(cwd, "data")).filter((f) => f.includes(".bak-"));
}

/** Linha do CSV com 10 cliques para a edição que o cache degradado vai zerar. */
const LINHA_COM_CLIQUES =
  "2026-05-01,Edição Teste,,Matéria p1,https://exemplo.com/p1,exemplo.com,100,10,10,10.00,Outro,Destaque,INT";

describe("build-link-ctr — guarda de reescrita destrutiva (fim-a-fim)", () => {
  it("--full aborta com exit 3 e deixa o CSV intacto", () => {
    const cwd = montarCaso("full-aborta", { csvLinhas: [LINHA_COM_CLIQUES] });
    const antes = lerCsv(cwd);

    const r = rodar(cwd, ["--full"]);

    assert.equal(r.status, 3, `esperado exit 3, veio ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr ?? "", /REBUILD ABORTADO/);
    assert.equal(lerCsv(cwd), antes, "o CSV não pode ser tocado quando a guarda recusa");
    assert.deepEqual(backups(cwd), [], "abortando, o próprio CSV original já é o backup");
  });

  it("CRLF no cabeçalho NÃO burla a guarda, mesmo sem --full", () => {
    // Regressão do achado crítico: `split('\n')` deixa o `\r` no cabeçalho, o
    // código cai em "CSV schema changed — re-bootstrapping" e reescrevia tudo
    // com isBootstrap=false, então a guarda nunca rodava. Exit 0, sem backup,
    // 10 cliques → 0. `data/` sincroniza entre SOs pelo OneDrive: CRLF é
    // cenário de sync, não de sabotagem.
    const cwd = montarCaso("crlf", { csvLinhas: [LINHA_COM_CLIQUES], eol: "\r\n" });
    const antes = lerCsv(cwd);

    const r = rodar(cwd); // sem --full, igual ao passo 0h do Stage 0

    assert.equal(r.status, 3, `esperado exit 3, veio ${r.status}. stdout: ${r.stdout}`);
    assert.match(r.stderr ?? "", /REBUILD ABORTADO/);
    assert.equal(lerCsv(cwd), antes, "10 cliques reais não podem sumir por causa de CRLF");
  });

  it("coluna extra no cabeçalho (schema drift real) também aciona a guarda sem --full", () => {
    const cwd = montarCaso("schema-drift", {
      header: `${HEADER},url`,
      csvLinhas: [`${LINHA_COM_CLIQUES},https://exemplo.com/p1`],
    });
    const antes = lerCsv(cwd);

    const r = rodar(cwd);

    assert.equal(r.status, 3, `esperado exit 3, veio ${r.status}. stdout: ${r.stdout}`);
    assert.equal(lerCsv(cwd), antes);
  });

  it("CSV com coluna de cliques renomeada aborta como ILEGÍVEL, não como 'nada a perder'", () => {
    const cwd = montarCaso("coluna-renomeada", {
      header: HEADER.replace("unique_verified_clicks", "clicks_unique"),
      csvLinhas: [LINHA_COM_CLIQUES],
    });
    const antes = lerCsv(cwd);

    const r = rodar(cwd, ["--full"]);

    assert.equal(r.status, 3, `esperado exit 3, veio ${r.status}. stdout: ${r.stdout}`);
    assert.match(r.stderr ?? "", /não foi possível ler o CSV atual|unique_verified_clicks/);
    assert.equal(lerCsv(cwd), antes);
  });

  it("--allow-click-loss segue em frente, mas grava backup com o conteúdo anterior", () => {
    const cwd = montarCaso("override", { csvLinhas: [LINHA_COM_CLIQUES] });
    const antes = lerCsv(cwd);

    const r = rodar(cwd, ["--full", "--allow-click-loss"]);

    assert.equal(r.status, 0, `esperado exit 0, veio ${r.status}. stderr: ${r.stderr}`);
    const bks = backups(cwd);
    assert.equal(bks.length, 1, "override sem backup deixaria o dado sem nenhuma rede");
    assert.equal(
      fs.readFileSync(path.join(cwd, "data", bks[0]), "utf8"),
      antes,
      "o backup precisa ter o conteúdo PRÉ-escrita",
    );
    assert.notEqual(lerCsv(cwd), antes, "com o override, a reescrita de fato acontece");
  });

  it("bootstrap legítimo (CSV inexistente) não é bloqueado", () => {
    const cwd = montarCaso("bootstrap", { csvLinhas: [] });
    fs.rmSync(path.join(cwd, "data", "link-ctr-table.csv"));

    const r = rodar(cwd);

    assert.equal(r.status, 0, `bootstrap legítimo não pode abortar. stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, "data", "link-ctr-table.csv")));
  });
});
