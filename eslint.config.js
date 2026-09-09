import { defineConfig } from 'eslint/config'
import eslintConfigXo from 'eslint-config-xo'
import boundaries from 'eslint-plugin-boundaries'
import sonarjs from 'eslint-plugin-sonarjs'

const projectFiles = ['**/*.{js,mjs,cjs,ts}']
const replFiles = ['plugins/repl/**/*.{ts,mjs}']

const noFunctionScopedDynamicLoads = [
  ['FunctionDeclaration ImportExpression', 'Dynamic import() is not allowed inside functions'],
  ['FunctionExpression ImportExpression', 'Dynamic import() is not allowed inside functions'],
  ['ArrowFunctionExpression ImportExpression', 'Dynamic import() is not allowed inside functions'],
  [
    "FunctionDeclaration CallExpression[callee.name='require']",
    'require() is not allowed inside functions'
  ],
  [
    "FunctionExpression CallExpression[callee.name='require']",
    'require() is not allowed inside functions'
  ],
  [
    "ArrowFunctionExpression CallExpression[callee.name='require']",
    'require() is not allowed inside functions'
  ]
].map(([selector, message]) => ({ selector, message }))

const architecturePolicies = [
  { allow: { to: { module: { origin: ['external', 'core'] } } } },
  {
    from: { file: { categories: 'entry' } },
    allow: { to: { file: { categories: ['core', 'contracts'] } } }
  },
  {
    from: { file: { categories: 'core' } },
    allow: { to: { file: { categories: ['core', 'contracts', 'adapter'] } } }
  },
  {
    from: { file: { categories: 'adapter' } },
    allow: { to: { file: { categories: ['adapter', 'contracts', 'utils'] } } }
  },
  {
    from: { file: { categories: 'contracts' } },
    allow: { to: { file: { categories: 'contracts' } } }
  },
  {
    from: { file: { categories: 'utils' } },
    allow: { to: { file: { categories: 'utils' } } }
  },
  {
    from: { file: { categories: 'worker' } },
    allow: { to: { file: { categories: 'worker' } } }
  }
]

const config = defineConfig([
  {
    ignores: ['node_modules/**', '.opencode/**', 'dist/**', 'build/**', 'coverage/**']
  },
  ...eslintConfigXo({
    space: true,
    semicolon: false,
    prettier: 'compat',
    gitignore: import.meta.url
  }),
  {
    files: ['**/package.json'],
    rules: {
      // Required by the OpenCode beta deployment contract.
      'package-json/no-dist-tag-dependencies': 'off',
      // Effect must stay pinned to the version source-gated against OpenCode beta.
      'package-json/dependency-version-range': [
        'error',
        { range: 'caret', exceptions: ['effect'] }
      ],
      // The plugin host is not the external Node >=26 interpreter.
      'package-json/require-engines': 'off'
    }
  },
  {
    files: projectFiles,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module'
    },
    plugins: {
      sonarjs
    },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 4],
      'import-x/no-cycle': 'error',
      complexity: ['error', 4],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...noFunctionScopedDynamicLoads]
    }
  },
  {
    files: replFiles,
    plugins: {
      boundaries
    },
    settings: {
      'boundaries/files-single-match': true,
      'boundaries/files': [
        { pattern: 'plugins/repl/index.ts', category: 'entry' },
        {
          pattern: [
            'plugins/repl/src/runtime.ts',
            'plugins/repl/src/runtime/**/*.ts',
            'plugins/repl/src/output-ring.ts'
          ],
          category: 'core'
        },
        { pattern: 'plugins/repl/src/model.ts', category: 'contracts' },
        { pattern: 'plugins/repl/src/adapters/**/*.ts', category: 'adapter' },
        { pattern: 'plugins/repl/src/ndjson.ts', category: 'utils' },
        { pattern: 'plugins/repl/workers/*.mjs', category: 'worker' }
      ]
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          checkUnknownLocals: true,
          policies: architecturePolicies
        }
      ]
    }
  }
])

export default config
