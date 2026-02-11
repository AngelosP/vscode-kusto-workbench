# Import Connections from Kusto Explorer

If you already use **Kusto Explorer** (Desktop or Web), you can import all your cluster connections at once instead of adding them one by one.

## Exporting from Kusto Explorer Desktop

1. Open **Kusto Explorer Desktop**.
2. Go to **File → Connections → Export Connections** (or right-click your connections panel and export).
3. Save the `.xml` file to a convenient location.

## Exporting from Kusto Explorer Web

1. Open **Kusto Explorer Web** (https://dataexplorer.azure.com).
2. In the left panel, click the **gear icon** or go to **Settings**.
3. Look for an option to export connections — this will produce an `.xml` file in Kusto Explorer's format.

## Importing into Kusto Workbench

1. Open the **Kusto Workbench Query Editor**.
2. Open the **Connection Manager** by clicking the connection icon or running **"Kusto Workbench: Manage Connections"** from the Command Palette.
3. In the Connection Manager, click the **"Import connections from XML"** action.
4. Select the `.xml` file you exported.
5. Review the list of discovered connections and confirm the import.

All your clusters and databases will be added and immediately available in the cluster/database dropdowns across all query sections.
