---
name: appstoreprice-hub
description: >-
  查询 App Store 全球各地区应用价格的技能，通过 appstoreprice.org 获取数据。
  使用 Minis 内置浏览器（minis-browser-use CLI）在页面上下文中直接调用网站原生签名函数，
  无需 API Key、无需自行实现签名算法。支持：按名称搜索应用、查询单个 App 所有地区价格、
  获取最便宜地区排行、分页浏览应用列表。
  当用户提到"App Store 价格"、"哪个区最便宜"、"土耳其区价格"、"appstoreprice"、
  "app 比价"、"App Store 低价区"、"订阅哪个区划算"，或任何需要查询 iOS/macOS App
  跨地区价格对比的场景，必须触发本技能。
---

# appstoreprice-hub

查询 [appstoreprice.org](https://appstoreprice.org) 的 App Store 全球价格数据。

> **数据来源**：[appstoreprice.org](https://appstoreprice.org)，由 [@qingnianxiaozhe](https://x.com/qingnianxiaozhe) 维护的非官方比价网站，实时抓取并对比全球各地区 App Store 价格。非 Apple 官方数据，价格每日更新。

## 原理

网站为 Next.js App Router，通过两种方式访问数据：

1. **REST API**（搜索/列表）：需要 FNV-1a 签名头 `X-Timestamp` + `X-Signature`
2. **RSC 页面流**（价格详情）：`fetch(url, { headers: { RSC: '1' } })` 直接解析

签名函数已内嵌在页面 webpack module 52661 中，直接在网站页面上下文里复用，无需自行实现。

## 执行方式：minis-browser-use CLI

**始终使用 `minis-browser-use` CLI + shell 脚本执行**，不要用 `browser_use` tool call。

好处：JS 代码从文件读取直接传给进程，不会占用 agent 上下文。

### 标准模板

```bash
# Step 1：导航到 /apps（webpack chunk 8699 仅在此页加载，每次会话执行一次）
minis-browser-use navigate --url "https://appstoreprice.org/zh/apps"
minis-browser-use wait_for_dom_stable --timeout 8

# Step 2：拼接 api.js + 业务逻辑，一次性执行
SCRIPT=$(cat /var/minis/skills/appstoreprice-hub/scripts/api.js; cat << 'LOGIC'

// --- 业务逻辑 ---
const asp = AppStorePriceAPI();
const result = await asp.search('Notion');
return result.apps.map(a => ({ name: a.name, id: a.appStoreId }));
LOGIC
)
minis-browser-use execute_js --script "$SCRIPT"
```

> `cat api.js; cat << 'LOGIC' ... LOGIC` 是标准拼接方式，api.js 内容不进入 agent 上下文。

## API 速查

`AppStorePriceAPI()` 返回 `{ search, list, prices }`：

| 方法 | 参数 | 返回 |
|---|---|---|
| `search(query, page=1, limit=20)` | 关键词 | `{ apps, hasMore, total }` |
| `list(page=1, limit=20)` | 页码/每页数 | `{ apps, hasMore, total }` |
| `prices(appStoreId, locale='zh')` | App Store ID | 价格数组，按 priceUsd 升序 |

`prices` 返回每条：`{ region, regionName, currency, price, priceUsd, priceCny }`

常用地区代码：`US` 美国、`TR` 土耳其、`NG` 尼日利亚、`PK` 巴基斯坦、`EG` 埃及、`AR` 阿根廷、`VN` 越南、`JP` 日本、`KR` 韩国、`CN` 中国、`HK` 香港

## 典型业务逻辑

### 最便宜 Top N

```js
const asp = AppStorePriceAPI();
const sr = await asp.search('ChatGPT');
const app = sr.apps[0];
const all = await asp.prices(app.appStoreId);
const topN = all.sort((a, b) => a.priceUsd - b.priceUsd).slice(0, 10);
const usPrice = all.find(p => p.region === 'US')?.priceUsd;
return { appName: app.name, topN: topN.map(p => ({
  ...p, saveVsUS: usPrice ? Math.round((1 - p.priceUsd / usPrice) * 100) + '%' : 'N/A'
}))};
```

### 指定地区价格

```js
const asp = AppStorePriceAPI();
const sr = await asp.search('Notion');
const all = await asp.prices(sr.apps[0].appStoreId);
return all.find(p => p.region === 'TR'); // 替换地区代码即可
```

## 结果展示规范

用 Markdown 表格展示，含：地区（国旗 emoji + 名称）、货币、原价、USD 等值、CNY 等值。
有对比场景时标注与美区折扣：`节省 = (1 - priceUsd / usPrice) * 100`。

## 故障排查

**签名模块未加载**：确认已 navigate 到 `/apps` 页面并 wait_for_dom_stable。

**HTTP 403 签名失败**：module ID 可能随版本更新变化，执行以下命令重新定位：
```bash
minis-browser-use execute_js --script "
self.webpackChunk_N_E.forEach(([,m]) => { if (!m) return;
  Object.keys(m).forEach(k => { try {
    const e = {}; m[k]({exports:e},e,{d:(t,d)=>{}});
    if (typeof e.Z5==='function') console.log('sig module:', k);
  } catch(e){} }); });
return 'check console';
"
```
找到新 ID 后更新 `scripts/api.js` 中的 `52661`。
