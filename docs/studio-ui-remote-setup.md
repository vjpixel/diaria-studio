# Studio UI — acesso remoto (Cloudflare Tunnel + Access)

Issue: [#3560](https://github.com/vjpixel/diaria-studio/issues/3560) (fatia 6 do epic "Studio UI" [#3554](https://github.com/vjpixel/diaria-studio/issues/3554))

Expõe o `studio-server` (hoje só `http://127.0.0.1:4174`, ver `scripts/studio-ui/server.ts`) num hostname público dedicado (ex: `studio.diar.ia.br`), acessível do celular do editor, **sem abrir porta nenhuma** e **sem nada público sem autenticação**.

Duas peças, cada uma numa camada diferente:

1. **Cloudflare Tunnel** (`cloudflared`) — conexão de saída da máquina do editor pra borda Cloudflare. Não expõe nenhuma porta na rede local/roteador; o hostname público só existe enquanto o `cloudflared` está rodando e conectado.
2. **Cloudflare Access** — proxy de autenticação **na borda**, configurado no painel Cloudflare (Zero Trust), na frente do hostname. Exige OTP por e-mail (ou IdP) de um allowlist antes de deixar QUALQUER requisição chegar no tunnel.

**Access não é implementado em código.** Não há autenticação própria no `studio-server.ts` — isso duplicaria o que o Access já resolve na borda, com mais superfície de bug (senha/token pra vazar, sessão pra gerenciar) e zero ganho. O `studio-server` continua sem noção nenhuma de "quem está logado" — ele só serve loopback, ponto.

---

## Pré-requisitos

- Windows OU Linux (a máquina do editor, ou o servidor Linux 24/7 — #4808 estendeu o fluxo pra Linux via `systemd --user`; passos específicos por OS marcados abaixo).
- Domínio `diar.ia.br` já numa zona Cloudflare (é o caso — usado por outros Workers do projeto).
- Conta Cloudflare com acesso a essa zona (mesma conta usada pra `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` do `.env`, mas **este fluxo usa login interativo via browser, não a API token** — são credenciais separadas).
- `studio-server` já rodando localmente (`npm run studio`, ou via `setup-studio-service-linux.sh` no Linux) quando você for testar do celular.
- **Linux apenas**: Node ≥22.5 (ver [#4823](https://github.com/vjpixel/diaria-studio/issues/4823) — `node:sqlite` não existe em versões anteriores; o Node do pacote da distro pode estar desatualizado) e `loginctl enable-linger $USER` rodado 1x (sudo) — sem isso o service para quando a última sessão de login encerra.
- **Guard de blast-radius (#4808):** se o tunnel já tiver um conector ativo rodando noutra máquina (ex: migrando do Windows pro Linux), suba o novo só depois de desarmar o antigo — dois conectores ativos pro mesmo tunnel roteiam o hostname de forma imprevisível entre as duas máquinas. `setup-remote-tunnel-linux.sh` checa isso automaticamente antes de iniciar (recusa sem `--force`).

---

## Passo a passo

### 1. Instalar o `cloudflared`

**Windows:**
```powershell
winget install --id Cloudflare.cloudflared
```
Alternativa sem winget: baixar o binário em [github.com/cloudflare/cloudflared/releases/latest](https://github.com/cloudflare/cloudflared/releases/latest) e colocar no PATH.

Reabra o terminal depois de instalar (o PATH precisa recarregar).

**Linux (sem sudo — binário direto):**
```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared
chmod +x ~/.local/bin/cloudflared
```
Garanta que `~/.local/bin` está no `PATH`.

### 2. Subir o `studio-server` como serviço (Linux)

O `.ps1` do Windows (`scripts/studio/setup-studio-service.ps1`) foi removido no #5115 (cutover final) — nenhuma tarefa `Diaria-*` roda mais no Windows:
```bash
./scripts/studio/setup-studio-service-linux.sh --dry-run   # ver o plano primeiro
./scripts/studio/setup-studio-service-linux.sh             # registrar + habilitar
systemctl --user start diaria-studio-server.service        # iniciar agora
```
Requer `loginctl enable-linger $USER` já feito (ver Pré-requisitos) — senão o service para no logout.

### 3. Rodar o script de setup do tunnel

O `.ps1` do Windows (`scripts/studio/setup-remote-tunnel.ps1`) foi removido no #5115 (cutover final) — nenhuma tarefa `Diaria-*` roda mais no Windows. Ele seguia o mesmo roteiro conceitual de 6 passos do script Linux abaixo (instalar → login → criar tunnel → gerar config → DNS → armar o processo de longa duração via task no Task Scheduler).

**Linux:**
```bash
./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br --dry-run   # ver o plano
./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br             # executar
systemctl --user start diaria-studio-tunnel.service                                    # iniciar agora
```

2 diferenças em relação ao antigo roteiro Windows, por causa da autenticação e do gerenciador de serviço:

- **Autenticação via token de conector** (`cloudflared tunnel token`), não `credentials-file` — funciona mesmo que o tunnel tenha sido criado originalmente noutra máquina (ex: migrando do Windows). O token vai pra `~/.cloudflared/token` (`chmod 600`, nunca no repo) e a unit systemd usa `--token-file` — **nunca `--token <valor>` inline**, que vazaria o segredo em `ps`/`systemctl status` (achado ao vivo, #4808).
- **`systemd --user`** em vez de Task Scheduler: `diaria-studio-tunnel.service`, com `Restart=always` e `Requires=diaria-studio-server.service` (o tunnel só sobe depois do server local estar de pé).

### 4. Configurar o Cloudflare Access

**Isso é feito inteiramente no painel Cloudflare — não há script pra essa parte** (é configuração de conta, não código do repo).

1. Acesse [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** → **Access** → **Applications**.
2. **Add an application** → tipo **Self-hosted**.
3. **Application domain**: o hostname configurado no passo 3 (ex: `studio.diar.ia.br`).
4. **Session duration**: sugestão 24h (o editor reautentica 1x por dia via celular).
5. **Policy**:
   - **Action**: Allow.
   - **Include**: `Emails` → adicione o e-mail do editor (`vjpixel@gmail.com`).
   - **Identity provider**: One-Time PIN (padrão, sem setup extra) é suficiente — o editor recebe um código por e-mail a cada login. Se preferir um IdP (Google, etc.), configurar em **Settings → Authentication** antes.
6. Salvar.

A partir daqui, **qualquer requisição** pro hostname público passa pelo Access antes de chegar no tunnel. Sem OTP/login válido, o Access responde com a própria página de login (ou redireciona pra ela) — o `studio-server` nunca vê a requisição.

### 5. Verificar do celular

Abra `https://studio.diar.ia.br` no navegador do celular. Deve aparecer a tela de login do Access (pedindo e-mail → OTP). Depois do OTP, o Studio real deve carregar normalmente, com os gates (fatias 3/4) funcionando como no desktop.

### 6. Verificação de segurança (smoke-test)

Depois de tudo ativado, rode o smoke-test que confirma que **nada vaza sem autenticação**:

```bash
npx tsx scripts/studio/verify-remote-tunnel.ts --url https://studio.diar.ia.br
```

**Só funciona depois da ativação real** (passos 1–3 acima) — antes disso o hostname nem existe, e o script retorna erro de rede (esperado, não é bug).

O script faz uma requisição **sem nenhum cookie/header de autenticação** contra o hostname público e confirma que a resposta é sempre um bloqueio do Access (redirect pro login, ou 401/403) — nunca o conteúdo real do Studio. Exit codes:

- `0` — protegido corretamente (Access está bloqueando).
- `1` — **VAZAMENTO**: o conteúdo real respondeu sem autenticação. Revisar a policy do Access no painel imediatamente.
- `2` — resposta ambígua ou erro de rede — tratado como falha por segurança (não confirma proteção).

---

## Defesa em profundidade

O `studio-server` (`scripts/studio-ui/server.ts`) faz bind exclusivo em `127.0.0.1` (nunca `0.0.0.0`) — mesmo que o tunnel ou o Access sejam mal configurados, o server continua inacessível pra qualquer coisa na rede local além da própria máquina. O tunnel é a **única** via de entrada externa, e o Access é a **única** camada de autenticação — as duas precisam estar corretas, mas mesmo uma falha do tunnel/Access não expõe o server na LAN.

---

## Remover / desativar

Remover a unit systemd — não desfaz o tunnel nem o DNS na Cloudflare:

```bash
./scripts/studio/setup-remote-tunnel-linux.sh --unregister
./scripts/studio/setup-studio-service-linux.sh --unregister   # se quiser derrubar o studio-server também
```

Desfazer o tunnel e o DNS de vez:

```powershell
cloudflared tunnel route dns --overwrite-dns diaria-studio <hostname-antigo-se-quiser-liberar>
cloudflared tunnel delete diaria-studio
```

E remover a Access Application correspondente no painel Cloudflare (Zero Trust → Access → Applications).

---

## O que está pronto vs. o que exige ação do editor

| Item | Status |
|---|---|
| `studio-server` bind loopback-only | ✅ Já era assim desde #3555 (confirmado, não precisou mudar) |
| Script de setup — Linux (`scripts/studio/setup-remote-tunnel-linux.sh`, `setup-studio-service-linux.sh`, #4808) | ✅ Pronto e **ativado ao vivo em `predator`** (260810) — Studio server + tunnel systemd `enabled`, `studio.diar.ia.br` respondendo 302 → Cloudflare Access |
| Smoke-test de verificação (`scripts/studio/verify-remote-tunnel.ts`) | ✅ Pronto, com testes unitários |
| Este doc | ✅ Pronto |
| `cloudflared tunnel login` (OAuth na conta CF) | ✅ Linux (`predator`): feito |
| Rodar o script de setup (cria tunnel + DNS + service) | ✅ Linux (`predator`): feito |
| Configurar o Cloudflare Access (allowlist + policy) | ✅ Já configurado (mesma Access Application cobre qualquer conector do tunnel, independente da máquina) |
| Rodar o smoke-test pós-ativação | ✅ Rodado contra `predator` (260810) — `exit 0`, Access bloqueando corretamente |

O par Windows (`scripts/studio/setup-remote-tunnel.ps1`, `scripts/studio/setup-studio-service.ps1`) foi removido no #5115 (cutover final, 260812) — nenhuma tarefa `Diaria-*` roda mais no Windows (política de 260811, #5074); esse lado já estava desarmado de propósito desde o #4808 (dois conectores ativos pro mesmo tunnel simultaneamente causam roteamento imprevisível).
