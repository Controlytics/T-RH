/**
 * Returns inline style objects for common themed UI elements.
 * Uses CSS custom properties set by the active theme.
 * Import and spread these in `style={{}}` props.
 */

/** Primary gradient background (buttons, page header icons) */
export const themeGradient: React.CSSProperties = {
  background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))',
};

/** Primary gradient background (diagonal, for icon containers) */
export const themeGradientBr: React.CSSProperties = {
  background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))',
};

/** Combined gradient button style */
export const themeButton: React.CSSProperties = {
  ...themeGradient,
  color: '#ffffff',
  boxShadow: '0 4px 14px -3px color-mix(in srgb, var(--theme-primary) 30%, transparent)',
};
