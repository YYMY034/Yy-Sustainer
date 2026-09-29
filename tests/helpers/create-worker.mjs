// T92 单测辅助进程：并发建会话，用来真刀真枪地验证 index 的跨进程锁。
// 由 tests/store.test.ts 通过 `node --import tsx tests/helpers/create-worker.mjs <n> <tag>` 拉起。
// 注意：它继承父进程的 USERPROFILE/HOME（沙箱），所以只写测试沙箱，不碰真实数据。
const { createSession } = await import("../../src/session/store.js")

const n = Number(process.argv[2] ?? "5")
const tag = process.argv[3] ?? String(process.pid)

for (let i = 0; i < n; i++) {
  createSession(process.cwd(), undefined, `${tag}-${i}`)
}

process.stdout.write(`ok ${tag} ${n}\n`)
