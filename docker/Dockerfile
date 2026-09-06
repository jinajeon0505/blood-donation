# syntax=docker/dockerfile:1

# 빌드 단계가 없는 Express 앱이다. 프런트엔드는 정적 파일이지만
# /admin.html 이 Express 의 Basic 인증을 거쳐야 하므로 Nginx 가 직접 서빙하지
# 않고 이미지에 함께 담는다. (총 244KB — 빌드 컨텍스트 부담 없음)

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# 이미지 레벨 HEALTHCHECK 은 두지 않는다. Compose 의 healthcheck 가
# 동일한 검사를 더 신뢰성 있게 수행하고, 중복 시 진단만 헷갈려진다.
CMD ["node", "server.js"]
