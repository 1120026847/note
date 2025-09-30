# 用 Nginx 托管静态文件
FROM nginx:alpine

# 可选：设置时区（日志更友好）
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# 替换默认站点配置（带 SPA 回退）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 把当前目录所有静态文件拷到 Nginx 的站点目录
COPY . /usr/share/nginx/html

# 暴露 80 端口
EXPOSE 80

# 健康检查（可选）
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# 启动 Nginx
CMD ["nginx", "-g", "daemon off;"]
