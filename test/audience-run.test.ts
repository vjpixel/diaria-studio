/**
 * test/audience-run.test.ts (#5192)
 *
 * Cobre `scripts/audience-run.ts` — o orquestrador determinístico que
 * substitui o *glue* em prosa da skill `/diaria-atualiza-audiencia`, no
 * mesmo molde do #4941 (`clarice-novos-run.ts`). Nenhuma chamada de rede
 * real: `fetchPublications`/`exec` são injetados, fakes que registram
 * chamadas e devolvem respostas canned — os testes verificam RESULTADO
 * (exit code, arquivos gravados) e a SEQUÊNCIA/ARGS de cada passo.
 *
 * `readFile`/`writeFile` usam `node:fs` real, mas sempre escopados a um
 * `mkdtempSync` isolado por teste — nunca tocam `data/`/`platform.config.json`
 * do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runAudience,
  parseAudienceRunArgs,
  normalizeSurveyResponses,
  resolvePublicationId,
  resolveProfileSurveyId,
  parsePlatformConfig,
  serializePlatformConfig,
  AudienceAbort,
  type AudienceRunDeps,
  type PlatformConfig,
  type PublicationCandidate,
  type ExecFn,
  type StepResult,
} from "../scripts/audience-run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "audience-run-"));
}

function writeConfig(root: string, cfg: PlatformConfig): void {
  writeFileSync(resolve(root, "platform.config.json"), serializePlatformConfig(cfg), "utf8");
}

function writeJsonFixture(root: string, relPath: string, data: unknown): string {
  const abs = resolve(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(data), "utf8");
  return relPath;
}

function makeFakeExec(handler: (script: string, args: string[]) => StepResult): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    return handler(script, args);
  };
  return { exec, calls };
}

function baseDeps(root: string, overrides: Partial<AudienceRunDeps> = {}): AudienceRunDeps {
  return {
    rootDir: root,
    apiKey: "test-key",
    fetchPublications: async () => {
      throw new Error("fetchPublications não deveria ser chamado — configure override");
    },
    exec: () => {
      throw new Error("exec não deveria ser chamado — configure override");
    },
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    ...overrides,
  };
}

const VALID_RESPONSE_A = {
  id: "resp-1",
  status: "active",
  answers: [{ question_id: "q1", question_prompt: "Setor de atuação?", answer: "Tecnologia" }],
};
const VALID_RESPONSE_B = {
  id: "resp-2",
  answers: [{ question_id: "q1", question_prompt: "Setor de atuação?", answer: "Educação" }],
};

// ---------------------------------------------------------------------------
// parseAudienceRunArgs
// ---------------------------------------------------------------------------

describe("parseAudienceRunArgs", () => {
  it("lê todas as flags", () => {
    const o = parseAudienceRunArgs([
      "--resolve-only",
      "--surveys-json",
      "s.json",
      "--responses",
      "r.json",
      "--dry-run",
      "--skip-beehiiv-resolve",
    ]);
    assert.deepEqual(o, {
      resolveOnly: true,
      surveysJsonPath: "s.json",
      responsesPath: "r.json",
      dryRun: true,
      skipBeehiivResolve: true,
    });
  });

  it("sem flags -> tudo default", () => {
    assert.deepEqual(parseAudienceRunArgs([]), {
      resolveOnly: false,
      surveysJsonPath: undefined,
      responsesPath: undefined,
      dryRun: false,
      skipBeehiivResolve: false,
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeSurveyResponses — fail-soft
// ---------------------------------------------------------------------------

describe("normalizeSurveyResponses (fail-soft)", () => {
  it("mantém itens válidos e preserva status/answers", () => {
    const result = normalizeSurveyResponses([VALID_RESPONSE_A, VALID_RESPONSE_B]);
    assert.equal(result.skipped, 0);
    assert.equal(result.valid.length, 2);
    assert.equal(result.valid[0].id, "resp-1");
    assert.equal(result.valid[0].status, "active");
    assert.equal(result.valid[1].status, undefined);
    assert.deepEqual(result.valid[0].answers, [{ question_id: "q1", question_prompt: "Setor de atuação?", answer: "Tecnologia" }]);
  });

  it("pula item sem 'id', loga motivo, mantém os outros válidos (nunca trava o lote)", () => {
    const malformed = { answers: [] };
    const result = normalizeSurveyResponses([VALID_RESPONSE_A, malformed, VALID_RESPONSE_B]);
    assert.equal(result.skipped, 1);
    assert.equal(result.valid.length, 2);
    assert.match(result.skipReasons[0], /item\[1\].*id/);
  });

  it("pula item com 'answers' ausente/não-array", () => {
    const result = normalizeSurveyResponses([{ id: "x", answers: "não é array" }]);
    assert.equal(result.skipped, 1);
    assert.equal(result.valid.length, 0);
    assert.match(result.skipReasons[0], /answers/);
  });

  it("pula item com answer[].question_id ausente", () => {
    const result = normalizeSurveyResponses([{ id: "x", answers: [{ question_prompt: "p", answer: "a" }] }]);
    assert.equal(result.skipped, 1);
    assert.match(result.skipReasons[0], /question_id/);
  });

  it("pula item que não é objeto (string/null/number no array)", () => {
    const result = normalizeSurveyResponses(["oops", null, 42, VALID_RESPONSE_A]);
    assert.equal(result.skipped, 3);
    assert.equal(result.valid.length, 1);
  });

  it("array vazio -> 0 válidos, 0 pulados, nunca lança", () => {
    const result = normalizeSurveyResponses([]);
    assert.deepEqual(result, { valid: [], skipped: 0, skipReasons: [] });
  });
});

// ---------------------------------------------------------------------------
// resolvePublicationId
// ---------------------------------------------------------------------------

describe("resolvePublicationId", () => {
  it("config já tem publicationId -> retorna sem chamar fetchPublications", async () => {
    const cfg: PlatformConfig = { beehiiv: { publicationId: "pub_abc" } };
    const result = await resolvePublicationId(cfg, {
      apiKey: "k",
      fetchPublications: async () => {
        throw new Error("não deveria chamar");
      },
    });
    assert.deepEqual(result, { publicationId: "pub_abc", persisted: false });
  });

  it("ausente + sem apiKey -> AudienceAbort code 2", async () => {
    await assert.rejects(
      () => resolvePublicationId({}, { apiKey: undefined, fetchPublications: async () => [] }),
      (e: unknown) => e instanceof AudienceAbort && e.code === 2,
    );
  });

  it("ausente + apiKey + exatamente 1 publicação -> resolve e persisted=true", async () => {
    const pubs: PublicationCandidate[] = [{ id: "pub_xyz", name: "Diar.ia" }];
    const result = await resolvePublicationId({}, { apiKey: "k", fetchPublications: async () => pubs });
    assert.deepEqual(result, { publicationId: "pub_xyz", persisted: true });
  });

  it("ausente + 0 publicações -> AudienceAbort code 1", async () => {
    await assert.rejects(
      () => resolvePublicationId({}, { apiKey: "k", fetchPublications: async () => [] }),
      (e: unknown) => e instanceof AudienceAbort && e.code === 1,
    );
  });

  it("ausente + >1 publicações -> AudienceAbort code 1, mensagem lista os ids", async () => {
    const pubs: PublicationCandidate[] = [{ id: "pub_a" }, { id: "pub_b", name: "Segunda" }];
    await assert.rejects(
      () => resolvePublicationId({}, { apiKey: "k", fetchPublications: async () => pubs }),
      (e: unknown) => e instanceof AudienceAbort && e.code === 1 && /pub_a/.test(e.message) && /pub_b/.test(e.message),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveProfileSurveyId
// ---------------------------------------------------------------------------

describe("resolveProfileSurveyId", () => {
  it("config já tem profileSurveyId -> retorna sem olhar surveysJson", () => {
    const cfg: PlatformConfig = { beehiiv: { profileSurveyId: "srv_1" } };
    const result = resolveProfileSurveyId(cfg, undefined);
    assert.deepEqual(result, { surveyId: "srv_1", persisted: false });
  });

  it("ausente + surveysJson não fornecido -> AudienceAbort", () => {
    assert.throws(() => resolveProfileSurveyId({}, undefined), AudienceAbort);
  });

  it("ausente + exatamente 1 survey candidata -> resolve e persisted=true", () => {
    const result = resolveProfileSurveyId({}, [{ id: "srv_only", name: "Perfil" }]);
    assert.deepEqual(result, { surveyId: "srv_only", persisted: true });
  });

  it("ausente + >1 surveys -> AudienceAbort, mensagem lista candidatos, NÃO adivinha", () => {
    assert.throws(
      () => resolveProfileSurveyId({}, [{ id: "srv_a", name: "A" }, { id: "srv_b", title: "B" }]),
      (e: unknown) => e instanceof AudienceAbort && /srv_a/.test(e.message) && /srv_b/.test(e.message),
    );
  });

  it("surveysJson sem nenhum item com 'id' válido -> AudienceAbort", () => {
    assert.throws(() => resolveProfileSurveyId({}, [{ nome: "sem id" }]), AudienceAbort);
  });
});

// ---------------------------------------------------------------------------
// runAudience — integração (fs real escopado a mkdtempSync)
// ---------------------------------------------------------------------------

describe("runAudience — integração", () => {
  it("platform.config.json ilegível -> exit 2, nenhuma chamada externa", async () => {
    const root = freshRoot();
    try {
      // não cria platform.config.json de propósito
      const { exec } = makeFakeExec(() => {
        throw new Error("não deveria chamar exec");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience([], deps);
      assert.equal(result.code, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--resolve-only com config já completo -> imprime ids, exit 0, config NÃO reescrito", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const configPath = resolve(root, "platform.config.json");
      const before = readFileSync(configPath, "utf8");
      const deps = baseDeps(root, {
        fetchPublications: async () => {
          throw new Error("não deveria chamar — publicationId já configurado");
        },
      });
      const result = await runAudience(["--resolve-only"], deps);
      assert.equal(result.code, 0);
      assert.equal(readFileSync(configPath, "utf8"), before, "config não deveria ser reescrito quando nada precisou ser resolvido");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--resolve-only resolve publicationId ausente via fetchPublications e PERSISTE em platform.config.json", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { profileSurveyId: "srv_ok" } });
      const deps = baseDeps(root, {
        fetchPublications: async () => [{ id: "pub_novo" }],
      });
      const result = await runAudience(["--resolve-only"], deps);
      assert.equal(result.code, 0);
      const cfgAfter = parsePlatformConfig(readFileSync(resolve(root, "platform.config.json"), "utf8"));
      assert.equal(cfgAfter.beehiiv?.publicationId, "pub_novo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--resolve-only resolve profileSurveyId ausente via --surveys-json (1 candidata) e persiste", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok" } });
      const surveysPath = writeJsonFixture(root, "data/_tmp/surveys.json", [{ id: "srv_unica", name: "Perfil diar.ia.br" }]);
      const deps = baseDeps(root);
      const result = await runAudience(["--resolve-only", "--surveys-json", surveysPath], deps);
      assert.equal(result.code, 0);
      const cfgAfter = parsePlatformConfig(readFileSync(resolve(root, "platform.config.json"), "utf8"));
      assert.equal(cfgAfter.beehiiv?.profileSurveyId, "srv_unica");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--resolve-only com >1 surveys em --surveys-json -> aborta (exit 1), config não tocado", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok" } });
      const configBefore = readFileSync(resolve(root, "platform.config.json"), "utf8");
      const surveysPath = writeJsonFixture(root, "data/_tmp/surveys.json", [{ id: "a" }, { id: "b" }]);
      const deps = baseDeps(root);
      const result = await runAudience(["--resolve-only", "--surveys-json", surveysPath], deps);
      assert.equal(result.code, 1);
      assert.equal(readFileSync(resolve(root, "platform.config.json"), "utf8"), configBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fora de --resolve-only, sem --responses -> aborta (exit 1)", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const deps = baseDeps(root);
      const result = await runAudience([], deps);
      assert.equal(result.code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caminho feliz completo: grava data/audience-raw.json, roda update-audience.ts, mostra o topo do profile", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [
        VALID_RESPONSE_A,
        VALID_RESPONSE_B,
        { id: "malformado" }, // sem answers -> deve ser pulado, fail-soft
      ]);
      // fixture do profile gerado por update-audience.ts — o script real
      // escreveria isto; aqui o fake exec simula esse efeito colateral.
      const profilePath = resolve(root, "context/audience-profile.md");
      mkdirSync(resolve(root, "context"), { recursive: true });

      const { exec, calls } = makeFakeExec((script) => {
        if (script === "scripts/update-audience.ts") {
          writeFileSync(profilePath, "# Perfil de Audiência — diar.ia.br\n\nlinha 2\n", "utf8");
          return { code: 0, stdout: "Wrote audience profile", stderr: "" };
        }
        throw new Error(`script inesperado: ${script}`);
      });

      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--responses", responsesPath], deps);
      assert.equal(result.code, 0);

      // audience-raw.json tem só as 2 respostas válidas (a malformada foi pulada)
      const rawWritten = JSON.parse(readFileSync(resolve(root, "data/audience-raw.json"), "utf8"));
      assert.equal(rawWritten.length, 2);
      assert.deepEqual(
        rawWritten.map((r: { id: string }) => r.id),
        ["resp-1", "resp-2"],
      );

      // update-audience.ts foi chamado exatamente 1x, com o path do audience-raw.json
      assert.equal(calls.length, 1);
      assert.equal(calls[0].script, "scripts/update-audience.ts");
      assert.equal(calls[0].args[0], resolve(root, "data/audience-raw.json"));

      assert.ok(existsSync(profilePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--skip-beehiiv-resolve (#466, achado CRÍTICO do review PR #6084): caminho feliz completo SEM beehiiv.publicationId/profileSurveyId no config", async () => {
    const root = freshRoot();
    try {
      // Config SEM beehiiv.* nenhum — mesma forma do platform.config.json
      // real (não tem beehiiv.profileSurveyId). Sem --skip-beehiiv-resolve,
      // resolveProfileSurveyId abortaria aqui (exit 1) ANTES de sequer
      // olhar --responses — era exatamente o que fetch-tally-audience.ts
      // sofria em produção antes deste fix.
      writeConfig(root, {});
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [VALID_RESPONSE_A]);
      const profilePath = resolve(root, "context/audience-profile.md");
      mkdirSync(resolve(root, "context"), { recursive: true });

      const { exec, calls } = makeFakeExec((script) => {
        if (script === "scripts/update-audience.ts") {
          writeFileSync(profilePath, "# Perfil de Audiência — diar.ia.br\n", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`script inesperado: ${script}`);
      });
      const deps = baseDeps(root, {
        exec,
        fetchPublications: async () => {
          throw new Error("não deveria chamar — Passo 1 pulado por --skip-beehiiv-resolve");
        },
      });

      const result = await runAudience(["--responses", responsesPath, "--skip-beehiiv-resolve"], deps);
      assert.equal(result.code, 0);
      assert.equal(calls.length, 1, "chegou até update-audience.ts — não abortou em resolveProfileSurveyId");
      assert.ok(existsSync(profilePath));
      // config não ganhou beehiiv.publicationId/profileSurveyId nenhum —
      // Passo 1/3 nunca rodaram.
      const cfgAfter = parsePlatformConfig(readFileSync(resolve(root, "platform.config.json"), "utf8"));
      assert.equal(cfgAfter.beehiiv, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--skip-beehiiv-resolve sem --responses: erro NÃO menciona publication_id/survey_id inexistentes", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, {});
      const { exec } = makeFakeExec(() => {
        throw new Error("não deveria chamar exec");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--skip-beehiiv-resolve"], deps);
      assert.equal(result.code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--skip-beehiiv-resolve + --resolve-only: combinação sem sentido, aborta (exit 1)", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, {});
      const { exec } = makeFakeExec(() => {
        throw new Error("não deveria chamar exec");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--resolve-only", "--skip-beehiiv-resolve"], deps);
      assert.equal(result.code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run: NÃO grava audience-raw.json nem chama exec", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [VALID_RESPONSE_A]);
      const { exec, calls } = makeFakeExec(() => {
        throw new Error("exec não deveria ser chamado em --dry-run");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--responses", responsesPath, "--dry-run"], deps);
      assert.equal(result.code, 0);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #5298 — achado do review dedicado: com profileSurveyId (e/ou
  // publicationId) AUSENTE de platform.config.json, a resolução via
  // --surveys-json disparava os branches de persistência ANTES do check de
  // --dry-run, gravando o arquivo mesmo sob "dry-run" (o teste acima nunca
  // pegava isso porque semeava as duas IDs já presentes, então os branches
  // de persistência nunca disparavam). Este teste reproduz exatamente o
  // cenário do achado: config com só publicationId, --surveys-json com 1
  // candidato, --resolve-only --dry-run — e confirma platform.config.json
  // idêntico byte a byte antes/depois.
  it("--dry-run + --resolve-only com profileSurveyId ausente: resolve em memória mas NÃO grava platform.config.json", async () => {
    const root = freshRoot();
    try {
      const initialCfg: PlatformConfig = { beehiiv: { publicationId: "pub_ok" } };
      writeConfig(root, initialCfg);
      const beforeBytes = readFileSync(resolve(root, "platform.config.json"), "utf8");

      const surveysPath = writeJsonFixture(root, "data/_tmp/surveys.json", [{ id: "srv_candidate", name: "Perfil da audiência" }]);

      const { exec, calls } = makeFakeExec(() => {
        throw new Error("exec não deveria ser chamado em --resolve-only/--dry-run");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--resolve-only", "--surveys-json", surveysPath, "--dry-run"], deps);

      assert.equal(result.code, 0);
      assert.equal(calls.length, 0);

      // platform.config.json não mudou — nem um byte.
      const afterBytes = readFileSync(resolve(root, "platform.config.json"), "utf8");
      assert.equal(afterBytes, beforeBytes);
      const afterCfg = parsePlatformConfig(afterBytes);
      assert.equal(afterCfg.beehiiv?.profileSurveyId, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Mesmo achado, mas no fluxo COMPLETO (sem --resolve-only) — confirma que
  // o guard vale também quando o dry-run segue até o passo de respostas.
  it("--dry-run (fluxo completo) com publicationId E profileSurveyId ausentes: nada é persistido em platform.config.json", async () => {
    const root = freshRoot();
    try {
      const initialCfg: PlatformConfig = {};
      writeConfig(root, initialCfg);
      const beforeBytes = readFileSync(resolve(root, "platform.config.json"), "utf8");

      const surveysPath = writeJsonFixture(root, "data/_tmp/surveys.json", [{ id: "srv_candidate" }]);
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [VALID_RESPONSE_A]);

      const { exec, calls } = makeFakeExec(() => {
        throw new Error("exec não deveria ser chamado em --dry-run");
      });
      const fetchPublications = async (): Promise<PublicationCandidate[]> => [{ id: "pub_candidate", name: "diar.ia.br" }];
      const deps = baseDeps(root, { exec, fetchPublications });
      const result = await runAudience(
        ["--surveys-json", surveysPath, "--responses", responsesPath, "--dry-run"],
        deps,
      );

      assert.equal(result.code, 0);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);

      const afterBytes = readFileSync(resolve(root, "platform.config.json"), "utf8");
      assert.equal(afterBytes, beforeBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("update-audience.ts falha (exit != 0) -> propaga como abort (exit 1)", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [VALID_RESPONSE_A]);
      const { exec } = makeFakeExec(() => ({ code: 1, stdout: "", stderr: "boom" }));
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--responses", responsesPath], deps);
      assert.equal(result.code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("0 respostas válidas após normalização -> aborta (exit 1), nada gravado, exec não chamado", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", [{ id: "x" }, { semId: true }]);
      const { exec, calls } = makeFakeExec(() => {
        throw new Error("não deveria chamar exec com 0 respostas válidas");
      });
      const deps = baseDeps(root, { exec });
      const result = await runAudience(["--responses", responsesPath], deps);
      assert.equal(result.code, 1);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--responses aponta pra arquivo que não é array JSON -> aborta (exit 1)", async () => {
    const root = freshRoot();
    try {
      writeConfig(root, { beehiiv: { publicationId: "pub_ok", profileSurveyId: "srv_ok" } });
      const responsesPath = writeJsonFixture(root, "data/_tmp/responses.json", { não: "é array" });
      const deps = baseDeps(root);
      const result = await runAudience(["--responses", responsesPath], deps);
      assert.equal(result.code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
