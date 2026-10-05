import { useEffect } from 'react';
import useSWR from 'swr';
import { type BrandingConfig, BRANDING_TAB_TITLE_DEFAULT } from '@digilog/shared';
import { getThemeById, applyTheme, DEFAULT_THEME_ID } from '@/lib/themes';
import { applyDocumentIdentity } from '@/lib/document-identity';

// Default branding values.
//
// The product's own words, not upstream DigiLog's (audit 2026-10-03, WEB-16):
// these print in the sidebar, the header and the login card on a fresh install
// until Branding is saved. `appName` is the ONE shared default
// (`BRANDING_TAB_TITLE_DEFAULT`), so the tab and the sidebar cannot ship two
// names. `logoText` is its initials.
export const defaultBranding: BrandingConfig = {
  appName: BRANDING_TAB_TITLE_DEFAULT,
  appTagline: '21 CFR Part 11 Compliant Monitoring',
  logoText: 'TRH',
  logoUrl: '/logo.jpg', // Controlytics logo
  // The browser tab. The default is the SHARED constant, never a literal — the
  // only hand-kept copy is index.html's static <title>, which is read before any
  // JS runs and therefore cannot import it.
  tabTitle: BRANDING_TAB_TITLE_DEFAULT,
  faviconUrl: '',
  companyName: 'Controlytics AI Pvt Ltd',
  version: '1.0',
  primaryColor: '#1e3a5f',
  secondaryColor: '#3b82f6',
  accentColor: '#8b5cf6',
  gradientStart: '#3b82f6',
  gradientMiddle: '#8b5cf6',
  gradientEnd: '#ec4899',
  loginBgStart: '#0f172a',
  loginBgEnd: '#1e3a5f',
  colorTheme: 'ocean',
  // No background image by default. Empty means absent — AppLayout renders no layer
  // at all rather than a transparent one over the page's own background.
  backgroundUrl: '',
  backgroundOpacity: 12,
};

export function useBranding() {
  const { data, error, isLoading, mutate } = useSWR<BrandingConfig>('/api/config/branding', {
    // Don't require auth for this endpoint
    fetcher: (url: string) => fetch(url).then(res => res.json()),
    // Cache for 5 minutes, revalidate in background
    revalidateOnFocus: false,
    revalidateOnMount: true, dedupingInterval: 5000,
  });

  // Merge data with defaults, but use default logoUrl if database has empty string
  let branding: BrandingConfig;
  if (data && Object.keys(data).length > 0) {
    branding = { ...defaultBranding, ...data };
    // If logoUrl is empty from DB, use the default logo
    if (!branding.logoUrl) {
      branding.logoUrl = defaultBranding.logoUrl;
    }
  } else {
    branding = defaultBranding;
  }

  // Apply theme CSS variables whenever branding loads or changes
  const themeId = (branding as any).colorTheme || DEFAULT_THEME_ID;
  useEffect(() => {
    const theme = getThemeById(themeId);
    applyTheme(theme.colors);
  }, [themeId]);

  // Apply the administered browser-tab title and icon. Deliberately here, beside
  // the theme, rather than in AppLayout: this hook is the ONE place branding is
  // resolved, and it is called from the login page too — so the tab is right
  // before anyone has signed in. Several components call this hook on the same
  // page and the effect therefore runs more than once; assigning the same title
  // and href repeatedly is a no-op, which is why applyDocumentIdentity reuses the
  // existing <link> rather than appending one.
  const tabTitle = branding.tabTitle;
  const faviconUrl = branding.faviconUrl;
  useEffect(() => {
    applyDocumentIdentity(document, tabTitle, faviconUrl);
  }, [tabTitle, faviconUrl]);

  return {
    branding,
    isLoading,
    error,
    mutate,
  };
}
