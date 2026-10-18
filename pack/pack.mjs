#!/usr/bin/env node
/**
 * 打包 gude55.pinduoduo-orders 的 .ppext（确定性构建）
 *
 * 为什么需要这个脚本：
 *   官方 ppext pack（PackingProof-Extensions 的 tools/cli.mjs）在生成包内 manifest.json 时，
 *   会把 access 固定写成空数组（expandAuthorManifest() 硬编码）；而市场登记文件
 *   versions/<version>.json 需要声明真实权限。两者不一致会让市场 CI 的
 *   `npm run verify:changed` 报错：manifest.access 与市场清单不一致。
 *   本脚本改用同一份 pack/manifest.json（其 access 与市场 versions/<version>.json
 *   完全一致）直接打包，保证可复现、可通过 CI。
 *
 * 用法：
 *   node pack/pack.mjs [--source <本仓库路径>] [--market <PackingProof-Extensions 路径>] [--out <输出 .ppext>]
 *
 *   --source  本仓库路径，默认取脚本上级目录
 *   --market  PackingProof-Extensions 克隆路径；提供后会从中解析 yazl 依赖，
 *             并调用官方 validatePackage 自检（含与市场 versions/<version>.json 的
 *             access / compatibility 深度比对，即 CI 同款检查）
 *   --out     输出文件，默认 <source>/<id>-<version>.ppext
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FIXED_ZIP_TIME = new Date("2000-01-01T00:00:00Z");

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function stableJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, normalize(input[key])]),
    );
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = path.resolve(args.source ?? path.resolve(import.meta.dirname, ".."));
  const market = args.market ? path.resolve(args.market) : null;

  const manifestPath = path.join(source, "pack", "manifest.json");
  const userscriptPath = path.join(source, "pinduoduo-order-push.user.js");
  const readmePath = path.join(source, "README.md");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const output = path.resolve(args.out ?? path.join(source, `${manifest.id}-${manifest.version}.ppext`));

  let yazl;
  try {
    // 优先从 --market 提供的 PackingProof-Extensions 克隆解析 yazl；
    // 也可以在本仓库执行 npm i yazl 后用本地 node_modules 解析。
    const require = createRequire(market ? path.join(market, "package.json") : import.meta.url);
    yazl = require("yazl");
  } catch (error) {
    throw new Error(
      `无法加载 yazl：${error.message}\n` +
      "请加 --market <PackingProof-Extensions 克隆路径>，或在本仓库执行 npm i yazl",
    );
  }

  // 与官方 validatePackage 相同的油猴脚本版本校验
  const userscript = await readFile(userscriptPath, "utf8");
  const versionMatch = userscript.match(/^\/\/\s*@version\s+([^\r\n]+)/m);
  if (!versionMatch) throw new Error(`${userscriptPath}: 油猴脚本缺少 @version`);
  const userscriptVersion = versionMatch[1].trim();
  if (userscriptVersion !== manifest.version) {
    throw new Error(`${userscriptPath}: @version(${userscriptVersion}) 与 manifest.version(${manifest.version}) 不一致`);
  }

  if (existsSync(output)) await rm(output, { force: true });

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(stableJson(manifest), "utf8"), "manifest.json", {
    mtime: FIXED_ZIP_TIME,
    mode: 0o100644,
  });
  zip.addFile(userscriptPath, manifest.installation.payloadPath, {
    mtime: FIXED_ZIP_TIME,
    mode: 0o100644,
  });
  if (existsSync(readmePath)) {
    zip.addFile(readmePath, "README.md", { mtime: FIXED_ZIP_TIME, mode: 0o100644 });
  }
  zip.end();

  const stream = createWriteStream(output, { flags: "wx" });
  zip.outputStream.pipe(stream);
  await once(stream, "close");

  const bytes = await readFile(output);
  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log(`PPEXT 已生成：${output}`);
  console.log(`size   = ${bytes.length}`);
  console.log(`sha256 = ${digest}`);

  if (market) {
    const { createSchemaValidator } = await import(
      pathToFileURL(path.join(market, "tools", "lib", "schemas.mjs")).href
    );
    const { validatePackage } = await import(
      pathToFileURL(path.join(market, "tools", "lib", "package-validator.mjs")).href
    );
    const schema = await createSchemaValidator(market);

    // 与市场 CI 的 verify:changed 同款检查：包内 manifest 的 access/compatibility
    // 必须与市场 versions/<version>.json 深度一致
    const versionDocumentPath = path.join(
      market,
      "extensions",
      manifest.id,
      "versions",
      `${manifest.version}.json`,
    );
    let expected = null;
    if (existsSync(versionDocumentPath)) {
      const version = JSON.parse(await readFile(versionDocumentPath, "utf8"));
      expected = {
        id: version.extensionId,
        version: version.version,
        type: manifest.type,
        compatibility: version.compatibility,
        access: version.access,
      };
      console.log(`已加载市场清单用于比对：${versionDocumentPath}`);
    } else {
      console.warn(`警告：未找到 ${versionDocumentPath}，跳过 access 一致性比对`);
    }

    validatePackage(output, schema, expected);
    console.log("官方 validatePackage 自检通过（Schema / 安装入口 / @version / access 一致性）");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
