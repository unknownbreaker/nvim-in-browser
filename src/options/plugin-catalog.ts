// Curated shelf of vetted pure-Lua plugins that work inside the WASM sandbox
// (no processes, no network at runtime). Each entry is installed via the normal
// GitHub path with a blank ref, so the repo's default branch (main vs master)
// is auto-detected. `name` is the derived plugin name = the repo segment after
// the slash, matching how options-plugins derives it on install.
export interface CuratedPlugin {
  repo: string;
  name: string;
  blurb: string;
  category: string;
}

export const CURATED_PLUGINS: CuratedPlugin[] = [
  {
    repo: "folke/tokyonight.nvim",
    name: "tokyonight.nvim",
    blurb: "Clean dark colorscheme with several variants.",
    category: "Theme",
  },
  {
    repo: "catppuccin/nvim",
    name: "nvim",
    blurb: "Soothing pastel theme (Mocha/Latte/…).",
    category: "Theme",
  },
  {
    repo: "ellisonleao/gruvbox.nvim",
    name: "gruvbox.nvim",
    blurb: "Retro warm colorscheme.",
    category: "Theme",
  },
  {
    repo: "folke/which-key.nvim",
    name: "which-key.nvim",
    blurb: "Popup showing keybindings as you type.",
    category: "UX",
  },
  {
    repo: "echasnovski/mini.nvim",
    name: "mini.nvim",
    blurb: "Modular suite: pairs, comment, surround, statusline & more.",
    category: "Suite",
  },
  {
    repo: "numToStr/Comment.nvim",
    name: "Comment.nvim",
    blurb: "Smart comment toggling (gcc / gc motions).",
    category: "Editing",
  },
  {
    repo: "windwp/nvim-autopairs",
    name: "nvim-autopairs",
    blurb: "Auto-close brackets and quotes.",
    category: "Editing",
  },
  {
    repo: "lukas-reineke/indent-blankline.nvim",
    name: "indent-blankline.nvim",
    blurb: "Indentation guide lines.",
    category: "UX",
  },
];
