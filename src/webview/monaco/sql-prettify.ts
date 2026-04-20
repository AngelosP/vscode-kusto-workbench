import { format } from 'sql-formatter';

/**
 * Format a T-SQL string using sql-formatter.
 * Returns the original text unchanged if formatting fails.
 */
export function prettifySql(text: string): string {
	try {
		const formatted = format(text, {
			language: 'transactsql',
			tabWidth: 4,
			keywordCase: 'upper',
		});
		// sql-formatter places TOP on its own line after SELECT and keeps the first
		// projected column on the same line as TOP. We want:
		//     SELECT TOP n
		//         col1,
		//         col2,
		// so collapse `SELECT\n    TOP n` → `SELECT TOP n` and push the first
		// column onto the next line with the standard 4-space indent.
		return formatted.replace(
			/\bSELECT(\s+DISTINCT)?\s*\r?\n\s+TOP(\s*\(?\s*[\w@$]+\s*\)?(?:\s+PERCENT)?(?:\s+WITH\s+TIES)?)([ \t]+)(?!FROM\b)/gi,
			(_match, distinct, topRest) => `SELECT${distinct ? ' DISTINCT' : ''} TOP${topRest}\n    `
		);
	} catch {
		return text;
	}
}
