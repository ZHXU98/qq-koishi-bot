# 基于官方 Koishi 镜像
FROM koishijs/koishi:latest

# 先用官方 entrypoint 逻辑解压 boilerplate
RUN unzip -n /boilerplate.zip -d /koishi && \
    sed -Ei 's/(([[:space:]]*)maxPort.*)/\1\n\2host: 0.0.0.0/' /koishi/koishi.yml || true

WORKDIR /koishi

# 复制我们的 package.json（含 scripts.start）
COPY package.json ./

# 删除旧 lockfile，用 yarn 重新安装所有依赖（含额外插件）
# --no-immutable 允许更新 lockfile
RUN rm -f yarn.lock && \
    yarn config set npmRegistryServer https://registry.npmmirror.com && \
    yarn install --no-immutable

# 复制我们自定义的 koishi.yml（覆盖 boilerplate 默认的）
COPY koishi.yml ./

# 使用官方 entrypoint（package.json 已存在，不会再覆盖）
# 使用官方 CMD: yarn start
