# syntax=docker/dockerfile:1

FROM nginx:1.27-alpine

# 默认端口给 8080（平台会注入 PORT 时覆盖）
ENV PORT=8080

# 用 templates 目录 + *.conf.template 让 entrypoint 自动 envsubst
# 会把 ${PORT} 等环境变量替换成具体值，生成 /etc/nginx/conf.d/default.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template

# 站点静态文件
COPY . /usr/share/nginx/html

# 本地调试时暴露 8080；线上平台会用 PORT
EXPOSE 8080

# 无需 CMD，基础镜像会以前台方式启动 nginx
