# Copilot Chat: AI-Assisted Query Editing

* Each query section has an integrated **Copilot Chat** experience that helps you write, edit, and optimize KQL without leaving the editor.
* Click the **Copilot button** (logo icon) in the query section toolbar. A chat panel opens alongside your query editor.

> **Important:** Each chat window is specific to the selected database in the section, **do not use this agent for questions that need it to span databases** (unless you just want it to use a fully qualified table to join to your local tables and you are going to tell which table you want, which is fine). **Use the Kusto Workbench custom VS Code agent for cross-database tasks and high-level orchestration.**

## What you can do

* **Ask for help writing queries**: describe what data you want in plain English and Copilot will write or modify the KQL.
* **Optimize performance**: ask Copilot to review your query and suggest improvements.
* **Explain query logic**: paste or reference a complex query and ask for an explanation.
* **Iterate naturally**: the conversation history is maintained, so follow-up requests build on prior context.

## How it works

* Copilot sees your **current query text** and the **database schema** for the selected database: it knows your tables, columns, and functions.
* It can **execute queries** as part of its reasoning, so it can validate that its suggestions actually work.
* Every tool call and query it runs is visible in the chat so you can inspect them, and remove items from the history if they're no longer relevant.

## Tips

* **Be specific about time ranges**, Copilot will write more accurate queries.
* Use the **Clear** button (clear-all icon in the header) to reset the conversation and start fresh.
* Your conversation is **per-section** so each query section has its own independent chat history.