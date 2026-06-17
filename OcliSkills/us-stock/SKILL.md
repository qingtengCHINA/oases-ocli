---
name: us-stock
description: 美股实时行情查询。三大指数（道指/标普/纳指） + Magnificent 7（NVDA/AAPL/MSFT/GOOGL/AMZN/META/TSLA）+ VIX恐慌指数 + 0DTE Gamma状态分析。当用户说"美股"、"查美股"、"美国股市"、"七姐妹"、"Magnificent 7"、"VIX"、"恐慌指数"、"标普"、"纳指"、"道指"时触发。
version: 1.0.0
---

# 美股行情查询

## 数据源
Google Finance（browser_use navigate + get_text）——无需API，无需登录，返回结构化数据。

## 查询流程

### Step 0：设置桌面端视窗
```
browser_use set_viewport viewport_width: 1280 viewport_height: 800
```
Google Finance 区分桌面/移动版主要靠 viewport 宽度，设置足够宽的视窗即可拿到完整数据。此方法跨 Android/iOS 兼容，不受 UA 枚举值差异影响。

### Step 1：三大指数（并行，最多同时开3个tab）
先用默认 tab 0 打开标普：
```
browser_use navigate https://www.google.com/finance/quote/.INX:INDEXSP?hl=en
browser_use get_text
```
然后新建两个标签页分别打开道指和纳指：
```
browser_use new_tab
browser_use navigate https://www.google.com/finance/quote/.DJI:INDEXDJX?hl=en
browser_use get_text

browser_use new_tab
browser_use navigate https://www.google.com/finance/quote/.IXIC:INDEXNASDAQ?hl=en
browser_use get_text
```
每个tab用 `get_text` 提取。提取关键字段：当前价、涨跌点数、涨跌幅%、开盘/最高/最低、昨收。

### Step 2：VIX 恐慌指数（在已有某个tab上跳转，不用新开tab）
```
browser_use navigate https://www.google.com/finance/quote/VIX:INDEXCBOE?hl=en
browser_use get_text
```
关键字段：当前价、涨跌幅、昨收、52周高/低。
**VIX警戒阈值**：<15 麻痹 / 15-20 正常 / 20-25 警惕 / 25+ 恐慌。
核心判断：VIX绝对值 + 当天涨跌方向（Broadcom这种个股事件引起的VIX温和上涨 vs 系统性恐慌引起的VIX飙升）

### Step 3：Magnificent 7（利用已有的3个tab轮转读取，不新开tab）
**没有VIX专用的第4个tab了**——先在默认/最新tab跳转到NVDA，用get_text提取后，再在该tab上跳到下一只。

读取顺序：NVDA → AAPL → MSFT → GOOGL → AMZN → META → TSLA
每读完一只就 `navigate` 到下一只的URL，每次用 `get_text` 提取。
如需查AVGO或其他热门，放在TSLA之后。每只提取：价格、涨跌%、涨跌点数、昨收、日内高/低、市值。

### Step 4：0DTE Gamma状态（可选，用户要求或大盘波动异常时查）
**先关掉一个已经读完的tab腾出位置**（比如关掉VIX或最早读的指数tab），然后新开tab：
```
browser_use close_tab
browser_use new_tab
browser_use navigate https://www.google.com/search?q=SPX+gamma+exposure+today+dealer+position&hl=en
browser_use get_text
```
提取AI Overview中的Gamma状态摘要，重点看：
- **Gamma Flip level**：标普在哪个点位从正Gamma变负Gamma
- **当前SPX位置与Flip的差距**（比如现价7,583，Flip在7,550，差距33点=0.4%）
- **Dealer positioning**: positive gamma（稳定）还是 negative gamma（放大波动）

**GEX风险判断标准：**
| 状态 | 描述 | 风险 |
|:---|:---|:---:|
| Positive Gamma | 做市商跟趋势走，买跌卖涨 | 市场稳定，波动被抑制 |
| Near flip（0-1%） | 黄金切割线，临界的 | 一个意外就能触发Gamma挤压 |
| Negative Gamma | 做市商追涨杀跌 | 波动自我放大，回调容易变崩盘 |

### Step 5：合成输出
输出结构（简洁表格+文字解读）：

## 📊 美股实时行情

**时间**: YYYY-MM-DD HH:MM ET

### 三大指数
| 指数 | 价格 | 涨跌 | 昨收 | 日内 |
|:---|:---:|:---:|:---:|:---:|
| 道指 | xxx | +x.xx% | xxx | H:xxx L:xxx |
| 标普 | xxx | +x.xx% | xxx | H:xxx L:xxx |
| 纳指 | xxx | +x.xx% | xxx | H:xxx L:xxx |

### 恐慌指数
VIX: xx.xx (涨跌 x.xx%) — 判断状态（麻痹/正常/警惕/恐慌）

### Magnificent 7
| 股票 | 价格 | 涨跌 | 备注 |
|:---|---:|:---:|:---|
| NVDA | xxx | +x.xx% | 关键驱动因素 |
| ... | ... | ... | ... |

### Gamma状态（如有查询）
SPX现价xxx，Gamma Flip在xxx（差距x.xx%），当前为Positive/Near Flip/Negative Gamma。

### 解读
2-4句话说明：今天市场主线（轮动/crash/震荡）、核心驱动、值得注意的风险信号。

### Step 6：写入日志
`memory_write` 将今日美股行情（三大指数+VIX+七姐妹+解读）摘要记录

## 注意事项
- 美股交易时间：美东9:30-16:00（夏令时=北京时间21:30-次日4:00；冬令时=22:30-5:00）
- 盘前/盘后数据标记时间，注意与A股交易时间的对比
- Google Finance显示的是美东时间UTC-4（夏令时）或UTC-5（冬令时）
- 基金/ETF的净值滞后一天，查询时标注"上一交易日净值"
- VIX期货贴水（Backwardation）是系统性风险的最强预警信号，出现时推送该信号到记忆并提醒用户
