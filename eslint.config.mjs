import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import ghostboxPlugin from "./eslint-rules/ghostbox-plugin.mjs";

const tsFiles = ["**/*.{ts,tsx}"];

export default [
  // Global ignores
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/docker/**", "**/web/**", "**/native/**", "**/*.d.ts"]
  },
  // TypeScript files - typed rules + custom ghostbox rules only
  // Biome handles formatting and standard lint. ESLint handles what Biome cannot.
  {
    files: tsFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        projectService: {
          allowDefaultProject: ["*.mjs", "*.js"]
        },
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.node,
        Bun: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      ghostbox: ghostboxPlugin
    },
    rules: {
      // --- Typed rules (Biome cannot do these) ---
      // TODO: promote to "error" once pre-existing violations are fixed
      "@typescript-eslint/no-unnecessary-condition": ["warn", { allowConstantLoopConditions: true }],
      "@typescript-eslint/no-floating-promises": ["warn", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],

      // --- Custom ghostbox rules ---
      "ghostbox/no-console-in-services": "error",
      "ghostbox/no-shell-delete": "error",
      "ghostbox/no-lint-suppression-comments": "error",
      "ghostbox/no-docker-cli-in-orchestrator": "error",

      // --- Disable everything Biome already handles ---
      "no-undef": "off",
      "no-console": "off",
      "no-unused-vars": "off"
    }
  },
  // Test files - relax typed rules
  {
    files: ["tests/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "ghostbox/no-console-in-services": "off",
      "ghostbox/no-shell-delete": "off"
    }
  }
];
