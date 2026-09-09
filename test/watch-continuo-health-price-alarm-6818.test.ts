/**
 * test/watch-continuo-health-price-alarm-6818.test.ts (#6818 item 4)
 *
 * O watchdog de custo (`hermes-model-cost-report.py --price-check`) já
 * detecta aumento de preço de modelo PAGO já em uso (não só `:free` virando
 * pago) — a lógica pura está coberta por
 * `hermes/scripts/hermes-model-cost-report.test.py`. O que faltava (e é o
 * gap real desta issue: "sem isso, o próximo penhasco de preço volta a ser
 * descoberto por acidente") era a checagem 4 do `watch-continuo-health.sh`
 * — o script que de fato roda 1x/dia via cron e abre issue — NUNCA chamar
 * `--price-check`. O detector existia e ninguém o invocava.
 *
 * Este teste é ESTÁTICO (mesma disciplina de
 * `test/watch-continuo-health-dedup-6771.test.ts`, que já cobre normalização
 * de `__ERR__` e dedup de `file_issue` para TODAS as checagens, inclusive a
 * nova) — trava que o item 12 (a) de fato invoca `--price-check --json`,
 * (b) nunca reporta "ok" quando o achado é `unverifiable` (fail-closed),
 * (c) só abre issue no ramo de aumento real, nunca nos outros dois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "hermes", "scripts", "watch-continuo-health.sh");
const source = readFileSync(SCRIPT, "utf8");

// Isola o bloco do item 12 (entre o marcador do cabeçalho e a próxima seção
// numerada/nomeada) para que as asserções não acidentalmente casem com outra
// checagem que também usa hermes-model-cost-report.py (item 4, item 6).
function extractItem12Block(src: string): string {
  const start = src.indexOf("# ── 12. aumento de preço em modelo pago já em uso");
  assert.ok(start >= 0, "bloco do item 12 não encontrado — a checagem foi removida ou renomeada?");
  const rest = src.slice(start);
  const nextSectionRel = rest.indexOf("\n# --- Parada dura por AUTH");
  assert.ok(nextSectionRel > 0, "fim do bloco do item 12 não encontrado (próxima seção ausente)");
  return rest.slice(0, nextSectionRel);
}

describe("#6818 item 4 — watch-continuo-health.sh alarma em aumento de preço de modelo pago em uso", () => {
  const block = extractItem12Block(source);

  it("invoca hermes-model-cost-report.py --price-check --json (o gap real: o detector existia sem ninguém chamá-lo)", () => {
    assert.match(block, /hermes-model-cost-report\.py --price-check --json/);
  });

  it("classifica 3 estados distintos — INCREASE / UNVERIFIABLE / OK — nunca colapsa indeterminado em ok", () => {
    assert.match(block, /d\.get\('increases'\)/);
    assert.match(block, /d\.get\('unverifiable'\)/);
    assert.match(block, /print\('INCREASE'\)/);
    assert.match(block, /print\('UNVERIFIABLE'\)/);
    assert.match(block, /print\('OK'\)/);
    // A ordem do if/elif importa: increases é checado ANTES de unverifiable,
    // então um achado com as duas coisas ainda vira INCREASE (mais forte),
    // nunca "ok" por acidente de ordem.
    const incIdx = block.indexOf("d.get('increases')");
    const unvIdx = block.indexOf("d.get('unverifiable')");
    assert.ok(incIdx >= 0 && unvIdx >= 0 && incIdx < unvIdx, "increases precisa ser checado antes de unverifiable");
  });

  it("ramo UNVERIFIABLE incrementa FAILS (indeterminado nunca é lido como saudável)", () => {
    const unvBranch = block.slice(block.indexOf('"$PRICE_PARSE" = "UNVERIFIABLE"'));
    const nextBranch = unvBranch.indexOf('elif [ "$PRICE_PARSE" = "INCREASE" ]');
    const scoped = unvBranch.slice(0, nextBranch);
    assert.match(scoped, /FAILS=\$\(\(FAILS \+ 1\)\)/, "UNVERIFIABLE precisa contar como falha de infra (FAILS+1), nunca 'ok'");
    assert.doesNotMatch(scoped, /file_issue/, "UNVERIFIABLE não deveria abrir issue de 'aumento de preço' — é indeterminado, não achado");
  });

  it("ramo __ERR__ (price-check falhou por completo) também incrementa FAILS e nunca reporta ok", () => {
    const errBranch = block.slice(
      block.indexOf('"$PRICE_PARSE" = "__ERR__"'),
      block.indexOf('elif [ "$PRICE_PARSE" = "UNVERIFIABLE" ]'),
    );
    assert.match(errBranch, /FAILS=\$\(\(FAILS \+ 1\)\)/);
    assert.match(errBranch, /INDETERMINADO/);
  });

  it("só o ramo INCREASE chama file_issue — OK e UNVERIFIABLE nunca abrem issue de aumento", () => {
    const increaseBranch = block.slice(block.indexOf('"$PRICE_PARSE" = "INCREASE"'));
    assert.match(increaseBranch, /file_issue "\[watch-continuo\] aumento de preço em modelo pago já em uso"/);
  });

  it("o marcador de dedup do item 12 é único e vira substring do título (mesmo invariante do #6771)", () => {
    // Regressão redundante e intencional com watch-continuo-health-dedup-6771:
    // aquele teste cobre TODOS os file_issue call sites de forma genérica,
    // mas travar aqui também documenta explicitamente por que o item 12
    // precisa satisfazer a mesma disciplina.
    const marker = "[watch-continuo] aumento de preço em modelo pago já em uso";
    const re = /file_issue "([^"]+)" \\\n\s*"([^"]+)"/g;
    let found: { marker: string; title: string } | undefined;
    for (const m of source.matchAll(re)) {
      if (m[1] === marker) found = { marker: m[1], title: m[2] };
    }
    assert.ok(found, "call site do item 12 não encontrado pelo parser genérico de file_issue");
    assert.ok(found!.title.includes(found!.marker), "título precisa conter o marcador (dedup depende disso)");
  });

  it("sintaxe bash do script continua válida (bash -n)", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n falhou: ${res.stderr}`);
  });
});
