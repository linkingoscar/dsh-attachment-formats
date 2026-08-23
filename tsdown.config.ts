import { defineConfig } from "tsdown";

// 浏览器半区打包：src/client/* → lib/client.js（__ModuleLoader__ 单文件 factory）。
// dsh 插件机制加载的是构建产物；源码拆域对齐 ui-conversation 的 src/client 组织。
export default defineConfig([
	{
		entry: { client: "src/client/index.js" },
		outDir: "lib",
		format: "es",
		platform: "browser",
		target: "es2022",
		minify: false,
		sourcemap: false,
		exports: false,
		// 关键：lib/ 同时承载宿主端源码（lib/index.js、lib/convert/* 等），
		// 绝不能清 outDir——曾因此整目录被删（已恢复）。
		clean: false,
	},
]);
