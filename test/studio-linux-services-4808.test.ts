/**
 * test/studio-linux-services-4808.test.ts (#4808)
 *
 * Regression tests estáticos pros 2 scripts bash que armam o Studio server +
 * Cloudflare tunnel como user systemd services em Linux (espelham
 * setup-studio-service.ps1 / setup-remote-tunnel.ps1 do Windows, mas não têm
 * o bug de "Register-ScheduledTask -Force reseta Enabled" que
 * test/scheduled-task-registration.test.ts cobre pros .ps1 — systemd
 * `enable` é idempotente por natureza, sem esse caso).
 *
 * Cobre 2 achados ao vivo da implementação (260810):
 *
 * 1. Token do tunnel NUNCA na linha de comando (`--token <valor>`) — só
 *    `--token-file`. Achado ao vivo: `ps`/`systemctl status` expõem args de
 *    processo pra qualquer usuário local; `--token "$(cat ...)"` vazava o
 *    token inteiro.
 * 2. Guard de conector duplicado — o script recusa iniciar se
 *    `cloudflared tunnel info` já mostra um conector ativo de outra origem
 *    (ex: o Windows ainda rodando), a menos que `--force` seja passado.
 *    Sem isso, dois conectores ativos pro mesmo tunnel roteiam o hostname de
 *    forma imprevisível entre as duas máquinas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = resolve(ROOT, "scripts/studio/setup-studio-service-linux.sh");
const TUNNEL_SCRIPT = resolve(ROOT, "scripts/studio/setup-remote-tunnel-linux.sh");

function bashSyntaxOk(path: string): boolean {
  try {
    execFileSync("bash", ["-n", path], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("setup-studio-service-linux.sh (#4808)", () => {
  const source = readFileSync(SERVER_SCRIPT, "utf8");

  it("tem sintaxe bash válida", () => {
    assert.ok(bashSyntaxOk(SERVER_SCRIPT), "bash -n falhou no script");
  });

  it("--unregister só para/desabilita/remove a unit — não mexe em nada fora de systemd", () => {
    const unregisterBlock = source.split('"$UNREGISTER" = "1"')[1]?.split("fi")[0] ?? "";
    assert.match(unregisterBlock, /systemctl --user stop/);
    assert.match(unregisterBlock, /systemctl --user disable/);
    assert.match(unregisterBlock, /rm -f "\$UNIT_FILE"/);
  });

  it("checa a versão do Node e avisa se < 22.5 (node:sqlite, #4823)", () => {
    assert.match(source, /NODE_MAJOR.*-lt 22/);
    assert.match(source, /node:sqlite/);
  });

  it("não hardcoda um usuário/path específico — deriva de $HOME/$BASH_SOURCE", () => {
    assert.doesNotMatch(source, /\/home\/[a-z]+\//, "path de usuário hardcoded encontrado");
  });
});

describe("setup-remote-tunnel-linux.sh (#4808)", () => {
  const source = readFileSync(TUNNEL_SCRIPT, "utf8");

  it("tem sintaxe bash válida", () => {
    assert.ok(bashSyntaxOk(TUNNEL_SCRIPT), "bash -n falhou no script");
  });

  it("achado ao vivo: a unit gerada usa --token-file, nunca --token <valor> na linha de comando", () => {
    const unitHeredoc = source.split("cat > \"$UNIT_FILE\"")[1] ?? "";
    assert.match(unitHeredoc, /--token-file \$TOKEN_PATH/, "unit deveria usar --token-file");
    assert.doesNotMatch(
      // Flag "s" (dotall): ExecStart pode ser quebrado em múltiplas linhas com
      // "\" de continuação (jeito idiomático de manter uma linha longa
      // legível) -- sem dotall, "." não cruza newline e um --token reintroduzido
      // numa linha de continuação passaria pelo teste sem ser pego.
      unitHeredoc,
      /ExecStart=.*--token[^-]/s,
      "ExecStart não deve conter --token com valor inline (vaza em ps/systemctl status)",
    );
  });

  it("o token nunca é escrito no config.yml nem impresso depois de gravado", () => {
    const afterTokenWrite = source.split('"6/7')[1] ?? "";
    assert.match(afterTokenWrite, /chmod 600 "\$TOKEN_PATH"/);
    // Garantir que a linha que grava o token não também o imprime (regressão
    // de segurança se alguém adicionar um `echo $TOKEN`/`cat` de debug ali).
    const tokenWriteLine = source
      .split("\n")
      .find((l) => l.includes("tunnel token") && l.includes(">"));
    assert.ok(tokenWriteLine, "esperava a linha que redireciona `tunnel token` pro arquivo");
    assert.doesNotMatch(tokenWriteLine!, /\becho\b/);
  });

  it("achado ao vivo: guard recusa iniciar se já há conector ativo de outra origem, sem --force", () => {
    assert.match(source, /GUARD/i);
    assert.match(source, /CONNECTOR ID/, "guard deveria checar a saída de 'tunnel info' por conectores ativos");
    assert.match(source, /FORCE.*!=.*"1"/, "guard deveria ser pulável só com --force explícito");

    // Não basta o texto aparecer em algum lugar do arquivo -- isola o bloco
    // `if ... fi` que de fato faz a checagem (mesmo padrão de
    // .split(...)[1]?.split("fi")[0] usado pelos testes de --unregister acima)
    // e confirma que HÁ um `exit 1` de verdade dentro dele, não comentado nem
    // neutralizado por um `if false`/condição sempre-falsa. Uma regressão que
    // desliga o guard (ex: troca a condição por `if false && ...`, ou troca
    // `exit 1` por um simples aviso) deve fazer este assert falhar.
    const grepIdx = source.indexOf('grep -q "CONNECTOR ID"');
    assert.ok(grepIdx > -1, "guard deveria conter o grep por CONNECTOR ID");
    const ifStart = source.lastIndexOf("if ", grepIdx);
    assert.ok(ifStart > -1, "esperava encontrar o 'if' que abre o bloco do guard");
    const guardIfBlock = source.slice(ifStart).split("fi")[0];

    assert.doesNotMatch(
      guardIfBlock,
      /if\s+false/,
      "condição do guard não pode estar neutralizada com 'if false'",
    );
    assert.match(guardIfBlock, /FORCE.*!=.*"1"/, "condição isolada deveria checar --force");

    // A linha precisa ser o COMANDO `exit 1` de verdade (início da linha,
    // ignorando indentação) -- não basta a substring aparecer dentro do texto
    // de um `echo "..."` de aviso, senão um regressão que troca o exit por um
    // simples aviso mencionando "exit 1" na mensagem passaria despercebida.
    const exitLine = guardIfBlock.split("\n").find((l) => /^\s*exit 1\b/.test(l));
    assert.ok(exitLine, "bloco do guard deveria conter um comando 'exit 1' real, não só a substring em outro lugar");
    assert.doesNotMatch(exitLine!, /^\s*#/, "'exit 1' do guard não pode estar comentado");
  });

  it("--unregister não desfaz o tunnel nem o DNS na Cloudflare (só a unit local)", () => {
    const unregisterBlock = source.split('"$UNREGISTER" = "1"')[1]?.split("fi")[0] ?? "";
    // "tunnel delete"/"route dns --overwrite-dns" só podem aparecer como texto
    // informativo (dentro de `echo "..."`) — nunca como comando executado de
    // verdade dentro do branch de --unregister.
    const executableLines = unregisterBlock
      .split("\n")
      .filter((l) => !/^\s*(#|echo\b)/.test(l.trim()));
    const executableText = executableLines.join("\n");
    assert.doesNotMatch(executableText, /tunnel delete/);
    assert.doesNotMatch(executableText, /route dns/);
    assert.match(unregisterBlock, /rm -f "\$UNIT_FILE"/);
  });

  it("não hardcoda um usuário/path específico — deriva de $HOME", () => {
    assert.doesNotMatch(source, /\/home\/[a-z]+\//, "path de usuário hardcoded encontrado");
  });
});
