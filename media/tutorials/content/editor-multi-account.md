# Different clusters can use different accounts in one file

Kusto Workbench remembers the Microsoft work account that succeeds for each cluster. That means one notebook can talk to multiple clusters even when they require different identities.

![Multi-account cluster selection](images/tip-editor-multi-account.png)

To review or change those cached choices, run **Kusto Workbench: Show Cached Values** from the Command Palette. The Cached Values screen lets you inspect and refresh saved Kusto and SQL connection metadata in one place.