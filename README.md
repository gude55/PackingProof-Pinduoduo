# PackingProof-Pinduoduo

拼多多打单订单联动油猴脚本（PackingProof 扩展市场第三方扩展 `gude55.pinduoduo-orders`）的独立公开源码仓库。

## 功能

安装到浏览器脚本管理器（Tampermonkey / Violentmonkey）后，在拼多多官方打单页面
（待打印 / 已发货 / 打印后变化订单）运行：

- 自动全量采集虚拟滚动列表中的订单（解决无限滚动导致漏单的问题）；
- 读取买家留言、卖家备注、商品明细、商品件数与快递单号；
- 将「待处理」的打印后变化订单推送到用户已配置的录像设备 / 上位机（PackingProof 体系）。

## 来源与许可

本脚本基于 **PackingProof 官方第三方油猴脚本开发规范** 实现：

- 官方扩展市场：<https://github.com/PackingProof/PackingProof-Extensions>
- 投稿规范：<https://github.com/PackingProof/PackingProof-Extensions/blob/main/docs/PUBLISHING.md>

源码以 **AGPL-3.0-only** 发布，完整许可证见 [LICENSE](./LICENSE)。

## 网络访问说明（重要）

脚本头部保留了 `@connect *`，用于让用户自定义局域网录像设备 / 上位机地址
（如 `192.168.x.x` 上的 `/api/storage`、`/api/orderinfo` 等接口）。
因此本脚本**会向用户配置的局域网设备发起请求**。具体的连接目标由用户在
PackingProof 安装向导中注入，不会在代码中写死任何外部地址。

安装向导会按当前设备注入本地的
`/api/userscripts/{scriptId}/download.user.js` 作为更新地址，无需手动配置。

## 安装

1. 通过 PackingProof 扩展市场安装扩展 `gude55.pinduoduo-orders`（推荐）；
2. 或直接将本项目 `pinduoduo-order-push.user.js` 导入 Tampermonkey / Violentmonkey。

## 打包与发布

打包流程见 [PACKAGING.md](./PACKAGING.md)。
发布的稳定制品（`.ppext`）统一存放在本仓库的 GitHub Release `v3.6` 中。
