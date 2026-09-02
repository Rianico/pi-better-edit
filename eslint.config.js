import js from "@eslint/js";
import tseslint from "typescript-eslint";

const GHERKIN_RE =
  /^\s*(Given|When|Then|And|But|Feature|Scenario|Background|Scenario Outline|Examples)\b/i;

const ALLOWLIST_RE =
  /(SAFETY:|WHY:|Invariant:|See ADR-|via https:\/\/|TODO\(#\d+\):|HACK:|@deprecated|eslint-disable)/;

const noCommentsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Allow only high-signal comments (SAFETY/WHY/Invariant/See ADR/via URL/TODO/HACK/Gherkin); see ADR-0014.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const comments = sourceCode.getAllComments();
        for (const comment of comments) {
          if (ALLOWLIST_RE.test(comment.value)) continue;
          if (GHERKIN_RE.test(comment.value)) continue;
          context.report({
            node: comment,
            message:
              "Comments are not allowed. The code must be self-documenting.",
          });
        }
      },
    };
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    plugins: {
      custom: {
        rules: {
          "no-comments": noCommentsRule,
        },
      },
    },
    rules: {
      "custom/no-comments": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      "custom/no-comments": "off",
    },
  },
  {
    ignores: ["node_modules/", ".git/", "dist/", ".tmp/"],
  },
);
