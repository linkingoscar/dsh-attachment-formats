import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // lib/client.js 是 tsdown 构建产物（打包后无 import 语句，no-undef 必然误报）；
    // 源码真身在 src/client/，由下方 lib 规则同款配置覆盖。
    ignores: ["node_modules/**", "temp/**", ".venv/**", "vendor/**", "dist/**", "build/**", "lib/client.js"]
  },
  {
    files: ["lib/**/*.js", "src/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {},
    rules: {
      ...js.configs.recommended.rules,
      // 核心正确性规则（useCallback 这类未定义引用在此被拦下）
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-useless-catch": "warn",
      "no-constant-binary-expression": "error"
    }
  }
];
