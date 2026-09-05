const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
    ...jestConfig,
    modulePathIgnorePatterns: ['<rootDir>/.localdevserver'],
    moduleNameMapper: {
        ...jestConfig.moduleNameMapper,
        // Only exists inside the MCN builder; see the stub for why the panel needs it.
        '^experience/cmsEditorApi$': '<rootDir>/force-app/test/jest-mocks/experience/cmsEditorApi'
    }
};
