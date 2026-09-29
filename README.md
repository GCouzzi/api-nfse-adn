# 🏛️ API NFS-e Nacional - ADN Contribuinte

API de alta performance em **Express.js** desenvolvida para rodar com o runtime **Bun**, integrando-se diretamente ao **Ambiente de Dados Nacional (ADN)** da NFS-e Nacional via **Procuração Eletrônica (Padrão 1)** com autenticação mútua **mTLS (Certificado Digital ICP-Brasil A1)**.

Projetada para implantação simplificada e segura em **VPSs / servidores dedicados**, com **Docker Secrets** para proteção de certificados, **API Token** configurável, **Rate Limiting** de entrada e saída, **Fila Assíncrona com Mutex Lock por CNPJ** e suporte a **PostgreSQL** e **SQLite**.

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

*(Rotas públicas sem autenticação: `GET /` e `GET /health`)*

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

## 📡 Endpoints da API

### 1. Sincronizar Documentos por NSU (Assíncrono com Mutex Lock)
Dispara a sincronização em segundo plano. Responde `202 Accepted` imediatamente com o identificador do Job.

- **Rota**: `POST /api/sync`
- **Headers**: `Authorization: Bearer <API_TOKEN>`
- **Body**:
```json
{
  "cnpj": "12345678000195",
  "nsuInicial": 0,
  "maxLoops": 10
}
```
- **Resposta (202 Accepted)**:
```json
{
  "success": true,
  "message": "Sincronização enfileirada com sucesso em segundo plano.",
  "data": {
    "id": 1,
    "cnpj": "12345678000195",
    "status": "QUEUED",
    "created_at": "2026-09-29T13:00:00.000Z"
  }
}
```
*(Se já houver uma sincronização em execução para este CNPJ, a API retorna `409 Conflict` informando o Job ativo).*

> **Nota:** Caso queira aguardar a sincronização de forma síncrona em scripts, envie `"async": false` no corpo da requisição ou `POST /api/sync?sync=true`.

---

### 2. Consultar Andamento de um Job de Sincronização
- **Rota**: `GET /api/sync/jobs/:id`
- **Resposta**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "cnpj": "12345678000195",
    "status": "COMPLETED",
    "nsu_inicial": 0,
    "nsu_final": 10,
    "novos_documentos": 10,
    "total_notas": 9,
    "total_eventos": 1,
    "ciclos_executados": 10,
    "finished_at": "2026-09-29T13:00:05.000Z"
  }
}
```

---

### 3. Listar Histórico de Jobs
- **Rota**: `GET /api/sync/jobs?cnpj={cnpj}&limit=20`

---

### 4. Consultar Status do NSU do CNPJ
- **Rota**: `GET /api/sync/:cnpj`

---

### 5. Listar Notas Fiscais por CNPJ (`findAllByCnpj`)
Retorna todas as notas fiscais do CNPJ acompanhadas de todos os seus eventos fiscais (cancelamentos, confirmações) e metadados dos XMLs em uma única resposta JSON otimizada.

- **Rota**: `GET /api/notas?cnpj={cnpj}`
- **Query Params**:
  - `cnpj` (obrigatório)
  - `status` (opcional): `AUTORIZADA`, `CANCELADA`, etc.
  - `papel` (opcional): `todos` (padrão), `prestador`, `tomador`
  - `limit` e `offset`: paginação
- **Resposta**:
```json
{
  "success": true,
  "total": 1,
  "data": [
    {
      "id": 1,
      "chave_acesso": "43260912345678000195550010000000011234567890",
      "nsu": 1,
      "cnpj_prestador": "12345678000195",
      "cnpj_tomador": "98765432000188",
      "razao_social_prestador": "EMPRESA PRESTADORA LTDA",
      "razao_social_tomador": "TOMADOR DOS SERVICOS S.A.",
      "numero_nfse": "100",
      "serie": "1",
      "valor_servicos": 1500.0,
      "valor_liquido": 1450.0,
      "status": "AUTORIZADA",
      "eventos": [
        {
          "id": 1,
          "tipo_evento": "CONFIRMACAO_TOMADOR",
          "descricao_evento": "Confirmação da Prestação do Serviço pelo Tomador",
          "data_hora_evento": "2026-09-29T12:00:00Z"
        }
      ],
      "documentos": [
        {
          "id": 1,
          "tipo_documento": "NFSE",
          "data_hora_geracao": "2026-09-29T12:00:00Z"
        },
        {
          "id": 2,
          "tipo_documento": "EVENTO",
          "tipo_evento": "CONFIRMACAO_TOMADOR"
        }
      ]
    }
  ]
}
```

---

### 6. Downloads de XML e ZIP
- **Download XML da NFS-e**: `GET /api/notas/:chaveAcesso/xml`
- **Download ZIP da Nota + Eventos**: `GET /api/notas/:chaveAcesso/zip`
- **Download ZIP de todas as Notas e Eventos do CNPJ**: `GET /api/notas/cnpj/:cnpj/zip`
- **Download Documento por ID**: `GET /api/notas/documento/:id/xml`
