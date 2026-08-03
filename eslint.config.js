import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  /*
   * The core boundary, enforced rather than documented.
   *
   * @voice/core holds the loop and the state machines and must stay free of I/O, so it
   * can be unit-tested exhaustively and driven by something other than a browser. The
   * tsconfig already withholds Node's type definitions; this closes the runtime side by
   * banning the imports outright — including the provider SDKs, which would smuggle a
   * network dependency into the one package that must not have one.
   */
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'net', 'ws'],
              message:
                '@voice/core must stay I/O-free. Put transport and platform code in @voice/providers or an app.',
            },
            {
              group: ['@deepgram/*', '@anthropic-ai/*', 'elevenlabs*', 'openai'],
              message:
                '@voice/core must not depend on a provider SDK. Implement the interface in @voice/providers instead.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /*
   * AudioWorklet code runs in AudioWorkletGlobalScope, not a window or a worker, so
   * its globals are declared nowhere else. This is the price of serving the worklet
   * as a static file rather than routing it through the bundler — a trade made
   * deliberately, since `addModule` fetches a URL and a dev-versus-build discrepancy
   * there would only surface in production.
   */
  {
    files: ['apps/web/public/worklets/*.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
);
