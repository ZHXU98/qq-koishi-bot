# 基于官方 Koishi 镜像
FROM koishijs/koishi:latest

# 设置工作目录（Koishi 官方镜像的工作目录）
WORKDIR /koishi

# 先复制 package.json，利用 Docker 层缓存
# 只有 package.json 改变时才重新 npm install
COPY package.json ./

# 预装所有插件
RUN npm install --registry=https://registry.npmmirror.com

# koishi.yml 通过 volume 挂载，不 COPY 进镜像（方便热修改）
