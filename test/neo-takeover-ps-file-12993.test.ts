/**
 * test/neo-takeover-ps-file-12993.test.ts (#12993)
 *
 * Regressão do 1º ensaio do failover (15/11/2026, Neo): o `--arm` rodava o
 * script com `powershell.exe -Command -` lendo do stdin, o PowerShell 5.1
 * descartava tudo depois do 1º bloco multi-linha e saía 0. Resultado:
 * "armado: 15 tarefas", lease do Neo gravado, zero `Diaria-Failover-*`.
 *
 * Cobre: (1) o runner monta `-File` com `.ps1` com BOM e apaga o temporário;
 * (2) o `--arm` relê o Task Scheduler e não grava o lease se o conjunto não
 * bate; (3) o `--disarm` avisa e sai 1 se sobrou tarefa. Nenhum teste roda
 * PowerShell de verdade (CI é Linux): os efeitos entram por injeção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main as takeoverMain } from "../scripts/failover/neo-takeover.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { buildStatusScript, checkArmedSet } from "../scripts/lib/failover/neo-takeover-plan.ts";
import { encodePs1, powershellFileArgs, runPowerShellFile, UTF8_BOM, UTF8_OUTPUT_LINE } from "../scripts/lib/failover/powershell-file.ts";
import { DOWN_SIGNAL_KEY, SCHEDULER_LEASE_KEY } from "../scripts/lib/failover/scheduler-lease.ts";

const REPO = "C:\\Users\\editor\\Projects\\diaria-studio";

describe("runPowerShellFile: .ps1 com BOM e -File, nunca -Command - (#12993)", () => {
  it("encodePs1 prefixa o BOM UTF-8, liga a saída UTF-8 e preserva acentos", () => {
    const buf = encodePs1("Write-Output 'execução'");
    assert.deepEqual(buf.subarray(0, 3), UTF8_BOM);
    assert.equal(buf.subarray(3).toString("utf8"), `${UTF8_OUTPUT_LINE}\nWrite-Output 'execução'`);
  });

  it("powershellFileArgs usa -File e não lê do stdin", () => {
    const args = powershellFileArgs("C:\\tmp\\x\\script.ps1");
    assert.deepEqual(args.slice(-2), ["-File", "C:\\tmp\\x\\script.ps1"]);
    assert.ok(!args.includes("-Command"), "-Command - descarta o que vem depois do 1º bloco multi-linha");
    assert.ok(!args.includes("-"));
  });

  function fakeFs() {
    const writes: { path: string; data: Buffer }[] = [];
    const removed: string[] = [];
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    return { writes, removed, calls };
  }

  it("grava o script inteiro (multi-linha) no .ps1, roda com -File e apaga o diretório", () => {
    const f = fakeFs();
    const script = "if ($true) {\n  Write-Output 'inside'\n}\nWrite-Output 'after'";
    const r = runPowerShellFile(script, 1234, {
      makeTempDir: () => "TMPDIR",
      writeFile: (path, data) => void f.writes.push({ path, data }),
      removeDir: (p) => void f.removed.push(p),
      spawn: (cmd, args, opts) => {
        f.calls.push({ cmd, args, opts });
        return { status: 0, stdout: "inside\nafter\n", stderr: "" };
      },
    });
    assert.deepEqual(r, { ok: true, stdout: "inside\nafter\n", stderr: "" });
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].path, /TMPDIR[\\/]script\.ps1$/);
    assert.deepEqual(f.writes[0].data, encodePs1(script));
    assert.equal(f.calls[0].cmd, "powershell.exe");
    assert.deepEqual(f.calls[0].args, powershellFileArgs(f.writes[0].path));
    assert.equal(f.calls[0].opts.timeout, 1234);
    assert.ok(!("input" in f.calls[0].opts), "nada vai pelo stdin");
    assert.deepEqual(f.removed, ["TMPDIR"]);
  });

  it("status ≠ 0 vira ok:false e o temporário é apagado mesmo se o spawn lança", () => {
    const f = fakeFs();
    const bad = runPowerShellFile("throw 'x'", 1, {
      makeTempDir: () => "T1",
      writeFile: () => {},
      removeDir: (p) => void f.removed.push(p),
      spawn: () => ({ status: 1, stdout: "", stderr: "x" }),
    });
    assert.equal(bad.ok, false);
    const thrown = runPowerShellFile("x", 1, {
      makeTempDir: () => "T2",
      writeFile: () => {},
      removeDir: (p) => void f.removed.push(p),
      spawn: () => {
        throw new Error("ENOENT powershell.exe");
      },
    });
    assert.equal(thrown.ok, false);
    assert.match(thrown.stderr, /ENOENT/);
    assert.deepEqual(f.removed, ["T1", "T2"]);
  });

  it("erro do spawn (timeout) vira ok:false com a mensagem", () => {
    const r = runPowerShellFile("x", 1, {
      makeTempDir: () => "T",
      writeFile: () => {},
      removeDir: () => {},
      spawn: () => ({ status: null, error: new Error("spawnSync powershell.exe ETIMEDOUT") }),
    });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /ETIMEDOUT/);
  });
});

describe("buildStatusScript não esconde erro do Agendador (#12993)", () => {
  it("sem SilentlyContinue; só ObjectNotFound vira lista vazia, o resto relança", () => {
    const s = buildStatusScript();
    assert.doesNotMatch(s, /SilentlyContinue/);
    assert.match(s, /ObjectNotFound/);
    assert.match(s, /else \{ throw \}/);
    assert.match(s, /\$ErrorActionPreference = 'Stop'/);
  });
});

describe("--status sai 1 se a listagem falhar", () => {
  it("listagem que falha -> exit 1 (não passa por 0 armadas)", async () => {
    const h = harness(fakeScheduler({ statusFails: true }));
    assert.equal(await takeoverMain(["--status"], h.deps), 1);
    assert.doesNotMatch(h.out.join("\n"), /armadas: 0/);
  });
  it("listagem ok -> exit 0", async () => {
    const h = harness(fakeScheduler());
    assert.equal(await takeoverMain(["--status"], h.deps), 0);
  });
});

describe("checkArmedSet", () => {
  it("bate só com o conjunto exato", () => {
    assert.deepEqual(checkArmedSet(["A", "B"], [{ name: "B", state: "Ready" }, { name: "A", state: "Ready" }]), { ok: true });
    assert.deepEqual(checkArmedSet(["A", "B"], []), { ok: false, missing: ["A", "B"], extra: [], disabled: [] });
    assert.deepEqual(checkArmedSet(["A"], [{ name: "A", state: "Ready" }, { name: "Z", state: "Ready" }]), {
      ok: false,
      missing: [],
      extra: ["Z"],
      disabled: [],
    });
  });

  it("tarefa registrada mas Disabled não conta como armada", () => {
    assert.deepEqual(checkArmedSet(["A", "B"], [{ name: "A", state: "Ready" }, { name: "B", state: "Disabled" }]), {
      ok: false,
      missing: [],
      extra: [],
      disabled: ["B"],
    });
  });
});

/** Task Scheduler fingido: registra no máximo `registerOnly` tarefas, simulando o script truncado. */
function fakeScheduler(
  opts: {
    registerOnly?: number;
    unregisterNoop?: boolean;
    statusFails?: boolean;
    statusStdout?: string;
    state?: string;
    /** Tarefas que o Unregister não consegue remover (sobra velha). */
    sticky?: string[];
    registerFails?: boolean;
    onUnregister?: () => void;
  } = {},
) {
  const tasks = new Set<string>(opts.sticky ?? []);
  return {
    tasks,
    run(script: string) {
      if (script === buildStatusScript()) {
        if (opts.statusFails) return { ok: false, stdout: "", stderr: "Get-ScheduledTask falhou" };
        if (opts.statusStdout !== undefined) return { ok: true, stdout: opts.statusStdout, stderr: "" };
        return { ok: true, stdout: JSON.stringify([...tasks].map((name) => ({ name, state: opts.state ?? "Ready" }))), stderr: "" };
      }
      if (/Unregister-ScheduledTask/.test(script) && !opts.unregisterNoop) {
        for (const t of [...tasks]) if (!(opts.sticky ?? []).includes(t)) tasks.delete(t);
        opts.onUnregister?.();
      }
      if (/ Register-ScheduledTask|^Register-ScheduledTask/m.test(script) && opts.registerFails) return { ok: false, stdout: "", stderr: "acesso negado" };
      const names = [...script.matchAll(/Register-ScheduledTask -TaskName '([^']+)'/g)].map((m) => m[1]);
      for (const n of names.slice(0, opts.registerOnly ?? names.length)) tasks.add(n);
      return { ok: true, stdout: "", stderr: "" };
    },
  };
}

function harness(sch: ReturnType<typeof fakeScheduler>, kvInit: Record<string, string> = {}, getThrowsFor: string[] = []) {
  const store = new Map(Object.entries(kvInit));
  const out: string[] = [];
  const puts: string[] = [];
  const deleted: string[] = [];
  const kv = {
    get: async (k: string) => {
      if (getThrowsFor.includes(k)) throw new Error(`KV fora para ${k}`);
      return store.has(k) ? store.get(k)! : null;
    },
    put: async (k: string, v: string) => {
      puts.push(k);
      store.set(k, v);
    },
    delete: async (k: string) => {
      deleted.push(k);
      store.delete(k);
    },
  };
  const deps = {
    runPowerShell: (s: string) => sch.run(s),
    openKv: () => ({ ok: true, kv }) as const,
    platform: "win32" as const,
    root: REPO,
    now: () => new Date("2026-11-15T12:00:00Z"),
    lastKnownLease: () => null,
    log: (m: string) => void out.push(m),
    err: (m: string) => void out.push(m),
    tasks: SCHEDULED_TASKS,
  };
  return { store, out, puts, deleted, deps };
}

describe("--arm relê o Task Scheduler antes de gravar o lease (#12993)", () => {
  it("PowerShell sai 0 mas registra 0 tarefas (o bug do ensaio) -> exit 1, lease NÃO gravado", async () => {
    const sch = fakeScheduler({ registerOnly: 0 });
    const h = harness(sch);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0, "nenhum put no KV");
    assert.equal(h.store.has(SCHEDULER_LEASE_KEY), false);
    const text = h.out.join("\n");
    assert.match(text, /registro das tarefas não confirmado: esperadas \d+, registradas 0/);
    assert.match(text, /Lease novo NÃO gravado/);
    assert.doesNotMatch(text, /armado:/);
  });

  it("registro parcial -> exit 1, rollback remove o que entrou, lease NÃO gravado", async () => {
    const sch = fakeScheduler({ registerOnly: 2 });
    const h = harness(sch);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0);
    assert.equal(sch.tasks.size, 0, "rollback removeu as 2 registradas");
    assert.match(h.out.join("\n"), /faltando: Diaria-Failover-/);
  });

  it("status ilegível depois do registro -> exit 1, lease NÃO gravado", async () => {
    const h = harness(fakeScheduler({ statusFails: true }));
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0);
    assert.match(h.out.join("\n"), /não consegui listar as tarefas \(Get-ScheduledTask falhou\)/);
  });

  it("tarefas registradas mas Disabled -> exit 1, lease NÃO gravado", async () => {
    const h = harness(fakeScheduler({ state: "Disabled" }));
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0);
    assert.match(h.out.join("\n"), /desabilitadas: Diaria-Failover-/);
  });

  it("plano sem nenhuma task critical -> exit 1 antes de registrar, lease NÃO gravado", async () => {
    const scripts: string[] = [];
    const sch = fakeScheduler();
    const h = harness(sch);
    const d = { ...h.deps, tasks: [], runPowerShell: (s: string) => (scripts.push(s), sch.run(s)) };
    assert.equal(await takeoverMain(["--arm", "--force"], d), 1);
    assert.equal(scripts.length, 0, "nada mandado ao PowerShell");
    assert.equal(h.puts.length, 0);
    assert.match(h.out.join("\n"), /não tem nenhuma tarefa critical/);
  });

  const oldNeo = { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "neo", until: "2026-11-15T14:00:00Z", by: "x" }) };
  const lease300 = { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "300", until: "2026-11-15T14:00:00Z" }) };

  it("re-arm com lease ANTERIOR do Neo + releitura que não confirma -> rollback apaga o lease antigo", async () => {
    const h = harness(fakeScheduler({ registerOnly: 0 }), oldNeo);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY], "lease do Neo sem tarefas só pararia o 300");
    assert.equal(h.puts.length, 0);
    assert.match(h.out.join("\n"), /lease ANTERIOR do Neo/);
    assert.match(h.out.join("\n"), /Lease novo NÃO gravado/);
  });

  it("re-arm com lease anterior do Neo + registro que falha -> rollback também apaga o lease antigo", async () => {
    const h = harness(fakeScheduler({ registerFails: true }), oldNeo);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY]);
  });

  it("rollback com lease do 300 no KV não apaga o lease alheio", async () => {
    const h = harness(fakeScheduler({ registerOnly: 0 }), lease300);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, []);
  });

  it("rollback que não confirma a remoção não mexe no lease anterior do Neo", async () => {
    const h = harness(fakeScheduler({ registerOnly: 0, sticky: ["Diaria-Failover-Velha"] }), oldNeo);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, []);
  });

  it("tarefa velha que o Unregister não remove -> exit 1 ponta a ponta, sobra nomeada, lease NÃO gravado", async () => {
    const sch = fakeScheduler({ sticky: ["Diaria-Failover-Velha"] });
    const h = harness(sch);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0);
    const text = h.out.join("\n");
    assert.match(text, /sobrando: Diaria-Failover-Velha/);
    assert.match(text, /rollback: ainda há 1 Diaria-Failover-\* registradas \(Diaria-Failover-Velha\)/);
  });

  it("status com exit 0 e stdout que não é JSON -> exit 1, lease NÃO gravado", async () => {
    const h = harness(fakeScheduler({ statusStdout: "Get-ScheduledTask : texto solto" }));
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.puts.length, 0);
    assert.match(h.out.join("\n"), /saída ilegível/);
  });

  it("contagem certa -> exit 0 e lease do Neo gravado", async () => {
    const sch = fakeScheduler();
    const h = harness(sch);
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 0);
    assert.ok(sch.tasks.size > 0);
    assert.equal(JSON.parse(h.store.get(SCHEDULER_LEASE_KEY)!).host, "neo");
    assert.match(h.out.join("\n"), new RegExp(`armado: ${sch.tasks.size} tarefas`));
  });
});

describe("--disarm confere 0 tarefas restantes (#12993)", () => {
  const neoLease = { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "neo", until: "2026-11-15T15:00:00Z" }) };

  it("sobrou tarefa -> exit 1 com aviso, mas o lease do Neo é liberado", async () => {
    const sch = fakeScheduler({ unregisterNoop: true });
    sch.tasks.add("Diaria-Failover-Edicao");
    const h = harness(sch, neoLease);
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY], "sem o lease do Neo as que sobraram cedem ao 300");
    const text = h.out.join("\n");
    assert.match(text, /ainda há 1 Diaria-Failover-\* registradas \(Diaria-Failover-Edicao\)/);
    assert.match(text, /--disarm incompleto/);
  });

  it("sobrou tarefa COM o sinal de queda presente -> exit 1 e lease RETIDO (as restantes retomariam)", async () => {
    const sch = fakeScheduler({ unregisterNoop: true });
    sch.tasks.add("Diaria-Failover-Edicao");
    const h = harness(sch, { ...neoLease, [DOWN_SIGNAL_KEY]: "2026-11-15T10:00:00Z" });
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.deepEqual(h.deleted, [], "lease do Neo mantido");
    assert.ok(h.store.has(SCHEDULER_LEASE_KEY));
    const text = h.out.join("\n");
    assert.match(text, /sinal de queda do 300 está presente/);
    assert.match(text, /RETOMARIAM/);
    assert.match(text, /Lease do Neo NÃO liberado/);
  });

  it("listagem falha depois da remoção COM o sinal presente -> exit 1 e lease RETIDO", async () => {
    const h = harness(fakeScheduler({ statusFails: true }), { ...neoLease, [DOWN_SIGNAL_KEY]: "2026-11-15T10:00:00Z" });
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.deepEqual(h.deleted, []);
    assert.match(h.out.join("\n"), /remoção não confirmada/);
  });

  it("sobrou tarefa com o sinal de queda ILEGÍVEL (KV lança só no sinal) -> exit 1, lease RETIDO", async () => {
    const sch = fakeScheduler({ unregisterNoop: true });
    sch.tasks.add("Diaria-Failover-Edicao");
    const h = harness(sch, neoLease, [DOWN_SIGNAL_KEY]);
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.deepEqual(h.deleted, []);
    assert.match(h.out.join("\n"), /sinal de queda não foi lido/);
    assert.match(h.out.join("\n"), /Lease do Neo NÃO liberado/);
  });

  it("sobrou tarefa + sinal presente + lease do 300 -> exit 1 com a mensagem do lease alheio", async () => {
    const sch = fakeScheduler({ unregisterNoop: true });
    sch.tasks.add("Diaria-Failover-Edicao");
    const h = harness(sch, { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "300", until: "2026-11-15T15:00:00Z" }), [DOWN_SIGNAL_KEY]: "x" });
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.deepEqual(h.deleted, []);
    const text = h.out.join("\n");
    assert.match(text, /o lease não é do Neo \(dono 300\)/);
    assert.doesNotMatch(text, /Lease do Neo NÃO liberado/);
  });

  it("o 300 regrava o lease durante a remoção -> o --disarm relê e NÃO apaga o lease do 300", async () => {
    let h: ReturnType<typeof harness>;
    const sch = fakeScheduler({
      onUnregister: () => void h.store.set(SCHEDULER_LEASE_KEY, JSON.stringify({ host: "300", until: "2026-11-15T15:00:00Z" })),
    });
    sch.tasks.add("Diaria-Failover-Edicao");
    h = harness(sch, neoLease);
    assert.equal(await takeoverMain(["--disarm"], h.deps), 0);
    assert.deepEqual(h.deleted, [], "lease lido depois da espera é do 300");
  });

  it("removeu tudo -> exit 0", async () => {
    const sch = fakeScheduler();
    sch.tasks.add("Diaria-Failover-Edicao");
    const h = harness(sch, neoLease);
    assert.equal(await takeoverMain(["--disarm"], h.deps), 0);
    assert.equal(sch.tasks.size, 0);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY]);
  });
});
