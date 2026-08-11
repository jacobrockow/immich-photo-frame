FROM node:22-alpine AS build

WORKDIR /app
COPY package.json tsconfig.json vite.config.ts index.html ./
COPY src ./src

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN npm install
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
