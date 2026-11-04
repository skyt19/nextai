# Build Stage
FROM node:22-alpine AS builder

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Install build dependencies
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src/

RUN npm run build

# Production Stage
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000

COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only
RUN npm ci --only=production
RUN npx prisma generate

# Copy compiled files from builder
COPY --from=builder /app/dist ./dist

# Create storage directory for slips
RUN mkdir -p storage/slips

EXPOSE 10000

CMD ["npm", "start"]
