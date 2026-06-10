# Telegram — setup do plugin (channels)

O plugin oficial **`telegram@claude-plugins-official`** conecta um bot do Telegram à sessão do Claude Code via _channels_: dá pra acompanhar o que a sessão está fazendo, responder e disparar ações de qualquer lugar pelo celular. Útil pra acompanhar uma edição rodando ou o `/diaria-overnight` sem ficar no terminal.

A declaração do marketplace e o enable do plugin já estão versionados em `.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "claude-plugins-official": {
    "source": { "source": "github", "repo": "anthropics/claude-plugins-official" }
  }
},
"enabledPlugins": {
  "telegram@claude-plugins-official": true
}
```

Mas a instalação tem passos **por máquina** que não dá pra versionar (token do bot é secret, pareamento é por dispositivo, Bun é dependência local). Faça uma vez por máquina:

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

## Nota — config versionada nem sempre auto-instala

O `extraKnownMarketplaces` + `enabledPlugins` no `.claude/settings.json` declara a intenção, mas o Claude Code **nem sempre** dispara a instalação do marketplace/plugin automaticamente ao abrir o repo pela primeira vez (e em print mode `-p` o trust dialog é pulado, então `extraKnownMarketplaces` não é processado). Se o `/telegram:*` não aparecer, rode os comandos do passo 3 manualmente.
