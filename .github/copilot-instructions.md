# VS Code Extension: Kusto Workbench

## Project Overview
This is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL), similar to Jupyter notebooks for Python, but better.

## Project Details
- **Extension Name**: Kusto Workbench
- **Internal Name**: vscode-kusto-workbench
- **Language**: TypeScript
- **Purpose**: Create and run Kusto queries and more.

## Development Guidelines
- Follow TypeScript best practices
- Implement proper error handling for query execution

## Application Behavior Guidelines

- The application tries to handle error conditions, and error flows in a graceful manner and as polished as the happy path.

- The application doesn't just show raw error messages from the backend or system. Instead, it provides user-friendly error messages that guide the user on how to resolve the issue or what steps to take next. We might even build entire features around helping the user recover from errors.
