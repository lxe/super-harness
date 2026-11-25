import type { Preview } from '@storybook/react';
import '../src/renderer/styles.css';

// Provide a harmless mock window.superHarness for composite stories
if (typeof window !== 'undefined' && !window.superHarness) {
  (window as unknown as Record<string, unknown>).superHarness = {
    openExternalUrl: async (url: string) => {
      console.info('[Storybook mock] openExternalUrl:', url);
      return { ok: true };
    },
  };
}

const preview: Preview = {
  parameters: {
    layout: 'centered',
    backgrounds: {
      default: 'Canvas (#16171b)',
      values: [
        { name: 'Canvas (#16171b)', value: '#16171b' },
        { name: 'Rail (#111215)', value: '#111215' },
        { name: 'Code (#101114)', value: '#101114' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
