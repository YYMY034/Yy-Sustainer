// 生成 T41 图标对照预览：三个图标的「改前（文本字形）/ 改后（手绘 SVG）」并排 + 3 倍放大看形状。
// SVG 直接从 web/index.html 里抽取，保证和真实界面里的标注一模一样。
// 运行：node scripts/gen-t41-preview.mjs  →  scripts/t41-preview.html
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const vars = (block) => [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)]
  .map(m => `    --${m[1]}: ${m[2].trim()};`).join('\n')
const dark = vars(css.match(/:root\s*\{([\s\S]*?)\}/)[1])
const light = vars(css.match(/html\.light\s*\{([\s\S]*?)\}/)[1])

const btnHtml = (id) => {
  const m = html.match(new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)</button>`))
  return m ? m[1] : ''
}
const svgOf = (frag) => (frag.match(/<svg[\s\S]*?<\/svg>/) || [''])[0]
const up = svgOf(btnHtml('fmUp'))
const rf = svgOf(btnHtml('fmRefresh'))
const jb = svgOf(btnHtml('jumpBottom'))

// 把 14px 的内联 svg 放大到 n 倍（改 width/height，viewBox 不动 → 矢量放大，正好检验路径质量）
const zoom = (s, n) => s.replace(/width="(\d+)"/, (_, w) => `width="${w * n}"`).replace(/height="(\d+)"/, (_, h) => `height="${h * n}"`)

const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T41 图标对照 · 上一级 / 刷新 / 回到底部</title>
<style>
  :root {
${dark}
  }
  html.light {
${light}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding: 22px 26px 44px; }
  h1 { font-size: 15px; margin-bottom: 3px; }
  .sub { font-size: 11.5px; color: var(--dim); margin-bottom: 18px; }
  .tools { position: fixed; top: 14px; right: 18px; z-index: 99; }
  .tools button { background: var(--text); color: var(--bg); border: 0; border-radius: 7px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
  section { margin-bottom: 26px; }
  h2 { font-size: 13px; margin-bottom: 9px; color: var(--text); }
  h2 span { font-weight: 400; color: var(--dim); font-size: 11.5px; }

  .pair { display: flex; gap: 22px; flex-wrap: wrap; }
  .side { flex: 1 1 330px; min-width: 290px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--panel2); }
  .side > .hd { font-size: 11.5px; font-weight: 700; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .side.bad > .hd { color: var(--err); }
  .side.good > .hd { color: var(--accent); }
  .side > .bd { padding: 12px; }
  .lbl { font-size: 10.5px; color: var(--dim); margin: 0 0 6px; }

  /* 文件管理工具条复刻（#fmBar：灰色 pane 上的一条） */
  .fmbar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--panel2); border-radius: 8px; }
  .fmpath { flex: 1; font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
  /* 改前按钮 */
  .b .btn-old { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; color: var(--text); width: 26px; height: 26px; font-size: 13px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  /* 改后按钮 */
  .g .btn-new { background: transparent; border: none; border-radius: 7px; color: var(--dim); width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .g .btn-new:hover { background: var(--panel); color: var(--accent); }

  /* 回到底部复刻 */
  .jbbox { display: flex; gap: 26px; align-items: center; }
  .jb-old { width: 38px; height: 38px; border-radius: 50%; background: var(--panel2); border: 1px solid var(--border); color: var(--dim); font-size: 16px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px var(--shadow); }
  .jb-new { width: 38px; height: 38px; border-radius: 50%; background: var(--panel2); border: 1px solid color-mix(in srgb, var(--border) 60%, transparent); color: var(--dim); display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 14px var(--shadow); }
  .jb-new:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--panel); }
  /* 同尺寸下把两者放在白底上，模仿它悬在白色消息卡片上的观感 */
  .onwhite { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; display: inline-flex; gap: 22px; align-items: center; }

  .zoomrow { display: flex; gap: 26px; align-items: flex-end; margin-top: 14px; padding-top: 12px; border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent); }
  .z { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .z .cap { font-size: 10px; color: var(--dim); }
  .z .glyph { color: var(--dim); font-size: 42px; line-height: 1; }
  .z svg { color: var(--dim); }
  .note { font-size: 11px; color: var(--dim); margin-top: 8px; line-height: 1.75; }
  .note b { color: var(--text); }
</style></head>
<body>
  <div class="tools"><button id="tg">切换主题</button></div>
  <h1>T41 图标对照：上一级 / 刷新 / 回到底部</h1>
  <div class="sub">「改后」的 SVG 直接从 <code>web/index.html</code> 抽取，色值从 <code>:root</code> / <code>html.light</code> 解析；放大行是 3 倍矢量放大，用来检验路径质量（文本字形放大会露细弱与锯齿）。把鼠标移到按钮上看 hover。</div>

  <section>
    <h2>① 文件管理工具条 <span>#fmBar · 灰面板上的一条</span></h2>
    <div class="pair">
      <div class="side bad"><div class="hd">改前</div><div class="bd">
        <div class="lbl">常驻白底 + 描边的方块 · 图标是文本 ↑ / ⟳</div>
        <div class="fmbar b">
          <button class="btn-old">↑</button>
          <span class="fmpath">…\\Documents\\Catpaw\\YYAgent\\yyagentd\\web</span>
          <button class="btn-old">⟳</button>
        </div>
      </div></div>
      <div class="side good"><div class="hd">改后</div><div class="bd">
        <div class="lbl">透明底 + dim 图标，hover 才浮浅底 · 图标改手绘 SVG</div>
        <div class="fmbar g">
          <button class="btn-new">${up}</button>
          <span class="fmpath">…\\Documents\\Catpaw\\YYAgent\\yyagentd\\web</span>
          <button class="btn-new">${rf}</button>
        </div>
      </div></div>
    </div>
    <div class="zoomrow">
      <div class="z"><span class="glyph">↑</span><span class="cap">改前 文本字形 3×</span></div>
      <div class="z">${zoom(up, 3)}<span class="cap">改后 上箭头+顶横线 3×</span></div>
      <div class="z"><span class="glyph">⟳</span><span class="cap">改前 文本字形 3×</span></div>
      <div class="z">${zoom(rf, 3)}<span class="cap">改后 环形箭头 3×</span></div>
    </div>
    <div class="note">
      · 突兀的来源是<b>常驻白底 + 描边</b>：在灰面板上等于贴了两块白牌，视觉重量压过了路径文字。<br>
      · 现在改成和顶栏/侧栏图标按钮同一套：<b>透明底 + dim 图标</b>，只有 hover 才浮出浅底（<code>var(--panel)</code>）。<br>
      · 刷新图标复用回复操作条 <code>REGEN_SVG</code> 的同一条弧路径，全站环形箭头长得一样。
    </div>
  </section>

  <section>
    <h2>② 回到底部 <span>#jumpBottom · 悬在白色消息卡片右下</span></h2>
    <div class="pair">
      <div class="side bad"><div class="hd">改前</div><div class="bd">
        <div class="onwhite"><div class="jb-old">↓</div><span class="lbl" style="margin:0">文本 ↓ + 实心 1px 描边</span></div>
      </div></div>
      <div class="side good"><div class="hd">改后</div><div class="bd">
        <div class="onwhite"><div class="jb-new">${jb}</div><span class="lbl" style="margin:0">SVG 下箭头+底横线 + 半透明描边</span></div>
      </div></div>
    </div>
    <div class="zoomrow">
      <div class="z"><span class="glyph">↓</span><span class="cap">改前 文本字形 3×</span></div>
      <div class="z">${zoom(jb, 3)}<span class="cap">改后 下箭头+底横线 3×</span></div>
    </div>
    <div class="note">
      · 描边由 <code>1px solid var(--border)</code> 改为 <b>半透明描边</b>（<code>color-mix(... 60%, transparent)</code>）
        并换柔投影，和实时预览卡片（T38 #pvWrap）用同一套「浮起」语言，不再是生硬的灰圈。<br>
      · 图标与「上一级」互为镜像（一个顶横线、一个底横线），也和回复操作条同一套 1.5px 线宽。
    </div>
  </section>
<script>
  document.getElementById('tg').onclick = () => document.documentElement.classList.toggle('light')
</script>
</body></html>`

writeFileSync('scripts/t41-preview.html', out)
console.log('已生成 scripts/t41-preview.html（', out.length, 'bytes ）')
console.log('抽取到的 SVG 长度：上一级', up.length, '/ 刷新', rf.length, '/ 回到底部', jb.length)
