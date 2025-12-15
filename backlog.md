## Custom documentation query -> banner
Our custom documentation tooltip is awesome, but a bit distracting. Let's keep the functionality and the contents and the triggers all the same, but let's change the presentation from a tooltip to a banner that shows at the top of the editor example like the one we show for the kusto clusters we detect in the query

## Error Handling
Awesome! We have finished building most of our awesome features but we have neglected spending any of our UX time on error conditions, error handling, etc.

We want users to have an awesome experience even when things are failing and we want to try and detect the solution on their behalf almost as often as possible.

The error condition here is that for some reason a connection that usually works is now failing to work. This might be for many different reasons, like the user forgetting to turn on their VPN, from their wifi being turned off, to their home or office network having an outage.

Error:
Query execution failed: Failed to get cloud info for cluster https://ddtelvscode.kusto.windows.net - Error: connect ETIMEDOUT 172.169.72.127:443

Let's present an awesome UX to the user about the above condition and guide them through what might be going on and the next steps they should take.

## Query failure notification  (depends on previous work item)
WHen a query fails there is also a notification on the bottom right corner of VS Code but it's prefixed twice with the string 'Query execution failed:' so it reads: 'Query execution failed: Query execution failed: <message>'

Can you please update this notification to match the language and information also visible on the main UX as well for the error that occurred? We want to just show the exact same string if possible so that users can easily make the mental connection between the two UX surfaces.

## Product a file with the following info (?)
A json file with the following info:

Cluster name
Database name
Table name

Table type: pick one of these:

	- Per Event = one row per time something happens, like a click, or an API call
	- Per Day = aggregated daily, so one row is one day of something happening
	- Per Month = aggregated monthly, so one row is the sum(), count() or dcount() of one whole month of something happening
 	- Per 28D Rolling = aggregated 28 rolling, so one row the sum(), count() or dcount() of the last 28 days for each day
	- Other = anything that isn't per event, per day, per month, or per 28d rolling

List of columns and per column include the following info:
 - data type
 - Top 10 unique values per column
 - Empty row count = whether it contains any rows where this column is empty 
 - Min Value
 - Max Value

