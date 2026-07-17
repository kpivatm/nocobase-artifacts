module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.ts'],
  globals: {
    'ts-jest': {
      tsconfig: {
        target: 'ES2019',
        module: 'commonjs',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false,
      },
    },
  },
};
