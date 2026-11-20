# 数据查询命令参考

## neodata-financial-search 查询示例

通过 `neodata-financial-search` skill 目录下的 `scripts/query.py --query "<自然语言查询>"` 调用。查询前需确保 token 已通过 `connect_cloud_service` 获取并保存；若输出 `TOKEN_EXPIRED` / `TOKEN_MISSING`，按其 SKILL.md「获取凭证」流程处理。

### 历史 K 线数据

```
上证指数从YYYY年M月D日到YYYY年M月D日的日K线数据（每日开盘价、最高价、最低价、收盘价、成交额），国证2000同区间日K线
上证指数周K线，从YYYY年M月D日到YYYY年M月D日，每周开盘收盘最高最低
```

### 全市场情绪数据

```
YYYY年M月D日A股全市场涨跌家数，成交额，涨停跌停家数
```

### 板块排名查询

```
YYYY年M月D日沪深板块涨幅榜，涨幅最大的行业板块
YYYY年M月D日沪深板块跌幅榜，跌幅最大的行业板块
```

## westock-data 查询示例

用于补充技术指标和结构化数据。

### K 线数据

```bash
westock-data kline sh000001 --period day --limit 20    # 上证日K线
westock-data kline sz399303 --period day --limit 20    # 国证2000日K线
westock-data kline sh000001 --period week --limit 12   # 上证周K线
```

### 技术指标

```bash
westock-data indicator sh000001                        # 上证技术指标（MA/MACD/KDJ/布林带等）
```

## 关键指数代码速查

| 指数 | 代码 | 市场 |
|------|------|------|
| 上证指数 | 000001.SH / sh000001 | 上海 |
| 国证2000 | 399303.SZ / sz399303 | 深圳 |
