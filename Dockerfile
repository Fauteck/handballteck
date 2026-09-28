FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline --no-audit
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# fontconfig + DejaVu: sharp rastert SVGs mit Text, und node:22-alpine bringt
# keine einzige Schrift mit — ohne diese Pakete fehlen alle Beschriftungen,
# ohne Fehlermeldung. Barlow und Barlow Condensed (SIL Open Font License,
# assets/fonts/OFL.txt) sind die Schriften der Bilder und der Microsite;
# fehlen sie, fällt fontconfig auf DejaVu zurück.
RUN apk add --no-cache fontconfig font-dejavu
COPY assets/fonts /usr/share/fonts/truetype/barlow
RUN fc-cache -f
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /data && chown appuser:appgroup /data
ARG GIT_SHA=dev
ARG BUILT_AT=unbekannt
ENV GIT_SHA=$GIT_SHA
ENV BUILT_AT=$BUILT_AT
ENV DATA_DIR=/data
ENV PORT=3000
USER appuser
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
