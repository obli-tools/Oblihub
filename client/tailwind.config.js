/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          primary:   'rgb(var(--c-bg-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--c-bg-tertiary)  / <alpha-value>)',
          hover:     'rgb(var(--c-bg-hover)     / <alpha-value>)',
          active:    'rgb(var(--c-bg-active)    / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--c-border)       / <alpha-value>)',
          light:   'rgb(var(--c-border-light) / <alpha-value>)',
        },
        text: {
          primary:   'rgb(var(--c-text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--c-text-muted)     / <alpha-value>)',
        },
        status: {
          up:               'rgb(var(--c-status-up)            / <alpha-value>)',
          'up-bg':          'rgb(var(--c-status-up-bg)         / <alpha-value>)',
          down:             'rgb(var(--c-status-down)          / <alpha-value>)',
          'down-bg':        'rgb(var(--c-status-down-bg)       / <alpha-value>)',
          pending:          'rgb(var(--c-status-pending)       / <alpha-value>)',
          'pending-bg':     'rgb(var(--c-status-pending-bg)    / <alpha-value>)',
          warning:          'rgb(var(--c-status-warning)       / <alpha-value>)',
          'warning-bg':     'rgb(var(--c-status-warning-bg)    / <alpha-value>)',
          critical:         'rgb(var(--c-status-critical)      / <alpha-value>)',
          'critical-bg':    'rgb(var(--c-status-critical-bg)   / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent)       / <alpha-value>)',
          hover:   'rgb(var(--c-accent-hover) / <alpha-value>)',
          dark:    'rgb(var(--c-accent-dark)  / <alpha-value>)',
        },
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
        // Obli Suite brand palette — used by the topbar app switcher.
        // Fixed so the dot colours stay recognisable across every theme.
        obli: {
          view:  '#2bc4bd',
          guard: '#f5a623',
          map:   '#1edd8a',
          ance:  '#e03a3a',
          hub:   '#2d4ec9',
          hub2:  '#5a78e8',
        },
      },
      fontFamily: {
        // Two-tier stack.
        // font-sans → Inter for body, nav, table rows
        // font-display → Rajdhani for headings + hero KPI values (≥ 24 px)
        // font-mono → JetBrains Mono for IDs / counts / timestamps
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Noto Sans',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        display: [
          'Rajdhani',
          'Inter',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
