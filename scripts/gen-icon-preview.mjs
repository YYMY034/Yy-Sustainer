// 生成「图标对照预览」：从 web/index.html 里直接抽取真实的 FM_* 常量块 + fmIcon，
// 用同一函数渲染「文件管理」和「产物」两份列表，用来肉眼确认两侧图标一致。
// 运行：node scripts/gen-icon-preview.mjs  →  产出 scripts/icon-compare-preview.html
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const start = script.indexOf('const FM_FOLDER_PATH')
const end = script.indexOf('\n}', script.indexOf('function fmIcon')) + 2
const fmBlock = script.slice(start, end)

const FILES = [
  ['src', true], ['web', true], ['AGENT-WHITEPAPER.md', false], ['gateway.ts', false], ['tools.py', false],
  ['index.html', false], ['styles.css', false], ['package.json', false], ['config.yml', false],
  ['app.js', false], ['view.tsx', false], ['logo.png', false], ['data.xlsx', false], ['docs.pdf', false],
  ['notes.txt', false], ['archive.zip', false], ['run.sh', false], ['main.go', false], ['lib.rs', false],
  ['unknown.xyzzy', false], ['Makefile', false],
]
const TAGS = ['new', 'edit', '']

const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>图标对照预览 · 文件管理 vs 产物</title>
<style>
  :root { --bg:#17191c; --panel:#1f2226; --panel2:#26292e; --border:#33373d; --text:#e6e8ea; --dim:#8b9198; --accent:#3fb6a8; --user:#4fc26a; --hover:#2b2f34; --shadow:rgba(0,0,0,.35); }
  html.light { --bg:#eef0f2; --panel:#ffffff; --panel2:#e6e9ec; --border:#d2d6da; --text:#1c1f22; --dim:#6b7278; --accent:#0f9488; --user:#2f9e4f; --hover:#f3f5f7; --shadow:rgba(0,0,0,.1); }
  * { box-sizing: border-box; }
  body { margin:0; padding:26px 30px 40px; background:var(--bg); color:var(--text);
         font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:16px; margin:0 0 4px; }
  .sub { font-size:12px; color:var(--dim); margin-bottom:18px; }
  .sub code { background:var(--panel2); padding:1px 5px; border-radius:4px; }
  .tools { position:fixed; top:16px; right:20px; }
  .tools button { background:var(--text); color:var(--bg); border:0; border-radius:7px; padding:6px 12px;
                  font-size:12px; cursor:pointer; }
  .cols { display:flex; gap:22px; align-items:flex-start; flex-wrap:wrap; }
  .col { flex:1 1 380px; min-width:330px; background:var(--panel); border:1px solid var(--border);
         border-radius:12px; overflow:hidden; box-shadow:0 3px 14px var(--shadow); }
  .col > h2 { font-size:12.5px; margin:0; padding:11px 14px; color:var(--dim); font-weight:600;
              background:linear-gradient(to bottom, var(--panel2), color-mix(in srgb, var(--panel2) 40%, var(--panel))); }
  .pad { padding:8px; }

  /* 文件管理：与 web/index.html 的 .fm-item 一致 */
  .fm-item { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:8px;
             cursor:pointer; font-size:12.5px; color:var(--text); }
  .fm-item:hover { background:var(--panel); }
  .fm-item > svg { flex-shrink:0; }
  .fm-item .fnm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .fm-item .fmeta { font-size:10.5px; color:var(--dim); flex-shrink:0; }

  /* 产物区：与 web/index.html 的 .artifacts 一致 */
  .artifacts { border:1px solid color-mix(in srgb, var(--border) 60%, transparent); border-radius:12px;
               overflow:hidden; background:var(--panel2); }
  .artifacts .art-title { display:flex; align-items:center; gap:7px; padding:9px 12px; font-size:12px;
                          color:var(--dim); background:var(--panel2);
                          border-bottom:1px solid color-mix(in srgb, var(--border) 55%, transparent); }
  .artifacts .art-title .cnt { margin-left:auto; font-size:10.5px; }
  .artifacts .art-item { display:flex; align-items:center; gap:8px; padding:6px 10px; font-size:12px;
                         cursor:pointer; background:var(--panel); }
  .artifacts .art-item + .art-item { border-top:1px solid color-mix(in srgb, var(--border) 55%, transparent); }
  .artifacts .art-item:hover { background:var(--hover); }
  .artifacts .art-item .aico { display:flex; align-items:center; flex-shrink:0; }
  .artifacts .art-item .anm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                              font-family:Consolas,monospace; font-size:11.5px; }
  .artifacts .art-item .atag { margin-left:auto; font-size:10.5px; color:var(--dim); flex-shrink:0; }
  .artifacts .art-item .atag.new { color:var(--accent); }
  .artifacts .art-item .atag.edit { color:var(--user); }
  .artifacts .art-item .adl { flex-shrink:0; color:var(--dim); display:flex; align-items:center;
                              padding:3px; border-radius:5px; }
  .artifacts .art-item .adl:hover { color:var(--accent); background:var(--panel); }
</style></head>
<body>
  <div class="tools"><button id="tg">切换主题</button></div>
  <h1>图标对照预览：文件管理 vs 产物</h1>
  <div class="sub">两侧图标均调用 <code>web/index.html</code> 中同一个 <code>fmIcon(name, isDir)</code>，输出字符串级相同。</div>
  <div class="cols">
    <div class="col"><h2>文件管理（#fmList）</h2><div class="pad" id="fm"></div></div>
    <div class="col"><h2>产物（消息末尾 .artifacts）</h2><div class="pad" id="art"></div></div>
  </div>
<script>
${fmBlock}

const ART_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1.8" y="2.5" width="12.4" height="8.2" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 13.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6.2 5.2l2 2-2 2M9.2 9.2h1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const DL_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l3-3m-3 3L5 7M2.5 12.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const FILES = ${JSON.stringify(FILES)}
const TAGS = ${JSON.stringify(TAGS)}

const fmEl = document.getElementById('fm')
fmEl.innerHTML = FILES.map(([n, d]) =>
  '<div class="fm-item" data-dir="' + (d ? 1 : 0) + '">' + fmIcon(n, d) +
  '<span class="fnm">' + n + '</span>' +
  '<span class="fmeta">' + (d ? '文件夹' : (n.split('.').pop() || '—')) + '</span></div>').join('')

const artEl = document.getElementById('art')
const rows = FILES.filter(([, d]) => !d)
artEl.innerHTML = '<div class="artifacts">' +
  '<div class="art-title">' + ART_ICON + '<span>产物</span><span class="cnt">' + rows.length + ' 个文件 · 点击预览</span></div>' +
  rows.map(([n], i) => { const tag = TAGS[i % 3]
    return '<div class="art-item"><span class="aico">' + fmIcon(n) + '</span>' +
      '<span class="anm">' + n + '</span>' +
      (tag ? '<span class="atag ' + tag + '">' + (tag === 'new' ? '新建' : '已修改') + '</span>' : '<span class="atag">输出</span>') +
      '<span class="adl">' + DL_ICON + '</span></div>' }).join('') +
  '</div>'

document.getElementById('tg').onclick = () =>
  document.documentElement.classList.toggle('light')
</script>
</body></html>`

writeFileSync('scripts/icon-compare-preview.html', out)
console.log('已生成 scripts/icon-compare-preview.html，图标样本', FILES.length, '个（含 2 个文件夹）')
console.log('其中「产物」列渲染', FILES.filter(([, d]) => !d).length, '行')
