// 宿主注入的全局与宿主提供的模块（factory require 运行时解析，编译期仅声明形状）。
// 注意：本文件必须保持"无顶层 import/export"的全局脚本形态，
// 否则 declare module 会退化为模块增强而非环境声明。
interface Window {
	__ModuleLoader__: {
		load(spec: {
			id: string;
			factory: (require: (id: string) => unknown) => unknown;
		}): void;
	};
}

declare module "@deepseek-ai/dsh-client-ui-primitives" {
	export const Tooltip: any;
	export const IconPaperclipOutline16: (props: { size?: number; className?: string }) => any;
}
