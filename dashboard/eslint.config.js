module.exports = [
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                // Node.js globals
                console: "readonly",
                process: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                require: "readonly",
                module: "readonly",
                exports: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                Buffer: "readonly",
                AbortSignal: "readonly",
                // Jest globals
                jest: "readonly",
                describe: "readonly",
                it: "readonly",
                expect: "readonly",
                beforeAll: "readonly",
                afterAll: "readonly",
                beforeEach: "readonly",
                afterEach: "readonly"
            }
        },
        rules: {
            "no-console": "warn",
            "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
        }
    }
];
