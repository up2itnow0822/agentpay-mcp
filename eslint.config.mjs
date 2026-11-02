import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-undef": "off", // TypeScript handles this
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "prefer-const": "warn",
      "eqeqeq": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    }
  },
  {
    // SEC-20261102-MCPCI F1: src/ must never reach a shell or evaluate strings.
    files: ["src/**/*.ts", "src/**/*.mts", "src/**/*.cts", "src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parser: tsParser,
    },
    rules: {
      "no-restricted-globals": ["error", { name: "Function", message: "src/ must not reference the Function constructor (SEC-20261102-MCPCI)." }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": ["error", {
        paths: [
          { name: "child_process", message: "src/ must not use child_process (SEC-20261102-MCPCI)." },
          { name: "node:child_process", message: "src/ must not use child_process (SEC-20261102-MCPCI)." },
        ],
      }],
      "no-restricted-syntax": ["error",
        { selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]", message: "src/ must not require child_process (SEC-20261102-MCPCI)." },
        { selector: "ImportExpression[source.value=/^(node:)?child_process$/]", message: "src/ must not dynamically import child_process (SEC-20261102-MCPCI)." },
        { selector: "TSImportEqualsDeclaration[moduleReference.expression.value=/^(node:)?child_process$/]", message: "src/ must not import child_process (SEC-20261102-MCPCI)." },
        { selector: "CallExpression[callee.name='require'] > TemplateLiteral.arguments[expressions.length=0][quasis.0.value.cooked=/^(node:)?child_process$/]", message: "src/ must not require child_process (SEC-20261102-MCPCI)." },
        { selector: "ImportExpression > TemplateLiteral.source[expressions.length=0][quasis.0.value.cooked=/^(node:)?child_process$/]", message: "src/ must not dynamically import child_process (SEC-20261102-MCPCI)." },
        { selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']", message: "src/ must not use Function constructor (SEC-20261102-MCPCI)." },
        { selector: "MemberExpression[object.name=/^(globalThis|global|window|self)$/][property.name='Function']", message: "src/ must not reference the Function constructor (SEC-20261102-MCPCI)." },
      ],
    },
  }
];
