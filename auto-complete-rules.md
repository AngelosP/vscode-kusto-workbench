# Rules for the auto complete experience of the monaco editor when writing Kusto

What items we provide auto-complete for:

* Tables
* Views
* Functions
* Columns
* Built-in Operations / Functions

Rule #1
Generally speaking, we have 3 sets of values that we show the auto-complete list for:

1. Tables, Views, Tabular Functions
2. Columns, Functions, Built-in Operations (e.g, tostring(), strcat(), count(), dcount(), avg() etc.)
3. Kusto query operators (e.g., where, summarize, extend, etc.)

Rule #1
On a blank line, or when starting a new statement, the items we want to see in the auto-complete for the first list (in order they should appear in): Tables, View, Tabular Functions. Inside each of these sub-groups we want the things listed in alphabetical order of course.

Rule #2
At the beginning of a new statement\, so either '\|'\, or '\| '\, or '\| '\, or any such variation we want to auto\-complete for the 2nd list \(in order they should appear in\): Columns\, Functions\, Built\-in Operations\.

Rule #3