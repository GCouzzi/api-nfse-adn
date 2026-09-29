# ==========================================
# Estágio 1: Instalação de dependências (Deps)
# ==========================================
FROM oven/bun:alpine AS deps
WORKDIR /app

# Copia manifestos de dependências aproveitando o cache de camadas do Docker
COPY package.json bun.lock* ./

# Instala apenas dependências de produção para manter a imagem leve
RUN bun install --production --frozen-lockfile || bun install --production

# ==========================================
# Estágio 2: Imagem final de execução (Runner)
# ==========================================
FROM oven/bun:alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Adiciona utilitário curl leve para o HEALTHCHECK do Docker
RUN apk add --no-cache curl

# Cria as pastas de persistência de dados e certificados
RUN mkdir -p /app/data /app/certs

# Copia as dependências instaladas do estágio anterior
COPY --from=deps /app/node_modules ./node_modules

# Copia o código-fonte da aplicação e configurações necessárias
COPY package.json tsconfig.json ./
COPY src ./src

# Garante que a aplicação execute com usuário não-privilegiado (segurança)
RUN chown -R bun:bun /app

# Troca para o usuário 'bun' nativo da imagem
USER bun

# Porta exposta pela API
EXPOSE 3000

# Verificação de saúde da aplicação
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Inicialização com Bun
ENTRYPOINT ["bun", "run", "src/server.ts"]
