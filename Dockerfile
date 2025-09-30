# syntax=docker/dockerfile:1

# 运行期镜像：Nginx 轻量版
FROM nginx:1.27-alpine

# 暴露本地缺省端口（平台会注入 PORT；本地测试默认 8080）
EXPOSE 8080

# 替换默认站点配置；监听 ${PORT:-8080} 并做 SPA 回退
RUN rm -f /etc/nginx/conf.d/default.conf \
 && printf 'server {\n\
  listen ${PORT:-8080};\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  # 前端资源缓存\n\
  location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {\n\
    expires 7d;\n\
    access_log off;\n\
  }\n\
  # SPA 路由回退到 index.html\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/site.conf

# 将仓库根目录下的静态文件拷贝进镜像
# （确保 Docker 构建上下文包含 index.html、静态资源等）
COPY . /usr/share/nginx/html
