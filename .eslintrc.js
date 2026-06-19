module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2021: true
    },
    extends: ['eslint:recommended', 'plugin:vue/vue3-recommended', 'prettier'],
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parser: '@babel/eslint-parser',
        requireConfigFile: false
    },
    plugins: ['vue', 'import'],
    rules: {
        'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
        'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
        'vue/multi-word-component-names': 'off',
        'vue/html-self-closing': 'warn',
        'vue/attribute-hyphenation': 'warn',
        'vue/v-on-event-hyphenation': 'warn',
        'vue/attributes-order': 'warn',
        'vue/valid-define-emits': 'warn',
        'no-unused-vars': [
            'warn',
            {
                vars: 'all',
                varsIgnorePattern: '^_',
                argsIgnorePattern: '^_'
            }
        ],
        'no-case-declarations': 'warn',
        'no-undef': 'error',
        'no-dupe-keys': 'error',
        eqeqeq: ['error', 'always']
    },
    overrides: [
        {
            // For Electron files using CommonJS
            files: ['electron/**/*.js'],
            parserOptions: {
                sourceType: 'script',
                ecmaVersion: 2020
            },
            env: {
                node: true,
                browser: false
            },
            globals: {
                BigInt: 'readonly'
            },
            rules: {
                'import/no-commonjs': 'off',
                'import/no-nodejs-modules': 'off'
            }
        },
        {
            // For src files using ES modules
            files: ['src/**/*.js', 'src/**/*.vue'],
            parserOptions: {
                sourceType: 'module',
                ecmaVersion: 2022
            },
            env: {
                browser: true,
                node: false
            },
            rules: {
                'import/no-commonjs': 'error'
            }
        }
    ]
};
