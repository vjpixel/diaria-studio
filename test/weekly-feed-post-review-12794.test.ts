/**
 * test/weekly-feed-post-review-12794.test.ts (#12794)
 *
 * Reincidência da #10384: no ciclo 26w45 as duas primeiras versões do post de
 * feed do /diaria-linkedin-semanal (Passo 8d) foram entregues sem humanizador
 * e sem Clarice. Guard mecânico: o texto só sai pro Passo 9 com um marcador
 * cujo hash bate com o texto atual. Os casos abaixo reproduzem o incidente
 * (texto sem marcador, versão nova depois do marcador) e os buracos do
 * atestado (Clarice sem arquivo de sugestões, sugestão não aplicada,
 * travessão). Só arquivos temporários.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  buildFeedPostReviewMarker,
  checkFeedPostReview,
  feedPostHash,
  feedPostPath,
  feedPostReviewPath,
  findDashLines,
  findUnappliedSuggestions,
} from "../scripts/lib/weekly-feed-post-review.ts";
import { FeedPostGuardError, runFeedPostReview } from "../scripts/weekly-feed-post-review.ts";
import { buildClariceSourceSidecar, clariceSourceSidecarPath } from "../scripts/lib/clarice-source-binding.ts";
import { feedPostClariceInputPath, type ClariceBinding } from "../scripts/lib/weekly-feed-post-review.ts";

const TEXT =
  "Toda semana eu trago aqui as três notícias de IA que os leitores da minha newsletter mais clicaram na semana anterior:\n\n" +
  "O Google paga até 12 salários a quem aceitar sair da empresa.\n\n#InteligenciaArtificial #Trabalho";
const NOW = new Date("2026-11-08T12:00:00Z");

function cycleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feed-post-12794-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

/** Amarração válida: o filtrado `list` saiu do texto `input` (o que clarice-filter --source-text grava). */
function bind(input: string, list: unknown[]): ClariceBinding {
  const raw = JSON.stringify(list, null, 2);
  return { inputText: input, filteredRaw: raw, sidecar: buildClariceSourceSidecar(input, raw, list.length) };
}

/** Grava texto enviado à Clarice + filtrado + sidecar, como o fluxo do Passo 8d. */
function writeSuggestions(dir: string, list: unknown[], input: string = TEXT): string {
  const p = join(dir, "s-filtrado.json");
  const raw = JSON.stringify(list, null, 2);
  writeFileSync(feedPostClariceInputPath(dir), input);
  writeFileSync(p, raw);
  writeFileSync(clariceSourceSidecarPath(p), JSON.stringify(buildClariceSourceSidecar(input, raw, list.length)));
  return p;
}

const quiet = () => {};

describe("weekly-feed-post-review (#12794)", () => {
  it("hash ignora CRLF e bordas, mas muda com qualquer palavra", () => {
    assert.equal(feedPostHash(TEXT), feedPostHash(`\n${TEXT.replace(/\n/g, "\r\n")}\n`));
    assert.notEqual(feedPostHash(TEXT), feedPostHash(TEXT.replace("12 salários", "doze salários")));
  });

  it("incidente 26w45: texto entregue sem marcador é recusado", () => {
    const r = checkFeedPostReview(TEXT, null);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /sem marcador/);
  });

  it("versão nova pedida pelo editor invalida o marcador da versão anterior", () => {
    const built = buildFeedPostReviewMarker({
      text: TEXT,
      humanizador: true,
      clariceFiltered: [],
      clariceBinding: bind(TEXT, []),
      now: NOW,
    });
    assert.equal(built.ok, true);
    const marker = (built as { marker: unknown }).marker;
    assert.equal(checkFeedPostReview(TEXT, marker).ok, true);
    const r = checkFeedPostReview(`${TEXT}\n\nParágrafo novo.`, marker);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /mudou depois da revisão/);
  });

  it("marcar exige --humanizador e o arquivo de sugestões da Clarice", () => {
    const semHumanizador = buildFeedPostReviewMarker({ text: TEXT, humanizador: false, clariceFiltered: [], now: NOW });
    assert.equal(semHumanizador.ok, false);
    const semClarice = buildFeedPostReviewMarker({ text: TEXT, humanizador: true, clariceFiltered: null, now: NOW });
    assert.equal(semClarice.ok, false);
    assert.match((semClarice as { reason: string }).reason, /clarice-filtered/);
  });

  it("sugestão da Clarice mantida e não aplicada bloqueia, salvo exceção declarada", () => {
    const sugestoes = [{ from: "12 salários", to: "doze salários" }];
    assert.equal(findUnappliedSuggestions(TEXT, sugestoes).length, 1);
    const recusado = buildFeedPostReviewMarker({ text: TEXT, humanizador: true, clariceFiltered: sugestoes, now: NOW });
    assert.equal(recusado.ok, false);
    assert.match((recusado as { reason: string }).reason, /não aplicada/);

    const aceito = buildFeedPostReviewMarker({
      text: TEXT,
      humanizador: true,
      clariceFiltered: sugestoes,
      clariceBinding: bind(TEXT, sugestoes),
      allowUnapplied: "número fica em algarismo, padrão da casa",
      now: NOW,
    });
    assert.equal(aceito.ok, true);
    const m = (aceito as { marker: { clarice_nao_aplicadas?: unknown[]; clarice_motivo?: string } }).marker;
    assert.equal(m.clarice_nao_aplicadas?.length, 1);
    assert.match(m.clarice_motivo ?? "", /algarismo/);
  });

  it("sugestão aplicada, de remoção ou com from ausente não conta como pendente", () => {
    const aplicado = TEXT.replace("12 salários", "doze salários");
    assert.deepEqual(
      findUnappliedSuggestions(aplicado, [
        { from: "12 salários", to: "doze salários" },
        { from: "Google", to: "" },
        { from: "inexistente", to: "outra" },
      ]),
      [],
    );
  });

  it("travessão bloqueia marcar e conferir", () => {
    const comTravessao = TEXT.replace("empresa.", "empresa — e só.");
    assert.deepEqual(findDashLines(comTravessao), [3]);
    assert.equal(
      buildFeedPostReviewMarker({ text: comTravessao, humanizador: true, clariceFiltered: [], now: NOW }).ok,
      false,
    );
    const ok = buildFeedPostReviewMarker({
      text: TEXT,
      humanizador: true,
      clariceFiltered: [],
      clariceBinding: bind(TEXT, []),
      now: NOW,
    });
    assert.equal(ok.ok, true);
    assert.equal(checkFeedPostReview(TEXT.replace("empresa.", "empresa – e só."), (ok as { marker: unknown }).marker).ok, false);
  });

  it("marcador sem clarice_sugestoes (forma da cédula) é inválido aqui", () => {
    const r = checkFeedPostReview(TEXT, { humanizador: true, clarice: true, em: NOW.toISOString(), hash: feedPostHash(TEXT) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /inválido/);
  });

  it("CLI: mark grava o marcador e check devolve o texto; edição posterior volta a recusar", () => {
    const dir = cycleDir();
    try {
      assert.throws(
        () => runFeedPostReview({ cycleDir: dir, mode: "check", humanizador: false, now: NOW, log: quiet }),
        FeedPostGuardError,
      );
      writeFileSync(feedPostPath(dir), `${TEXT}\n`);
      assert.throws(
        () => runFeedPostReview({ cycleDir: dir, mode: "check", humanizador: false, now: NOW, log: quiet }),
        /sem marcador/,
      );
      runFeedPostReview({
        cycleDir: dir,
        mode: "mark",
        humanizador: true,
        clariceFilteredPath: writeSuggestions(dir, []),
        now: NOW,
        log: quiet,
      });
      assert.ok(existsSync(feedPostReviewPath(dir)));
      const marker = JSON.parse(readFileSync(feedPostReviewPath(dir), "utf8"));
      assert.equal(marker.clarice_sugestoes, 0);
      assert.equal(
        runFeedPostReview({ cycleDir: dir, mode: "check", humanizador: false, now: NOW, log: quiet }),
        `${TEXT}\n`,
      );

      writeFileSync(feedPostPath(dir), `${TEXT} Versão mais longa.\n`);
      assert.throws(
        () => runFeedPostReview({ cycleDir: dir, mode: "check", humanizador: false, now: NOW, log: quiet }),
        /mudou depois da revisão/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regressão PR #12823: filtrado [] antigo + texto novo é recusado (exit 2)", () => {
    const dir = cycleDir();
    try {
      const antigo = TEXT;
      const novo = `${TEXT}\n\nVersão mais longa pedida pelo editor.`;
      // Versão 1: Clarice rodou sobre o texto antigo, sem sugestões.
      const filtrado = writeSuggestions(dir, [], antigo);
      // Versão 2: o editor pede outra versão; o agente grava o texto novo e
      // reaproveita o [] da versão anterior.
      writeFileSync(feedPostPath(dir), novo);
      const mark = () =>
        runFeedPostReview({ cycleDir: dir, mode: "mark", humanizador: true, clariceFilteredPath: filtrado, now: NOW, log: quiet });
      assert.throws(mark, (e: unknown) => e instanceof FeedPostGuardError && /edição depois da Clarice/.test((e as Error).message));
      // Reescrever só o texto de entrada da Clarice não basta: o sidecar é do antigo.
      writeFileSync(feedPostClariceInputPath(dir), novo);
      assert.throws(mark, (e: unknown) => e instanceof FeedPostGuardError && /é de outro texto/.test((e as Error).message));
      // Trocar o filtrado à mão (sem clarice-filter) também não passa.
      writeFileSync(filtrado, "[ ]\n");
      assert.throws(mark, /trocado ou editado/);
      assert.equal(existsSync(feedPostReviewPath(dir)), false);
      // Clarice de novo sobre a versão nova: passa.
      writeSuggestions(dir, [], novo);
      mark();
      assert.equal(runFeedPostReview({ cycleDir: dir, mode: "check", humanizador: false, now: NOW, log: quiet }), novo);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filtrado sem sidecar ou sem texto de entrada da Clarice é recusado", () => {
    const raw = "[]";
    const semSidecar = buildFeedPostReviewMarker({
      text: TEXT,
      humanizador: true,
      clariceFiltered: [],
      clariceBinding: { inputText: TEXT, filteredRaw: raw, sidecar: null },
      now: NOW,
    });
    assert.match((semSidecar as { reason: string }).reason, /sidecar/);
    const semEntrada = buildFeedPostReviewMarker({ text: TEXT, humanizador: true, clariceFiltered: [], now: NOW });
    assert.match((semEntrada as { reason: string }).reason, /texto enviado à Clarice ausente/);
  });

  it("sugestões aplicadas ao texto de entrada passam; edição extra depois da Clarice não", () => {
    const sugestoes = [{ from: "12 salários", to: "doze salários" }];
    const final = TEXT.replace("12 salários", "doze salários");
    const ok = buildFeedPostReviewMarker({
      text: final,
      humanizador: true,
      clariceFiltered: sugestoes,
      clariceBinding: bind(TEXT, sugestoes),
      now: NOW,
    });
    assert.equal(ok.ok, true);
    const editado = buildFeedPostReviewMarker({
      text: `${final} Frase nova.`,
      humanizador: true,
      clariceFiltered: sugestoes,
      clariceBinding: bind(TEXT, sugestoes),
      now: NOW,
    });
    assert.equal(editado.ok, false);
  });

  it("CLI clarice-filter --source-text grava o sidecar com o hash do texto", () => {
    const dir = cycleDir();
    try {
      const inp = join(dir, "s.json");
      const out = join(dir, "s-filtrado.json");
      const src = join(dir, "src.txt");
      writeFileSync(inp, JSON.stringify([{ from: "12 salários", to: "doze salários" }]));
      writeFileSync(src, TEXT);
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/clarice-filter.ts", "--suggestions", inp, "--out", out, "--source-text", src],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const sidecar = JSON.parse(readFileSync(clariceSourceSidecarPath(out), "utf8"));
      assert.deepEqual(sidecar, buildClariceSourceSidecar(TEXT, readFileSync(out, "utf8"), 1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guard armado: o SKILL.md chama --mark no Passo 8d e --check no Passo 9", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-linkedin-semanal/SKILL.md"), "utf8");
    const p8d = skill.indexOf("### 8d.");
    const p9 = skill.indexOf("## Passo 9");
    assert.ok(p8d > 0 && p9 > p8d);
    assert.match(skill.slice(p8d, p9), /weekly-feed-post-review\.ts --cycle \{cycle\} --mark --humanizador --clarice-filtered/);
    assert.match(skill.slice(p9), /weekly-feed-post-review\.ts --cycle \{cycle\} --check/);
  });

  it("CLI: --clarice-filtered que não é array de sugestões é recusado", () => {
    const dir = cycleDir();
    try {
      writeFileSync(feedPostPath(dir), TEXT);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ kept: 1 }));
      assert.throws(
        () =>
          runFeedPostReview({ cycleDir: dir, mode: "mark", humanizador: true, clariceFilteredPath: bad, now: NOW, log: quiet }),
        /não é um array/,
      );
      assert.equal(existsSync(feedPostReviewPath(dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
