# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# 默认端口（云端会注入 PORT 覆盖）
ENV PORT=8080

# 使用 nginx 官方的 envsubst 模板机制
COPY default.conf.template /etc/nginx/templates/default.conf.template

# 你的静态站点文件（index.html 等在仓库根目录）
COPY . /usr/share/nginx/html

EXPOSE 8080
