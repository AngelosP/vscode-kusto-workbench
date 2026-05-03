# The agent can run checks before it answers

The agent is not limited to writing KQL and hoping it is right. It can execute queries, inspect results, and use what it learns to revise the notebook before it gives you the final answer.

![Agent workflow in VS Code chat](images/tip-agent-orchestration.png)

This is especially helpful for broad prompts like "find the biggest change this week". Ask it to validate assumptions, check row counts, and call out anything it could not verify.