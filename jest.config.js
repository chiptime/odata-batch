/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tests/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'tsx', 'jsx', 'json'],
    roots: ['<rootDir>'],
    collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
    testPathIgnorePatterns: ['/node_modules/'],
    modulePathIgnorePatterns: ['node_modules'],
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    sourceMap: true,
                },
            },
        ],
    },
};
