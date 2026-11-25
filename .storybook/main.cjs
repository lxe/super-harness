const path = require('node:path');

/** @type {import('@storybook/react-vite').StorybookConfig} */
module.exports = {
  stories: ['../src/renderer/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {
      builder: {
        viteConfigPath: path.resolve(__dirname, 'vite.config.ts'),
      },
    },
  },
};
