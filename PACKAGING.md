# 打包与发布（PACKAGING）

本仓库是 `gude55.pinduoduo-orders` 扩展的**源码仓库**。
最终分发给用户的制品是 `.ppext` 包，由扩展市场工具链生成并上传到本仓库 Release。

## 前置

- Node.js >= 22
- PackingProof 扩展市场工具链（`PackingProof-Extensions` 仓库）

```bash
git clone https://github.com/PackingProof/PackingProof-Extensions.git
cd PackingProof-Extensions
npm ci
```

## 打包

扩展项目目录（含 `manifest.json` 与 `payload/main.user.js`）位于本地工作区，
使用市场工具的 `ppext pack` 子命令：

```bash
# 在 PackingProof-Extensions 仓库根目录执行，projectDir 指向扩展项目
node tools/cli.mjs ppext pack <path-to-extension-project>

# 例如：生成 gude55.pinduoduo-orders-3.6.ppext
```

`ppext pack` 会按 `manifest.json` 把 `payload/main.user.js` 与 `README.md`
打包进 `{id}-{version}.ppext`，并通过市场 Schema 校验。

## 发布

1. 将生成的 `.ppext` 上传到本仓库的 GitHub Release（标签 `v3.6`）；
2. 资产文件名必须是 `gude55.pinduoduo-orders-3.6.ppext`；
3. 在 `PackingProof-Extensions` 仓库中运行投稿流程，登记
   `publishers/gude55.json`、`extensions/gude55.pinduoduo-orders/extension.json`
   与 `versions/3.6.json`，指向本仓库的源码标签与 Release 制品。

## 许可证

源码与制品均以 **AGPL-3.0-only** 发布，见 [LICENSE](./LICENSE)。
