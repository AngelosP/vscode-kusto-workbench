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

