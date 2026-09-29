/**
 * T92 监听地址决策单测
 *
 * 这是「安全默认」的守门人：默认必须是仅本机。
 * 写错了不是功能 bug，而是把端口默默开到局域网——所以哪怕逻辑只有三行也要有测试。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { ANY_HOST, LOCAL_HOST, isLanShare, resolveListenHost } from "../src/util/net.js"

test("默认（无 env、无配置）只监听本机", () => {
  assert.equal(resolveListenHost(undefined, undefined), LOCAL_HOST)
  assert.equal(resolveListenHost(undefined, false), LOCAL_HOST)
})

test("配置里显式开 lanShare 才对外", () => {
  assert.equal(resolveListenHost(undefined, true), ANY_HOST)
})

test("只有 lanShare === true 才算开启（truthy 值不算）", () => {
  // 用 as 绕过类型，模拟配置文件里被手写成了字符串/数字
  assert.equal(resolveListenHost(undefined, "true" as unknown as boolean), LOCAL_HOST)
  assert.equal(resolveListenHost(undefined, 1 as unknown as boolean), LOCAL_HOST)
})

test("环境变量优先于配置（一次性调试用）", () => {
  assert.equal(resolveListenHost("0.0.0.0", false), ANY_HOST)
  assert.equal(resolveListenHost("127.0.0.1", true), LOCAL_HOST)
  assert.equal(resolveListenHost("192.168.1.5", true), "192.168.1.5")
})

test("环境变量是空白串时视为没设", () => {
  assert.equal(resolveListenHost("   ", true), ANY_HOST)
  assert.equal(resolveListenHost("", undefined), LOCAL_HOST)
})

test("isLanShare 认得各种「对外」写法", () => {
  assert.equal(isLanShare(ANY_HOST), true)
  assert.equal(isLanShare("::"), true)
  assert.equal(isLanShare("[::]"), true)
  assert.equal(isLanShare(LOCAL_HOST), false)
  assert.equal(isLanShare("192.168.1.5"), false, "绑到具体网卡地址不算「全对外」，但也确实对外——这里只判通配")
})
