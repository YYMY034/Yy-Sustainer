/**
 * T92 网关监听地址决策
 *
 * 单独抽出来是因为它是**安全默认**的一部分，值得有测试盯着：
 * 这个判断错了，等于把 agent 的 HTTP 端口默默开到整个局域网。
 * （原来默认 0.0.0.0，公共 Wi-Fi 下同网段任何人扫到端口就能看到这个 agent 的存在。）
 *
 * 优先级：显式环境变量 > 配置开关 > 最安全的默认。
 * 环境变量优先是为了「一次性调试」方便（YYAGENT_HOST=0.0.0.0 npm run gateway），
 * 不需要为了试一次就去改配置文件。
 */

export const LOCAL_HOST = "127.0.0.1"
export const ANY_HOST = "0.0.0.0"

/** 按优先级算出该监听哪个地址 */
export function resolveListenHost(envHost: string | undefined, lanShare: boolean | undefined): string {
  const env = envHost?.trim()
  if (env) return env
  return lanShare === true ? ANY_HOST : LOCAL_HOST
}

/** 该监听地址是否对外（局域网可访问）——用于启动日志与分享链接提示 */
export function isLanShare(host: string): boolean {
  return host === ANY_HOST || host === "::" || host === "[::]"
}
