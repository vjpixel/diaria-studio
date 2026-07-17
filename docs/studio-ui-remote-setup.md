# Studio UI — acesso remoto (Cloudflare Tunnel + Access)

Issue: [#3560](https://github.com/vjpixel/diaria-studio/issues/3560) (fatia 6 do epic "Studio UI" [#3554](https://github.com/vjpixel/diaria-studio/issues/3554))

Expõe o `studio-server` (hoje só `http://127.0.0.1:4174`, ver `scripts/studio-ui/server.ts`) num hostname público dedicado (ex: `studio.diar.ia.br`), acessível do celular do editor, **sem abrir porta nenhuma** e **sem nada público sem autenticação**.

Duas peças, cada uma numa camada diferente:

1. **Cloudflare Tunnel** (`cloudflared`) — conexão de saída da máquina do editor pra borda Cloudflare. Não expõe nenhuma porta na rede local/roteador; o hostname público só existe enquanto o `cloudflared` está rodando e conectado.
2. **Cloudflare Access** — proxy de autenticação **na borda**, configurado no painel Cloudflare (Zero Trust), na frente do hostname. Exige OTP por e-mail (ou IdP) de um allowlist antes de deixar QUALQUER requisição chegar no tunnel.

**Access não é implementado em código.** Não há autenticação própria no `studio-server.ts` — isso duplicaria o que o Access já resolve na borda, com mais superfície de bug (senha/token pra vazar, sessão pra gerenciar) e zero ganho. O `studio-server` continua sem noção nenhuma de "quem está logado" — ele só serve loopback, ponto.

---

## Pré-requisitos

- Windows (a máquina do editor).
- Domínio `diar.ia.br` já numa zona Cloudflare (é o caso — usado por outros Workers do projeto).
- Conta Cloudflare com acesso a essa zona (mesma conta usada pra `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` do `.env.local`, mas **este fluxo usa login interativo via browser, não a API token** — são credenciais separadas).
- `studio-server` já rodando localmente (`npm run studio`) quando você for testar do celular.

---

## Passo a passo

### 1. Instalar o `cloudflared`

```powershell
winget install --id Cloudflare.cloudflared
```

Alternativa sem winget: baixar o binário em [github.com/cloudflare/cloudflared/releases/latest](https://github.com/cloudflare/cloudflared/releases/latest) e colocar no PATH.

Reabra o terminal depois de instalar (o PATH precisa recarregar).

### 2. Rodar o script de setup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\studio\setup-remote-tunnel.ps1 -Hostname studio.diar.ia.br
```

Use `-DryRun` primeiro se quiser ver o plano sem executar nada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\studio\setup-remote-tunnel.ps1 -Hostname studio.diar.ia.br -DryRun
```

O script é **idempotente** — pode rodar de novo a qualquer momento pra retomar de onde parou. Ele guia por 6 passos:

1. Verifica se `cloudflared` está instalado.
2. Verifica se já há login (`~/.cloudflared/cert.pem`). **Se não houver, o script para aqui** e imprime a instrução:
   ```powershell
   cloudflared tunnel login
   ```
   Isso abre o browser pra você autenticar na sua conta Cloudflare e escolher a zona `diar.ia.br`. **Ação manual — o script nunca automatiza login** (é um fluxo OAuth no browser, não dá pra scriptar, e não seria seguro tentar).

   Depois de autenticar, rode o script de novo — ele detecta o `cert.pem` e continua do passo 3.
3. Cria o tunnel nomeado `diaria-studio` (reusa se já existir).
4. Gera `~/.cloudflared/config.yml` com o ingress apontando pra `http://127.0.0.1:4174`.
5. Roteia o DNS do hostname pro tunnel (`cloudflared tunnel route dns`) — cria um CNAME na zona.
6. Registra a task **`Diaria-Studio-Tunnel`** no Task Scheduler (mesmo padrão do watchdog overnight, [#2688](https://github.com/vjpixel/diaria-studio/issues/2688) — ver `scripts/overnight/setup-watchdog-schedule.ps1`), rodando `cloudflared tunnel run` no logon, com restart automático se cair. Isso mantém o tunnel ativo sem precisar deixar um terminal aberto.

Pra iniciar a task imediatamente sem esperar o próximo logon:

```powershell
Start-ScheduledTask -TaskName "Diaria-Studio-Tunnel"
```

### 3. Configurar o Cloudflare Access

**Isso é feito inteiramente no painel Cloudflare — não há script pra essa parte** (é configuração de conta, não código do repo).

1. Acesse [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** → **Access** → **Applications**.
2. **Add an application** → tipo **Self-hosted**.
3. **Application domain**: o hostname configurado no passo 2 (ex: `studio.diar.ia.br`).
4. **Session duration**: sugestão 24h (o editor reautentica 1x por dia via celular).
5. **Policy**:
   - **Action**: Allow.
   - **Include**: `Emails` → adicione o e-mail do editor (`vjpixel@gmail.com`).
   - **Identity provider**: One-Time PIN (padrão, sem setup extra) é suficiente — o editor recebe um código por e-mail a cada login. Se preferir um IdP (Google, etc.), configurar em **Settings → Authentication** antes.
6. Salvar.

A partir daqui, **qualquer requisição** pro hostname público passa pelo Access antes de chegar no tunnel. Sem OTP/login válido, o Access responde com a própria página de login (ou redireciona pra ela) — o `studio-server` nunca vê a requisição.

### 4. Verificar do celular

Abra `https://studio.diar.ia.br` no navegador do celular. Deve aparecer a tela de login do Access (pedindo e-mail → OTP). Depois do OTP, o Studio real deve carregar normalmente, com os gates (fatias 3/4) funcionando como no desktop.

### 5. Verificação de segurança (smoke-test)

Depois de tudo ativado, rode o smoke-test que confirma que **nada vaza sem autenticação**:

```powershell
npx tsx scripts\studio\verify-remote-tunnel.ts --url https://studio.diar.ia.br
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

Remover a task do Task Scheduler (não desfaz o tunnel nem o DNS na Cloudflare):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
    -File scripts\studio\setup-remote-tunnel.ps1 -Unregister
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
| Script de setup (`scripts/studio/setup-remote-tunnel.ps1`) | ✅ Pronto — prepara config, cria tunnel/DNS/task quando executado pelo editor |
| Smoke-test de verificação (`scripts/studio/verify-remote-tunnel.ts`) | ✅ Pronto, com testes unitários |
| Este doc | ✅ Pronto |
| Instalar `cloudflared` | ⬜ Ação do editor (`winget install` ou download) |
| `cloudflared tunnel login` (OAuth na conta CF) | ⬜ Ação do editor — não automatizável |
| Rodar o script de setup (cria tunnel + DNS + task) | ⬜ Ação do editor — muta recursos reais na conta Cloudflare |
| Configurar o Cloudflare Access (allowlist + policy) | ⬜ Ação do editor no painel CF |
| Rodar o smoke-test pós-ativação | ⬜ Ação do editor, depois dos itens acima |

Este PR entrega código/doc/script — a ativação real (label `local`, [#2643](https://github.com/vjpixel/diaria-studio/issues/2643)) fica pro editor rodar na própria máquina/conta.
