# Change Log

All notable changes to the "vscode-kusto-workbench" extension will be documented in this file.
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.5.0] - 2026-02-12

* Support for creating and restoring developement notes per file. Use the command 'Show Development Notes' with a file open to see what metadata the LLM has stored for itself. We'll find a better way to expose this info later on, for now it's good enough.
* Support for VS Code's built-in memory tool.
* Bugs
    * Do not re-scroll the chat window automatically to show me the latest message if I've scrolled it first :)

## [2.4.0] - 2026-02-12

* New custom sub-agent for searching Kusto for anything.
* New tool for the integrated Copilot Chat window that allows it to search the cached schemas for tables, columns, and functions. This should allow it to perform cross-database and cross-cluster joins using fully qualified table names, whereas before we were relying on the orchestating Kusto Workbench custom agent to take care of that scenario.
* Bugs
    * Timing issue where the section would flip from Run Query to Run Query (take 100) due to an internal state reload, and limit the results without the agent knowing it had happened.
    * The tool listKustoSchemas was misbehaving and in hindsight badly designed, so swapped it over for getKustoSchema. The agent was able to get around it by just executing admin commands to figure out the schema of things.

## [2.3.0] - 2026-02-11

* Bugs
    * Timing issue when opening a file and the Kusto Monaco editor would not intialize in time to receive the text for the query. The end result was a blank query section, and if the file was saved, it would blast over the query and save it blank to file. The workaround was to re-open the file without saving, but anybody who saved blasted over it.

## [2.3.0] - 2026-02-11

* <span data-teams="true">When in the connection manager, if you select a database you have the option to create new </span>`<span data-teams="true">.kqlx</span>`<span data-teams="true"> file with the connection details for that database already prefilled, ready to go. </span>
* VS Code wide shortcut for opening the Query Editor is now CTRL+SHIFT+ALT+K and users can change it.

## [2.2.0] - 2026-02-11

* Added 'Share' feature for Kusto sections so they paste nicely into Teams and other rich editors
* Improved the UX of the integrated Copilot Chat to make it look and feel more like the native one
* Trying to improve the UX around resizing everything, hopefully this is a little better now (been watching users and taking notes of common pain points and nobody discovers how the chat window resizes right now).
* Bugs
    * Small alignment issues with resize grips and little things like that
    * Fixed cancelation token propagaton so that users can reliably cancel Kusto query executions

## [2.1.0] - 2026-02-11

* Added walkthroughs! Access them via the command pallete, activity bar, or welcome page.
* Added shortcuts to add a new connection or import connections, directly to the Connection Manager UI under the title.
* Bugs
    * Sometimes the markdown content that gets sent has \\n\\n in it, instead of new lines, and we don't format things correctly.

## [2.0.1] - 2026-02-10

* Bugs
    * This is a bug where the query returned a server-side semantic error, but the UI didn't transition out of the "running" state, so the timer keeps ticking and cancel has nothing to cancel.
    * Timing issue stopped the 'addKustoSection' tool from adding its query contents when the new section is added (monaco editor not fully initialized)

## [2.0.0] - 2026-02-10

* Added support for opening files from remote locations, like GitHub and Sharepoint. Added `Kusto Workbench: Open Remote File` to command pallete and an entry to the Quick Access panel of Activity Bar icon.
* Added function count to schema (i) info UI and removed 1 px break line.
* Handles extremely large Kusto databases with thousands of tables without consuming the entire context window. It prunes the schema until it takes up only 40% of the context window available for the selected model, so it should scale with large context windows (like the 1M+ Opus 4.6 one)
* Bugs
    * Fixed issue where markdown sections sometimes had the '/n' literal in them instead of a proper new lines and looked all messed up.
    * Fixed issue where the Kusto Workbench agent would switch over to 'Run Query' but would still get limited to just 100 results.
    * Fixed issue where even though the query had \`\`\` it was being treated as a new line and it was being split up into multiple queries.
    * Fixed issue where refreshing the schema of the database to find new tables / functions, the schema would refresh, but the Kusto section auto-complete would not refresh.
    * Fixed issue where if the number of rows returned was very large, list virtualization would break and after 50 or so rows it would look like the results ended.

## [1.9.1] - 2026-02-07

* Bugs
    * In some cases the tool calls were not followed up with tool results in the convesation history and the Anthropic API did not love that. Looks like the fix for 1.9.0 was not enough.

## [1.9.0] - 2026-02-07

* Support for displaying and copying the Client Activity ID for Kusto queries in the results UI, and ensures that all Kusto requests are properly tagged with application and activity metadata. The changes improve traceability and user experience by surfacing the Client Activity ID in the results and allowing users to copy it easily for diagnostics or support.
* New tool for Kusto Workbench agent to be able to get the schema of a cluster for which there is no cached data. Helps when it is trying to find data for you across many different connections. If this becomes a use case for people, we can make a dedicated agent that looks for specific data across many different connections.
* Bugs
    * In some cases the tool calls were not followed up with tool results in the convesation history and the Anthropic API did not love that.

## [1.8.0] - 2026-02-06

* Fixed tool calling for integrated Copilot Chat window inside of Kusto sections, it was not using the proper API for tool calls before, oops! Hadn't noticed because up until now the models were reliably obying the instructions. The latest stable release changed that. Previous change in v1.7.0 was a partial fix to the overall problem.

## [1.7.0] - 2026-02-06

* Models no longer listen to instructions about local function tool calling very well. Keep finding instances were previous instructions followed well no longer work. For this case I had to adapt to allow the model to send me narrative back about the various tools it is using, which is not a bad thing in the end, so we'll just adapt.

## [1.6.0] - 2026-02-06

* Much better diff mode
* Now it automatically changes the mode to just 'Run query' when using Kusto Workbench agent to run queries (no sample, no top 100)
* Defaults to Claude Opus 4.6 for the custom agent in VS Code called Kusto Workbench
* Improved labels on X axis (making sure they are always readable)
* Bugs
    * Fixed the issue of the model drop down becoming disabled after a cancelled query.

## [1.5.1] - 2026-02-05

* Latest VS Code update broke tool calling because the LLMs are now prone to using the wrong property names. The fix is to check for both the right property names and the wrong ones ... crazy times we live in.

## [1.5.0] - 2026-02-05

* Improved the data labels in pie charts
* Improved data comparison UX to list the columns that are extra
* Improved min height layout logic for integrated Copilot Chat window
* Bugs
    * Data comparison of two sections would say the data differs even when there are 0 different rows or columns.
    * Removed 1 pixel of unwanted gap between the top of the tabular results and the top border. It made it possible to see the text that was being scrolled, super annoying.
    * Sections that had their data changed were not refreshing automatically and the data source had to be re-picked through the Data picker.

## [1.4.1] - 2026-02-03

* Bugs
    * Stupid markdown editor changes --- to \*\*\* arggg

## [1.4.0] - 2026-02-03

* Notification when a clarifying question has been asked.
* Default to Claude Opus 4.5 unless the user selects something different (please don't unless you know what you are doing)
* New command to allow users to reset their sticky model choice inside the Copilot Chat integrated into Kusto sections.
* Bugs
    * Fixed double-clicking to resize the section did not do the right thing, ended up with the wrong height.
    * Fixed a bug that would leave the markdown sections empty until the file was saved / loaded and then the contents would show up.

## [1.3.0] - 2026-02-03

* Added ability to rename sections through the custom agent.
* Added extension tool for custom agent called 'orderSections'.
* Bugs
    * Fixed the updateMarkdownSection tool to properly display the contents after the changes are made

## [1.2.0] - 2026-02-02

* Better instructions for the custom agent + it now selects its tools automatically

## [1.1.0] - 2026-01-31

* Additional extension tools to allow Kusto Workbench custom agent double check its work, and improvements to custom agent prompt.
* Added the docstring of Kusto tables and views to the response of **`get_extended_schema`.**
* Small README.md fixes
* Bugs
    * Fixed a bug where if the user opened a .kql or .cls file after installing the extension, the built-in editor would open instead of the extension. Problem was that the extension had not activated yet to register for these file types.

## [1.0.0] - 2026-01-30

* [**** IT, WE'LL DO IT LIVE!](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

## [0.9.0] - 2026-01-30

* Added extension tools that allow you to drive Kusto Workbench via VS Code's Copilot Chat ... so you can ask Copilot to ask Copilot to write you a query. Yes, I am certain this is the right architecture.
* Added Copilot tool 'Ask user a clarifying question', so be on the look out for that in the chat window.
* Added shortcut to extension setting sto Activity bar
* Bugs
    * Copilot had to audacity to tell me the reason it added a random timer a couple of releases ago without telling is because, and I quote 'The JS approach was likely written before Container Queries had broad browser support (they became widely available around 2023), or it was just the solution chosen at the time.'. Yeah, OK buddy. Anyway, fixed the random bug of adding new sections that look broken, with controls that have minimal width.
    * Fixed issue with the setting for the activity bar not taking effect.
    * Fixed missing top border from tabular results and CSV files.

## [0.8.0] - 2026-01-29

* After user feedback (thank you Kristen), added an extension icon to the VS Code **Activity Bar** as they call it. It does the same thing as executing the command `Open Query Editor` from the command pallete does. If the extra icon is annoying to you because you prefer a more minimal look, you can turn the extension icon off in the extension's settings.
* After user feedback again (thank you Chris), Implemented the concept of 'Leave no trace' Kusto clusters. These are clusters that the user can mark to never leave any trace of data behind. It will never persist any data to disk, only queries and section configurations will be saved, but never actual tabular data or chart data.
* Added new UX for managing connections called **Connection Manager**. It can be launched either from the command bar, or from the Activity Bar.
* Bugs
    * Randomly started seeing 2 sections at the bottom of .md files. The joys of vibe coding :)

## [0.7.0] - 2026-01-28

* Improved instructions for working with raw data in Kusto.

## [0.6.0] - 2026-01-28

* Many UX improvements for **Charts**. Biggest change is the ability to click on X or Y axis and configure additional settings. Still WIP, so more improvements to come.
* Many UX improvements for **Transformation**. Still WIP, so more improvements to come.
* Double click the resize handle to autofit to the contents of the section (available on all types of sections and editors).
* Export to Power BI has better formatting now, using fewer " characters.
* More responsive UX and better experience at tiny widths.
* Better UX controlling whether results are cached.
* Better toolbar overflow UX.
* Bug fixes
    * Kusto schema based completion dropdown annoyingly showed up when at the end of a term / word, even after successfully accepting a completion for the exact same term / word. I thought I had arleady fixed this, but apparently not. The joys of vibe coding :)

## [0.5.0] - 2026-01-25

* Improved the Copilot integration.
    * The LLM gets general instructions ala copilot-instructions.md in each new conversation.
    * The LLM gets the full conversation history by default.
    * The user gets the ability to manage the conversation history by being able to delete parts (tool calls, returned queries, etc.) on demand through the chat UI.
    * The user gets the ability to inspect the tool calls made.
    * More efficient syntax for Kusto schemas to handle larger databases and be more efficient with the context window.
* Added the **Funnel** chart type.
* Improved UX and error messages when a Kusto connection cannot be established, yet the user is changing the cluster / database selection. Better use of cached schema & better error messages.
* The chart mode buttons are hidden when the section is minimized.
* The markdown mode buttons are hidden when the section is minimized.
* New extension setting for controlling whether it opens .md files by default or not.
* Much better naming strategy for sections: `<Name> | 'Unamed' [section #<number]`
* Updated 'Add X / Y / Z' buttons at the bottom of the file to not repeat 'Add'.
* Updated README.
* Bug fixes
    * Various CTRL+ shortcuts that are used by VS Code were being interfering with editing markdown sections or files. This is an old bug that returned, so fixed it again.
    * Search box within a single kusto editor box (e.g., .cls, or .kql file) was losing focus automatically making it impossible to actually search.
    * Chart types Bar, Chart, and Line had UI alignment issues.
    * It used to trigger the auto-complete dropdown when the cursor was at the very end of a term or string, right after the last character and before white space which just ruins the flow of typing with the auto-trigger completions feature enabled.
    * It used to always copy the table header into the clipboard and it was annoying when we were only trying to copy a single cell or two. So now it only includes the headers when you are copying entire rows.
    * Focus was not being assigned to the correct controls at the correct time, which lead to table cells being selected and then CTRL+C would not copy their contents into the clipboard, which of course was wrong.
    * Undo inside a .md file would reset the view and move the cursor to the very top of the file, position 0,0.
    * Paste into a .md file would reset the view and move the cursor to the very top of the file, position 0,0.

## [0.4.0] - 2026-01-22

* Added extension settings for controlling whether the extension opens .kql and .cls files
* Copilot inline auto-complete (ghost text) support + new toolbar button turning it on / off
* Bug fixes
    * When a single editor contained multiple queries, it would complain about the non-active statements when they should be getting completely ignored.

## [0.3.0] - 2026-01-15

* Data Transformations. New type of section that allows you to manipulate data that comes from a kusto query, a .csv file, or another data transformation.
* Cell Value Viewer. Improved the tabular control with the ability to double click any cell and open its contents up into a 'cell viewer' with search capabilities. This should help with scenarios where the value is just a string, not JSON, but still a very long string that makes it uncomfortable to deal with.
* Search UX and functionality improvements. Now able to search using either simple wildcards or using full blown regex.
* Auto-complete can now be toggled to auto-show via the toolbar
* The files .kql and .csl now have feature parity with .kqlx files via a sidecar json file
* Bug fixes
    * Fixed bug that affected CTRL+C in the tabular control.
    * Fixed bug that stopped query results from being saved to file.
    * Fixed bug that made VS Code flicker the 'file has changes' indicator for the session.kqlx file.
    * Fixed bug when editing Kusto code at the end of the file without enough space to show a drop-down auto-complete menu
    * Fixed bug that stopped the file from remembering the size of charts

## [0.2.1] - 2026-01-12

* Fixed embarassing bug that stopped the cluster and database drop-downs from being usable. If I was a user of this thing, I'd be screaming. I'm sorry everybody!

## [0.2.0] - 2026-01-10

* Initial support for charts
* Initial support for diff views
* Integrated the official Kusto editor https://github.com/Azure/monaco-kusto
* A ton of other bug fixes and improvements, but instead of documenting them I was playing Civ VI (deity is BS)

## [0.1.8] - 2026-01-06

* Support for large datasets
* Improved syntax support (more work to be done there, please send examples that don't work perfectly as that helps a lot)
* Gutter indicator for the currently active Kusto statements (only visible when there are mutliple ones)
* Toolbar buttons groupped better for less clutter
* Renamed 'Smart documentation tooltips' to just 'Smart documentation' now that it is a banner and not a tooltip any more (better user experience that way)
* Added 'Share query as URL' feature that is compatible with Azure Data Explorer
* Fixed 'fit to contents' behavior that resulted in the wrong size
* Implemented smart default connection for .KQL files by looking at the tables being used
    Fixed VS Code PROBLEMS diagnostics getting stuck (e.g., KW\_UNKNOWN\_TABLE) after switching cluster/database: diagnostics now refresh immediately as the selection changes.

## [0.1.7] - 2026-01-06

* Run query: Ctrl+Enter and Ctrl+Shift+Enter now both execute (Cmd variants on macOS too)
* Run query: when the cursor is inside the editor, only the Kusto statement under the cursor executes (statements separated by one or more blank lines)

## [0.1.6] - 2025-12-21

* Auto-complete improvements and fixes
* Filter tabular results improvements and fixes
* Search support for all file types

## [0.1.5] - 2025-12-20

* Version bump and packaging for the v0.1.5 release.

## [0.1.4]

* Reset database dropdown to an empty placeholder on invalid/unreachable cluster addresses (e.g., ENOTFOUND).
* Clear stale database-load errors when switching clusters.
* Disable "Run query" until a valid cluster + database (or favorite) selection is available; keep run-mode selection available.
* Show a helpful tooltip when "Run query" is disabled.

## [0.1.3]

* Added support for Kusto dot control commands across autocomplete, docs, and diagnostics.
* Improved caret-docs banner behavior (argument tracking, focus freeze, and boundary correctness).
* Fixed false "Unknown table" diagnostics for tabular user-defined function parameters.

## [0.1.2]

* Made the schema "(cached)" indicator a hyperlink that opens the cached values viewer.
* Implemented a viewer + editor for all the cached values (authentication tokens, database names, etc.)
* Improved authentication logic to better handle multi-account scenarios

## [0.1.1]

* Added a 'ask for link' at the bottom of the files
* Fixed the issue with images + markdown files

## [0.1.0]

* Improved multi-account authentication flow: clicking "Refresh databases" now prompts for the correct VS Code/Microsoft account when needed, and retries after 401/403 authentication failures.
* Prevented an empty refresh result from wiping a previously loaded database list.

## [0.0.9]

* Fixed the glaring issue with the editing toolbar in the markdown section not staying always visible as you scroll (oops, sorry!)
* Fixed the incosistent behavior of drop down menus (should be able to navigate with keyboard now as well)
* Proper per-cluster authentication: remember which work account was used per Kusto cluster and retry known accounts silently before prompting.

## [0.0.8]

* Markdown section massively improved thanks to the folks @ toast-ui who have built an awesome control!
* Created re-usable drop-down control and ... then well ... re-used it.
* Made the Kusto editor's autocomplete drop-down be smarter in terms of its size and overall behavior

## [0.0.7]

* Tables sorting (even advanced multi-column scenarios are supported)
* Table filtering (both value based and rule based supported).
* Kusto query sections can now be hidden / viewed just like URL sections.
* Red squiggly line support for Kusto editor.
* Auto-complete for Kusto editor is now context aware, multi-line aware, variable aware and their suggestions are expected to match the red squiggly line behavior.
* New ability to add cluster + database connection pairs as favorites and pick them.
* Fix: Switching favorites across clusters no longer reuses the wrong cluster client.

## [0.0.6]

* Bug fixes and UX improvements

## [0.0.5]

* Initial release