import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/next-env.d.ts', 'packages/api-client/src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use injected Clock instead of new Date().' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use injected Clock instead of Date.now().' },
      ],
    },
  },
  { files: ['**/*.test.ts', '**/clock*.ts', '**/*.config.*'], rules: { 'no-restricted-syntax': 'off' } },
);
