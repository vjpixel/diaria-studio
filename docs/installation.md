# Installation — Diar.ia Studio

Passo-a-passo end-to-end, do zero ao primeiro `/diaria-edicao` funcional. Estimativa: **30–45 min** na primeira vez.

Estrutura linear: cada seção completa, instala e valida um componente. Não pule etapas.

---

## 1. Pré-requisitos

| Item | Versão | Onde obter |
|---|---|---|
| Node.js | 22+ | https://nodejs.org/ |
| Git | recente | sistema |
| Claude Code CLI | autenticado | https://claude.com/claude-code |
| Chrome browser | recente | pra extensão Claude in Chrome (Fase 3) |
| Conta Anthropic | paga | pra OAuth do Claude Code |
| Conta Beehiiv | Scale+ | https://www.beehiiv.com/ (necessário pra MCP oficial) |
| Conta Gmail | comum | pra inbox editorial |
| Conta Meta Business | com Página FB + App Graph API | pra publicação Facebook |
| Google Cloud Console | projeto criado | pra OAuth (Drive + Gmail) |

---

## 2. Clone e instalação básica

```bash
git clone git@github.com:vjpixel/diaria-studio.git
cd diaria-studio
npm ci
```

Validar:

```bash
npm test              # 148+ testes passando
npm run typecheck     # limpo
npm run smoke         # "✓ Pipeline match golden"
```

Se qualquer um falhar, abrir issue antes de seguir — algo no setup da máquina está fora do esperado.

---

## 3. Variáveis de ambiente

Copiar `.env.example` pra `.env` e preencher:

```bash
cp .env.example .env
```

| Variável | Pra que serve | Como obter |
|---|---|---|
| `CLARICE_API_KEY` | MCP Clarice (revisão PT-BR) | conta Clarice.ai |
| `GEMINI_API_KEY` | Stages 4–5 (imagens via Gemini) | https://aistudio.google.com/apikey |
| `GOOGLE_CLIENT_ID` | Drive sync + Gmail inbox | Console Cloud → Credentials → OAuth Client ID (Desktop app) |
| `GOOGLE_CLIENT_SECRET` | idem | mesma tela |

No Windows, use `setx` ou `[Environment]::SetEnvironmentVariable(...)` pra persistir — requer reabrir o terminal.

---

## 4. MCPs — conexões

`/mcp` no Claude Code lista os MCPs conectados. A meta final é ver:

```
clarice          (local)
Beehiiv          (conector nativo)
claude.ai Gmail  (conector nativo)
Claude in Chrome (extensão; configurada na seção 8)
github           (opcional, issues/PRs)
```

### 4.1 Clarice (local)

O MCP da Clarice roda localmente. Instalar e configurar:

1. Seguir `README` da Clarice (ou instruções fornecidas pela equipe).
2. Confirmar `CLARICE_API_KEY` exportada no shell (seção 3).
3. Confirmar que `.mcp.json` lista `clarice`.
4. Reiniciar Claude Code → `/mcp` → `clarice` deve aparecer conectado.

### 4.2 Beehiiv MCP

1. Em https://claude.ai/settings/connectors, conectar **Beehiiv** com a conta da publicação.
2. Autorizar acesso.
3. `/mcp` → `claude.ai Beehiiv` listado.

### 4.3 Gmail MCP (inbox editorial)

Duas abordagens. **Recomendada: Opção A** (forward + label). Detalhes completos em [`gmail-inbox-setup.md`](./gmail-inbox-setup.md).

**Resumo da Opção A:**
1. Configurar forwarding em `diariaeditor@gmail.com` → `vjpixel@gmail.com`.
2. Criar filtro + label `Diaria` em `vjpixel@gmail.com`.
3. Gmail MCP na claude.ai autenticado com `vjpixel@gmail.com` (conta pessoal).
4. Confirmar `platform.config.json.inbox.enabled: true` e `gmailQuery: "label:Diaria"`.

Validar:

```bash
# No Claude Code:
/diaria-inbox
```

Deve retornar sem erros (vazio na 1ª execução).

### 4.4 GitHub MCP (opcional)

Só se quiser que o Claude crie issues/PRs automaticamente.

1. https://claude.ai/settings/connectors → GitHub → conectar.
2. `/mcp` → listado.

---

## 5. Google OAuth (Drive sync)

Setup único pra permitir sync dos outputs de edição com Drive.

1. Pré-req: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` no `.env`.
2. Rodar:
   ```bash
   npx tsx scripts/oauth-setup.ts
   ```
3. Browser abre no Google Consent Screen → autorizar.
4. Token salvo em `data/.credentials.json` (gitignored).

Validar:

```bash
# deve listar sem erro
npx tsx -e "import('./scripts/drive-sync.ts').then(m => console.log('Drive sync loaded'))"
```

---

## 6. Facebook Graph API

Pra Stage 6 publicação no Facebook.

1. Em https://developers.facebook.com/, criar um App (tipo Business).
2. Adicionar produto **Pages API**.
3. Obter **Page Access Token** de longa duração pra página Diar.ia.
4. Criar `data/.fb-credentials.json`:
   ```json
   {
     "page_id": "839717705901271",
     "page_access_token": "EAAA...",
     "api_version": "v21.0"
   }
   ```
5. Validar:
   ```bash
   curl "https://graph.facebook.com/v21.0/me?access_token=<TOKEN>"
   # deve retornar info da página
   ```

---

## 7. Gemini API (imagens)

1. `GEMINI_API_KEY` no `.env` (seção 3).
2. Validar:
   ```bash
   /diaria-4-eai 260425   # edição de teste
   # deve baixar Wikimedia POTD + gerar versão IA
   ```

---

## 8. Claude in Chrome (Fase 3 — publicação)

Resumo abaixo. Guia completo em [`browser-publish-setup.md`](./browser-publish-setup.md).

1. Instalar extensão **Claude in Chrome** (https://claude.ai/chrome).
2. Logar na extensão com a mesma conta Anthropic.
3. Abrir Chrome e logar manualmente em cada plataforma:
   - Beehiiv: https://app.beehiiv.com/
   - LinkedIn: https://www.linkedin.com/
   - Facebook Business Suite: https://business.facebook.com/
4. Marcar "manter conectado" em cada.
5. `/mcp` → `Claude in Chrome` listado.

---

## 9. Geração de assets do projeto

```bash
npm run sync-sources                  # seed/sources.csv → context/sources.md
```

Opcional (pode rodar depois da 1ª edição):

```bash
# No Claude Code:
/diaria-refresh-dedup                 # extrai past editions do Beehiiv
/diaria-atualiza-audiencia            # perfil de audiência via Beehiiv survey
```

---

## 10. Primeira edição de teste

```bash
# No Claude Code:
/diaria-test
```

Essa skill roda a pipeline completa mas:
- Pula Drive sync (sem poluir Drive real).
- Agenda social 10 dias no futuro (sem spam real).
- Usa edição de teste 999999 por default.

Acompanhar cada gate e validar que funciona. Se falhar em algum stage, ver `/diaria-log` + troubleshooting abaixo.

---

## 11. Produção — primeira edição real

```bash
/diaria-edicao 260425   # data no formato AAMMDD
```

- Stages 1–6 em sequência, cada um com gate humano.
- Outputs em `data/editions/260425/`.
- Se interromper, re-rodar `/diaria-edicao 260425` resume de onde parou.

---

## Troubleshooting

### `clarice` não conecta
- `/mcp` → se `clarice` não aparece: verificar se processo está rodando localmente.
- `CLARICE_API_KEY not set` → revisar seção 3, reabrir terminal.

### `beehiiv_login_expired`
- Token OAuth do conector caducou. https://claude.ai/settings/connectors → reconectar Beehiiv.

### `chrome_disconnected` no meio de Stage 5/6
- Extensão Claude in Chrome desconectou. Aguardar 30s, tentar de novo até 3×. Se persistir, reinstalar extensão.

### `Template 'Default' not found` no Beehiiv
- Nome do template em `platform.config.json.publishing.newsletter.template` não bate com dashboard Beehiiv. Verificar case-sensitive.

### Imagens do Stage 4 não geram
- `GEMINI_API_KEY` ausente ou inválida. Rodar `/diaria-4-eai` isolado e ver erro.

### `/diaria-inbox` retorna `label_created_empty`
- Label `Diaria` não tinha emails. Configurar filtro (seção 4.3, opção A passo 2).

### `fb_post_id` missing depois de Stage 6
- `data/.fb-credentials.json` ausente ou com token expirado. Revisar seção 6.

### Drive sync falha silenciosamente
- Token OAuth caducou. `npx tsx scripts/oauth-setup.ts` de novo.

### `npm test` falha em CI mas passa local
- Provável bug em `test/**/*.test.ts` ou script importado. Abrir issue com output de `npm test -- --reporter=spec`.

---

## Próximos passos

- Ler [`CLAUDE.md`](../CLAUDE.md) — arquitetura e regras do projeto.
- Ler [`context/editorial-rules.md`](../context/editorial-rules.md) — regras editoriais invariantes.
- Acompanhar issues com labels `P0`–`P3` em https://github.com/vjpixel/diaria-studio/issues.

## Referências dos guias detalhados

- [`browser-publish-setup.md`](./browser-publish-setup.md) — Claude in Chrome (seção 8 resumida aqui).
- [`gmail-inbox-setup.md`](./gmail-inbox-setup.md) — inbox editorial (seção 4.3 resumida aqui).
- [`comfyui-setup.md`](./comfyui-setup.md) — Stable Diffusion local (alternativa ao Gemini; raro usar hoje).
