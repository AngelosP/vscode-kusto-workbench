/**
 * Convenience re-export of both OverlayScrollbars CSS sheets for Shadow DOM.
 *
 * Usage in a Lit component's static styles:
 *   import { osStyles } from '../shared/os-styles.js';
 *   static styles = [...osStyles, styles];
 */
import { osLibrarySheet } from './os-library-styles.js';
import { osThemeSheet } from './os-theme-styles.js';

export const osStyles: CSSStyleSheet[] = [osLibrarySheet, osThemeSheet];
export { osLibrarySheet, osThemeSheet };
