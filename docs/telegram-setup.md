# Telegram — setup do plugin (channels)

O plugin oficial **`telegram@claude-plugins-official`** conecta um bot do Telegram à sessão do Claude Code via _channels_: dá pra acompanhar o que a sessão está fazendo, responder e disparar ações de qualquer lugar pelo celular. Útil pra acompanhar uma edição rodando ou o `/diaria-overnight` sem ficar no terminal.

> **Desde 260727 o plugin NÃO é mais declarado no repo.** O editor removeu
> `extraKnownMarketplaces` e `enabledPlugins` de `.claude/settings.json`, então
> **todos** os passos abaixo são manuais — inclusive registrar o marketplace e
> habilitar o plugin (passo 3), que antes o repo às vezes disparava sozinho.
> Se você quiser o Telegram de volta como padrão do projeto, é decisão de
> config: re-adicionar os dois blocos ao `settings.json` versionado.

A instalação tem passos **por máquina** que não dá pra versionar de qualquer forma (token do bot é secret, pareamento é por dispositivo, Bun é dependência local). Faça uma vez por máquina:

## 1. Pré-requisito: Bun

O MCP server do plugin roda em [Bun](https://bun.sh):

```bash
curl -fsSL https://bun.sh/install | bash
```

## 2. Criar o bot no Telegram

1. Abrir conversa com [@BotFather](https://t.me/BotFather).
2. Enviar `/newbot`.
3. Escolher um display name e um username único terminado em `bot` (ex: `diaria_studio_bot`).
4. O BotFather responde com o **token** no formato `123456789:AAHfiqksKZ8...`. Guarde — é secret.

## 3. Instalar o plugin

Se o marketplace ainda não estiver na máquina (clone novo costuma precisar — ver _Nota_ abaixo):

```
/plugin marketplace add anthropics/claude-plugins-official
```

Depois:

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

## 4. Configurar o token

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

O token fica em `~/.claude/channels/telegram/.env`. Alternativamente, exporte `TELEGRAM_BOT_TOKEN` no shell (tem precedência — ver `.env.example`).

## 5. Relançar com o channel ativo

```bash
claude --channels plugin:telegram@claude-plugins-official
```

## 6. Parear + travar o acesso

1. Mandar uma DM pro bot no Telegram.
2. No Claude Code, parear com o código exibido: `/telegram:access pair <código>`.
3. **Travar o acesso** (allowlist/policy) via `/telegram:access` — só os chats pareados devem poder controlar a sessão. Crítico: um bot aberto deixaria qualquer um disparar ações no seu Claude Code.

## Nota — o passo 3 é obrigatório (não há mais config versionada)

Enquanto o repo declarava `extraKnownMarketplaces` + `enabledPlugins`, essa
declaração valia como intenção mas o Claude Code **nem sempre** disparava a
instalação sozinho ao abrir o repo (e em print mode `-p` o trust dialog é
pulado, então `extraKnownMarketplaces` nem era processado) — o passo 3 manual
já era o fallback comum.

Desde 260727 os dois blocos saíram do `.claude/settings.json`, então o passo 3
deixou de ser fallback e virou **o único caminho**. Se `/telegram:*` não
aparecer, não é bug: é a config não existir mais.
