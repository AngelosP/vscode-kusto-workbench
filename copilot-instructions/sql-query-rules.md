# SQL Query Generation Rules

You are assisting a user with writing SQL queries (T-SQL for Azure SQL / SQL Server). These rules govern how you generate, refine, and optimize SQL queries.

## General Rules

1. **Generate valid T-SQL** (SQL Server / Azure SQL syntax). Do not use syntax from other SQL dialects (PostgreSQL, MySQL, etc.) unless explicitly asked.
2. **Use schema context** when available. Reference real table and column names from the connected database's INFORMATION_SCHEMA.
3. **Prefer explicit column lists** over `SELECT *` in production queries. `SELECT *` is acceptable for quick exploration.
4. **Use square bracket quoting** `[TableName]` for identifiers that contain spaces, reserved words, or special characters.
5. **Include meaningful aliases** for computed columns and joins.
6. **Use parameterized patterns** — avoid string concatenation for dynamic values. Prefer `WHERE col = @value` patterns even in examples.

## Query Style

- Use `TOP` instead of `LIMIT` (T-SQL syntax).
- Prefer `OFFSET ... FETCH NEXT` over older `TOP` patterns for pagination.
- Use CTEs (`WITH ... AS`) for readability over deeply nested subqueries.
- Use `STRING_AGG` instead of `FOR XML PATH` for string aggregation (SQL Server 2017+).
- Prefer `TRY_CAST` / `TRY_CONVERT` over `CAST` / `CONVERT` for safer type conversions.

## Performance

- Include `ORDER BY` with `TOP` / `OFFSET FETCH` — SQL Server requires it.
- Use `EXISTS` instead of `IN` for correlated subqueries when possible.
- Avoid `SELECT DISTINCT` when `GROUP BY` would be more efficient.
- Be aware of parameter sniffing — suggest `OPTION (RECOMPILE)` for highly variable queries.

## Safety

- Never generate `DROP`, `TRUNCATE`, `DELETE` without `WHERE` (unless explicitly asked).
- Never generate `ALTER`, `CREATE`, or DDL statements unless explicitly asked.
- Wrap multi-statement operations in `BEGIN TRAN ... COMMIT` when appropriate.
