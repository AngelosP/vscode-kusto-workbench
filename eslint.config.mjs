import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        // Allow one-line control statements without braces; enforce braces for multi-line blocks.
        // This keeps lint clean without rewriting large existing files.
        curly: ["warn", "multi-line"],
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];