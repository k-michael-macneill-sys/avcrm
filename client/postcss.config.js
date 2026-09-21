const path = require('node:path');

// Resolved from this file's directory rather than left implicit: Vite is
// invoked as `vite build --config client/vite.config.ts` from the repo
// root, and postcss's default config lookup is relative to the process's
// cwd, which would miss client/tailwind.config.ts entirely.
module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.ts') },
    autoprefixer: {},
  },
};
