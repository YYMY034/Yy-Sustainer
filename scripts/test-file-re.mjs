// 测试 render() 里的文件路径正则对两种斜杠格式的匹配
const content1 = "已生成图片：C:/Users/YYMY/AppData/Local/Temp/testimg.png"
const content2 = "已生成图片：C:\\Users\\YYMY\\AppData\\Local\\Temp\\testimg.png"
const fileRe = /(C:[\\/][^"'`\s()<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg|csv|xlsx?|docx?|pdf|mp4|zip))/gi
console.log("forward-slash match:", fileRe.exec(content1)?.[0] ?? "NO MATCH")
fileRe.lastIndex = 0
console.log("backslash match:", fileRe.exec(content2)?.[0] ?? "NO MATCH")
