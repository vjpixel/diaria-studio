/**
 * test/watch-continuo-health-dedup-6771.test.ts (#6771)
 *
 * Trava o invariante que faz a dedup de `hermes/scripts/watch-continuo-health.sh`
 * funcionar: **o MARCADOR passado a `file_issue` tem de ser substring do
 * TÍTULO que ela cria.**
 *
 * Por que isso precisa de guard mecânico e não de atenção:
 *
 * `have_issue` procura o marcador entre os títulos das issues ABERTAS
 * (`gh issue list ... | command grep -qF "$marker"`). Se o marcador não
 * aparece no título criado, a busca nunca encontra a issue que o próprio
 * script acabou de abrir — e ele cria outra a cada execução, para sempre.
 * O sintoma não é um erro: é uma issue nova por corrida, indistinguível de
 * "o problema continua acontecendo".
 *
 * Achado ao vivo em 03/09/2026: três execuções manuais do script em ~40s
 * produziram #7326, #7327 e #7328, idênticas. Duas checagens estavam
 * quebradas — a 6 (`degradação de modelo por tick`, #6912) e a 7 (`laço de
 * espera de CI órfão`, #6921). A 7 era latente: a condição dela raramente
 * dispara, então a duplicação nunca tinha se manifestado.
 *
 * É a MESMA classe que o #6798 já tinha consertado uma vez, cortando a
 * checagem 5 depois que ela "produziu issue duplicada 3x". O defeito voltou
 * em duas checagens escritas depois — que é exatamente o padrão que o #633
 * (todo bugfix exige teste de regressão) existe pra impedir. Sem um guard
 * mecânico, a única defesa é lembrar da regra ao escrever a próxima
 * checagem, e isso já falhou duas vezes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "hermes", "scripts", "watch-continuo-health.sh");

/**
 * Extrai os pares (marcador, título) de cada chamada a `file_issue`.
 * A assinatura é `file_issue "<marcador>" \<newline> "<título>" \...`.
 */
export function extractFileIssueCallSites(source: string): { marker: string; title: string }[] {
  const re = /file_issue "([^"]+)" \\\n\s*"([^"]+)"/g;
  const out: { marker: string; title: string }[] = [];
  for (const m of source.matchAll(re)) out.push({ marker: m[1], title: m[2] });
  return out;
}

describe("#6771 — dedup do watch-continuo-health", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const callSites = extractFileIssueCallSites(source);

  it("o parser enxerga TODA chamada a file_issue que existe no script", () => {
    // Guard contra o ponto cego do parser (review do PR #7330): o regex exige
    // a formatação `file_issue "m" \` + newline + `"t"`. Uma chamada futura
    // escrita de outro jeito válido em bash (tudo na mesma linha, aspas
    // escapadas, variável indireta) não seria capturada — e com uma asserção
    // de PISO (`>= 6`) os 6 sites atuais já satisfariam o mínimo, deixando o
    // guard CEGO para o site novo sem falhar nada. Falso-negativo silencioso
    // é o pior modo de falha possível pra um guard.
    //
    // A contagem independente (ocorrências literais de `file_issue "` fora da
    // definição da própria função) cruza com o que o regex extraiu: divergir
    // força revisão humana do parser em vez de passar em silêncio.
    const literalCalls = (source.match(/^\s+file_issue "/gm) ?? []).length;
    assert.equal(
      callSites.length,
      literalCalls,
      `o regex extraiu ${callSites.length} call sites mas o script tem ${literalCalls} — ` +
        "alguma chamada está num formato que o parser não enxerga; ajuste o regex antes de confiar neste guard",
    );
    assert.ok(callSites.length >= 6, `esperava >=6 call sites, achei ${callSites.length}`);
  });

  it("tratamento de __ERR__ nunca usa igualdade exata (review do PR #7330)", () => {
    // Com `pipefail` e sem `-e`, `A | B` reporta o rc de A mesmo quando B
    // capturou a exceção e imprimiu `__ERR__` — então o `|| echo "__ERR__"`
    // externo dispara também e a variável vira "__ERR__\n__ERR__". Isso
    // escapa de `[ "$X" = "__ERR__" ]`, e na checagem 4 caía no ramo que ABRE
    // ISSUE P1 de cobrança com corpo lixo: alarme falso sobre dinheiro a
    // partir de uma falha de infra. Reproduzido ao vivo em 03/09/2026.
    //
    // O guard exige que toda variável comparada com `__ERR__` passe antes por
    // um `case ... *__ERR__*` normalizador.
    const equalityChecks = [...source.matchAll(/\[ "\$(\w+)" = "__ERR__" \]/g)].map((m) => m[1]);
    assert.ok(equalityChecks.length > 0, "esperava encontrar as comparações — o teste não pode virar no-op");
    const semNormalizador = equalityChecks.filter(
      (v) => !new RegExp(`case "\\$${v}" in \\*__ERR__\\*\\)`).test(source),
    );
    assert.deepEqual(semNormalizador, [], "variável comparada por igualdade sem o `case *__ERR__*` que normaliza antes");
  });

  it("TODO marcador é substring do título que a mesma chamada cria", () => {
    const broken = callSites.filter((c) => !c.title.includes(c.marker));
    assert.deepEqual(
      broken.map((c) => c.marker),
      [],
      "marcador ausente do título → have_issue nunca acha a issue criada → duplica a cada corrida",
    );
  });

  it("marcadores são únicos entre si (dois iguais colapsariam achados distintos)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const { marker } of callSites) {
      if (seen.has(marker)) dupes.push(marker);
      seen.add(marker);
    }
    assert.deepEqual(dupes, [], "marcador repetido faria uma checagem suprimir a issue de outra");
  });
});

describe("#6771 — o parser em si", () => {
  it("extrai marcador e título de uma chamada bem formada", () => {
    const src = `  file_issue "[m] curto" \\\n    "[m] curto — título longo" \\\n    "bug,P2" \\\n`;
    assert.deepEqual(extractFileIssueCallSites(src), [{ marker: "[m] curto", title: "[m] curto — título longo" }]);
  });

  it("reprova o par exato que quebrou em 03/09 (#7326/#7327/#7328)", () => {
    const src =
      `  file_issue "[watch-continuo] degradação de modelo por tick" \\\n` +
      `    "[watch-continuo] tick(s) do contínuo caíram no fallback local nas últimas 24h" \\\n`;
    const [site] = extractFileIssueCallSites(src);
    assert.equal(site.title.includes(site.marker), false, "este par É o defeito — o guard tem de reprová-lo");
  });
});
