/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // 主题色走 CSS Variables，便于高对比度 / 色盲友好主题切换（NFR-7）
        bg: 'var(--tl-bg)',
        surface: 'var(--tl-surface)',
        border: 'var(--tl-border)',
        fg: 'var(--tl-fg)',
        muted: 'var(--tl-fg-muted)',
        accent: 'var(--tl-accent)',
        // 术语标注三态（FR-4.2 / FR-4.3）
        'term-idle': 'var(--tl-term-idle)',
        'term-hover': 'var(--tl-term-hover)',
        'term-active': 'var(--tl-term-active)'
      },
      transitionDuration: { 150: '150ms' }
    }
  },
  plugins: []
}
