# Application compilée (npm run build) servie par nginx, qui sert aussi d'entrée à l'API Supabase.
# Construit depuis la racine du dépôt (voir docker-compose.yml).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_SUPABASE_URL=same-origin
ARG VITE_SUPABASE_ANON_KEY=
# Version affichée par l'app (État du système) : celle de package.json, sauf si APP_VERSION est donnée.
ARG APP_VERSION=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Pas de .env du dépôt dans l'image : seules les valeurs ci-dessus comptent.
RUN rm -f .env .env.local && npm run build \
 && printf '{"version":"%s","built_at":"%s"}\n' "${APP_VERSION:-$(node -p "require('./package.json').version")}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/version.json

FROM nginx:1.29-alpine
COPY serveur-local/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
