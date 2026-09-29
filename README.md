# 🏛️ API NFS-e Nacional - ADN Contribuinte

API de alta performance em **Express.js** desenvolvida para rodar com o runtime **Bun**, integrando-se diretamente ao **Ambiente de Dados Nacional (ADN)** da NFS-e Nacional via **Procuração Eletrônica (Padrão 1)** com autenticação mútua **mTLS (Certificado Digital ICP-Brasil A1)**.

Projetada para implantação simplificada e segura em **VPSs / servidores dedicados**, com **Docker Secrets** para proteção de certificados, **API Token** configurável, **Rate Limiting** de entrada e saída, **Fila Assíncrona com Mutex Lock por CNPJ** e suporte a **PostgreSQL** e **SQLite**.

---

## 📖 Documentação da API

A API conta com documentação completa disponível em múltiplos formatos:

- **Interface Visual Interativa (Swagger / OpenAPI)**: Disponível diretamente no navegador ao rodar a API em:
  👉 **`http://localhost:3000/docs`** (ou `http://IP_DA_SUA_VPS:3000/docs`)
- **Guia Completo em Markdown**: Disponível em [docs/API.md](docs/API.md) com exemplos de cURL, tabelas de parâmetros e payloads JSON detalhados.
- **Especificação OpenAPI 3.0 (JSON)**: Disponível em [docs/openapi.json](docs/openapi.json) ou no endpoint `GET /docs/openapi.json` para importar diretamente no Postman, Insomnia ou Swagger Editor.

---

## 🚀 Principais Recursos

- **Execução Otimizada em Bun**: Inicialização instantânea e baixíssimo consumo de memória RAM (~20-40 MB).
- **Segurança de Nível Corporativo via Docker Secrets**:
  - O certificado `.pfx` não é exposto em variáveis de ambiente nem no `docker inspect`. Ele é injetado diretamente em memória RAM temporária (`/run/secrets/cert_pfx`).
  - A pasta `certs/` é **100% ignorada pelo Git** no `.gitignore`.
- **Autenticação por API Token de Alta Entropia**:
  - Proteção de todos os endpoints via `API_TOKEN` no cabeçalho `Authorization: Bearer <TOKEN>` ou `x-api-key: <TOKEN>`.
- **Proteção por Rate Limiting & Throttling (Anti-Bloqueio Governamental)**:
  - **Inbound Rate Limiting**: Protege sua VPS contra flooding e ataques de força bruta.
  - **Outbound ADN Throttling**: Aplica intervalo controlado (`ADN_REQUEST_DELAY_MS=500`) entre chamadas sequenciais ao ADN, impedindo que o firewall/WAF da Receita Federal bloqueie o IP do seu servidor.
- **Fila de Sincronização Assíncrona & Mutex Lock por CNPJ**:
  - `POST /api/sync` responde imediatamente `202 Accepted` com `jobId` e executa em segundo plano.
  - **Mutex Lock**: Impede sincronizações simultâneas para o mesmo CNPJ, evitando processamento redundante do mesmo NSU.
  - Histórico persistente de execuções com endpoints para consulta de status.
- **Flexibilidade de Banco de Dados (`DB_CLIENT=postgres` ou `DB_CLIENT=sqlite`)**:
  - **PostgreSQL**:
    - **Consultas Otimizadas sem N+1**: Utiliza `json_agg` e `json_build_object` para trazer em uma única query indexada a nota com todos os seus eventos e XMLs aninhados.
    - **Índices Compostos**: Cobertura otimizada para prestador, tomador, datas e status.
  - **SQLite (`bun:sqlite`)**:
    - SQLite nativo do Bun com modo WAL (Write-Ahead Logging), sem dependência de serviços externos.
- **Descompactação Automática Gzip + Base64**:
  - Trata o formato de compactação do ADN (`GZip + Base64`), gravando os XMLs originais descompactados em UTF-8.
- **Download Flexível de XMLs**:
  - `findAllByCnpj`: lista notas com metadados, eventos vinculados e links dos XMLs.
  - Download de XML individual da NFS-e ou de evento.
  - Download de pacote `.zip` de uma nota com seus eventos.
  - Download de pacote `.zip` completo de todas as notas e eventos de um CNPJ.

---

## 🔒 Configuração do Certificado Digital (Criação Manual na VPS)

Por segurança absoluta, **a pasta `certs/` é ignorada pelo Git**. Ela deve ser criada **manualmente na VPS**:

1. **Na VPS, crie a pasta e copie o seu certificado:**
   ```bash
   mkdir -p certs
   # Copie seu arquivo .pfx para dentro da pasta com o nome 'certificado.pfx'
   chmod 600 certs/certificado.pfx
   ```
2. **Defina no `.env` a senha do certificado:**
   ```env
   CERT_PASSWORD=senha_do_seu_certificado_a1
   ```
3. O Docker Compose monta o certificado automaticamente em memória RAM (`/run/secrets/cert_pfx`), blindando-o contra vazamentos em logs ou inspeção de containers.

> 💡 **Alternativa PaaS (Easypanel / Render / Railway):**  
> Se preferir não usar arquivos físicos, você pode converter o certificado para Base64 e colar diretamente na variável `CERT_BASE64` no `.env`. A API detecta e prioriza automaticamente.

---

## 🔑 Autenticação (Geração e Uso do API_TOKEN)

O token da API deve ser uma chave aleatória de alta entropia (recomendado: 32 bytes / 64 caracteres hexadecimais).

### Como gerar a chave em diferentes sistemas:

- **Linux / macOS (via OpenSSL):**
  ```bash
  openssl rand -hex 32
  ```
- **Windows (PowerShell):**
  ```powershell
  [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
  ```
- **Qualquer ambiente com Bun ou Node.js:**
  ```bash
  bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### Configurar no `.env`:
```env
API_TOKEN=coloque_a_chave_gerada_acima_aqui
```

### Como consumir a API:
Envie a chave gerada através de um dos cabeçalhos:

```bash
# Opção 1: Bearer Token
curl -H "Authorization: Bearer SUA_CHAVE_AQUI" http://seu-ip:3000/api/notas?cnpj=12345678000195

# Opção 2: Header x-api-key
curl -H "x-api-key: SUA_CHAVE_AQUI" http://seu-ip:3000/api/notas?cnpj=12345678000195
```

*(Rotas públicas sem autenticação: `GET /`, `GET /health` e `GET /docs`)*

---

## 🛡️ Rate Limiting e Throttling

| Configuração | Padrão | Descrição |
| :--- | :--- | :--- |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 min) | Janela de contagem de requisições à API |
| `RATE_LIMIT_MAX` | `100` | Máximo de requisições por IP permitidas na janela |
| `ADN_REQUEST_DELAY_MS` | `500` (ms) | Atraso intencional entre lotes ao ADN para evitar WAF/bloqueio de IP pela Receita |
| `ADN_MAX_RETRIES` | `3` | Tentativas de repetição em caso de instabilidade |

---

## 🐳 Execução via Docker e Docker Compose

O projeto conta com **Dockerfile multi-stage** ultra-otimizado (`oven/bun:alpine`, usuário não-root `bun`, healthcheck integrado).

### Opção 1: Stack com PostgreSQL (Recomendada para Produção)
Sobe a API e um banco PostgreSQL 17 ajustado:

```bash
# 1. Certifique-se de que a pasta certs foi criada com o seu certificado:
mkdir -p certs
cp /caminho/do/seu_cert.pfx certs/certificado.pfx

# 2. Subir a stack:
docker compose -f docker-compose.postgres.yml up -d
```
*(ou simplesmente `docker compose up -d`)*

### Opção 2: Standalone com SQLite (Máxima Leveza)
Sobe apenas a API com volume local persistente:

```bash
docker compose -f docker-compose.sqlite.yml up -d
```

---

## 💻 Execução Local (sem Docker)

```bash
# 1. Instalar dependências
bun install

# 2. Configurar o .env
cp .env.example .env

# 3. Rodar
bun run dev    # Desenvolvimento com hot-reload
bun run start  # Produção
```

---

## 📡 Resumo Rápido dos Endpoints

> Para a documentação completa com esquemas JSON e exemplos de resposta, acesse [docs/API.md](docs/API.md) ou a rota interativa `/docs`.

- `POST /api/sync`: Dispara a sincronização de NSUs em segundo plano (responde `202 Accepted`).
- `GET /api/sync/jobs/:id`: Consulta o status e andamento de um Job.
- `GET /api/sync/jobs?cnpj={cnpj}`: Lista histórico de jobs de sincronização.
- `GET /api/sync/:cnpj`: Consulta o último NSU sincronizado para um CNPJ.
- `GET /api/notas?cnpj={cnpj}`: Lista notas fiscais de um CNPJ com eventos e XMLs (`findAllByCnpj`).
- `GET /api/notas/:chaveAcesso`: Detalhes de uma nota fiscal por chave de acesso.
- `GET /api/notas/:chaveAcesso/xml`: Download direto do XML da NFS-e.
- `GET /api/notas/:chaveAcesso/zip`: Download do pacote ZIP da nota com eventos.
- `GET /api/notas/cnpj/:cnpj/zip`: Download do pacote ZIP completo do CNPJ.
- `GET /api/notas/documento/:id/xml`: Download de um XML individual por ID.
