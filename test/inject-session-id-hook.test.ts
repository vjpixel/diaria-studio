/**
 * test/inject-session-id-hook.test.ts (#5156)
 *
 * Cobre a lógica PURA de `.claude/hooks/inject-session-id.mjs` — injeta
 * `--session-id {payload.session_id}` em chamadas standalone de
 * `overnight-session-marker.ts --start`/`--phase` e `session-registry.ts
 * {register,heartbeat,end,claim-issue,is-claimed,merge-lock-acquire,merge-lock-release}`
 * que ainda não trazem a flag. Sem I/O — as funções exportadas são puras.
 *
 * #5161 fleet review item 10 (pr-test-analyzer): o describe "CLI end-to-end"
 * no final exercita o HARNESS real (stdin real via processo filho) — este
 * hook roda em TODA chamada Bash uma vez wireado (o de maior tráfego deste
 * PR) e é fail-open por design; um bug de parsing de stdin ou de path-
 * matching não erraria, só silenciosamente NUNCA injetaria a flag,
 * desligando o mecanismo #5156 inteiro sem aviso — só as 5 funções puras
 * nunca exercitariam esse caminho. Mesmo padrão de `test/notify-sound-hook.test.ts`
 * (spawnSync do processo real, #4830).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isChainedCommand,
  needsSessionId,
  alreadyHasSessionId,
  needsPid,
  alreadyHasPid,
  shellSingleQuote,
  buildUpdatedCommand,
  detectChainedSessionIdRisk,
  ghBodyHeredocOpeningLine,
} from "../.claude/hooks/inject-session-id.mjs";
// #7836 — fonte única (ver scripts/lib/session-id-required-subcommands.ts).
// Iterar sobre ESTA lista em vez de reproduzir os nomes à mão aqui é o que
// fecha a classe de omissão da issue: se um subcomando novo entrar na lista
// compartilhada sem o hook derivar dela, o teste abaixo pega — e se o hook
// já deriva dela (como agora), qualquer subcomando adicionado aqui já sai
// coberto automaticamente, sem precisar lembrar de atualizar o teste.
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../scripts/lib/session-id-required-subcommands.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dirname, "..", ".claude", "hooks", "inject-session-id.mjs");

describe("isChainedCommand", () => {
  it("comando simples não é encadeado", () => {
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start"), false);
  });

  it("&&, ;, | e || marcam como encadeado", () => {
    assert.equal(isChainedCommand("git pull && npx tsx scripts/overnight-session-marker.ts --start"), true);
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start; echo ok"), true);
    assert.equal(isChainedCommand("cat x | npx tsx scripts/overnight-session-marker.ts --start"), true);
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start || echo fail"), true);
  });

  it("newline embutido (script Bash multi-linha) também marca como encadeado (#5161 item 6)", () => {
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight\necho done"),
      true,
    );
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight\r\necho done"),
      true,
    );
  });

  // #8346: metacaractere DENTRO de aspas não é encadeamento — reprodução
  // real da issue (self-authorize-merge --reason "...;...") e os outros 4
  // metacaracteres, em aspas duplas e simples.
  it("os 5 metacaracteres dentro de aspas DUPLAS não marcam como encadeado", () => {
    assert.equal(isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "a && b"'), false);
    assert.equal(isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "a || b"'), false);
    assert.equal(isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "a; b"'), false);
    assert.equal(isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "a | b"'), false);
    assert.equal(isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "a\nb"'), false);
  });

  it("os 5 metacaracteres dentro de aspas SIMPLES não marcam como encadeado", () => {
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'a && b'"), false);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'a || b'"), false);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'a; b'"), false);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'a | b'"), false);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'a\nb'"), false);
  });

  it("os mesmos 5 metacaracteres FORA de aspas continuam encadeados (não regride #5161/#7212)", () => {
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end && echo ok"), true);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end || echo fail"), true);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end; echo ok"), true);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end | cat"), true);
    assert.equal(isChainedCommand("npx tsx scripts/lib/session-registry.ts end\necho ok"), true);
  });

  it("escape (\\;) fora de aspas suprime a detecção", () => {
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason a\\;b"),
      false,
    );
  });

  it("aspas não fechadas são fail-closed (tratado como encadeado)", () => {
    assert.equal(
      isChainedCommand('npx tsx scripts/lib/session-registry.ts end --reason "sem fechar'),
      true,
    );
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts end --reason 'sem fechar"),
      true,
    );
  });

  it("reprodução literal da issue #8346 — self-authorize-merge com ; dentro de --reason → standalone", () => {
    assert.equal(
      isChainedCommand(
        'npx tsx scripts/lib/session-registry.ts self-authorize-merge --pr 8337 ' +
          '--reason "Editor pediu o merge nesta sessao interativa; grant-merge pedido ao 300 sem resposta"',
      ),
      false,
    );
  });
});

describe("needsSessionId", () => {
  it("overnight-session-marker.ts --start → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --start"), true);
  });

  it("overnight-session-marker.ts --phase autonomous → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --phase autonomous"), true);
  });

  it("overnight-session-marker.ts --end → true (#9419: marker é por sessão desde #9347)", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --end"), true);
  });

  it("session-registry.ts register/heartbeat/end/claim-issue/unclaim-issue/is-claimed/merge-lock-* → true", () => {
    for (const sub of [
      "register",
      "heartbeat",
      "end",
      "claim-issue",
      "unclaim-issue",
      "is-claimed",
      "merge-lock-acquire",
      "merge-lock-release",
    ]) {
      assert.equal(
        needsSessionId(`npx tsx scripts/lib/session-registry.ts ${sub} --kind overnight`),
        true,
        `esperava true para subcomando ${sub}`,
      );
    }
  });

  it(
    "TODO subcomando de SESSION_ID_REQUIRED_SUBCOMMANDS (#7836) → true, sem precisar listar " +
      "os nomes de novo aqui — inclui self-authorize-merge, grant-merge, check-merge-grant, " +
      "consume-merge-grant, merge-lock-renew e conflicts, que o teste manual acima nunca cobriu",
    () => {
      for (const sub of SESSION_ID_REQUIRED_SUBCOMMANDS) {
        assert.equal(
          needsSessionId(`npx tsx scripts/lib/session-registry.ts ${sub} --kind overnight`),
          true,
          `esperava true para subcomando ${sub} (da lista compartilhada)`,
        );
      }
    },
  );

  it("self-authorize-merge (#7303) → true (#7836 — regressão: ficou de fora da regex por 6 dias)", () => {
    assert.equal(
      needsSessionId('npx tsx scripts/lib/session-registry.ts self-authorize-merge --reason "teste"'),
      true,
    );
    assert.equal(
      buildUpdatedCommand(
        'npx tsx scripts/lib/session-registry.ts self-authorize-merge --reason "teste"',
        "sess-7836",
      ),
      'npx tsx scripts/lib/session-registry.ts self-authorize-merge --reason "teste" --session-id \'sess-7836\'',
    );
  });

  it("session-registry.ts list-active → false (leitura pura, sem noção de sessão atual)", () => {
    assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts list-active"), false);
  });

  it(
    "session-registry.ts is-claimed → true (#5161 item 4: recebe --session-id como excludeSessionId, " +
      "senão uma sessão vê o PRÓPRIO claim como 'de outra sessão' ao reavaliar numa onda posterior)",
    () => {
      assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts is-claimed --issue 1"), true);
    },
  );

  it("comando encadeado nunca é candidato, mesmo citando o script-alvo", () => {
    assert.equal(
      needsSessionId("git checkout master && npx tsx scripts/overnight-session-marker.ts --start"),
      false,
    );
  });

  it("comando não relacionado → false", () => {
    assert.equal(needsSessionId("npm test"), false);
    assert.equal(needsSessionId(""), false);
    assert.equal(needsSessionId(undefined), false);
  });

  it(
    "resolve-develop-plan-path.ts standalone → true, incondicional (#6259/#6265: script inteiro " +
      "exige --session-id, sem noção de subcomando)",
    () => {
      assert.equal(
        needsSessionId("npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826"),
        true,
      );
    },
  );

  it("resolve-develop-plan-path.ts encadeado → false, mesmo invariante dos outros 2 alvos (#6259/#6265)", () => {
    assert.equal(
      needsSessionId("git pull && npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826"),
      false,
    );
  });

  it(
    "resolve-overnight-plan-path.ts standalone → true, incondicional (#6328: mesmo invariante do irmão develop)",
    () => {
      assert.equal(
        needsSessionId("npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826"),
        true,
      );
    },
  );

  it("resolve-overnight-plan-path.ts encadeado → false, mesmo invariante dos outros alvos (#6328)", () => {
    assert.equal(
      needsSessionId("git pull && npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826"),
      false,
    );
  });
});

describe("alreadyHasSessionId", () => {
  it("detecta --session-id já presente", () => {
    assert.equal(
      alreadyHasSessionId("npx tsx scripts/overnight-session-marker.ts --start --session-id abc"),
      true,
    );
  });

  it("false quando ausente", () => {
    assert.equal(alreadyHasSessionId("npx tsx scripts/overnight-session-marker.ts --start"), false);
  });
});

describe("needsPid (#6160)", () => {
  it("session-registry.ts register → true", () => {
    assert.equal(needsPid("npx tsx scripts/lib/session-registry.ts register --kind overnight"), true);
  });

  it("subcomandos que não são register → false (nenhum outro aceita --pid)", () => {
    for (const sub of ["heartbeat", "end", "claim-issue", "is-claimed", "merge-lock-acquire", "merge-lock-release", "list-active"]) {
      assert.equal(
        needsPid(`npx tsx scripts/lib/session-registry.ts ${sub} --kind overnight`),
        false,
        `esperava false para subcomando ${sub}`,
      );
    }
  });

  it("overnight-session-marker.ts → false (script sem noção de --pid)", () => {
    assert.equal(needsPid("npx tsx scripts/overnight-session-marker.ts --start"), false);
  });

  it("resolve-develop-plan-path.ts → false (#6259/#6265: 3º alvo não aceita --pid)", () => {
    assert.equal(needsPid("npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826"), false);
  });

  it("resolve-overnight-plan-path.ts → false (#6328: 4º alvo também não aceita --pid)", () => {
    assert.equal(needsPid("npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826"), false);
  });

  it("comando encadeado → false, mesmo citando register", () => {
    assert.equal(
      needsPid("git pull && npx tsx scripts/lib/session-registry.ts register --kind overnight"),
      false,
    );
  });

  it("comando não relacionado → false", () => {
    assert.equal(needsPid("npm test"), false);
    assert.equal(needsPid(""), false);
    assert.equal(needsPid(undefined), false);
  });

  it(
    "#7264/#7281 fleet review — menção em prosa (título/corpo citando 'session-registry.ts' e " +
      "'register') → false, nunca invocação (mesmo bug de command.includes bruto que o PR corrigiu " +
      "pro --session-id, agora fechado também no --pid)",
    () => {
      assert.equal(
        needsPid('gh issue create --title "Fix session-registry.ts register bug" --body "..."'),
        false,
      );
    },
  );
});

describe("alreadyHasPid", () => {
  it("detecta --pid já presente", () => {
    assert.equal(
      alreadyHasPid("npx tsx scripts/lib/session-registry.ts register --kind overnight --pid 4242"),
      true,
    );
  });

  it("false quando ausente", () => {
    assert.equal(alreadyHasPid("npx tsx scripts/lib/session-registry.ts register --kind overnight"), false);
  });
});

describe("shellSingleQuote", () => {
  it("envolve em aspas simples", () => {
    assert.equal(shellSingleQuote("abc-123"), "'abc-123'");
  });

  it("escapa aspas simples embutidas com segurança", () => {
    assert.equal(shellSingleQuote("a'b"), `'a'\\''b'`);
  });
});

describe("buildUpdatedCommand (#5156)", () => {
  it("injeta --session-id em overnight-session-marker.ts --start sem a flag", () => {
    const result = buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", "sess-abc");
    assert.equal(result, "npx tsx scripts/overnight-session-marker.ts --start --session-id 'sess-abc'");
  });

  it("injeta --session-id em session-registry.ts register", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight", "sess-abc");
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-abc'");
  });

  it("injeta --session-id em session-registry.ts unclaim-issue (#6317 — precisa saber DE QUEM remover)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts unclaim-issue --kind develop --issue 6317",
      "sess-abc",
    );
    assert.equal(
      result,
      "npx tsx scripts/lib/session-registry.ts unclaim-issue --kind develop --issue 6317 --session-id 'sess-abc'",
    );
  });

  it("retorna null quando o comando já tem --session-id (nunca sobrescreve)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/overnight-session-marker.ts --start --session-id ja-presente",
      "sess-novo",
    );
    assert.equal(result, null);
  });

  it("retorna null quando sessionId está ausente/vazio", () => {
    assert.equal(buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", undefined), null);
    assert.equal(buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", ""), null);
  });

  it("retorna null pra comando não-relacionado (fail-open — nunca modifica por engano)", () => {
    assert.equal(buildUpdatedCommand("npm test", "sess-abc"), null);
  });

  it("retorna null pra comando encadeado, mesmo citando o script-alvo", () => {
    assert.equal(
      buildUpdatedCommand("git pull && npx tsx scripts/overnight-session-marker.ts --start", "sess-abc"),
      null,
    );
  });

  it("retorna null pra list-active (leitura pura, sem noção de sessão atual)", () => {
    assert.equal(buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts list-active", "sess-abc"), null);
  });

  it("injeta --session-id em session-registry.ts is-claimed (#5161 item 4)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts is-claimed --issue 1", "sess-abc");
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts is-claimed --issue 1 --session-id 'sess-abc'");
  });

  it("injeta --session-id em resolve-develop-plan-path.ts standalone (#6259/#6265) — sem --pid, script não aceita", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826",
      "sess-abc",
      4242,
    );
    assert.equal(
      result,
      "npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826 --session-id 'sess-abc'",
    );
  });

  it("resolve-develop-plan-path.ts já com --session-id → null, nunca sobrescreve (#6259/#6265)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826 --session-id ja-presente",
      "sess-novo",
    );
    assert.equal(result, null);
  });

  it("resolve-develop-plan-path.ts encadeado → null, mesmo invariante dos outros 2 alvos (#6259/#6265)", () => {
    const result = buildUpdatedCommand(
      "git pull && npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826",
      "sess-abc",
    );
    assert.equal(result, null);
  });

  it("injeta --session-id em resolve-overnight-plan-path.ts standalone (#6328) — sem --pid, script não aceita", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826",
      "sess-abc",
      4242,
    );
    assert.equal(
      result,
      "npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826 --session-id 'sess-abc'",
    );
  });

  it("resolve-overnight-plan-path.ts já com --session-id → null, nunca sobrescreve (#6328)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826 --session-id ja-presente",
      "sess-novo",
    );
    assert.equal(result, null);
  });

  it("injeta --session-id em effective-model-probe.ts standalone (#9527 — sonda lia transcript de outra sessão)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/effective-model-probe.ts", "sess-abc", 4242);
    assert.equal(result, "npx tsx scripts/lib/effective-model-probe.ts --session-id 'sess-abc'");
  });

  it("injeta --session-id em edition-lock.ts standalone (#10309 — trava por edição identifica o fork)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/edition-lock.ts acquire --edition-dir data/editions/261016 --stage 4",
      "sess-abc",
      4242,
    );
    assert.equal(
      result,
      "npx tsx scripts/edition-lock.ts acquire --edition-dir data/editions/261016 --stage 4 --session-id 'sess-abc'",
    );
  });

  it("edition-lock.ts encadeado → null (#10309)", () => {
    assert.equal(
      buildUpdatedCommand("cd x && npx tsx scripts/edition-lock.ts release --edition-dir d", "sess-abc"),
      null,
    );
  });

  it("effective-model-probe.ts encadeado → null (#9527)", () => {
    assert.equal(buildUpdatedCommand("cd x && npx tsx scripts/lib/effective-model-probe.ts", "sess-abc"), null);
  });

  it("resolve-overnight-plan-path.ts encadeado → null, mesmo invariante dos outros alvos (#6328)", () => {
    const result = buildUpdatedCommand(
      "git pull && npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826",
      "sess-abc",
    );
    assert.equal(result, null);
  });

  it("retorna null pra script-alvo com script multi-linha (newline embutido, #5161 item 6)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts register --kind overnight\necho done",
      "sess-abc",
    );
    assert.equal(result, null);
  });

  it("sem pid (3º argumento omitido), register não recebe --pid — retrocompatibilidade (#6160)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight", "sess-abc");
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-abc'");
  });

  it("injeta --session-id E --pid em session-registry.ts register (#6160)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight", "sess-abc", 4242);
    assert.equal(
      result,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-abc' --pid 4242",
    );
  });

  it("comando já com --pid explícito não é sobrescrito (retrocompatibilidade, #6160)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --pid 999",
      "sess-abc",
      4242,
    );
    assert.equal(
      result,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --pid 999 --session-id 'sess-abc'",
    );
  });

  it("comando já com --session-id mas sem --pid: injeta só --pid (#6160)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id ja-presente",
      "sess-novo",
      4242,
    );
    assert.equal(
      result,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id ja-presente --pid 4242",
    );
  });

  it("comando já com --session-id E --pid → null (nada a injetar)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id ja-presente --pid 999",
      "sess-novo",
      4242,
    );
    assert.equal(result, null);
  });

  it("pid fornecido mas subcomando não é register (ex: heartbeat) → --pid nunca injetado", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts heartbeat --kind overnight", "sess-abc", 4242);
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts heartbeat --kind overnight --session-id 'sess-abc'");
  });

  it("pid fornecido mas sessionId ausente e comando já tem --session-id: null se register já tem --pid também", () => {
    assert.equal(
      buildUpdatedCommand(
        "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id x --pid 1",
        undefined,
        4242,
      ),
      null,
    );
  });

  it("pid=0 é um valor válido e ainda assim injeta (checagem estrita contra undefined/null, não falsy)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight", "sess-abc", 0);
    assert.equal(
      result,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-abc' --pid 0",
    );
  });
});

describe("detectChainedSessionIdRisk (#7212)", () => {
  it(
    "caso real 1 — overnight-session-marker.ts --start | tail -3 → bloqueia " +
      "(ocorrência 1 da rodada 260902b: aqui o script falha ALTO, mas o hook " +
      "de qualquer forma detecta o risco ANTES de deixar a chamada rodar)",
    () => {
      const risk = detectChainedSessionIdRisk(
        "npx tsx scripts/overnight-session-marker.ts --start 2>&1 | tail -3",
      );
      assert.notEqual(risk, null);
      assert.match(risk, /encadead/i);
    },
  );

  it(
    "caso real 2 — for loop com unclaim-issue redirecionado pra /dev/null 2>&1 → bloqueia " +
      "(ocorrência 2: exatamente o comando que engoliu o erro em silêncio na rodada 260902b)",
    () => {
      const risk = detectChainedSessionIdRisk(
        'for i in 7175 7176 7177; do npx tsx scripts/lib/session-registry.ts unclaim-issue ' +
          '--kind overnight --issue $i > /dev/null 2>&1; echo "unclaim $i"; done',
      );
      assert.notEqual(risk, null);
      assert.match(risk, /encadead/i);
    },
  );

  it("comando standalone (não encadeado) → null, mesmo citando um alvo que precisa de --session-id", () => {
    assert.equal(
      detectChainedSessionIdRisk("npx tsx scripts/overnight-session-marker.ts --start"),
      null,
    );
  });

  it("comando encadeado que JÁ traz --session-id explícito → null (não depende da injeção automática)", () => {
    assert.equal(
      detectChainedSessionIdRisk(
        "npx tsx scripts/lib/session-registry.ts unclaim-issue --kind overnight --issue 1 --session-id abc; echo done",
      ),
      null,
    );
  });

  it("comando encadeado que não cita nenhum alvo injetável → null", () => {
    assert.equal(detectChainedSessionIdRisk("git pull && npm test"), null);
  });

  it("comando encadeado citando session-registry.ts list-active (leitura pura) → null", () => {
    assert.equal(
      detectChainedSessionIdRisk("npx tsx scripts/lib/session-registry.ts list-active | tail -5"),
      null,
    );
  });

  it("comando encadeado citando resolve-develop-plan-path.ts (incondicional) → bloqueia", () => {
    const risk = detectChainedSessionIdRisk(
      "git pull && npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826",
    );
    assert.notEqual(risk, null);
  });

  it("comando vazio/undefined → null", () => {
    assert.equal(detectChainedSessionIdRisk(""), null);
    assert.equal(detectChainedSessionIdRisk(undefined), null);
  });
});

describe("invocação vs menção (#7264/#7281)", () => {
  // Casos NEGATIVOS — o nome do script aparece como MENÇÃO (prosa, caminho
  // de arquivo em comando de leitura), nunca como chamada. Devem passar,
  // mesmo quando o comando "parece" encadeado (pipe pro grep, ou texto
  // livre com `;`/newline dentro de um argumento entre aspas).

  it("#7281 caso real — git show REVSPEC:path | grep (menção, não invocação) → null", () => {
    assert.equal(
      detectChainedSessionIdRisk(
        'git show "origin/master:scripts/lib/session-registry.ts" | grep -c "chained"',
      ),
      null,
    );
  });

  it("#7281 variante — grep -rn NOME scripts/ | wc -l (menção em argumento de grep) → null", () => {
    assert.equal(
      detectChainedSessionIdRisk('grep -rn "session-registry.ts" scripts/ | wc -l'),
      null,
    );
  });

  it("#7281 variante — cat/git log citando o script em pipeline → null", () => {
    assert.equal(
      detectChainedSessionIdRisk('cat docs/notas.md | grep "session-registry.ts"'),
      null,
    );
    assert.equal(
      detectChainedSessionIdRisk("git log -- scripts/lib/session-registry.ts | head -5"),
      null,
    );
  });

  it(
    "#7264 caso real — gh issue create --body citando o script em prosa, com ';' e newline " +
      "dentro do texto entre aspas (o que faz isChainedCommand ver risco) → null",
    () => {
      const command =
        'gh issue create --title "Guard falso positivo" --body "A docstring de ' +
        "scripts/lib/session-registry.ts proíbe --force no claim-issue;\n" +
        'documentar isso evita repetir o erro."';
      assert.equal(detectChainedSessionIdRisk(command), null);
    },
  );

  it("needsSessionId (caminho standalone) também não injeta por menção — só citação, não invocação", () => {
    assert.equal(
      needsSessionId('git show "origin/master:scripts/lib/session-registry.ts"'),
      false,
    );
  });

  // Casos POSITIVOS — invocação real dentro de comando encadeado. O guard
  // do #7212 tem que continuar bloqueando estes, sem exceção — é o caso
  // que motivou o guard (erro engolido por redirect/saída concorrente).

  it("#7212 continua bloqueando — git checkout && npx tsx session-registry.ts claim-issue", () => {
    const risk = detectChainedSessionIdRisk(
      "git checkout master && npx tsx scripts/lib/session-registry.ts claim-issue --kind overnight --issue 42",
    );
    assert.notEqual(risk, null);
    assert.match(risk, /encadead/i);
  });

  it("#7212 continua bloqueando — for loop com unclaim-issue engolido por > /dev/null 2>&1 (caso real da issue original)", () => {
    const risk = detectChainedSessionIdRisk(
      'for i in 7175 7176 7177; do npx tsx scripts/lib/session-registry.ts unclaim-issue ' +
        '--kind overnight --issue $i > /dev/null 2>&1; echo "unclaim $i"; done',
    );
    assert.notEqual(risk, null);
    assert.match(risk, /encadead/i);
  });

  it("#7212 continua bloqueando — overnight-session-marker.ts --start | tail -3 (invocação real, não menção)", () => {
    const risk = detectChainedSessionIdRisk(
      "npx tsx scripts/overnight-session-marker.ts --start 2>&1 | tail -3",
    );
    assert.notEqual(risk, null);
  });
});

describe("mensagem nomeia o alvo real e heredoc de texto não bloqueia (#12029)", () => {
  it("caso real — cd … && cleanup-merged-worktrees.ts | tail: mensagem cita esse script, não os outros", () => {
    const risk = detectChainedSessionIdRisk(
      "cd /home/x/diaria-studio && npx tsx scripts/cleanup-merged-worktrees.ts 2>&1 | tail -6",
    );
    assert.notEqual(risk, null);
    assert.match(risk, /cleanup-merged-worktrees\.ts/);
    assert.doesNotMatch(risk, /session-registry\.ts/);
    assert.doesNotMatch(risk, /overnight-session-marker\.ts/);
    assert.doesNotMatch(risk, /plan-path\.ts/);
  });

  for (const [script, invocation] of [
    ["effective-model-probe.ts", "npx tsx scripts/effective-model-probe.ts"],
    ["edition-lock.ts", "npx tsx scripts/lib/edition-lock.ts acquire"],
    ["resolve-overnight-plan-path.ts", "npx tsx scripts/resolve-overnight-plan-path.ts"],
  ]) {
    it(`mensagem cita ${script} quando é ele o alvo encadeado`, () => {
      const risk = detectChainedSessionIdRisk(`git pull && ${invocation}`);
      assert.notEqual(risk, null);
      assert.ok(risk.includes(script), risk);
    });
  }

  it("dois alvos invocados no mesmo bloco → a mensagem cita os dois", () => {
    const risk = detectChainedSessionIdRisk(
      "npx tsx scripts/lib/session-registry.ts claim-issue --kind develop --issue 1 && " +
        "npx tsx scripts/cleanup-merged-worktrees.ts",
    );
    assert.notEqual(risk, null);
    assert.match(risk, /session-registry\.ts/);
    assert.match(risk, /cleanup-merged-worktrees\.ts/);
  });

  it("alvo de leitura (list-active) seguido de alvo incondicional → bloqueia (antes parava no 1º alvo)", () => {
    const risk = detectChainedSessionIdRisk(
      "npx tsx scripts/lib/session-registry.ts list-active; npx tsx scripts/cleanup-merged-worktrees.ts",
    );
    assert.notEqual(risk, null);
    assert.match(risk, /cleanup-merged-worktrees\.ts/);
    assert.doesNotMatch(risk, /session-registry\.ts/);
  });

});

// #12029 (parte do heredoc retirada da PR #12048): uma versão que ignorava o
// corpo de heredoc de texto mediu falsos negativos — comandos que a base
// bloqueia e que passariam a sair sem --session-id. Estes casos travam o
// comportamento da base: TODOS continuam BLOQUEADOS. Quem tentar de novo
// ignorar heredoc precisa passar por aqui.
describe("heredoc não abre buraco no bloqueio de encadeado (#12029, regressão)", () => {
  const TARGET = "npx tsx scripts/cleanup-merged-worktrees.ts";
  const cases: Array<[string, string]> = [
    // (a) marcador de heredoc dentro de aspas ou comentário, sem terminador,
    // seguido de invocação real em outra linha.
    ["(a) <<'EOF' dentro de aspas duplas (grep)", `grep -rn "<<'EOF'" scripts/\n${TARGET}`],
    ["(a) <<EOF dentro de --body", `gh issue comment 1 --body "use cat <<EOF"\n${TARGET}`],
    ["(a) <<EOF em comentário", `# usar <<EOF\n${TARGET}`],
    // (b) substituição de comando no corpo de heredoc sem aspas: expande.
    ["(b) $(...) no corpo sem aspas", `cat <<EOF\n$(${TARGET})\nEOF`],
    ["(b) crase no corpo sem aspas", "cat <<EOF\n`" + TARGET + "`\nEOF"],
    // (c) shells/executores que o regex de interpretador não reconhecia.
    ["(c) /bin/bash <<'EOF'", `/bin/bash <<'EOF'\n${TARGET}\nEOF`],
    ["(c) bash<<'EOF' sem espaço", `bash<<'EOF'\n${TARGET}\nEOF`],
    ["(c) sudo -u x bash<<'EOF'", `sudo -u x bash<<'EOF'\n${TARGET}\nEOF`],
    ["(c) parallel <<'EOF'", `parallel <<'EOF'\n${TARGET}\nEOF`],
    // (d) heredoc grava script que é executado depois / pipe na linha seguinte.
    ["(d) cat > r.sh <<'EOF' … EOF; bash r.sh", `cat > /tmp/r.sh <<'EOF'\n${TARGET}\nEOF\nbash /tmp/r.sh`],
    ["(d) cat <<'EOF' | com bash na linha seguinte", `cat <<'EOF' |\nbash\n${TARGET}\nEOF`],
    // (e) outra linguagem disparando o alvo por subprocess.
    ["(e) node <<'EOF' com execSync", `node <<'EOF'\nrequire('child_process').execSync('${TARGET}')\nEOF`],
    // casos que a versão anterior já cobria — seguem bloqueados.
    ["texto em heredoc + invocação real depois do terminador", `cat > /tmp/f.md <<'EOF'\ntexto\nEOF\n${TARGET}`],
    ["invocação na linha de abertura", `${TARGET} <<'EOF'\nx\nEOF`],
    ["bash <<'EOF'", `bash <<'EOF'\n${TARGET}\nEOF`],
    ["ssh host <<EOF", `ssh host <<EOF\n${TARGET}\nEOF`],
    ["cat <<'EOF' | bash", `cat <<'EOF' | bash\n${TARGET}\nEOF`],
  ];
  for (const [label, command] of cases) {
    it(`bloqueia: ${label}`, () => {
      const risk = detectChainedSessionIdRisk(command);
      assert.notEqual(risk, null, command);
      assert.match(risk as string, /cleanup-merged-worktrees\.ts/);
    });
  }
});

// #12050: só um heredoc tem o corpo fora da checagem — o comando INTEIRO na
// forma `gh (issue|pr) (comment|create|edit) … --body-file - <<'TAG'`, corpo,
// `TAG`. Qualquer outra forma volta ao comportamento da base (96e9e357b). Os
// casos "bloqueia" incluem os falsos negativos medidos pelos revisores da
// 1ª versão da PR #12054 (8 deles executavam o alvo de verdade no bash).
describe("heredoc gh --body-file - não bloqueia por citar alvo no corpo (#12050)", () => {
  const TARGET = "npx tsx scripts/lib/session-registry.ts claim-issue --kind develop --issue 1";
  const BODY = `Nota: rode ${TARGET} isolado.`;

  const liberados: Array<[string, string]> = [
    ["gh issue comment 1 --body-file - <<'EOF'", `gh issue comment 1 --body-file - <<'EOF'\n${BODY}\nEOF`],
    ['gh pr create --title "x" --body-file - <<\'EOF\'', `gh pr create --title "x" --body-file - <<'EOF'\n${BODY}\nEOF`],
    ['gh issue create -F - <<"BODY" + espaço/quebra no fim', `gh issue create --title 'a b' -F - <<"BODY"\n${BODY}\nBODY\n  \n`],
    ["gh pr edit com espaço inicial", `  gh pr edit 12 --body-file - <<'EOF'\n${BODY}\nEOF`],
  ];
  for (const [label, command] of liberados) {
    it(`libera: ${label}`, () => {
      assert.equal(detectChainedSessionIdRisk(command), null, command);
      assert.equal(ghBodyHeredocOpeningLine(command), command.split("\n")[0]);
    });
  }

  it("alvo citado na linha 1 continua contando", () => {
    const command = `gh issue comment 1 --body "${TARGET}" --body-file - <<'EOF'\ntexto\nEOF`;
    assert.notEqual(detectChainedSessionIdRisk(command), null);
  });

  const H = (body: string) => `<<'EOF'\n${body}\nEOF`;
  const bloqueados: Array<[string, string]> = [
    // Falsos negativos medidos na 1ª versão.
    ["( cat <<'EOF' … ) | bash", `( cat ${H(TARGET)}\n) | bash`],
    ["{ cat <<'EOF' … } | bash", `{ cat ${H(TARGET)}\n} | bash`],
    ["bash <(cat <<'EOF' …)", `bash <(cat ${H(TARGET)}\n)`],
    ["x=$(cat <<'EOF' …) ; eval \"$x\"", `x=$(cat ${H(TARGET)}\n) ; eval "$x"`],
    ["for … do cat <<'EOF' … done | sh", `for i in 1; do cat ${H(TARGET)}\ndone | sh`],
    ["glob bash /tmp/*.sh", `cat > /tmp/r.sh ${H(TARGET)}\nbash /tmp/*.sh`],
    ['aspas no nome x.s"h"', `cat > /tmp/x.sh ${H(TARGET)}\nbash /tmp/x.s"h"`],
    ["trap antes do heredoc", `trap 'bash /tmp/r.sh' EXIT\ncat > /tmp/r.sh ${H(TARGET)}`],
    ["& antes do heredoc", `sleep 1 && bash /tmp/r.sh &\ncat > /tmp/r.sh ${H(TARGET)}`],
    ["package.json + npm run", `cat > package.json <<'EOF'\n{"scripts":{"x":"${TARGET}"}}\nEOF\nnpm run x`],
    ["Makefile + make", `cat > Makefile <<'EOF'\nx:\n\t${TARGET}\nEOF\nmake x`],
    [".git/hooks", `cat > .git/hooks/post-checkout ${H(TARGET)}\ngit checkout -`],
    [".bashrc", `cat >> ~/.bashrc ${H(TARGET)}\nbash -i -c true`],
    ["BASH_ENV", `cat > /tmp/env.sh ${H(TARGET)}\nBASH_ENV=/tmp/env.sh bash -c true`],
    ["eval 'cat(){ bash; }'", `eval 'cat(){ bash; }'\ncat ${H(TARGET)}`],
    ["PATH= com cat falso", `PATH=/tmp/fake:$PATH\ncat ${H(TARGET)}`],
    ["gh <extensão> --body-file -", `gh myext --body-file - ${H(TARGET)}`],
    ["gh ext …", `gh ext exec x --body-file - ${H(TARGET)}`],
    ["gh api --input -", `gh api repos/o/r/issues --input - ${H(TARGET)}`],
    // cat > arquivo sempre volta à base.
    ["cat > arquivo + gh --body-file arquivo", `cat > /tmp/x.md ${H(BODY)}\ngh issue create --body-file /tmp/x.md`],
    // Comando a mais antes ou depois, dois heredocs.
    ["comando antes", `cd /tmp\ngh issue comment 1 --body-file - ${H(TARGET)}`],
    ["comando depois", `gh issue comment 1 --body-file - ${H(BODY)}\n${TARGET}`],
    ["comando na linha 1 com &&", `git pull && gh issue comment 1 --body-file - ${H(TARGET)}`],
    ["dois heredocs", `gh issue comment 1 --body-file - ${H(BODY)}\ngh issue comment 2 --body-file - ${H(TARGET)}`],
    // Variações da linha 1 fora da forma exata.
    ["delimitador sem aspas", `gh issue comment 1 --body-file - <<EOF\n$(${TARGET})\nEOF`],
    ["sem --body-file -", `gh issue comment 1 --body x ${H(TARGET)}`],
    ["| no fim da linha 1", `gh issue comment 1 --body-file - <<'EOF' | bash\n${TARGET}\nEOF`],
    // `#` comenta o `<<'EOF'`: sem heredoc, o "corpo" roda como código (review da #12054).
    ["# colado antes do <<", `gh issue comment 1 --body-file - #<<'EOF'\n${TARGET}\nEOF`],
    ["# com espaço antes do <<", `gh issue comment 1 --body-file - # <<'EOF'\n${TARGET}\nEOF`],
    ["# antes do --body-file", `gh issue comment 1 #--body-file - <<'EOF'\n${TARGET}\nEOF`],
    ["$() nos argumentos", `gh issue comment 1 --title "$(date)" --body-file - ${H(TARGET)}`],
    ["aspa aberta engolindo o <<", `gh issue comment 1 --body-file - --title "x <<'EOF'\n"; ${TARGET}\nEOF`],
    ["terminador ausente", `gh issue comment 1 --body-file - <<'EOF'\n${TARGET}`],
    ["terminador com tab", `gh issue comment 1 --body-file - <<'EOF'\n${TARGET}\n\tEOF`],
  ];
  for (const [label, command] of bloqueados) {
    it(`bloqueia: ${label}`, () => {
      assert.equal(ghBodyHeredocOpeningLine(command), null, command);
      const risk = detectChainedSessionIdRisk(command);
      assert.notEqual(risk, null, command);
      assert.match(risk as string, /session-registry\.ts/);
    });
  }

  it("desempenho: 200k caracteres sem espaço resolvem em < 50 ms", () => {
    const blob = "a".repeat(200_000);
    const commands = [
      blob,
      `gh issue comment 1 --body-file -${blob}`,
      `gh issue comment 1 --body-file - <<'EOF'\n${blob}\nEOF`,
      `gh issue comment 1 ${blob}<<'EOF'\n${blob}\n${TARGET}`,
      `${blob}\n${blob}`,
    ];
    for (const command of commands) {
      const t0 = performance.now();
      detectChainedSessionIdRisk(command);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms para ${command.length} caracteres`);
    }
  });
});

describe("CLI end-to-end — harness real via stdin (#5161 fleet review item 10)", () => {
  it("PreToolUse Bash real (payload via stdin) → injeta --session-id no updatedInput.command emitido", () => {
    const payload = {
      session_id: "sess-real-abc",
      tool_name: "Bash",
      // #6160: heartbeat (não register) pra isolar a injeção de --session-id
      // deste caso do --pid, coberto separadamente abaixo.
      tool_input: { command: "npx tsx scripts/lib/session-registry.ts heartbeat --kind overnight" },
    };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "npx tsx scripts/lib/session-registry.ts heartbeat --kind overnight --session-id 'sess-real-abc'",
    );
  });

  it("PreToolUse Bash real com register (#6160) → injeta --session-id E --pid={process.pid do processo de teste}", () => {
    // O hook é spawnado como filho DIRETO deste processo de teste (spawnSync),
    // exatamente como o harness spawna o hook como filho direto da sessão
    // Claude Code corrente — então process.ppid DENTRO do hook == process.pid
    // AQUI (o processo que o spawnou).
    const payload = {
      session_id: "sess-real-abc",
      tool_name: "Bash",
      tool_input: { command: "npx tsx scripts/lib/session-registry.ts register --kind overnight" },
    };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      `npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-real-abc' --pid ${process.pid}`,
    );
  });

  it("register já com --pid explícito via stdin real → --pid preservado, não sobrescrito (#6160)", () => {
    const payload = {
      session_id: "sess-real-abc",
      tool_name: "Bash",
      tool_input: { command: "npx tsx scripts/lib/session-registry.ts register --kind overnight --pid 999" },
    };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --pid 999 --session-id 'sess-real-abc'",
    );
  });

  it(
    "PreToolUse Bash real com resolve-develop-plan-path.ts standalone (#6259/#6265) → injeta " +
      "--session-id (sem --pid — script não aceita)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: { command: "npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826" },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(
        output.hookSpecificOutput.updatedInput.command,
        "npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826 --session-id 'sess-real-abc'",
      );
    },
  );

  it(
    "PreToolUse Bash real com resolve-develop-plan-path.ts encadeado → deny (#7212: antes só " +
      "não injetava e deixava a chamada seguir sem a flag, silenciosamente; desde o #7212 " +
      "bloqueia em vez de deixar o script falhar sem ninguém notar)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: {
          command: "git pull && npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826",
        },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    },
  );

  it(
    "PreToolUse Bash real com resolve-overnight-plan-path.ts standalone (#6328) → injeta " +
      "--session-id (sem --pid — script não aceita)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: { command: "npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826" },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(
        output.hookSpecificOutput.updatedInput.command,
        "npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826 --session-id 'sess-real-abc'",
      );
    },
  );

  it(
    "PreToolUse Bash real com resolve-overnight-plan-path.ts encadeado → deny (#7212, mesmo racional do irmão develop acima)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: {
          command: "git pull && npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826",
        },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    },
  );

  it("comando não-alvo (ex: npm test) via stdin real → nenhum stdout emitido", () => {
    const payload = { session_id: "sess-real-abc", tool_name: "Bash", tool_input: { command: "npm test" } };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "");
  });

  it("tool_name diferente de Bash via stdin real → nenhum stdout emitido (guard defensivo)", () => {
    const payload = { session_id: "sess-real-abc", tool_name: "Read", tool_input: {} };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it("payload JSON malformado no stdin real → fail-open, exit 0, sem stdout/stderr", () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: "{not valid json",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr, "");
  });

  it("stdin vazio (payload ausente) via processo real → fail-open, exit 0, sem stdout", () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it(
    "#7212 caso real 1 via stdin real — overnight-session-marker.ts --start | tail -3 → deny, " +
      "nunca updatedInput (reprodução exata da ocorrência 1 da rodada 260902b)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: { command: "npx tsx scripts/overnight-session-marker.ts --start 2>&1 | tail -3" },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /encadead/i);
      assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    },
  );

  it(
    "#7212 caso real 2 via stdin real — for loop com unclaim-issue engolido por > /dev/null 2>&1 → deny " +
      "(reprodução exata da ocorrência 2 da rodada 260902b, a que motivou a issue: sem este guard, " +
      "as 3 chamadas do loop falhariam em silêncio total)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: {
          command:
            'for i in 7175 7176 7177; do npx tsx scripts/lib/session-registry.ts unclaim-issue ' +
            '--kind overnight --issue $i > /dev/null 2>&1; echo "unclaim $i"; done',
        },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /encadead/i);
    },
  );

  it(
    "#7281 caso real via stdin real — git show REVSPEC:path | grep (menção, não invocação) → " +
      "segue rodando normalmente, nunca deny (reprodução exata do repro da issue)",
    () => {
      const payload = {
        session_id: "sess-real-abc",
        tool_name: "Bash",
        tool_input: {
          command: 'git show "origin/master:scripts/lib/session-registry.ts" | grep -c "chained"',
        },
      };
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), "");
    },
  );

  it("#7212 comando standalone (sem risco) via stdin real → segue injetando normalmente, nunca deny", () => {
    const payload = {
      session_id: "sess-real-abc",
      tool_name: "Bash",
      tool_input: { command: "npx tsx scripts/lib/session-registry.ts unclaim-issue --kind overnight --issue 1" },
    };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "npx tsx scripts/lib/session-registry.ts unclaim-issue --kind overnight --issue 1 --session-id 'sess-real-abc'",
    );
  });
});
