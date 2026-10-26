const REQUIRED_COLUMNS = ['platform', 'item_id', 'observed_at', 'title', 'price', 'sales_total'];
const ALL_COLUMNS = [...REQUIRED_COLUMNS, 'sales_exact',
  'seller_region', 'ship_region', 'made_region', 'item_region', 'image_url', 'product_url'];

// 拼多多商品搜索只给累计已售件数，所有指标都从累计值的跨日期差分推出。
const MIN_TREND_SNAPSHOTS = 3;
const MIN_TREND_SPAN = 7;   // 累计值差分成每日新增后，7 天足以比较前后两段速度
const MAX_TREND_HALF = 14;  // 只比较最近 14 天与之前 14 天，历史再长也不拿半年前的数据当「近期」
const ROLLING_WINDOW = 30;
const ROLLING_TOLERANCE = 3;
// 档位上移只给方向、不给幅度，所以最多只能贡献一半趋势分。
const BUCKET_TREND_WEIGHT = 0.5;

const garmentTerms = ['改良袄裙', '袄裙', '短袄', '马面裙', '褙子', '齐胸襦裙', '圆领袍', '交领衫'];
const colorTerms = ['黛青', '米白', '浅青', '月白', '藕粉', '墨绿', '绛红', '黑色', '白色', '粉色'];
const motifTerms = ['牡丹', '云纹', '花鸟', '竹纹', '梅花', '暗纹', '纯色'];
const fabricTerms = ['棉麻', '提花', '织锦', '雪纺', '绒', '真丝'];

function parseCsv(input) {
  const text = input.replace(/^﻿/, '');
  const lines = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) lines.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(field);
  if (row.some(v => v.trim() !== '')) lines.push(row);
  if (!lines.length) throw new Error('CSV 文件为空');
  const headers = lines.shift().map(x => x.trim());
  const missing = REQUIRED_COLUMNS.filter(x => !headers.includes(x));
  if (missing.length) throw new Error(`缺少字段：${missing.join(', ')}`);
  return lines.map((cells, index) => {
    const raw = Object.fromEntries(headers.map((key, i) => [key, (cells[i] ?? '').trim()]));
    const platform = ({'拼多多':'pinduoduo', 'pdd':'pinduoduo'})[raw.platform] || raw.platform.toLowerCase();
    if (platform !== 'pinduoduo') throw new Error(`第 ${index + 2} 行平台应为 pinduoduo`);
    const date = new Date(`${raw.observed_at}T00:00:00Z`);
    if (!raw.item_id || !raw.title || !/^\d{4}-\d{2}-\d{2}$/.test(raw.observed_at) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== raw.observed_at) throw new Error(`第 ${index + 2} 行商品 ID、标题或日期无效`);
    const price = Number(raw.price);
    if (raw.price === '' || !Number.isFinite(price) || price < 0) throw new Error(`第 ${index + 2} 行价格无效`);
    const salesTotal = Number(raw.sales_total);
    if (raw.sales_total === '' || !Number.isInteger(salesTotal) || salesTotal < 0) throw new Error(`第 ${index + 2} 行累计销量无效`);
    return {
      platform, item_id: raw.item_id, observed_at: raw.observed_at, title: raw.title,
      price, sales_total: salesTotal,
      sales_exact: ['0', 'false', '否'].includes((raw.sales_exact ?? '').toLowerCase()) ? 0 : 1,
      seller_region: raw.seller_region || '',
      ship_region: raw.ship_region || '', made_region: raw.made_region || '', item_region: raw.item_region || '',
      image_url: raw.image_url || '', product_url: raw.product_url || ''
    };
  });
}

function toCsv(rows) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [ALL_COLUMNS.join(','), ...rows.map(row => ALL_COLUMNS.map(col => escape(row[col])).join(','))].join('\r\n');
}

function mergeRows(existing, incoming) {
  const map = new Map();
  for (const row of [...existing, ...incoming]) map.set(`${row.platform}|${row.item_id}|${row.observed_at}`, row);
  return [...map.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
function term(title, choices) { return choices.find(x => title.includes(x)) || ''; }
function styleOf(title) {
  return { garment: term(title, garmentTerms) || '其他汉服', color: term(title, colorTerms), motif: term(title, motifTerms), fabric: term(title, fabricTerms) };
}
function daysBetween(a, b) { return (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000; }
function percentile(values, value) {
  if (values.length <= 1) return .5;
  return values.filter(x => x < value).length / (values.length - 1);
}

// 真·近 30 天销量：拿最新快照减去约 30 天前的快照。这是观测窗口内的实际成交件数，
// 不是平台给的滚动值，所以只在确实存在 30±3 天前的快照时才输出。
function rollingWindow(history, latest) {
  let best = null, bestGap = Infinity;
  for (const row of history) {
    const days = daysBetween(row.observed_at, latest.observed_at);
    const gap = Math.abs(days - ROLLING_WINDOW);
    if (gap <= ROLLING_TOLERANCE && gap < bestGap) { bestGap = gap; best = row; }
  }
  if (!best) return null;
  const days = daysBetween(best.observed_at, latest.observed_at);
  const sold = latest.sales_total - best.sales_total;
  if (sold < 0) return null;
  return { sold, days, sales30: sold / days * ROLLING_WINDOW, exact: best.sales_exact !== 0 && latest.sales_exact !== 0 };
}

// Theil–Sen 斜率：所有点对斜率的中位数。单日的接口延迟或回跳只影响少数点对，不会带偏结果。
function robustSlope(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (points[j].t > points[i].t) slopes.push((points[j].y - points[i].y) / (points[j].t - points[i].t));
  return slopes.length ? median(slopes) : null;
}

// 把累计值差分成每日新增，再用最近一段的速度比前一段的速度。
// 两段各取最多 14 天；每段至少 3 次观察时用稳健斜率，否则退回取窗口起点、分割点、终点三个快照。
// 分档值（如「1万+」）未跳档时差分为 0，那是观察不到变化，按未知处理而不是 0% 增长。
function velocityTrend(history, span) {
  const none = { growth: null, approx: false };
  if (history.length < MIN_TREND_SNAPSHOTS || span < MIN_TREND_SPAN) return none;
  const first = history[0];
  const half = Math.min(span / 2, MAX_TREND_HALF), split = span - half, from = span - 2 * half;
  const points = history.map(row => ({ t: daysBetween(first.observed_at, row.observed_at), y: row.sales_total, exact: row.sales_exact !== 0 }));
  // 窗口左侧保留一个锚点：最后一个不晚于窗口起点的快照。
  let anchor = 0;
  points.forEach((p, i) => { if (p.t <= from) anchor = i; });
  const inWindow = points.slice(anchor);
  let early = inWindow.filter(p => p.t < split), late = inWindow.filter(p => p.t >= split);
  if (early.length < 3 || late.length < 3) {
    const nearest = target => inWindow.reduce((a, b) => Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a);
    const a = nearest(from), m = nearest(split), z = inWindow.at(-1);
    if (!(a.t < m.t && m.t < z.t)) return none;
    early = [a, m]; late = [m, z];
  }
  const vEarly = robustSlope(early), vLate = robustSlope(late);
  if (vEarly === null || vLate === null) return none;
  const exact = [...early, ...late].every(p => p.exact);
  if (vEarly < 0 || vLate < 0) return none;
  if (!exact && (vEarly === 0 || vLate === 0)) return { growth: null, approx: true };
  if (vEarly === 0) return { growth: null, approx: !exact };
  return { growth: vLate / vEarly - 1, approx: !exact };
}

function analyze(rows, { keyword = '汉服', region = '山东', basis = 'made_region' } = {}) {
  const phrase = keyword.trim();
  const idOf = row => `${row.platform}|${row.item_id}`;
  const byKeyword = rows.filter(x => !phrase || x.title.includes(phrase));
  const matching = basis === 'any' ? byKeyword : byKeyword.filter(x => String(x[basis] || '').includes(region.trim()));
  const keptIds = new Set(matching.map(idOf));
  const regionExcluded = new Set(byKeyword.map(idOf).filter(x => !keptIds.has(x))).size;
  const ids = new Map();
  for (const row of matching) {
    const key = idOf(row);
    if (!ids.has(key)) ids.set(key, []);
    ids.get(key).push(row);
  }
  const items = [...ids.values()].map(history => {
    history.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const first = history[0], latest = history.at(-1);
    const span = daysBetween(first.observed_at, latest.observed_at);
    const { growth, approx } = velocityTrend(history, span);
    const window = rollingWindow(history, latest);
    const bucketed = history.some(x => x.sales_exact === 0);
    // 分档样本唯一可靠的信号：这段时间里档位有没有上移。
    // 「1万+ → 2万+」只说明累计值越过了 2 万，真实增量可能是 1 件也可能是 1 万件，
    // 所以分档样本一律不输出件数幅度，只保留方向。
    const bucketUp = bucketed && span >= MIN_TREND_SPAN ? latest.sales_total > first.sales_total : null;
    const observed = !bucketed && span >= MIN_TREND_SPAN && latest.sales_total >= first.sales_total
      ? (latest.sales_total - first.sales_total) / span * ROLLING_WINDOW : null;
    return { ...latest, style: styleOf(latest.title), growth, approx, bucketed, bucketUp,
      sales30: window && window.exact ? window.sales30 : null,
      sales30Days: window ? window.days : null, hasWindow: !!window,
      sales30Exact: window ? window.exact : null,
      sales30Sold: window && window.exact ? window.sold : null,
      observedMonthly: observed, snapshots: history.length, span,
      trendFrom: growth !== null ? 'velocity' : bucketUp !== null ? 'bucket' : null };
  });
  const rankPool = items.map(x => x.sales30 ?? x.observedMonthly).filter(x => x !== null);
  items.forEach(item => {
    const value = item.sales30 ?? item.observedMonthly;
    // 测不出幅度的商品（分档、或历史太短）不参与排位，记为 null，而不是给一个中性分。
    item.volumeRank = value === null ? null : percentile(rankPool, value);
  });
  const groups = new Map();
  for (const item of items) {
    const key = item.style.garment;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const styles = [...groups].map(([name, group]) => {
    const growths = group.map(x => x.growth).filter(x => x !== null);
    const growth = growths.length ? median(growths) : null;
    const bucketPool = group.filter(x => x.bucketUp !== null);
    const bucketUp = bucketPool.length ? { up: bucketPool.filter(x => x.bucketUp).length, total: bucketPool.length } : null;
    const momentum = bucketUp ? bucketUp.up / bucketUp.total : null;
    // 只用测得出排位的商品取中位数；整款都测不出时不给销量分，避免「未知」比「实测偏低」占便宜。
    const ranked = group.map(x => x.volumeRank).filter(x => x !== null);
    const volumeRank = ranked.length ? median(ranked) : 0;
    // 没有可测速度时退回档位上移比例；它是比例而不是增速，所以算作半份证据。
    const trendComponent = growth !== null ? Math.max(0, Math.min(1, (growth + .2) / 1.2))
      : momentum === null ? 0 : momentum * BUCKET_TREND_WEIGHT;
    const bucketOnly = bucketPool.filter(x => x.growth === null).length;
    const evidence = (growths.length + 0.5 * bucketOnly) / group.length;
    const score = Math.round(100 * (0.55 * trendComponent + 0.25 * volumeRank + 0.20 * evidence));
    const sales30 = group.map(x => x.sales30).filter(x => x !== null);
    return { name, count: group.length, growth, momentum, bucketUp,
      windowBucketed: sales30.length === 0 && group.some(x => x.hasWindow),
      trendFrom: growth !== null ? 'velocity' : momentum !== null ? 'bucket' : null,
      approx: group.some(x => x.approx && x.growth !== null),
      volumeRank, score, price: median(group.map(x => x.price)),
      sales30: sales30.length ? median(sales30) : null, evidence, items: group };
  }).sort((a, b) => b.score - a.score);

  const weightedTerm = (field, exclude = '') => {
    const scores = new Map();
    for (const item of items) {
      const value = item.style[field];
      if (!value || value === exclude) continue;
      const weight = 1 + Math.max(-.5, Math.min(2, item.growth ?? 0)) + (item.volumeRank ?? .5);
      scores.set(value, (scores.get(value) || 0) + weight);
    }
    return [...scores].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  const top = styles[0];
  let candidate = null;
  if (top && items.some(x => x.trendFrom !== null)) {
    const colors = weightedTerm('color'), motifs = weightedTerm('motif');
    let choice;
    for (const color of colors) {
      for (const motif of motifs) {
        if (!items.some(x => x.style.garment === top.name && x.style.color === color && x.style.motif === motif)) { choice = { color, motif }; break; }
      }
      if (choice) break;
    }
    if (choice) candidate = {
      garment: top.name, ...choice, title: `${choice.color}${choice.motif}日常${top.name}`,
      reason: `${top.name}样本近期表现领先（${top.trendFrom === 'velocity' ? '按累计销量差分出的速度比较' : '按分档档位上移比例'}）；${choice.color}与${choice.motif}在样本中有需求信号；该三项组合未见于当前样本。`,
      prompt: `设计一款原创秋冬女款日常改良汉服：${top.name}，主色${choice.color}，局部${choice.motif}纹样。展示正反面、面料质感和可生产的结构；白底，无文字与商标。`
    };
  }
  const dates = [...new Set(matching.map(x => x.observed_at))].sort();
  const series = dates.map(date => {
    const sameDate = matching.filter(x => x.observed_at === date);
    const monthly = [];
    for (const row of sameDate) {
      const history = ids.get(idOf(row)).filter(x => x.observed_at <= date);
      const window = rollingWindow(history, row);
      if (window) monthly.push(window.sales30);
    }
    return { date, count: sameDate.length,
      cumulative: median(sameDate.map(x => x.sales_total)),
      sales30: monthly.length ? median(monthly) : null };
  });
  const bucketPool = items.filter(x => x.bucketUp !== null);
  return { snapshotCount: matching.length, itemCount: items.length, regionExcluded, styles, items, candidate, series,
    eligibleCount: items.filter(x => x.growth !== null).length,
    bucketedCount: items.filter(x => x.bucketed).length,
    bucketUp: bucketPool.length ? { up: bucketPool.filter(x => x.bucketUp).length, total: bucketPool.length } : null,
    sales30Count: items.filter(x => x.sales30 !== null).length };
}

function demoRows() {
  const today = new Date();
  const dates = [35, 28, 21, 14, 7, 0].map(offset => { const d = new Date(today); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); });
  // 演示值是累计已售件数，和接口返回的口径一致；最后两件是分档样本（sales_exact=0）。
  const products = [
    ['P201','汉服 日常短袄 黛青 窄袖',139,[800,980,1200,1500,1900,2500],1],
    ['P202','汉服 马面裙 牡丹暗纹',119,[2600,2900,3250,3650,4100,4600],1],
    ['P203','汉服 改良袄裙 浅青 对襟',199,[700,820,940,1050,1150,1240],1],
    ['P204','汉服 齐胸襦裙 绛红 宽袖',179,[4800,5100,5350,5550,5700,5800],1],
    ['P205','汉服 宋制褙子 米白 棉麻',159,[400,480,580,700,850,1050],1],
    ['P206','汉服 明制短袄 米白 立领 日常',169,[300,360,430,520,640,800],1],
    ['P207','汉服 改良袄裙 棉麻 米白 通勤',239,[1500,1700,1950,2250,2600,3000],1],
    ['P208','汉服 马面裙 黛青 提花',129,[900,1000,1120,1260,1420,1600],1],
    ['P209','汉服 齐胸襦裙 粉色 绣花',219,[10000,10000,10000,10000,10000,10000],0],
    ['P210','汉服 短袄 牡丹刺绣 月白',189,[10000,10000,20000,20000,20000,30000],0],
    ['P211','汉服 交领衫 墨绿 竹纹',149,[20000,20000,20000,30000,30000,30000],0],
  ];
  return products.flatMap(([item_id,title,price,values,exact]) => dates.map((observed_at,i) => ({
    platform:'pinduoduo',item_id,observed_at,title,price,
    sales_total: values[i], sales_exact: exact,
    seller_region:'',ship_region:'',made_region:'山东 菏泽',item_region:'',
    image_url:'',product_url:''
  })));
}


const KEY = 'style-forecast-snapshots-v1';
const $ = id => document.getElementById(id);
let mode = 'demo';
let saved = [];
try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(saved)) saved = []; } catch { saved = []; }
const state = { keyword: '汉服', region: '山东', basis: 'made_region' };
let current = null;
let collectorStatus = '';

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function compact(n) { return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(Math.round(n)) : '—'; }
function pct(n) { return n === null ? '样本不足' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`; }
function download(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿', content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function persist() { localStorage.setItem(KEY, JSON.stringify(saved)); }
function setMessage(message, error = false) { $('importMessage').textContent = message; $('importMessage').classList.toggle('error', error); }

function chartSvg(series, metric, label) {
  const drawn = series.filter(x => x[metric] !== null);
  if (!drawn.length) return '';
  const w = 600, h = 190, left = 44, right = 15, top = 22, bottom = 30;
  const values = drawn.map(x => x[metric]), max = Math.max(1, ...values) * 1.15;
  const x = i => left + (drawn.length === 1 ? (w - left - right) / 2 : i * (w - left - right) / (drawn.length - 1));
  const y = v => h - bottom - v / max * (h - top - bottom);
  const points = drawn.map((p, i) => `${x(i)},${y(p[metric])}`).join(' ');
  const area = `${left},${h-bottom} ${points} ${x(drawn.length-1)},${h-bottom}`;
  const ticks = [0,.5,1].map(t => { const yy = y(max*t); return `<line x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}" stroke="#e9eee8" stroke-dasharray="4 4"/><text x="0" y="${yy+4}">${Math.round(max*t)}</text>`; }).join('');
  const dateLabels = drawn.map((p,i) => `<text text-anchor="middle" x="${x(i)}" y="${h-5}">${escapeHtml(p.date.slice(5))}</text>`).join('');
  const dots = drawn.map((p,i) => `<circle cx="${x(i)}" cy="${y(p[metric])}" r="4" fill="#3f7655" stroke="white" stroke-width="2"><title>${escapeHtml(p.date)}：${p[metric].toFixed(0)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}样本中位数走势">${ticks}<text x="0" y="12">${escapeHtml(label)}</text><polygon points="${area}" fill="#dceadf" opacity=".65"/><polyline points="${points}" fill="none" stroke="#407958" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dots}${dateLabels}</svg>`;
}

function renderChart(series) {
  const charts = chartSvg(series, 'cumulative', '累计已售件数（接口原值）')
    + chartSvg(series, 'sales30', '近 30 天销量（差分得出）');
  $('trendChart').innerHTML = charts || '<div class="empty-chart">没有符合条件的快照</div>';
}

function styleChange(style) {
  if (style.growth !== null) return `${pct(style.growth)}${style.approx ? ' ≈' : ''}`;
  if (style.bucketUp) return `档位上移 ${style.bucketUp.up}/${style.bucketUp.total}`;
  return '样本不足';
}

function render() {
  const rows = mode === 'demo' ? demoRows() : saved;
  current = analyze(rows, state);
  const demo = mode === 'demo';
  $('demoMode').classList.toggle('selected', demo);
  $('realMode').classList.toggle('selected', !demo);
  $('modeBanner').classList.toggle('real', !demo);
  $('modeBanner').textContent = demo
    ? '演示模式｜所有商品、价格和销量均为模拟数据，只用于查看系统流程；下方排名不是实际拼多多结论。'
    : `我的数据｜分析已导入及本机采集的快照，浏览器保留一份副本。${collectorStatus || '尚未读取本机采集结果。'}`;
  $('updatedAt').textContent = `${demo ? '演示预览' : '本地数据'} · ${new Date().toLocaleDateString('zh-CN')}`;
  $('itemCount').textContent = compact(current.itemCount);
  $('snapshotCount').textContent = compact(current.snapshotCount);
  $('eligibleCount').textContent = compact(current.eligibleCount);
  $('sales30Count').textContent = compact(current.sales30Count);
  $('pddSource').textContent = `${current.itemCount} 件商品`;
  $('bucketSource').textContent = current.bucketUp
    ? `${current.bucketUp.up}/${current.bucketUp.total} 上移`
    : `${current.bucketedCount} 件`;
  $('chartBasis').textContent = current.sales30Count ? '累计件数 + 近 30 天销量' : '累计件数（近 30 天销量待攒满 30 天）';
  const notes = [];
  if (demo) notes.push('本页只展示算法流程。模拟数据不用于采购决策。');
  else if (!saved.length) notes.push('尚无真实商品快照。配置拼多多开放平台凭据并运行采集程序，或导入 CSV。');
  else {
    if (state.basis !== 'any' && current.regionExcluded) notes.push(`有 ${current.regionExcluded} 件商品不符合当前地区口径已排除。商品搜索接口不返回地区字段，若要分析这些商品，请把地区依据切到「不限地区」，或先凭证据维护产地映射。`);
    if (current.itemCount && current.eligibleCount === 0) notes.push('样本观察次数不足：需至少 3 次观察且跨度满 7 天，才能从累计值差分出速度变化。');
    if (current.itemCount && !current.sales30Count) notes.push('还没有满 30 天的历史，近 30 天销量要等最早快照满 30 天后才能相减得出；当前排序用的是观察窗口内的折算值。');
    if (current.bucketUp) notes.push(`其中 ${current.bucketUp.total} 件是分档销量（如 1万+），只统计档位是否上移（${current.bucketUp.up} 件上移），不读作精确增速。`);
    if (!notes.length) notes.push('趋势只代表已导入样本。多多进宝的检索范围是可推广商品库，不等于拼多多全站。');
  }
  $('qualityNote').textContent = notes.join('');
  renderChart(current.series);
  $('styleRows').innerHTML = current.styles.length ? current.styles.map((x,i) => `<tr><td>${String(i+1).padStart(2,'0')}　${escapeHtml(x.name)}</td><td>${x.count}</td><td>${x.sales30 !== null ? compact(x.sales30) : `<span class="muted">${x.windowBucketed ? '分档不可测' : '攒够 30 天'}</span>`}</td><td class="${x.growth === null ? '' : x.growth >= 0 ? 'positive' : 'negative'}">${escapeHtml(styleChange(x))}</td><td><div class="score"><div class="score-bar"><i style="width:${x.score}%"></i></div>${x.score}</div></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty-row">没有符合当前关键词与地区口径的商品</td></tr>';
  const c = current.candidate;
  $('candidateTitle').textContent = c ? c.title : '等待更多历史快照';
  $('candidateReason').textContent = c ? c.reason : '同一商品至少要有 3 次观察且跨度满 7 天，才能从累计销量里差分出近期方向并组合一个未出现的设计。';
  $('candidateTags').innerHTML = c ? [c.garment,c.color,c.motif].map(x => `<span>${escapeHtml(x)}</span>`).join('') : '';
  $('candidatePrompt').textContent = c?.prompt || '有足够的历史数据后，这里会给出一段可用于设计图生成的描述。';
  const visual = $('candidateVisual');
  if (demo) visual.innerHTML = '<img src="./assets/hanfu-concept.png" alt="秋冬改良袄裙示例设计图，展示正面和背面"><span>示例设计图 · 与动态评分不自动同步</span>';
  else visual.innerHTML = '<div>正式数据的推荐款式图<br>将在确认设计提案后生成</div>';
  visual.classList.toggle('no-image', !demo);
}

function updateFilters() {
  state.keyword = $('keyword').value.trim(); state.region = $('region').value.trim(); state.basis = $('basis').value;
  if (!state.region && state.basis !== 'any') { setMessage('请填写地区，或把地区依据切换为「不限地区」', true); return; }
  render();
}

$('demoMode').addEventListener('click', () => { mode = 'demo'; render(); });
$('realMode').addEventListener('click', () => { mode = 'real'; render(); });
$('analyzeBtn').addEventListener('click', updateFilters);
$('keyword').addEventListener('keydown', e => { if (e.key === 'Enter') updateFilters(); });
$('region').addEventListener('keydown', e => { if (e.key === 'Enter') updateFilters(); });
$('basis').addEventListener('change', updateFilters);
$('csvFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setMessage('文件超过 5 MB，请分批导入', true); event.target.value = ''; return; }
  try {
    const rows = parseCsv(await file.text());
    const before = saved.length; saved = mergeRows(saved, rows); persist(); mode = 'real';
    setMessage(`已读取 ${rows.length} 条记录，新增或更新 ${saved.length - before} 个日期快照。`);
    render();
  } catch (error) { setMessage(error.message || '导入失败', true); }
  event.target.value = '';
});
$('templateBtn').addEventListener('click', () => download('款势观察室_导入模板.csv', ALL_COLUMNS.join(',') + '\r\n'));
async function syncCollected({ quiet = false } = {}) {
  try {
    const response = await fetch('/api/snapshots.csv', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? '本机还没有采集快照' : `读取失败（HTTP ${response.status}）`);
    const rows = parseCsv(await response.text());
    const before = saved.length;
    saved = mergeRows(saved, rows); persist(); mode = 'real';
    let last = '', detail = '';
    try {
      const statusResponse = await fetch('/api/collector-status', { cache: 'no-store' });
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        last = status.last_success || '';
        if (Number.isFinite(status.pinduoduo_rows)) detail = `（读取 ${status.pinduoduo_rows} 件）`;
      }
    } catch { /* snapshots remain usable without status */ }
    collectorStatus = last ? `最近采集：${last}${detail}。` : '已读取本机采集文件。';
    if (!quiet) setMessage(`已同步 ${rows.length} 条采集记录，新增 ${saved.length - before} 条。`);
    render();
  } catch (error) {
    if (!quiet) setMessage(`${error.message}。请运行 python server.py 和 collector.py，或手动导入 CSV。`, true);
  }
}
$('syncBtn').addEventListener('click', () => syncCollected());
$('exportBtn').addEventListener('click', () => saved.length ? download('款势观察室_已存快照.csv', toCsv(saved)) : setMessage('当前浏览器没有已存数据', true));
$('clearBtn').addEventListener('click', () => {
  if (!saved.length) { setMessage('当前浏览器没有已存数据'); return; }
  if (!confirm(`确定删除当前浏览器保存的 ${saved.length} 条快照吗？请先导出备份。`)) return;
  saved = []; persist(); mode = 'real'; setMessage('已清空当前浏览器保存的数据'); render();
});
$('copyPrompt').addEventListener('click', async () => {
  if (!current?.candidate) return;
  try { await navigator.clipboard.writeText(current.candidate.prompt); $('copyPrompt').textContent = '已复制 ✓'; setTimeout(() => $('copyPrompt').textContent = '复制 ↗', 1800); }
  catch { setMessage('复制失败，请手动选中提示词', true); }
});
render();
if (typeof location !== 'undefined' && location.protocol.startsWith('http')) syncCollected({ quiet: true });
