export interface ThemeColors {
  // Primary action colors (buttons, links, active states)
  primary: string;
  primaryLight: string;
  primaryDark: string;
  // Accent / secondary
  accent: string;
  accentLight: string;
  // Gradients for headers, icons, decorative elements
  gradientFrom: string;
  gradientTo: string;
  // Sidebar
  sidebarBg: string;
  sidebarBgEnd: string;
  // Login background
  loginBgStart: string;
  loginBgEnd: string;
  // Focus ring
  focusRing: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cyan & Teal — Clean and modern',
    colors: {
      primary: '#0891b2',       // cyan-600
      primaryLight: '#ecfeff',  // cyan-50
      primaryDark: '#0e7490',   // cyan-700
      accent: '#0d9488',        // teal-600
      accentLight: '#f0fdfa',   // teal-50
      gradientFrom: '#0891b2',  // cyan-600
      gradientTo: '#2563eb',    // blue-600
      sidebarBg: '#164e63',     // cyan-900
      sidebarBgEnd: '#1e3a5f',
      loginBgStart: '#0f172a',
      loginBgEnd: '#164e63',
      focusRing: '#06b6d4',     // cyan-400
    },
  },
  {
    id: 'sapphire',
    name: 'Sapphire',
    description: 'Blue & Indigo — Corporate and formal',
    colors: {
      primary: '#2563eb',       // blue-600
      primaryLight: '#eff6ff',  // blue-50
      primaryDark: '#1d4ed8',   // blue-700
      accent: '#4f46e5',        // indigo-600
      accentLight: '#eef2ff',   // indigo-50
      gradientFrom: '#2563eb',
      gradientTo: '#4f46e5',
      sidebarBg: '#1e3a8a',     // blue-900
      sidebarBgEnd: '#312e81',  // indigo-900
      loginBgStart: '#0f172a',
      loginBgEnd: '#1e3a8a',
      focusRing: '#3b82f6',     // blue-500
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    description: 'Green & Emerald — Fresh and natural',
    colors: {
      primary: '#059669',       // emerald-600
      primaryLight: '#ecfdf5',  // emerald-50
      primaryDark: '#047857',   // emerald-700
      accent: '#0d9488',        // teal-600
      accentLight: '#f0fdfa',   // teal-50
      gradientFrom: '#059669',
      gradientTo: '#0d9488',
      sidebarBg: '#064e3b',     // emerald-900
      sidebarBgEnd: '#134e4a',  // teal-900
      loginBgStart: '#022c22',
      loginBgEnd: '#064e3b',
      focusRing: '#10b981',     // emerald-500
    },
  },
  {
    id: 'amethyst',
    name: 'Amethyst',
    description: 'Purple & Violet — Modern and creative',
    colors: {
      primary: '#7c3aed',       // violet-600
      primaryLight: '#f5f3ff',  // violet-50
      primaryDark: '#6d28d9',   // violet-700
      accent: '#db2777',        // pink-600
      accentLight: '#fdf2f8',   // pink-50
      gradientFrom: '#7c3aed',
      gradientTo: '#db2777',
      sidebarBg: '#4c1d95',     // violet-900
      sidebarBgEnd: '#581c87',  // purple-900
      loginBgStart: '#1e1b4b',
      loginBgEnd: '#4c1d95',
      focusRing: '#8b5cf6',     // violet-500
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Orange & Amber — Warm and energetic',
    colors: {
      primary: '#ea580c',       // orange-600
      primaryLight: '#fff7ed',  // orange-50
      primaryDark: '#c2410c',   // orange-700
      accent: '#d97706',        // amber-600
      accentLight: '#fffbeb',   // amber-50
      gradientFrom: '#ea580c',
      gradientTo: '#d97706',
      sidebarBg: '#7c2d12',     // orange-900
      sidebarBgEnd: '#78350f',  // amber-900
      loginBgStart: '#431407',
      loginBgEnd: '#7c2d12',
      focusRing: '#f97316',     // orange-500
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Gray & Slate — Minimal and neutral',
    colors: {
      primary: '#475569',       // slate-600
      primaryLight: '#f8fafc',  // slate-50
      primaryDark: '#334155',   // slate-700
      accent: '#0891b2',        // cyan-600
      accentLight: '#ecfeff',   // cyan-50
      gradientFrom: '#475569',
      gradientTo: '#334155',
      sidebarBg: '#1e293b',     // slate-800
      sidebarBgEnd: '#0f172a',  // slate-900
      loginBgStart: '#0f172a',
      loginBgEnd: '#1e293b',
      focusRing: '#64748b',     // slate-500
    },
  },
  {
    id: 'ruby',
    name: 'Ruby',
    description: 'Red & Rose — Bold and attention-grabbing',
    colors: {
      primary: '#dc2626',       // red-600
      primaryLight: '#fef2f2',  // red-50
      primaryDark: '#b91c1c',   // red-700
      accent: '#e11d48',        // rose-600
      accentLight: '#fff1f2',   // rose-50
      gradientFrom: '#dc2626',
      gradientTo: '#e11d48',
      sidebarBg: '#7f1d1d',     // red-900
      sidebarBgEnd: '#881337',  // rose-900
      loginBgStart: '#450a0a',
      loginBgEnd: '#7f1d1d',
      focusRing: '#ef4444',     // red-500
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Green & Lime — Earthy and organic',
    colors: {
      primary: '#16a34a',       // green-600
      primaryLight: '#f0fdf4',  // green-50
      primaryDark: '#15803d',   // green-700
      accent: '#65a30d',        // lime-600
      accentLight: '#f7fee7',   // lime-50
      gradientFrom: '#16a34a',
      gradientTo: '#65a30d',
      sidebarBg: '#14532d',     // green-900
      sidebarBgEnd: '#365314',  // lime-900
      loginBgStart: '#052e16',
      loginBgEnd: '#14532d',
      focusRing: '#22c55e',     // green-500
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Navy & Sky — Deep and professional',
    colors: {
      primary: '#1e40af',       // blue-800
      primaryLight: '#eff6ff',  // blue-50
      primaryDark: '#1e3a8a',   // blue-900
      accent: '#0284c7',        // sky-600
      accentLight: '#f0f9ff',   // sky-50
      gradientFrom: '#1e40af',
      gradientTo: '#0284c7',
      sidebarBg: '#172554',     // blue-950
      sidebarBgEnd: '#0c4a6e',  // sky-900
      loginBgStart: '#020617',
      loginBgEnd: '#172554',
      focusRing: '#3b82f6',     // blue-500
    },
  },
  {
    id: 'coral',
    name: 'Coral',
    description: 'Pink & Rose — Soft and friendly',
    colors: {
      primary: '#db2777',       // pink-600
      primaryLight: '#fdf2f8',  // pink-50
      primaryDark: '#be185d',   // pink-700
      accent: '#ea580c',        // orange-600
      accentLight: '#fff7ed',   // orange-50
      gradientFrom: '#db2777',
      gradientTo: '#ea580c',
      sidebarBg: '#831843',     // pink-900
      sidebarBgEnd: '#7c2d12',  // orange-900
      loginBgStart: '#500724',
      loginBgEnd: '#831843',
      focusRing: '#ec4899',     // pink-500
    },
  },
];

export const DEFAULT_THEME_ID = 'ocean';

export function getThemeById(id: string): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

/** Apply theme colors as CSS custom properties on :root */
export function applyTheme(colors: ThemeColors): void {
  const root = document.documentElement;
  root.style.setProperty('--theme-primary', colors.primary);
  root.style.setProperty('--theme-primary-light', colors.primaryLight);
  root.style.setProperty('--theme-primary-dark', colors.primaryDark);
  root.style.setProperty('--theme-accent', colors.accent);
  root.style.setProperty('--theme-accent-light', colors.accentLight);
  root.style.setProperty('--theme-gradient-from', colors.gradientFrom);
  root.style.setProperty('--theme-gradient-to', colors.gradientTo);
  root.style.setProperty('--theme-sidebar-bg', colors.sidebarBg);
  root.style.setProperty('--theme-sidebar-bg-end', colors.sidebarBgEnd);
  root.style.setProperty('--theme-login-bg-start', colors.loginBgStart);
  root.style.setProperty('--theme-login-bg-end', colors.loginBgEnd);
  root.style.setProperty('--theme-focus-ring', colors.focusRing);
}
