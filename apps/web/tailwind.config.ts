import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9ebff',
          500: '#1d4ed8',
          600: '#1e40af',
          700: '#1e3a8a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
