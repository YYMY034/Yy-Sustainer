/**
 * 向内核要一个空闲端口（探针起网关/假 provider 用）。
 * 为什么：探针原来各自硬编码端口（8799-8813/8889/8890/8891/18899）——端口被别的
 * 程序占用时探针会莫名失败，甚至更糟：连到错的服务上（check-t74 的 8899 就是这么
 * 被 IDE 自管 python 占掉的，分类断言红了一下午）。动态选端口把这一类环境硬假设
 * 一次清掉。竞态窗口极小，且真被抢了失败信息也明确。
 */
import net from "node:net"

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}
