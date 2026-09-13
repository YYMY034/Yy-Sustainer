// 生成 T42 对照预览：① 三条缝的过渡（改前 16px+硬线 / 改后 8px 无硬线）
//                       ② 导轨伸长方向（T40 向左 / T42 向右）+ 净距参考线
//                       ③ 过渡节奏对比（旧 .35s+.12s延迟 / 新 .2s+.05s延迟）
// 色值从 web/index.html 解析；导轨 CSS 参数与真实规则一致。
// 运行：node scripts/gen-t42-preview.mjs  →  scripts/t42-preview.html
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const vars = (b) => [...b.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => `    --${m[1]}: ${m[2].trim()};`).join('\n')
const dark = vars(css.match(/:root\s*\{([\s\S]*?)\}/)[1])
const light = vars(css.match(/html\.light\s*\{([\s\S]*?)\}/)[1])

// 从真实 CSS 里读导轨参数，避免预览与实现脱节
const rule = (sel) => {
  const m = css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp('(?:^|\\n)[ \\t]*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}
const px = (s, prop) => +((rule(s).match(new RegExp(prop + ':\\s*(\\d+)px')) || [])[1])
const RAIL = { left: px('#qaRail', 'left'), w: px('#qaRail', 'width'), base: px('#qaRail .qa-dash', 'width') }
const dashW = (s) => { for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) { const sels = m[1].split(',').map(x => x.trim().replace(/\s+/g, ' ')); if (sels.some(x => x === s) && /width:\s*\d+px/.test(m[2])) return +m[2].match(/width:\s*(\d+)px/)[1] } return 0 }
const NEAR = dashW('#qaRail .qa-dash.near'), FAR = dashW('#qaRail .qa-dash.far'), HOVER = dashW('#qaRail .qa-dash:hover')
const msgRule = rule('#messages')
const TEXT_LEFT = +((msgRule.match(/margin:\s*[\d.]+px\s+(\d+)px/) || [])[1]) + +(msgRule.match(/padding:[^;]*?(\d+)px;/) || [])[1]

const dashRow = (kind) => Array.from({ length: 5 }, (_, i) => (i === 2 ? `<span class="qd cur ${kind}"></span>` : `<span class="qd ${kind}"></span>`)).join('')

const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T42 对照 · 三条缝过渡 / 导轨方向 / 节奏</title>
<style>
  :root {
${dark}
  }
  html.light {
${light}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding: 22px 26px 46px; }
  h1 { font-size: 15px; margin-bottom: 3px; }
  .sub { font-size: 11.5px; color: var(--dim); margin-bottom: 18px; }
  .tools { position: fixed; top: 14px; right: 18px; z-index: 99; }
  .tools button { background: var(--text); color: var(--bg); border: 0; border-radius: 7px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
  section { margin-bottom: 28px; }
  h2 { font-size: 13px; margin-bottom: 9px; }
  h2 span { font-weight: 400; color: var(--dim); font-size: 11.5px; }
  .pair { display: flex; gap: 20px; flex-wrap: wrap; }
  .side { flex: 1 1 400px; min-width: 330px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .side > .hd { font-size: 11.5px; font-weight: 700; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .side.bad > .hd { color: var(--err); }
  .side.good > .hd { color: var(--accent); }
  .side > .bd { padding: 12px; background: var(--panel2); }
  .note { font-size: 11px; color: var(--dim); margin-top: 7px; line-height: 1.75; }
  .note b { color: var(--text); }

  /* 应用顶部骨架复刻（顶栏 + 左栏 / 中部 / 右栏 的接缝） */
  .app { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg); }
  .tb { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 9px; background: var(--panel); }
  .tb .brand { width: 19px; height: 19px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #000)); }
  .tb .ic { width: 13px; height: 13px; border-radius: 4px; background: color-mix(in srgb, var(--dim) 45%, transparent); }
  .tb .sp { flex: 1; }
  .row { display: flex; height: 104px; }
  .col-l { width: 118px; flex-shrink: 0; border-right: 1px solid var(--border); }
  .col-m { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .col-m .card { flex: 1; margin: 8px 9px 0; background: var(--panel); border-radius: 14px 14px 0 0; }
  .col-r { width: 128px; flex-shrink: 0; }
  .col-r .mon { height: 26px; }
  /* 改前 */
  .app.before .tb { border-bottom: 1px solid var(--border); box-shadow: 0 0 0 0 transparent; }
  .app.before .col-l, .app.before .col-r { background: var(--panel2); }
  .app.before .col-m { border-top: 1px solid var(--border); }
  /* 改后：三条缝都是 8px 顶色渐变、一律无硬线 */
  .app.after .col-l, .app.after .col-r { background: linear-gradient(to bottom, var(--panel) 0, var(--panel2) 8px); }
  .app.after .col-m { background: linear-gradient(to bottom, var(--panel) 0, var(--bg) 8px); }

  /* ---- 导轨对比 ---- */
  .railstage { position: relative; height: 96px; background: var(--panel); border-radius: 10px; overflow: hidden; }
  .railstage .textline { position: absolute; top: 0; bottom: 0; border-left: 1px dashed color-mix(in srgb, var(--err) 55%, transparent); }
  .railstage .textline.after { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .railstage .txt { position: absolute; top: 10px; font-size: 11.5px; color: var(--text); }
  .railstage .mark { position: absolute; bottom: 4px; font-size: 9.5px; color: var(--dim); transform: translateX(-50%); white-space: nowrap; }
  .railbox { position: absolute; top: 12px; left: ${RAIL.left}px; width: ${RAIL.w}px; display: flex; flex-direction: column; gap: 6px; }
  .railbox.end { align-items: flex-end; }
  .railbox.start { align-items: flex-start; }
  .qd { height: 3px; border-radius: 2px; background: var(--border); width: ${RAIL.base}px; transition: background .2s ease .05s, width .2s cubic-bezier(.22,.61,.36,1) .05s; }
  .qd.cur { background: var(--accent); }
  /* 伸长态（自动来回演示，也可直接把鼠标移到框上） */
  .railbox.hot .qd { background: var(--accent); width: ${HOVER}px; transition: background .13s ease, width .16s cubic-bezier(.22,.61,.36,1); }
  .railbox.hot .qd.cur { background: var(--accent); }
  .railbox.hot .qd:nth-child(2), .railbox.hot .qd:nth-child(4) { width: ${NEAR}px; }
  .railbox.hot .qd:nth-child(1), .railbox.hot .qd:nth-child(5) { width: ${FAR}px; }
  /* 改前的「向左长」不需要额外位移：flex-end 会让所有短横的右缘自动对齐，
     宽度一变，左缘自然往左退（这正是 T40 的效果，也是 T42 要去掉的方向） */

  /* ---- 节奏对比 ---- */
  .r2 { display: flex; gap: 26px; align-items: center; }
  .r2 .box { flex: 1; }
  .r2 .cap { font-size: 11px; color: var(--dim); margin-bottom: 6px; }
  .strip { position: relative; height: 22px; }
  .strip .qd { position: absolute; left: 0; top: 9px; }
  .strip.old .qd { transition: background .35s ease .12s, width .35s ease .12s; }
  .strip.old.on .qd { width: ${HOVER}px; transition: background .12s ease, width .12s ease; }
  .strip.new .qd { transition: background .2s ease .05s, width .2s cubic-bezier(.22,.61,.36,1) .05s; }
  .strip.new.on .qd { width: ${HOVER}px; transition: background .13s ease, width .16s cubic-bezier(.22,.61,.36,1); }
  .btns { margin-top: 10px; display: flex; gap: 8px; }
  .btns button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 5px 11px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
  .btns button:hover { border-color: var(--accent); color: var(--accent); }
</style></head>
<body>
  <div class="tools"><button id="tg">切换主题</button></div>
  <h1>T42 对照：三条缝的过渡 / 导轨方向 / 过渡节奏</h1>
  <div class="sub">色值与导轨参数（left ${RAIL.left}px、基准宽 ${RAIL.base}px、near ${NEAR} / far ${FAR} / hover ${HOVER}px、正文起点 ${TEXT_LEFT}px）都从 <code>web/index.html</code> 解析，改前样式按旧值复刻。</div>

  <section>
    <h2>① 顶栏 ↔ 输出区 / 左右侧栏 <span>三条缝现在都是「无硬线 + 8px 顶色渐变」</span></h2>
    <div class="pair">
      <div class="side bad"><div class="hd">改前</div><div class="bd">
        <div class="app before"><div class="tb"><span class="brand"></span><span class="ic"></span><span class="sp"></span></div>
          <div class="row"><div class="col-l"></div><div class="col-m"><div class="card"></div></div><div class="col-r"><div class="mon"></div></div></div>
        </div>
        <div class="note">顶栏有满宽 1px 分隔线；左右栏平铺 panel2；中部还多一条 <b>border-top</b>（T40 加的）——三处都是硬边。</div>
      </div></div>
      <div class="side good"><div class="hd">改后</div><div class="bd">
        <div class="app after"><div class="tb"><span class="brand"></span><span class="ic"></span><span class="sp"></span></div>
          <div class="row"><div class="col-l"></div><div class="col-m"><div class="card"></div></div><div class="col-r"><div class="mon"></div></div></div>
        </div>
        <div class="note">三条缝全部无硬线：左右栏 <code>panel→panel2 8px</code>，中部 <code>panel→bg 8px</code>（<b>8px 正好等于 #messages 的上外边距</b>，严丝合缝铺满那条缝，不留色带）。过渡区由 16px 收到 8px。</div>
      </div></div>
    </div>
  </section>

  <section>
    <h2>② 导轨伸长方向 <span>T42 改回向右（左缘固定）· 下面两条会自动伸缩</span></h2>
    <div class="pair">
      <div class="side bad"><div class="hd">改前（T40：向右缘对齐、向左长 —— 方向反了）</div><div class="bd">
        <div class="railstage">
          <div class="railbox end hot"><span class="qd"></span><span class="qd"></span><span class="qd cur"></span><span class="qd"></span><span class="qd"></span></div>
          <div class="textline" style="left:${TEXT_LEFT}px"></div>
          <div class="txt" style="left:${TEXT_LEFT + 6}px">模型的回答从这里开始</div>
          <div class="mark" style="left:${RAIL.left + RAIL.w / 2}px">导轨右缘固定 ${RAIL.left + RAIL.w}px</div>
        </div>
      </div></div>
      <div class="side good"><div class="hd">改后（T42：向左缘对齐、向右长）</div><div class="bd">
        <div class="railstage">
          <div class="railbox start hot"><span class="qd"></span><span class="qd"></span><span class="qd cur"></span><span class="qd"></span><span class="qd"></span></div>
          <div class="textline after" style="left:${TEXT_LEFT}px"></div>
          <div class="txt" style="left:${TEXT_LEFT + 6}px">模型的回答从这里开始</div>
          <div class="mark" style="left:${RAIL.left + HOVER / 2}px">向左缘固定 ${RAIL.left}px，最长到 ${RAIL.left + HOVER}px</div>
        </div>
        <div class="note">向右最长 ${HOVER}px → 右缘 ${RAIL.left + HOVER}px，仍比正文起点 ${TEXT_LEFT}px 早 <b>${TEXT_LEFT - RAIL.left - HOVER}px</b>，所以"向右长"也压不到字。</div>
      </div></div>
    </div>
  </section>

  <section>
    <h2>③ 过渡节奏 <span>点按钮来回切，比较两条的伸缩速度</span></h2>
    <div class="bd" style="border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--panel2)">
      <div class="r2">
        <div class="box">
          <div class="cap">旧：伸长 .12s ／ 缩回 .35s + .12s 延迟</div>
          <div class="strip old" id="oldStrip"><span class="qd cur"></span></div>
        </div>
        <div class="box">
          <div class="cap">新：伸长 .16s cubic-bezier(.22,.61,.36,1) ／ 缩回 .2s + .05s 延迟</div>
          <div class="strip new" id="newStrip"><span class="qd cur"></span></div>
        </div>
      </div>
      <div class="btns"><button id="toggle">来回切一次</button><span style="font-size:11px;color:var(--dim);align-self:center">（连点观察：旧版缩回明显发飘、跟不上；新版收放一致）</span></div>
      <div class="note"><b>更关键的流畅度修复不在时间参数上</b>：原来 <code>mouseleave</code> 里无条件清空 <code>.near/.far</code>，而快速划过时"下一条的 enter"可能先于"上一条的 leave" → 刚点亮的波纹被抹掉，观感就是一下亮一下灭。现改为幂等函数 <code>paintQaRipple()</code>：按"当前真正 :hover 的那条"重算波纹，事件顺序颠倒也不会打架（已用仿真用例回归）。滚动期间屏蔽 hover 的窗口也从 150ms 收到 90ms。</div>
    </div>
  </section>
<script>
  document.getElementById('tg').onclick = () => document.documentElement.classList.toggle('light')
  const o = document.getElementById('oldStrip'), n = document.getElementById('newStrip')
  document.getElementById('toggle').onclick = () => { o.classList.toggle('on'); n.classList.toggle('on') }
  // ② 的两条导轨自动来回演示伸缩（也能直接把鼠标移上去看）
  const boxes = [...document.querySelectorAll('.railbox')]
  setInterval(() => boxes.forEach((b) => b.classList.toggle('hot')), 1600)
</script>
</body></html>`

writeFileSync('scripts/t42-preview.html', out)
console.log('已生成 scripts/t42-preview.html（', out.length, 'bytes ）')
console.log(`实测参数：导轨 left=${RAIL.left} 容器宽=${RAIL.w} 基准=${RAIL.base} near=${NEAR} far=${FAR} hover=${HOVER}｜正文起点=${TEXT_LEFT}｜净距=${TEXT_LEFT - RAIL.left - HOVER}px`)
