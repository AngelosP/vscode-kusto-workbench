# Notebooks for Kusto

A Visual Studio Code extension that provides a notebook-like experience for Kusto Query Language (KQL), similar to Jupyter notebooks for Python.

## Features

- **Notebook Interface**: Create and manage Kusto queries in a familiar notebook format
- **Cell-based Execution**: Write and execute KQL queries in individual cells
- **Custom File Format**: Save your work as `.kusto-notebook` files

## Getting Started

### Creating a New Kusto Notebook

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "Kusto: Create New Notebook" and press Enter
3. Start writing your KQL queries!

### Working with Notebooks

- **Add Cells**: Click the `+ Code` or `+ Markdown` buttons between cells
- **Execute Cells**: Click the play button next to a cell or use `Ctrl+Enter`
- **Cell Languages**: Kusto notebooks support `kql` and `kusto` language modes

## Requirements

This extension requires VS Code version 1.107.0 or higher.

## Extension Settings

This extension does not add any VS Code settings at this time.

## Known Issues

- Query execution is currently a placeholder and will be fully implemented in future versions
- Connection to Azure Data Explorer clusters is coming soon

## Release Notes

### 0.0.1

Initial release of Notebooks for Kusto:
- Basic notebook interface for KQL queries
- Notebook serialization and deserialization
- Placeholder query execution

## Development

### Building from Source

```bash
npm install
npm run compile
```

### Running the Extension

Press `F5` to open a new VS Code window with the extension loaded.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

[MIT](LICENSE)
