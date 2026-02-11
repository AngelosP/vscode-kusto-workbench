# Open Existing .kql Files

Already have `.kql` or `.csl` query files? Kusto Workbench opens them natively with a rich editing experience.

## How it works

When you open a `.kql` or `.csl` file in VS Code, Kusto Workbench automatically provides its enhanced editor with:

- **Full KQL IntelliSense** — completions, syntax highlighting, and error diagnostics.
- **Query execution** — run the query directly from the editor with `Shift+Enter`.
- **Results table** — view results inline, just like in a `.kqlx` notebook.
- **Connection selection** — pick a cluster and database from the dropdowns in the header.

## What works right away

Your `.kql` file is the source of truth for the query text. You can:

- Edit the query freely — changes save back to the `.kql` file.
- Connect to any configured cluster and run the query.
- See results, sort columns, inspect values.
- Use the integrated Copilot Chat to refine the query.

The `.kql` file remains a standard text file — fully compatible with Kusto Explorer, Git, and any other tool that reads `.kql`.

## Settings

By default, Kusto Workbench opens `.kql` and `.csl` files automatically. To change this behavior:

- **`kustoWorkbench.openKqlFiles`** — toggle `.kql` file handling
- **`kustoWorkbench.openCslFiles`** — toggle `.csl` file handling

When disabled, files open in VS Code's default text editor instead.
