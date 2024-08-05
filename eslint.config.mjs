import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const config = {
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    quotes: ["error", "single"],
    "block-spacing": "off",
    "@typescript-eslint/block-spacing": "error",
    "@typescript-eslint/ban-ts-comment": "off",
    "no-case-declarations": "off",
    "no-control-regex": "off",
  },
};

export default [
  { files: ["**/*.{js,ts}"] },
  { ignores: ["html/**", "dist/**"] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  config,
];
