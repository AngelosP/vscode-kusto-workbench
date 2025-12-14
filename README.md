# Kusto Workbench

Kusto Workbench is a VS Code extension that gives you a modern Kusto editor and a notebook-like workflow while staying friendly to existing .kql and .csl files and workflows.

It’s designed to make the “write → run → inspect → iterate” loop feel fast: rich editor help, result tools, caching, and lightweight notebook-style cells (without trying to copy Jupyter 1:1).

## Quick start

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run `Kusto Workbench: Open Query Editor`.
3. Add a connection, pick a database, and run a query.

To open an existing file:

- `.kqlx`: open it normally, or run `Kusto Workbench: Open .kqlx File`
- `.kql` / `.csl`: open it normally; the editor opens in compatibility mode

## Highlight features

This is a non-exhaustive list of the “quality of life” features that tend to matter most day-to-day:

- Notebook-style sections: query cells plus Markdown + Python (similar spirit to notebooks, but not the exact same UX)
- Rich documentation tooltips while typing: a “caret docs” tooltip can stay visible even when autocomplete is open
- Code editing tools: format document, search/replace, and quick quote conversion (replace all `"` with `'` and vice versa)
- Export to Power BI: copies a Power Query (M) snippet for your current query
- Import connections from Kusto Explorer export (`connections.xml`)
- Scroll a column into view in large result tables
- Search across all results (including within JSON/object cells)
- JSON/Object viewer with its own search
- Quick per-column analysis: unique values and distinct-count breakdowns
- Caching features to keep you moving:
	- Optional query result caching with a configurable TTL
	- Cached database lists and schema prefetching to reduce repeated round-trips
- “Safe by default” run modes: quickly run as `take 100` / `sample 100` so you don’t have to remember to limit results while iterating

## File formats (and “no file” mode)

### Open existing `.kql` and `.csl` files (compatibility mode)

You can open existing `.kql` and `.csl` files in this extension with no conversion. The file stays plain text, and saving writes back plain text.

Compatibility mode does not persist notebook-only content (like Markdown/Python cells) into a `.kql`/`.csl` file, but it’s still worth using because you still get many of the “query editor” features (tooltips, result tools, caching, export helpers, etc.).

### Use the new `.kqlx` format for full features

For the full notebook-style experience, use `.kqlx` files.

`.kqlx` sessions support multiple sections, including:

- Query “cells” (KQL)
- Markdown cells (including images)
- Python cells (run locally)
- URL preview cells

### Start without a file (persistent global session)

You don’t need to create a file at all.

Run the command `Kusto Workbench: Open Query Editor` from the Command Palette and the extension will open a global, persistent session that auto-saves to a temporary `.kqlx` file stored in VS Code’s global storage. This session is designed to survive VS Code restarts so you don’t lose work between sessions.

If you want to turn that session into a real file in your workspace later, use `Kusto Workbench: Save Session As... (.kqlx)`.

## Importing connections from Kusto Explorer (connections.xml)

This extension can import connections that you already have set up in the Windows Kusto Explorer desktop app.

### 1) Export `connections.xml` from Kusto Explorer

In Kusto Explorer, export your saved connections as an XML file (commonly named `connections.xml`).

- Menu path: **Connections > Export Connections**
- Shortcut: `Ctrl+Shift+X`

If you can’t find an export option in your version, a practical fallback is:

- Close Kusto Explorer.
- Use Windows search to locate an existing `connections.xml` (or similarly named connections export) on your machine.
- Copy it somewhere convenient (e.g., your Desktop) so you can select it from VS Code.

### 2) Import the XML into the extension

1. Open the query editor (`Kusto Workbench: Open Query Editor`) or open any `.kqlx` session.
2. In a query cell, open the Connection dropdown.
3. Choose `Import from .xml file…`.
4. Pick the exported `connections.xml`.

The extension will add any new connections it finds (it skips ones you already imported).

### Can this be automated?

Not fully today.

Kusto Explorer is a separate desktop app and doesn’t provide a stable, cross-version API that a VS Code extension can reliably call to export connections on your behalf. The current “pick an XML file and import it” flow keeps things explicit and works across setups.

## Requirements

- VS Code 1.107.0 or higher
- For Python cells: a local Python install available as `python`, `python3`, or `py` on your PATH

## Development

```bash
npm install
npm run compile
```

Press `F5` to open a new VS Code window with the extension loaded.

## License

[MIT](LICENSE)
