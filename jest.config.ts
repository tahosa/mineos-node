import { type JestConfigWithTsJest, createDefaultPreset } from 'ts-jest';

const config: JestConfigWithTsJest = {
  // A preset that is used as a base for Jest's configuration
  ...createDefaultPreset(),

  // Automatically clear mock calls, instances, contexts and results before every test
  clearMocks: true,

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/lib/memoize.ts'],

  // The directory where Jest should output its coverage files
  coverageDirectory: 'coverage',

  // An array of regexp pattern strings used to skip coverage collection
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'src/profiles.d/'
  ],

  // Indicates which provider should be used to instrument code for coverage
  coverageProvider: 'v8',

  // A list of reporter names that Jest uses when writing coverage reports
  coverageReporters: [ 'text', 'html' ],
};

export default config;
