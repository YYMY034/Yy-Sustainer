// 生成 T40 改前/改后对照预览：颜色变量直接从 web/index.html 解析，保证色值一致。
// 运行：node scripts/gen-t40-preview.mjs  →  scripts/t40-preview.html
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const vars = (block) => [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)]
  .map(m => `    --${m[1]}: ${m[2].trim()};`).join('\n')
const dark = vars(css.match(/:root\s*\{([\s\S]*?)\}/)[1])
const light = vars(css.match(/html\.light\s*\{([\s\S]*?)\}/)[1])

const icon = (d, s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none">${d}</svg>`
const I = {
  refresh: '<path d="M13 8a5 5 0 11-1.6-3.7M13 1.8v3.4h-3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  search: '<circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 10.2L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  moon: '<path d="M13.2 9.6A5.4 5.4 0 016.4 2.8a5.6 5.6 0 106.8 6.8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  layout: '<rect x="2.2" y="3" width="11.6" height="10" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6.4 3v10" stroke="currentColor" stroke-width="1.4"/>',
  min: '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
}

// 两侧共用的骨架；before/after 的差异全在 .app.before / .app.after 的规则里
const appBlock = (kind) => `
<div class="app ${kind}">
  <div class="topbar">
    <span class="brand"></span>
    <span class="tbic">${icon(I.refresh)}</span>
    <span class="title">yyagentd</span>
    <span class="sp"></span>
    <span class="tbic">${icon(I.moon)}</span>
    <span class="tbic on">${icon(I.layout, 14)}</span>
    <span class="tbic">${icon(I.min)}</span>
    <span class="tbic">${icon(I.close)}</span>
  </div>
  <div class="content">
    <div class="sidebar">
      <div class="qrow">${icon(I.plus)}<span>新建对话</span><i>Ctrl+N</i></div>
      <div class="qrow">${icon(I.search)}<span>搜索</span><i>Ctrl+K</i></div>
    </div>
    <div class="main">
      <div class="mcard">
        <div class="rail"><button class="dash"></button><button class="dash"></button><button class="dash cur"></button><button class="dash"></button></div>
        <div class="ans"><b>可能的原因：</b><br>1. Tabbit 服务未安装或未启动<br>2. 浏览器连接配置问题</div>
      </div>
    </div>
    <div class="drawer">
      <div class="mon"><span class="mdot"></span>主对话空闲</div>
      <div class="tabs"><span class="atab active">辅助对话</span><span class="atab">文件管理</span><span class="atab">实时预览</span></div>
    </div>
  </div>
</div>`

const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T40 改前 / 改后对照</title>
<style>
  :root {
${dark}
  }
  html.light {
${light}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding: 20px 24px 40px; }
  h1 { font-size: 15px; margin-bottom: 3px; }
  .sub { font-size: 11.5px; color: var(--dim); margin-bottom: 16px; }
  .tools { position: fixed; top: 14px; right: 18px; display: flex; gap: 8px; z-index: 99; }
  .tools button { background: var(--text); color: var(--bg); border: 0; border-radius: 7px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .cols { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
  .col { flex: 1 1 460px; min-width: 380px; }
  .col > .cap { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
  .col.bad > .cap { color: var(--err); }
  .col.good > .cap { color: var(--accent); }
  .col > .note { font-size: 11px; color: var(--dim); margin-top: 7px; line-height: 1.7; }

  /* ---- 应用骨架 ---- */
  .app { height: 232px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); box-shadow: 0 4px 16px var(--shadow); }
  .topbar { height: 32px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 10px; background: var(--panel); color: var(--dim); }
  .brand { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #000)); }
  .tbic { display: flex; align-items: center; justify-content: center; padding: 3px; border-radius: 6px; }
  .tbic.on { color: var(--accent); border: 1px solid var(--accent); }
  .title { font-size: 12.5px; color: var(--text); }
  .sp { flex: 1; }
  .content { flex: 1; display: flex; min-height: 0; }
  .sidebar { width: 148px; flex-shrink: 0; padding: 8px 6px; border-right: 1px solid var(--border); }
  .qrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; font-size: 12px; color: var(--text); }
  .qrow i { margin-left: auto; font-style: normal; font-size: 10px; color: var(--dim); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .mcard { flex: 1; margin: 8px 9px 0; background: var(--panel); border-radius: 14px 14px 0 0; overflow: hidden; }
  .drawer { width: 152px; flex-shrink: 0; }
  .mon { display: flex; align-items: center; gap: 6px; padding: 7px 10px; font-size: 11px; color: var(--dim); }
  .mdot { width: 7px; height: 7px; border-radius: 50%; background: var(--dot-idle); }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 0; }
  .atab { font-size: 11px; color: var(--dim); padding: 4px 6px; border-bottom: 2px solid transparent; }
  .atab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

  /* ---- 导轨（两侧共用外观，位置/对齐在下面按 before/after 覆盖） ---- */
  .rail { position: absolute; left: 10px; width: 22px; top: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .dash { width: 14px; height: 3px; border-radius: 2px; background: var(--border); border: 0; padding: 0; cursor: pointer; transition: background .12s ease, width .12s ease; }
  .dash.cur { background: var(--accent); }
  .dash:hover { background: var(--accent); width: 22px; }
  .mcard { position: relative; }
  .ans { font-size: 12px; line-height: 1.6; color: var(--text); padding: 14px 12px 12px 32px; }
  .ans b { color: var(--text); }

  /* ---- 改前（T40 之前） ---- */
  .app.before .topbar { border-bottom: 1px solid var(--border); }     /* 满宽硬线，切断过渡 */
  .app.before .sidebar { background: var(--panel2); }                 /* 平铺 panel2：与顶栏硬边 */
  .app.before .drawer  { background: var(--panel2); }                 /* 同上 */
  .app.before .main    { /* 无 border-top：分隔线由顶栏负责 */ }
  .app.before .rail    { left: 16px; align-items: flex-start; }
  .app.before .dash:hover { width: 26px; margin-left: 4px; }          /* 向右长 → 压住正文 */
  .app.before .ans     { padding-left: 22px; }                        /* 正文起点 = 9+22 = 31px */
  /* 正文起点参考线 */
  .app.before .mcard::after  { content: ""; position: absolute; left: 31px; top: 0; bottom: 0; border-left: 1px dashed color-mix(in srgb, var(--err) 55%, transparent); }
  .app.before .rail::after   { content: ""; position: absolute; left: 46px; top: -4px; bottom: -4px; border-left: 1px dashed color-mix(in srgb, var(--err) 40%, transparent); }

  /* ---- 改后（T40） ---- */
  .app.after .topbar { /* 无 border-bottom */ }
  .app.after .main   { border-top: 1px solid var(--border); }         /* 分隔线只横跨中部画布 */
  .app.after .sidebar { background: linear-gradient(to bottom, var(--panel) 0, var(--panel2) 16px); }
  .app.after .drawer  { background: linear-gradient(to bottom, var(--panel) 0, var(--panel2) 16px); }
  .app.after .mon     { background: transparent; }
  .app.after .rail    { left: 10px; align-items: flex-end; }
  .app.after .dash:hover { width: 22px; margin-left: 0; }             /* 右缘钉死，向左长 */
  .app.after .ans     { padding-left: 32px; }                         /* 正文起点 = 9+32 = 41px */
  .app.after .mcard::after { content: ""; position: absolute; left: 32px; top: 0; bottom: 0; border-left: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent); }
  .app.after .rail::after  { content: ""; position: absolute; left: 32px; top: -4px; bottom: -4px; border-left: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent); }

  /* ---- 侧栏收起联动：改后导轨只在收起时出现；改前恒定出现 ---- */
  body.collapsed .app.after .sidebar { display: none; }
  body.collapsed .app.after .rail { display: flex; }
  body:not(.collapsed) .app.after .rail { display: none; }
  .app.before .rail { display: flex; }

  .legend { margin-top: 18px; font-size: 11.5px; color: var(--dim); line-height: 1.9; }
  .legend b { color: var(--text); }
  .k { display: inline-block; width: 9px; height: 9px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; }
</style></head>
<body>
  <div class="tools">
    <button id="tg">切换主题</button>
    <button id="sc">侧栏展开/收起</button>
  </div>
  <h1>T40 改前 / 改后对照</h1>
  <div class="sub">色值从 <code>web/index.html</code> 的 <code>:root</code> / <code>html.light</code> 直接解析，与真实界面一致。把鼠标放到导轨短横上可看变长方向。</div>
  <div class="cols">
    <div class="col bad">
      <div class="cap">改前（T40 之前）</div>
      ${appBlock('before')}
      <div class="note">
        · 顶栏有一条<b>满宽</b>分隔线，横跨左右侧栏顶部 → 交界处是硬边，没有颜色过渡<br>
        · 左侧栏/右抽屉直接平铺 panel2，与顶栏的 panel 色<b>一刀切</b><br>
        · 导轨短横 hover 时向右长到 46px，<b>压住</b>正文（正文起点 31px）→ 间隔太小
      </div>
    </div>
    <div class="col good">
      <div class="cap">改后（T40）</div>
      ${appBlock('after')}
      <div class="note">
        · 顶栏分隔线改由中部画布承担（<code>#main border-top</code>），不再跨过侧栏<br>
        · 左右栏顶部 16px 由顶栏色 <b>渐变</b>到侧栏色 → 接缝同色、无硬边<br>
        · 导轨改为右缘对齐：短横只向<b>左</b>长，右缘恒定 32px；正文起点 41px → 净距 10px，永不压字<br>
        · 导轨仅在<b>左侧栏收起</b>时显示（点右上「侧栏展开/收起」验证）
      </div>
    </div>
  </div>
  <div class="legend">
    <b>虚线说明：</b><span class="k" style="background:var(--err)"></span>红=改前「正文起点(31px) / 导轨最长右缘(46px)」，
    <span class="k" style="background:var(--accent)"></span>绿=改后「导轨右缘(32px) / 正文起点(41px)」。
  </div>
<script>
  document.getElementById('tg').onclick = () => document.documentElement.classList.toggle('light')
  document.getElementById('sc').onclick = () => document.body.classList.toggle('collapsed')
</script>
</body></html>`

writeFileSync('scripts/t40-preview.html', out)
console.log('已生成 scripts/t40-preview.html（', out.length, 'bytes ）')
