# VS Code Extension: Notebooks for Kusto

## Project Overview
This is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL), similar to Jupyter notebooks for Python.

## Project Details
- **Extension Name**: Notebooks for Kusto
- **Internal Name**: vscode-kusto-notebooks
- **Language**: TypeScript
- **Purpose**: Create and run Kusto queries in a notebook interface

## Architecture
- Uses VS Code's native notebook API
- Implements notebook serializer for custom `.kusto-notebook` file format
- Provides kernel for executing KQL queries against Azure Data Explorer clusters

## Development Guidelines
- Follow TypeScript best practices
- Use VS Code's notebook API for all notebook operations
- Keep notebook cell execution isolated and secure
- Implement proper error handling for query execution
