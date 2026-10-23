# Stage 1: Prepare frontend files
FROM alpine:3.22 AS builder

WORKDIR /app

COPY public/ ./public/
COPY nginx/default.conf.template ./nginx/default.conf.template

# Stage 2: Nginx web server
FROM nginx:alpine AS production

COPY --from=builder /app/public/ /usr/share/nginx/html/
COPY --from=builder /app/nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
