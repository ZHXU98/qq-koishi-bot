# QQ 机器人（Koishi + NapCatQQ）

基于 **Koishi.js** 框架 + **NapCatQQ** 协议端，支持 RSS 订阅推送与权限控制，全程 Docker 部署。

## 目录结构

```
qq-bot/
├── docker-compose.yml          # 容器编排
├── .env                        # 配置（QQ 账号，勿提交 Git）
├── .gitignore
├── koishi/
│   ├── Dockerfile              # 自定义镜像（预装插件）
│   ├── package.json            # 插件依赖声明
│   ├── koishi.yml              # Koishi 主配置文件
│   ├── data/                   # 数据库、缓存（本地持久化）
│   └── assets/                 # 图片、附件等静态资源
└── napcat/
    ├── config/
    │   └── onebot11.json       # NapCat OneBot 协议配置
    └── QQ/                     # QQ 登录态（勿提交 Git）
```

> **所有运行数据均挂载到本地目录**，方便备份、迁移与独立存储。
> `koishi/assets/` 可用于存放机器人发送/缓存的图片等文件。

---

## 快速开始

### 第一步：配置必填项

**1. 填写 QQ 账号**

编辑 `.env`：
```env
QQ_ACCOUNT=你的QQ号
```

**2. 设置机器人主人 QQ 号**

编辑 `koishi/koishi.yml`，找到末尾的 `superusers`：
```yaml
superusers:
  - "你的QQ号"   # ← 改为你的 QQ 号（加引号，字符串格式）
```

---

### 第二步：构建镜像

首次部署或修改了 `package.json`（插件依赖）后，需要重新构建：

```bash
cd qq-bot
docker compose build koishi
```

> 构建时会自动安装 `package.json` 中声明的所有插件，使用淘宝镜像源加速。

---

### 第三步：启动服务

```bash
docker compose up -d
```

---

### 第四步：QQ 登录（首次）

访问 NapCatQQ Web 管理页，扫码登录 QQ：

```
http://localhost:6099
```

> 登录态会保存在 `./napcat/QQ/` 目录，重启容器后**无需重复扫码**。

---

### 第五步：访问 Koishi 控制台

```
http://localhost:5140
```

首次访问会提示设置控制台登录密码（已启用 `auth` 插件）。

---

## 配置说明

### `.env` — 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `QQ_ACCOUNT` | ✅ | 机器人 QQ 号 |

### `koishi/koishi.yml` — 主配置

| 配置项 | 说明 |
|--------|------|
| `superusers` | 机器人主人的 QQ 号列表（最高权限） |
| `plugins.onebot.selfId` | 机器人 QQ 号（从 `.env` 读取） |
| `plugins."koishi-plugin-rss".refreshInterval` | RSS 刷新间隔（毫秒，默认 300000 = 5分钟） |

---

## 权限系统

Koishi 内置 6 级权限（`authority`）：

| 等级 | 说明 |
|------|------|
| 0 | 黑名单（被封禁） |
| 1 | 普通用户（默认） |
| 2 | 高级用户 |
| 3 | 管理员 |
| 4 | 超级管理员 |
| 5 | 机器人主人（superusers，最高权限） |

**聊天命令设置权限**（需要自己拥有更高等级）：
```
authorize @用户 2    # 提升为高级用户
ban @用户            # 封禁用户（authority → 0）
```

也可以在 Web 控制台 → 「用户管理」页面图形化操作。

---

## RSS 订阅使用

机器人命令（在 QQ 群或私聊中发送）：

```
rss.add <URL>       添加 RSS 订阅（推送到当前会话）
rss.remove <URL>    取消订阅
rss.list            查看当前会话的订阅列表
rss.check           立即检查一次更新
```

> RSS 插件使用 `koishi-plugin-rss`，订阅数据存储在 `koishi/data/database.db`。

---

## 订阅同花顺财经资讯

同花顺没有原生 RSS，需要通过内置的 **RSSHub**（`http://rsshub:1200`）转换。

### 可用订阅源（复制命令直接发给机器人）

```
# 同花顺 - 财经直播（全市场资讯，更新最频繁，推荐）
rss.add http://rsshub:1200/10jqka/realtimenews

# 同花顺 - A股快讯
rss.add http://rsshub:1200/10jqka/realtimenews/a

# 同花顺 - 港股快讯
rss.add http://rsshub:1200/10jqka/realtimenews/hk

# 同花顺 - 美股快讯
rss.add http://rsshub:1200/10jqka/realtimenews/us

# 同花顺 - 期货快讯
rss.add http://rsshub:1200/10jqka/realtimenews/qh
```

> **注意**：RSSHub 路由使用内网地址 `rsshub:1200`（容器间通信），不是 `localhost:1200`。

### 推荐的财经 RSS 组合

```
# 同花顺财经直播（高频推送，每天数十条）
rss.add http://rsshub:1200/10jqka/realtimenews

# 东方财富 - 财经头条
rss.add http://rsshub:1200/eastmoney/news/kuaixun

# 雪球 - 市场动态
rss.add http://rsshub:1200/xueqiu/hot_stock_news

# 新浪财经 - 头条
rss.add https://feed.sina.com.cn/news/finance/mix.xml
```

### 关于 RSSHub

本方案已内置自托管 RSSHub 服务（`http://localhost:1200`），可以将各大平台转换为 RSS。

完整路由文档：https://docs.rsshub.app/zh/

---

## 数据备份

所有数据均在本地目录，备份时只需打包以下内容：

| 目录 | 内容 | 重要性 |
|------|------|--------|
| `napcat/QQ/` | QQ 登录态 | ⭐⭐⭐ 丢失需重新扫码 |
| `koishi/data/` | 数据库（RSS订阅、用户权限等） | ⭐⭐⭐ 丢失会丢失所有订阅配置 |
| `koishi/assets/` | 图片、附件等资源文件 | ⭐⭐ 按需备份 |
| `koishi/koishi.yml` | 配置文件 | ⭐⭐⭐ 纳入 Git 管理 |

```bash
# 备份示例
tar -czf qq-bot-backup-$(date +%Y%m%d).tar.gz \
  napcat/QQ/ \
  koishi/data/ \
  koishi/assets/ \
  koishi/koishi.yml \
  .env
```

---

## 常用运维命令

```bash
# 查看实时日志
docker compose logs -f koishi
docker compose logs -f napcat

# 重启单个服务
docker compose restart koishi

# 停止所有服务
docker compose down

# 重新构建镜像（修改插件后执行）
docker compose build koishi
docker compose up -d koishi

# 更新基础镜像（升级 Koishi 版本）
docker compose build --no-cache koishi
docker compose up -d
```

---

## 注意事项

1. **QQ 封号风险**：建议使用小号，不要用主号
2. **登录态保密**：`napcat/QQ/` 目录包含 QQ session，不要上传到公开 Git 仓库
3. **RSS 频率**：默认 5 分钟刷新一次，不要设太短，避免 IP 被 RSS 源封禁
4. **控制台安全**：已开启登录验证，请设置强密码；如部署在公网需配置防火墙
