import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          // Theme-aware colors using CSS variables
          bg: "var(--bg-primary)",
          surface: "var(--bg-surface)",
          elevated: "var(--bg-elevated)",
          border: "var(--border)",
          "border-bright": "var(--border-bright)",
          
          green: "var(--accent-primary)",
          cyan: "var(--accent-secondary)",
          amber: "var(--accent-tertiary)",
          
          red: "var(--error)",
          yellow: "var(--warning)",
          purple: "var(--info)",
          
          dim: "var(--text-dim)",
          text: "var(--text-primary)",
          "text-secondary": "var(--text-secondary)",
          
          // Semantic colors
          success: "var(--success)",
          warning: "var(--warning)",
          error: "var(--error)",
          info: "var(--info)",
        },
      },
      fontFamily: {
        mono: ["var(--font-primary)", "JetBrains Mono", "Fira Code", "Monaco", "monospace"],
        display: ["var(--font-display)", "Space Grotesk", "Inter", "sans-serif"],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        glow: "0 0 20px var(--glow-primary)",
        "glow-secondary": "0 0 20px var(--glow-secondary)",
      },
      animation: {
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        blink: "blink 1s step-end infinite",
        shimmer: "shimmer 3s ease-in-out infinite",
        flicker: "flicker 2s ease-in-out infinite",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        shimmer: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.85" },
          "75%": { opacity: "0.95" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
