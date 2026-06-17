/**
 * AppStorePriceAPI — appstoreprice.org 浏览器内 API 工具
 *
 * 必须在 https://appstoreprice.org/zh/apps 页面上下文中执行（webpack chunk 8699 需已加载）。
 * 使用方式：将此文件内容与查询逻辑一起传入 browser_use execute_js。
 *
 * 返回对象：{ search, list, prices }
 */
function AppStorePriceAPI() {
  function _getSignFn() {
    const chunks = self.webpackChunk_N_E;
    if (!chunks) throw new Error('webpackChunk_N_E not found');
    let factory = null;
    for (const chunk of chunks) {
      const [, modules] = chunk;
      if (modules?.[52661]) { factory = modules[52661]; break; }
    }
    if (!factory) throw new Error('签名模块 52661 未加载，请先访问 /apps 页面');
    const exp = {};
    factory({ exports: exp }, exp, {
      d: (t, defs) => {
        for (const k in defs)
          Object.defineProperty(t, k, { get: defs[k], enumerable: true });
      }
    });
    if (typeof exp.Z5 !== 'function') throw new Error('Z5 签名函数未找到');
    return exp.Z5; // Z5(path) => { 'X-Timestamp': '...', 'X-Signature': '...' }
  }

  const _sign = _getSignFn();

  async function _signedGet(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await fetch(`https://appstoreprice.org${path}?${qs}`, { headers: _sign(path) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  /**
   * 搜索应用
   * @returns {{ apps: Array<{appStoreId, name, developer, iconUrl, category}>, hasMore, total }}
   */
  async function search(query, page = 1, limit = 20) {
    return _signedGet('/api/apps/search', { q: query, page, limit });
  }

  /**
   * 分页获取应用列表
   * @returns {{ apps: Array, hasMore, total }}
   */
  async function list(page = 1, limit = 20) {
    return _signedGet('/api/apps/paginated', { page, limit });
  }

  /**
   * 获取指定 App 所有地区价格，按 priceUsd 升序
   * @returns {Array<{region, regionName, currency, price, priceUsd, priceCny}>}
   */
  async function prices(appStoreId, locale = 'zh') {
    const resp = await fetch(`https://appstoreprice.org/${locale}/apps/${appStoreId}`, {
      headers: { 'RSC': '1' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const m = text.match(/"prices":(\[[\s\S]*?\])/);
    return m ? JSON.parse(m[1]) : [];
  }

  return { search, list, prices };
}
