---
name: carefully-implement
description: "Careful, thorough implementation with pre-edit and post-edit pessimistic reviews. Use when the user says 'carefully implement', 'carefully do', 'careful implementation', 'thorough implementation', 'safe implementation', 'review before editing', or any request that emphasizes caution, thoroughness, or risk-awareness during code changes."
---

# Careful Implementation Workflow

This skill defines a four-phase implementation workflow that wraps normal code changes with two pessimistic review steps — one before editing and one after — to catch mistakes, missed dependencies, and regressions.

## When to Use

When the user emphasizes caution or thoroughness in their request:
- "Carefully implement..."
- "Carefully do..."
- "Thoroughly change..."
- "Safely refactor..."
- Any request where the user wants extra confidence that nothing will break

## Workflow

### Phase 1: Understand & Plan

Research the task thoroughly before proposing any changes:
1. Read all relevant files to understand the current behavior
2. Identify which files will need to change and how
3. Formulate a concrete approach — specific enough to describe to a reviewer

**Do NOT make any file edits in this phase.**

### Phase 2: Pre-Edit Review

Before making ANY file edits, call the `pre-edit-reviewer` sub-agent. Provide it with:
- **Task description**: What you're trying to accomplish
- **Proposed approach**: Your specific plan, including which files you'll change and how
- **Affected file paths**: Every file you plan to modify

Wait for the reviewer's response. Then:
- If it identifies **critical risks**: Adjust your approach to address them before proceeding
- If it identifies **potential issues**: Decide whether to address them proactively or note them for the post-edit review
- If it identifies **edge cases**: Make sure your implementation will handle them
- Share a brief summary of the review findings with the user before proceeding to implementation

### Phase 3: Implement

Make the code changes. This is the core of the task — implement the user's request with the same quality and efficiency as normal, but informed by the pre-edit review's findings.

### Phase 4: Post-Edit Review

After ALL file edits are complete, call the `post-edit-reviewer` sub-agent. Provide it with:
- **Task description**: What was implemented
- **Files changed**: Every file that was modified
- **Summary of changes**: What was changed in each file and why

Wait for the reviewer's response. Then:
- If it identifies **issues**: Fix them before declaring the task complete
- **Always** show the reviewer's **manual testing checklist** to the user — this is mandatory, even if no issues were found

## Rules

- The pre-edit review is NOT optional — do not skip it to save time
- The post-edit review is NOT optional — do not skip it to save time
- The testing checklist MUST be shown to the user — do not summarize or omit it
- If a reviewer finds critical issues, fix them before moving on
- Do NOT reduce the quality or scope of your implementation to accommodate the reviews — the reviews are guardrails, not constraints on the implementation itself
