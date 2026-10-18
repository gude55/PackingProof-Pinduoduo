# 打包与发布（PACKAGING）

本仓库是 `gude55.pinduoduo-orders` 扩展的**源码仓库**。
最终分发给用户的制品是 `.ppext` 包，由本仓库的 [`pack/pack.mjs`](./pack/pack.mjs) 生成，
并上传到本仓库的 GitHub Release。

## 为什么不用官方 `ppext pack`

官方 `ppext pack`（PackingProof-Extensions 的 `tools/cli.mjs`）在生成包内
`manifest.json` 时，会把 `access` **固定写成空数组**（`expandAuthorManifest()` 硬编码），
而市场登记文件 `versions/<version>.json` 需要声明真实权限。
两者不一致会导致市场 CI 的 `npm run verify:changed` 报错：

```
manifest.access 与市场清单不一致
```

因此本仓库改用 `pack/pack.mjs`：用同一份 [`pack/manifest.json`](./pack/manifest.json)
（其 `access` 与市场 `versions/3.6.json` 完全一致）直接打包，保证可复现、可通过 CI。

## 前置

- Node.js >= 22
- 本仓库（含 `pinduoduo-order-push.user.js`、`pack/manifest.json`、`pack/pack.mjs`）
- 一份已 `npm ci` 的 [PackingProof-Extensions](https://github.com/PackingProof/PackingProof-Extensions)
  克隆（用于提供 `yazl` 依赖与官方 Schema 校验器）

## 打包

```bash
node pack/pack.mjs --source . --market /path/to/PackingProof-Extensions \
  --out gude55.pinduoduo-orders-3.6.ppext
```

脚本会：

1. 读取 `pack/manifest.json`（含 `access`），按 `stableJson` 规范化后作为包内 `manifest.json`；
2. 把 `pinduoduo-order-push.user.js` 作为 `payload/main.user.js` 打入包内；
3. 校验油猴脚本 `@version` 与 `manifest.version` 一致；
4. 以固定时间戳（2000-01-01）与固定权限位（0644）打包，保证字节级可复现；
5. 若提供 `--market`，则调用官方 `validatePackage` 自检，并自动用市场
   `extensions/gude55.pinduoduo-orders/versions/<version>.json` 的 `access` /
   `compatibility` 与包内 manifest 做深度比对（即市场 CI 的同款检查）。

## 修改权限声明

同时改两处，确保完全一致：

- 本仓库 [`pack/manifest.json`](./pack/manifest.json) 的 `access`
- 市场仓库 `extensions/gude55.pinduoduo-orders/versions/<version>.json` 的 `access`

然后重新打包、上传 Release、更新市场 `versions/<version>.json` 的 `sha256` / `size`。

## 发布

1. 将生成的 `.ppext` 上传到本仓库 GitHub Release（标签 `v3.6`）；
2. 资产文件名必须是 `gude55.pinduoduo-orders-3.6.ppext`；
3. 在市场仓库登记 `publishers/gude55.json`、`extensions/gude55.pinduoduo-orders/extension.json`
   与 `versions/3.6.json`，指向本仓库的源码标签与 Release 制品。

## 目录说明

```
.
├── pinduoduo-order-push.user.js   # 油猴脚本源码（同时是打包 payload）
├── pack/
│   ├── manifest.json              # 打入 .ppext 的包内 manifest（含 access）
│   └── pack.mjs                   # 确定性打包脚本
├── PACKAGING.md
├── README.md
└── LICENSE                        # AGPL-3.0-only
```

## 许可证

源码与制品均以 **AGPL-3.0-only** 发布，见 [LICENSE](./LICENSE)。
