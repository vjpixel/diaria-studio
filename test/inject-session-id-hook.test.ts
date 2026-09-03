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
} from "../.claude/hooks/inject-session-id.mjs";

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
});

describe("needsSessionId", () => {
  it("overnight-session-marker.ts --start → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --start"), true);
  });

  it("overnight-session-marker.ts --phase autonomous → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --phase autonomous"), true);
  });

  it("overnight-session-marker.ts --end → false (leitura/remoção, session_id irrelevante)", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --end"), false);
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
