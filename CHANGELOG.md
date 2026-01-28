# Change Log

All notable changes to the "vscode-kusto-workbench" extension will be documented in this file.
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.7.0] - 2026-28-01

* Improved instructions for working with raw data in Kusto. 

## [0.6.0] - 2026-28-01

* Many UX improvements for **Charts**. Biggest change is the ability to click on X or Y axis and configure additional settings. Still WIP, so more improvements to come.
* Many UX improvements for **Transformation**. Still WIP, so more improvements to come.
* Double click the resize handle to autofit to the contents of the section (available on all types of sections and editors).
* Export to Power BI has better formatting now, using fewer " characters.
* More responsive UX and better experience at tiny widths.
* Better UX controlling whether results are cached.
* Better toolbar overflow UX.
* Bug fixes
    * Kusto schema based completion dropdown annoyingly showed up when at the end of a term / word, even after successfully accepting a completion for the exact same term / word. I thought I had arleady fixed this, but apparently not. The joys of vibe coding :)

## [0.5.0] - 2026-25-01

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

## [0.4.0] - 2026-22-01

* Added extension settings for controlling whether the extension opens .kql and .cls files
* Copilot inline auto-complete (ghost text) support + new toolbar button turning it on / off
* Bug fixes
    * When a single editor contained multiple queries, it would complain about the non-active statements when they should be getting completely ignored.

## [0.3.0] - 2026-15-01

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