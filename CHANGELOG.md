# Change Log

All notable changes to the "vscode-kusto-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [unreleased]

* Support for large datasets

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