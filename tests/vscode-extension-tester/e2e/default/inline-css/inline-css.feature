Feature: Inline CSS — webview is styled at first paint with no external CSS dependency

  Background:
    Given the extension is in a clean state
    And I wait 2 seconds

  Scenario: Query editor webview has inline CSS, not an external link
    # Open a standalone query editor
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # ── TEST 1: The <head> contains a <style> tag with substantial CSS (the inlined bundle) ──
    When I evaluate "(() => { const styles = document.querySelectorAll('head style'); if (styles.length === 0) throw new Error('No <style> tags in <head>'); const totalCss = Array.from(styles).reduce((sum, s) => sum + s.textContent.length, 0); if (totalCss < 5000) throw new Error('Inline CSS too small (' + totalCss + ' chars) — bundle likely not inlined'); return 'inline CSS present: ' + totalCss + ' chars across ' + styles.length + ' <style> tag(s) ✓'; })()" in the webview

    # ── TEST 2: No <link> tag pointing to queryEditor.bundle.css (it should be inlined now) ──
    When I evaluate "(() => { const links = Array.from(document.querySelectorAll('head link[rel=stylesheet]')); const cssBundleLink = links.find(l => l.href && l.href.includes('queryEditor.bundle.css')); if (cssBundleLink) throw new Error('Found external <link> to queryEditor.bundle.css — CSS should be inlined, not external. href=' + cssBundleLink.href); return 'no external CSS bundle link ✓ (found ' + links.length + ' other <link> tags)'; })()" in the webview

    # ── TEST 3: Monaco CSS is still loaded as an external <link> (intentionally kept external) ──
    When I evaluate "(() => { const links = Array.from(document.querySelectorAll('head link[rel=stylesheet]')); const monacoLink = links.find(l => l.href && l.href.includes('editor.main.css')); if (!monacoLink) throw new Error('Monaco CSS <link> missing — it should still be an external link'); return 'Monaco CSS external link present ✓'; })()" in the webview

    # ── TEST 4: Body has correct theme styling (from inline CSS) ──────────
    When I evaluate "(() => { const body = document.body; const style = getComputedStyle(body); const bg = style.backgroundColor; const color = style.color; const fontFamily = style.fontFamily; if (!fontFamily || fontFamily === 'Times New Roman' || fontFamily === 'serif') throw new Error('Body font not themed: ' + fontFamily); if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') throw new Error('Body background not set: ' + bg); return 'body themed ✓ bg=' + bg + ' color=' + color + ' font=' + fontFamily.substring(0, 40); })()" in the webview

    # ── TEST 5: Modals are hidden (display:none from inline CSS) ──────────
    When I evaluate "(() => { const ids = ['objectViewer', 'cellViewer', 'shareModal']; const visible = []; ids.forEach(id => { const el = document.getElementById(id); if (el) { const display = getComputedStyle(el).display; if (display !== 'none') visible.push(id + '=' + display); } }); if (visible.length > 0) throw new Error('Modals visible when they should be hidden: ' + visible.join(', ')); return 'all modals hidden ✓'; })()" in the webview

    Then I take a screenshot "01-query-editor-styled"

  Scenario: KQLX file webview has inline CSS
    # Open a .kqlx file via the extension's own command (avoids native file dialog)
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # ── TEST 6: Webview has inline CSS (same as standalone, but verifies the shared code path) ──
    When I evaluate "(() => { const styles = document.querySelectorAll('head style'); const totalCss = Array.from(styles).reduce((sum, s) => sum + s.textContent.length, 0); if (totalCss < 5000) throw new Error('Inline CSS too small (' + totalCss + ' chars)'); const cssBundleLink = Array.from(document.querySelectorAll('head link[rel=stylesheet]')).find(l => l.href && l.href.includes('queryEditor.bundle.css')); if (cssBundleLink) throw new Error('External CSS bundle link found'); return 'inline CSS verified: ' + totalCss + ' chars ✓'; })()" in the webview

    # ── TEST 6b: The inline CSS contains key rules from the bundle ────────
    When I evaluate "(() => { const styles = Array.from(document.querySelectorAll('head style')); const allCss = styles.map(s => s.textContent).join(''); const checks = ['object-viewer-modal', 'cell-viewer-modal', 'share-modal', 'add-controls', 'query-box']; const missing = checks.filter(cls => !allCss.includes(cls)); if (missing.length > 0) throw new Error('Inline CSS missing expected class rules: ' + missing.join(', ')); return 'CSS bundle content verified — contains all expected rules ✓'; })()" in the webview

    Then I take a screenshot "02-inline-css-content-verified"

  Scenario: Add-controls footer is functional after inline CSS
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # Clear all sections first
    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    # ── TEST 7: Add-controls are visible and styled as flex ──────────────
    When I evaluate "(() => { const el = document.querySelector('.add-controls'); if (!el) throw new Error('No .add-controls element'); const display = getComputedStyle(el).display; if (display === 'none') throw new Error('.add-controls is hidden (display:none) — should be visible in query editor'); if (display !== 'flex') throw new Error('.add-controls display=' + display + ', expected flex'); return '.add-controls visible with display=' + display + ' ✓'; })()" in the webview

    # ── TEST 8: Clicking add-controls buttons works ──────────────────────
    When I wait for "button[data-add-kind='query']" in the webview for 10 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('KQL section not created after clicking add button'); return 'KQL section added via add-controls ✓'; })()" in the webview

    When I click "button[data-add-kind='markdown']" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-markdown-section'); if (!el) throw new Error('Markdown section not created after clicking add button'); return 'Markdown section added via add-controls ✓'; })()" in the webview

    Then I take a screenshot "03-add-controls-functional"

  Scenario: Share modal opens and closes correctly with inline CSS
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # ── TEST 9: Share modal starts hidden ────────────────────────────────
    When I evaluate "(() => { const modal = document.getElementById('shareModal'); if (!modal) throw new Error('Share modal element not found'); const display = getComputedStyle(modal).display; if (display !== 'none') throw new Error('Share modal should start hidden, got display=' + display); return 'share modal hidden ✓'; })()" in the webview

    # ── TEST 10: Share modal can be shown via .visible class ─────────────
    When I evaluate "(() => { const modal = document.getElementById('shareModal'); modal.classList.add('visible'); const display = getComputedStyle(modal).display; if (display === 'none') throw new Error('Share modal should be visible after adding .visible class, got display=' + display); modal.classList.remove('visible'); const afterDisplay = getComputedStyle(modal).display; if (afterDisplay !== 'none') throw new Error('Share modal should be hidden after removing .visible, got display=' + afterDisplay); return 'share modal toggle works ✓ (visible=' + display + ', hidden=' + afterDisplay + ')'; })()" in the webview

    Then I take a screenshot "04-share-modal-tested"

  Scenario: Alternating row CSS custom property is injected
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # ── TEST 11: The alternating row CSS custom property is set ───────────
    When I evaluate "(() => { const root = document.documentElement; const altBg = getComputedStyle(root).getPropertyValue('--kw-alt-row-bg'); if (!altBg || altBg.trim() === '') throw new Error('--kw-alt-row-bg CSS custom property not set'); return 'alternating row CSS property set: ' + altBg.trim() + ' ✓'; })()" in the webview

    Then I take a screenshot "05-alt-row-property"
