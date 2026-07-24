import js from "@eslint/js";
import tseslint from "typescript-eslint";

const noCommentsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Forbid all comments. Code must be self-documenting.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const comments = sourceCode.getAllComments();
        for (const comment of comments) {
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
    ignores: [
      "node_modules/",
      ".git/",
      "dist/",
      ".tmp/",
    ],
  },
);
