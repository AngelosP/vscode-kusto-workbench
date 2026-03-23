# CSS Snippet Reference for Lit Migrations

## Standard Select/Dropdown Styling

```css
/* Native <select> with custom caret — use SEPARATE properties, not shorthand */
.my-select {
    background-color: var(--vscode-dropdown-background);
    background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 4px center;
    background-size: 16px 16px;
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 0;
    padding: 4px 24px 4px 8px;
    font-size: 12px;
    height: 28px;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    outline: none;
}

/* Checkbox dropdown trigger button (for multi-select) */
.dropdown-btn {
    background-color: var(--vscode-dropdown-background);
    background-image: url("data:image/svg+xml,...same caret...");
    background-repeat: no-repeat;
    background-position: right 4px center;
    background-size: 16px 16px;
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 0;
    padding: 4px 24px 4px 8px;
    height: 28px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Fixed-position dropdown menu */
.dropdown-menu {
    position: fixed;
    z-index: 10000;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 0;
    padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0,0,0,.35);
    max-height: 200px;
    overflow-y: auto;
    scrollbar-width: thin;
}
```

## Standard Section Host

```css
:host {
    display: block;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
    border-radius: 0;
    margin-bottom: 16px;
    background: var(--vscode-editor-background);
    box-shadow: 0 2px 10px var(--vscode-widget-shadow);
    padding-bottom: 0;
}

:host(.is-collapsed) {
    margin-bottom: 26px;
}
```

## Standard Button Styling

```css
.unified-btn-secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;  /* MUST be explicit transparent */
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
}

.md-tab {
    background: transparent;
    border: 1px solid transparent;  /* MUST be explicit transparent */
    color: var(--vscode-foreground);
    width: 28px;
    height: 28px;
    border-radius: 4px;
    outline: none;
}
```

## Fixed-Position Popup (Axis Settings Pattern)

```css
.axis-popup {
    position: fixed;
    z-index: 10000;
    min-width: 280px;
    max-width: 360px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
    border-radius: 0;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}

/* Arrow pointer */
.axis-popup::before {
    content: '';
    position: absolute;
    top: -6px;
    left: 12px;
    width: 10px;
    height: 10px;
    background: var(--vscode-editorWidget-background);
    border-left: 1px solid var(--vscode-editorWidget-border);
    border-top: 1px solid var(--vscode-editorWidget-border);
    transform: rotate(45deg);
}
```

## Resizer

```css
/* Resizer IS the border — 1px line that grows to 6px sash on hover */
.resizer {
    flex: 0 0 1px;
    height: 1px;
    cursor: ns-resize;
    background: var(--vscode-panel-border, rgba(128,128,128,0.35));
    position: relative;
    touch-action: none;
    z-index: 1;
}
/* Extended hit area for comfortable resizing */
.resizer::after {
    content: '';
    position: absolute;
    left: 0; right: 0;
    top: -3px; bottom: -3px;
}
/* Sash highlight on hover / drag */
.resizer::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: 50%;
    height: 0;
    transform: translateY(-50%);
    background: var(--vscode-sash-hoverBorder, #007fd4);
    transition: height 0.1s ease;
    pointer-events: none;
    z-index: 1;
}
.resizer:hover::before { height: 6px; }
.resizer.is-dragging::before { height: 6px; }
```

## Controls Panel Full-Bleed

```css
.controls {
    background: var(--vscode-editor-background);
    position: relative;
    left: -12px;
    width: calc(100% + 24px);
    padding: 16px 16px 0 16px;
    margin-bottom: 20px;
}
/* Theme-aware tint */
.controls::before {
    content: '';
    position: absolute; inset: 0;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.035);
}
:host-context(body.vscode-dark) .controls::before {
    background: rgba(255, 255, 255, 0.04);
}
```
