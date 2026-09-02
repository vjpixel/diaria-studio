/**
 * test/worker-drift-deploy-blocked-7092.test.ts (#7092)
 *
 * Regressão do status `deploy_blocked` de `scripts/lib/worker-drift-check.ts`.
 *
 * ─── O incidente (02/09/2026) ──────────────────────────────────────────────
 *
 * O alarme `Diaria-Worker-Drift-Check` viu commit > deploy em `diaria-artigos`
 * e abriu a issue #7092 prescrevendo `cd workers/artigos && npx wrangler
 * deploy` — o único comando que comprovadamente NÃO funcionava naquele
 * estado: `workers/artigos/wrangler.toml` ainda carregava
 * `id = "PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE"` (o KV namespace
 * `ARTIGOS_APOIO_NIVEL` nunca foi provisionado, #7030), e o deploy falharia
 * contra um id inexistente.
 *
 * O detalhe que torna isto um bug e não uma limitação: o REPO JÁ SABIA.
 * `.github/workflows/deploy-artigos.yml` tem o passo "Guard - KV namespace
 * provisionado?" que pula o deploy automático enquanto esse literal estiver
 * no config. Dois mecanismos lendo o mesmo arquivo e discordando — o CI
 * pulava, o alarme insistia. Estes testes travam a concordância.
 *
 * **O que estes testes NÃO cobrem, de propósito:** o fato de o gate dos
 * Artigos Especiais continuar fora do ar em produção. Isso é estado do mundo,
 * não do código — rastreado em #7152. Silenciar o alarme aqui só é correto
 * porque aquela issue existe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseDeployBlockingPlaceholders,
  evaluateWorkerDrift,
  hasPendingDrift,
  computeDriftFingerprint,
  shouldAlarm,
  emptyWorkerDriftAlarmState,
  buildWorkerDriftAlarmEmail,
  type WorkerDriftResult,
} from "../scripts/lib/worker-drift-check.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

/** Timestamps EXATOS do incidente — o deploy publicado e o commit que o
 * alarme comparou quando abriu a #7092. */
const INCIDENT = {
  lastDeployedAt: "2026-09-02T01:16:57.681617Z",
  lastCommitAt: "2026-09-02T07:30:51Z",
} as const;

function result(overrides: Partial<WorkerDriftResult>): WorkerDriftResult {
  return {
    workerName: "reativar",
    workerDir: "reativar",
    status: "drift",
    lastDeployedAt: "2026-08-01T10:00:00Z",
    lastCommitAt: "2026-08-05T10:00:00Z",
    driftMs: 1000,
    message: "",
    deployBlockedBy: [],
    ...overrides,
  };
}

describe("parseDeployBlockingPlaceholders (#7092)", () => {
  it("acha o placeholder de KV do workers/artigos em posição de valor", () => {
    const toml = [
      "[[kv_namespaces]]",
      'binding = "ARTIGOS_APOIO_NIVEL"',
      'id = "PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE"',
    ].join("\n");
    assert.deepEqual(parseDeployBlockingPlaceholders(toml), [
      "PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE",
    ]);
  });

  it("MENÇÃO em comentário não conta — só valor entre aspas depois de =/:", () => {
    // O wrangler.toml real do artigos explica o placeholder num comentário
    // logo acima da linha do id; casar o comentário deixaria o worker
    // silenciado para sempre, mesmo depois de o id real ser colado.
    const toml = [
      "# PLACEHOLDER — rodar `wrangler kv namespace create` e colar o id aqui.",
      "# Enquanto PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE estiver aqui, o CI pula.",
      'id = "a1b2c3d4e5f6"',
    ].join("\n");
    assert.deepEqual(parseDeployBlockingPlaceholders(toml), []);
  });

  it("config normal (nenhum placeholder) -> lista vazia", () => {
    assert.deepEqual(parseDeployBlockingPlaceholders('name = "reativar"\nid = "abc123"'), []);
  });

  it("wrangler.jsonc (aspas + dois-pontos) também é reconhecido", () => {
    assert.deepEqual(parseDeployBlockingPlaceholders('{ "id": "PLACEHOLDER_ALGUMA_COISA" }'), [
      "PLACEHOLDER_ALGUMA_COISA",
    ]);
  });

  it("dedup + ordenação estável com múltiplos placeholders", () => {
    const toml = 'a = "PLACEHOLDER_Z"\nb = "PLACEHOLDER_A"\nc = "PLACEHOLDER_Z"';
    assert.deepEqual(parseDeployBlockingPlaceholders(toml), ["PLACEHOLDER_A", "PLACEHOLDER_Z"]);
  });

  it("conteúdo vazio nunca lança", () => {
    assert.deepEqual(parseDeployBlockingPlaceholders(""), []);
  });
});

describe("evaluateWorkerDrift com deployBlockedBy (#7092)", () => {
  it("REGRESSÃO: drift + placeholder -> deploy_blocked, não drift", () => {
    const r = evaluateWorkerDrift(
      {
        workerName: "diaria-artigos",
        workerDir: "artigos",
        ...INCIDENT,
        deployBlockedBy: ["PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE"],
      },
      NOW,
    );
    assert.equal(r.status, "deploy_blocked");
    // O FATO do drift continua visível — bloquear o alarme nunca pode
    // esconder que o publicado está atrás do master.
    assert.match(r.message, /commit mais recente/);
    assert.match(r.message, /PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE/);
    assert.notEqual(r.driftMs, null);
  });

  it("REGRESSÃO: deploy_blocked não alarma nem entra no fingerprint", () => {
    const blocked = evaluateWorkerDrift(
      {
        workerName: "diaria-artigos",
        workerDir: "artigos",
        ...INCIDENT,
        deployBlockedBy: ["PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE"],
      },
      NOW,
    );
    assert.equal(hasPendingDrift([blocked]), false);
    assert.equal(computeDriftFingerprint([blocked]), "");
    assert.equal(shouldAlarm(emptyWorkerDriftAlarmState(), [blocked]), false);
  });

  it("nunca deployado + placeholder -> deploy_blocked (não never_deployed)", () => {
    const r = evaluateWorkerDrift(
      {
        workerName: "novo",
        workerDir: "novo",
        lastDeployedAt: null,
        lastCommitAt: "2026-09-01T10:00:00Z",
        deployBlockedBy: ["PLACEHOLDER_ALGO"],
      },
      NOW,
    );
    assert.equal(r.status, "deploy_blocked");
    assert.equal(hasPendingDrift([r]), false);
  });

  it("SEM placeholder o comportamento pré-#7092 é preservado: drift alarma", () => {
    const r = evaluateWorkerDrift(
      { workerName: "diaria-artigos", workerDir: "artigos", ...INCIDENT, deployBlockedBy: [] },
      NOW,
    );
    assert.equal(r.status, "drift");
    assert.equal(hasPendingDrift([r]), true);
  });

  it("deployBlockedBy OMITIDO (input legado) equivale a lista vazia", () => {
    const r = evaluateWorkerDrift(
      {
        workerName: "reativar",
        workerDir: "reativar",
        lastDeployedAt: "2026-08-01T10:00:00Z",
        lastCommitAt: "2026-08-05T10:00:00Z",
      },
      NOW,
    );
    assert.equal(r.status, "drift");
    assert.deepEqual(r.deployBlockedBy, []);
  });

  it("placeholder mas SEM drift (deploy em dia) -> ok, não deploy_blocked", () => {
    // O status novo é confinado ao caminho que ALARMARIA: "em dia" continua
    // sendo a informação mais útil quando não há nada a deployar.
    const r = evaluateWorkerDrift(
      {
        workerName: "artigos",
        workerDir: "artigos",
        lastDeployedAt: "2026-09-02T10:00:00Z",
        lastCommitAt: "2026-09-01T10:00:00Z",
        deployBlockedBy: ["PLACEHOLDER_ALGO"],
      },
      NOW,
    );
    assert.equal(r.status, "ok");
  });

  it("erro de consulta vence o placeholder — sem dado confiável, status error", () => {
    const r = evaluateWorkerDrift(
      {
        workerName: "artigos",
        workerDir: "artigos",
        lastDeployedAt: null,
        lastCommitAt: "2026-09-01T10:00:00Z",
        deployError: "401 Unauthorized",
        deployBlockedBy: ["PLACEHOLDER_ALGO"],
      },
      NOW,
    );
    assert.equal(r.status, "error");
  });
});

describe("CI e alarme concordam sobre os arquivos REAIS (#7092)", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const readRoot = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  /** Reimplementa em JS o `grep -qE` do passo "Guard - KV namespace
   * provisionado?" de `.github/workflows/deploy-artigos.yml`. Se o workflow
   * mudar o padrão sem mudar este teste, a asserção de equivalência abaixo
   * quebra — que é o ponto: a divergência entre os dois mecanismos foi o
   * bug. */
  const ciGrepSkips = (toml: string) =>
    toml.split("\n").some((line) => /^[^#]*[=:]\s*"PLACEHOLDER_[A-Z0-9_]*"/.test(line));

  it("o padrão do workflow e o do alarme decidem IGUAL sobre workers/artigos/wrangler.toml", () => {
    const toml = readRoot("workers/artigos/wrangler.toml");
    const alarmBlocks = parseDeployBlockingPlaceholders(toml).length > 0;
    assert.equal(
      alarmBlocks,
      ciGrepSkips(toml),
      "CI pularia o deploy e o alarme não sabe disso (ou vice-versa) — foi exatamente essa divergência que abriu a #7092",
    );
  });

  it("o workflow ainda usa o padrão em posição de VALOR, não um grep literal solto", () => {
    // Guard contra regressão do próprio fix: voltar pro `grep -q "PLACEHOLDER_..."`
    // literal reintroduz o falso-positivo por comentário.
    const wf = readRoot(".github/workflows/deploy-artigos.yml");
    assert.match(wf, /grep -qE '\^\[\^#\]\*\[=:\]\[\[:space:\]\]\*"PLACEHOLDER_\[A-Z0-9_\]\*"'/);
  });

  it("uma MENÇÃO em comentário não faz nenhum dos dois pular (o caso que divergia)", () => {
    const toml = [
      "# id = PLACEHOLDER_RODAR_WRANGLER_KV_NAMESPACE_CREATE (histórico, já resolvido)",
      'id = "a1b2c3d4e5f6"',
    ].join("\n");
    assert.equal(parseDeployBlockingPlaceholders(toml).length > 0, false);
    assert.equal(ciGrepSkips(toml), false);
  });
});

describe("buildWorkerDriftAlarmEmail com deploy_blocked (#7092)", () => {
  it("bloqueado sai em seção separada, fora da contagem de defasados", () => {
    const drifted = result({ workerName: "reativar", status: "drift" });
    const blocked = result({
      workerName: "diaria-artigos",
      workerDir: "artigos",
      status: "deploy_blocked",
      message: "commit mais recente ..., mas o deploy está bloqueado: PLACEHOLDER_X",
      deployBlockedBy: ["PLACEHOLDER_X"],
    });
    const { subject, body } = buildWorkerDriftAlarmEmail([drifted, blocked], NOW);
    assert.match(subject, /1 worker\(s\) com deploy defasado/);
    assert.match(body, /deploy bloqueado por placeholder \(NÃO alarmado\)/);
    assert.match(body, /diaria-artigos/);
    // O bloqueado NUNCA recebe a receita de deploy que não funciona — foi
    // exatamente ela que a #7092 mandou pro editor.
    assert.doesNotMatch(body, /cd workers\/artigos && npx wrangler deploy/);
  });

  it("só bloqueados (nenhum drift real) -> nada a alarmar", () => {
    const blocked = result({
      workerName: "diaria-artigos",
      workerDir: "artigos",
      status: "deploy_blocked",
      deployBlockedBy: ["PLACEHOLDER_X"],
    });
    assert.equal(hasPendingDrift([blocked]), false);
    assert.equal(shouldAlarm(emptyWorkerDriftAlarmState(), [blocked]), false);
  });
});
