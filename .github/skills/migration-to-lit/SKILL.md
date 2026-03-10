---
name: migration-to-lit
description: Migrate legacy global-scope JS sections to Lit web components with full feature parity, pixel-perfect styling, and side-by-side comparison workflow. Use when asked to migrate any section type (Chart, Transformation, Results Table, Query, Copilot Chat, etc.) to Lit.
---

# Lit Migration Skill

## When to Use This Skill

Use this skill when:
- Migrating a legacy section type from `extraBoxes.js`, `queryBoxes.js`, or `copilotQueryBoxes.js` to a Lit web component
- Asked to create the "next migration" or "migrate X section"
- Debugging or fixing issues in an existing Lit section migration
- Comparing legacy vs Lit implementations side-by-side

## Pre-Migration Research Checklist

Before writing any code, read ALL of these for the section being migrated:

1. **Legacy implementation** — the full `addXxxBox()` function and all related `__kusto*` helpers
2. **Legacy CSS** — search `queryEditor.css` for all selectors containing the section's class names
3. **CSS variable audit** — extract EVERY `var(--vscode-*)` used in the legacy CSS for this section type. Record them in a table (see below). The Lit component MUST use the exact same variables for the same elements.
4. **Persistence** — read `persistence.js` for both serialization (DOM → JSON) and restoration (JSON → DOM)
5. **Message handlers** — search `main.js` for all message types related to this section
6. **kqlxFormat.ts** — the TypeScript type definition for this section's serialized format
7. **Cross-section dependencies** — any code that references this section from other sections (e.g., charts depending on query results)
8. **Global window state** — all `window.*` properties used by this section type

### CSS Variable Audit (MANDATORY)

**This step is critical.** Using the wrong VS Code CSS variables is the #1 cause of visual mismatches between legacy and Lit sections, especially in light themes where `--vscode-dropdown-background` and `--vscode-input-background` resolve to visibly different colors.

Before writing any CSS, build this table by reading the legacy CSS in `queryEditor.css`:

```
| Legacy Selector          | Property         | CSS Variable Used                    |
|--------------------------|------------------|--------------------------------------|
| .select-wrapper select   | background       | var(--vscode-dropdown-background)    |
| .select-wrapper select   | color            | var(--vscode-dropdown-foreground)    |
| .select-wrapper select   | border           | var(--vscode-dropdown-border)        |
| .kusto-xxx-input         | background       | var(--vscode-input-background)       |
| .kusto-xxx-controls      | background       | var(--vscode-editor-background)      |
| ...                      | ...              | ...                                  |
```

Then when writing the Lit component's CSS, use **exactly** the same variable for each corresponding element. Do not guess or use a "close enough" variable — look it up in the legacy CSS.

**Common mistakes to avoid:**
- Using `--vscode-input-background` for dropdowns (should be `--vscode-dropdown-background`)
- Using `--vscode-input-border` for dropdowns (should be `--vscode-dropdown-border`)
- Using `--vscode-editor-background` for input fields (should be `--vscode-input-background`)
- Using `background:` shorthand when `background-color:` is needed (shorthand conflicts with `background-image`)

## Architecture Rules

### Shadow DOM + Light DOM Boundary

**Rule**: The Lit component owns the **controls UI** in shadow DOM. Any elements that:
- Need to be found by `document.getElementById()` from legacy code
- Need third-party libraries (Monaco, ECharts, TOAST UI) that can't render in shadow DOM
- Need to be resized/measured by legacy height management code

...must live in **light DOM** and be slotted via `<slot name="...">`.

**Pattern**:
```
<kw-xxx-section>          ← custom element (shadow DOM for controls)
  <div slot="content">    ← light DOM wrapper with proper IDs
    <div id="boxId_wrapper">
      <div id="boxId_canvas">  ← third-party lib renders here
      </div>
      <div class="query-editor-resizer">  ← drag handle
      </div>
    </div>
  </div>
</kw-xxx-section>
```

**Why**: Legacy rendering functions use `document.getElementById(boxId + '_wrapper')` which can't reach into shadow DOM. The light-DOM wrapper with proper IDs lets legacy code work unchanged.

### Side-by-Side Comparison Phase

Every migration starts with side-by-side rendering:

1. **Create the Lit element** with `id = 'lit_' + originalId`
2. **Give it `box-id = 'lit_' + originalId`** so it has its own state key (completely independent from the legacy section)
3. **Insert it after the legacy section** in `queries-container`
4. **Both sections must be fully independent** — configuring one must not affect the other
5. **Cleanup on remove** — when the legacy section is removed, also remove its Lit companion

### Persistence Integration

```
// In persistence.js serialization loop:
if (id.startsWith('xxx_')) {
    const el = document.getElementById(id);
    if (el && typeof el.serialize === 'function') {
        sections.push(el.serialize());
        continue;
    }
    // Legacy fallback path...
}
```

The `serialize()` method must output **byte-identical JSON** to the legacy serialization code. Compare field-by-field against the legacy `persistence.js` block for the section type being migrated.

## Styling Rules (CRITICAL)

### VS Code Theme Variables

| Element Type | Background | Border | Foreground |
|---|---|---|---|
| **Dropdowns / Selects** | `--vscode-dropdown-background` | `--vscode-dropdown-border` | `--vscode-dropdown-foreground` |
| **Text inputs** | `--vscode-input-background` | `--vscode-input-border` | `--vscode-input-foreground` |
| **Section border** | — | `--vscode-input-border` | — |
| **Section background** | `--vscode-editor-background` | — | — |
| **Menus/popups** | `--vscode-menu-background` | `--vscode-menu-border` | `--vscode-menu-foreground` |
| **Buttons (secondary)** | `transparent` | `1px solid transparent` | `--vscode-foreground` |

### Select/Dropdown Styling (CRITICAL — multiple iterations were needed)

Native `<select>` elements in shadow DOM with `appearance: none` are tricky:

```css
.my-select {
    /* MUST use separate properties — combined shorthand breaks on <select> in Chromium */
    background-color: var(--vscode-dropdown-background);
    background-image: url("data:image/svg+xml,...caret...");
    background-repeat: no-repeat;
    background-position: right 4px center;
    background-size: 16px 16px;
    /* NEVER use: background: var(--color) url(...) — it breaks */
}
```

**Why this matters**: Using `background:` shorthand with a CSS variable + URL in one declaration does NOT work reliably on `<select>` elements in Chromium's webview. Always use separate `background-color`, `background-image`, `background-repeat`, `background-position`, `background-size` properties.

### No Rounded Corners on Dropdowns

All dropdown menus, select elements, and popup menus must have `border-radius: 0`. This is a global convention across all Lit components.

### Global `* { padding: 0; margin: 0 }` Override

The webview has a global CSS reset. This means `:host` padding is overridden. Use an inner `.section-root` wrapper div for padding instead.

### Controls Panel Full-Bleed Background

Sections with a distinct controls region (like chart or transformation edit controls) use this technique to bleed the background to the section edges:
```css
.controls {
    position: relative;
    left: -12px;
    width: calc(100% + 24px);
    padding: 16px 16px 0 16px;
}
```

## Dropdown & Popup Rendering (CRITICAL)

### Popups Must Escape Section Boundaries

All dropdown menus and settings popups must use `position: fixed` (not `position: absolute`) so they render above everything, even outside the section's border.

```css
.dropdown-menu {
    position: fixed;
    z-index: 10000;
}
```

After opening, compute position from the trigger button's `getBoundingClientRect()`:
```typescript
this.updateComplete.then(() => {
    const menu = this.shadowRoot?.querySelector('.dropdown-menu');
    const rect = btnEl.getBoundingClientRect();
    menu.style.top = rect.bottom + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.width = rect.width + 'px';
});
```

### Close-on-Outside Behavior

Use `mousedown` (not `click`) for dismiss-on-outside:

```typescript
// Opening:
setTimeout(() => document.addEventListener('mousedown', this._closeBound), 0);

// Closing:
document.removeEventListener('mousedown', this._closeBound);

// Inside popup template:
@mousedown=${(e: Event) => e.stopPropagation()}
@click=${(e: Event) => e.stopPropagation()}
```

**Why `mousedown`**: With `click` (mouseup), starting a gesture inside (e.g., dragging a slider) and accidentally releasing outside would close the popup. `mousedown` only fires when the press itself lands outside.

**Critical**: Use a single stable bound handler stored on the instance. Always clean it up when closing (whether via close button, toggle, or click-outside). A common bug is creating closure-based handlers that can't be removed, causing stale listeners that block reopening.

### Popup Arrow Centering

When a popup has an arrow/caret pointing at a trigger label, measure actual text width (not element width) to center the arrow precisely:

```typescript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
ctx.font = computedStyle.fontSize + ' ' + computedStyle.fontFamily;
const textWidth = ctx.measureText(labelText).width;
const arrowTipOffset = 17; // 12px CSS left + 5px for arrow center
const textCenter = rect.left + (textWidth / 2);
this._popupPos = { top: rect.bottom + 8, left: textCenter - arrowTipOffset };
```

## Multi-Select Checkbox Dropdowns

For columns, tags, or any multi-select needs, use a **checkbox dropdown button** pattern (never native `<select multiple>` which renders as a tall listbox):

```html
<div class="dropdown-wrapper">
    <button class="dropdown-btn" @click=${toggle}>
        ${selected.length ? selected.join(', ') : placeholder}
    </button>
    ${isOpen ? html`
        <div class="dropdown-menu" @mousedown=${stop}>
            ${options.map(c => html`
                <label class="dropdown-item" @mousedown=${stop} @click=${stop}>
                    <input type="checkbox" .checked=${selected.includes(c)}
                        @change=${handler} />
                    <span>${c}</span>
                </label>
            `)}
        </div>
    ` : nothing}
</div>
```

## Resize Pattern

### Light-DOM Resizer (for sections with legacy rendering code)

When the legacy code needs `document.getElementById(boxId + '_xxx_wrapper')` for height management, create the resizer in light DOM:

```javascript
// In addXxxBox() — create light-DOM resizer
const resizerEl = document.createElement('div');
resizerEl.id = litId + '_xxx_resizer';
resizerEl.className = 'query-editor-resizer';
resizerEl.title = 'Drag to resize';
wrapper.appendChild(resizerEl);

// Wire up drag handler
resizerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    wrapper.dataset.kustoUserResized = 'true';
    // ... standard drag logic
});
```

### Shadow-DOM Resizer (for self-contained sections)

When the section handles its own rendering (no legacy ID lookups needed), keep the resizer in shadow DOM with standard mousedown/mousemove/mouseup:

```typescript
private _onResizerMouseDown(e: MouseEvent): void {
    const wrapper = this.shadowRoot?.getElementById('output-wrapper');
    // ... standard drag logic with wrapper.style.height
}
```

## Theme Observer

For sections that use third-party libraries (ECharts, Monaco) with theme-dependent rendering, set up a MutationObserver to detect VS Code theme changes:

```typescript
private _setupThemeObserver(): void {
    this._themeObserver = new MutationObserver(() => {
        const isDark = this._isDarkTheme();
        if (this._lastThemeDark !== isDark) {
            this._lastThemeDark = isDark;
            // Dispose and re-render with new theme
        }
    });
    document.body && this._themeObserver.observe(document.body, {
        attributes: true, attributeFilter: ['class', 'style']
    });
}
```

## Cross-Section Dependencies

Some sections depend on other sections' data (e.g., chart/transformation sections depend on query results). When migrating such sections:

1. Register the Lit element's `boxId` in the appropriate tracking array so global refresh loops find it
2. Store state in the appropriate `window.*StateByBoxId[litId]` object so legacy render functions can read from it
3. Ensure light-DOM elements use IDs that match what legacy render functions expect
4. Call data/dataset refresh inside the render function so column dropdowns update when source data changes

## Standard Component Structure

```typescript
@customElement('kw-xxx-section')
export class KwXxxSection extends LitElement {
    // 1. Public properties (attributes)
    @property({ type: String, reflect: true, attribute: 'box-id' }) boxId = '';

    // 2. Internal reactive state
    @state() private _name = '';
    @state() private _expanded = true;

    // 3. Private non-reactive fields
    private _closeHandler = this._onOutsideClick.bind(this);

    // 4. Lifecycle (connectedCallback, disconnectedCallback, firstUpdated, updated)
    // 5. Static styles (css`...`)
    // 6. render() method
    // 7. Sub-templates (_renderXxx)
    // 8. Event handlers
    // 9. Global state bridge (_syncGlobalState, _writeToGlobalState)
    // 10. Data helpers (_refreshDatasets, _getColumnNames)
    // 11. Rendering delegation (e.g., _renderContent, delegates to legacy global functions)
    // 12. Host class management (_updateHostClasses)
    // 13. Persistence (_schedulePersist, serialize, applyOptions)
}
```

## Wiring Checklist for Side-by-Side Phase

In `addXxxBox()` inside the relevant JS file (e.g., `extraBoxes.js`, `queryBoxes.js`):

- [ ] Create Lit element: `document.createElement('kw-xxx-section')`
- [ ] Set `id = 'lit_' + originalId`
- [ ] Set `box-id = 'lit_' + originalId` (independent state key)
- [ ] Create light-DOM elements with proper IDs (wrapper, editor/canvas, resizer) as needed
- [ ] Call `litEl.applyOptions(options)` for initial state
- [ ] Listen for `section-remove` event — clean up state + DOM
- [ ] Register `litId` in any tracking arrays the section type uses
- [ ] Insert after legacy element

In `removeXxxBox()`:

- [ ] Dispose third-party instances for `'lit_' + boxId`
- [ ] Delete from global state (e.g., `window.xxxStateByBoxId[litId]`)
- [ ] Remove from tracking arrays
- [ ] Remove the Lit element from DOM

In `index.ts`:

- [ ] Add `import './sections/kw-xxx-section.js'`

In `queryEditor.css`:

- [ ] Add the new custom element tag to the `margin-bottom: 16px` override rule (search for `kw-python-section` to find it). Without this, the global `* { margin: 0 }` reset removes all spacing between stacked sections.

## Common Bugs & How to Avoid Them

| Bug | Cause | Fix |
|-----|-------|-----|\n| No gap between stacked sections | New custom element tag not added to the `margin-bottom` override rule in `queryEditor.css` | Add `kw-xxx-section` to the comma-separated selector list near `kw-python-section` |
| Dropdowns have wrong background in light theme | Used `background:` shorthand or `--vscode-input-*` instead of `--vscode-dropdown-*` | Use separate `background-color: var(--vscode-dropdown-background)` + `background-image` |
| Popup won't reopen after closing | Stale document event listener not cleaned up | Use single bound handler; always remove before adding |
| Popups clip at section border | Used `position: absolute` | Use `position: fixed` + `z-index: 10000` |
| Legacy rendering doesn't work in Lit section | Legacy code uses `document.getElementById` which can't reach shadow DOM | Put wrapper/output containers in light DOM with proper IDs |
| Auto-expand on first render doesn't work | Wrapper is in shadow DOM | Wrapper must be in light DOM for legacy height-management code |
| Multi-select shows native scrollable listbox | Used native `<select multiple>` | Use checkbox dropdown button pattern |
| Slider drag inside popup closes popup | Close handler uses `click` (fires on mouseup) | Use `mousedown` + `stopPropagation()` on popup container |
| Section buttons get borders in light theme | CSS specificity issue or missing explicit `border: 1px solid transparent` | Add explicit transparent border on buttons |
| `:host` padding doesn't work | Global `* { padding: 0 }` reset | Use inner `.section-root` div |
| `::slotted()` can't style deep children | CSS spec limitation | Use inline styles or class on the slotted element directly |

## Final Verification

After migration, compare both sections with:
1. Every mode/variation the section supports
2. **Light theme AND dark theme** — switch themes and verify every control (selects, inputs, buttons, popups) has the correct background, border, and foreground colors matching the legacy section
3. Resize by dragging
4. Collapse/expand toggle
5. Mode switching (if applicable, e.g., Edit/Preview)
6. All popup dialogs and dropdown menus
7. Cross-section data refresh (if applicable)
8. Persist → reload → verify state restored
9. Remove section → verify cleanup (no orphan DOM, no stale state)

### CSS Variable Spot-Check (do this BEFORE showing the result)

Before presenting the migration to the user, grep the new Lit component for every `var(--vscode-` usage and cross-reference against your CSS variable audit table from step 3 of the research checklist. Confirm:
- Every `<select>` uses `--vscode-dropdown-*` (not `--vscode-input-*`)
- Every text `<input>` uses `--vscode-input-*` (not `--vscode-dropdown-*`)
- Popup/menu containers use `--vscode-menu-*`
- Section background uses `--vscode-editor-background`
- Buttons use `transparent` background with `border: 1px solid transparent`