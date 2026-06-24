module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'tsx', 'jsx', 'json'],
  roots: ['<rootDir>'],
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  modulePathIgnorePatterns: ['node_modules'],
  globals: {
    'ts-jest': {
      tsconfig: {
        skipLibCheck: true,
        sourceMap: false,
      },
      diagnostics: false,
    },
  },
};