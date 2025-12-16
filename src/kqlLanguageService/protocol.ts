export type KqlPosition = {
	/** 0-based */
	line: number;
	/** 0-based UTF-16 code unit offset within the line */
	character: number;
};

export type KqlRange = {
	start: KqlPosition;
	end: KqlPosition;
};

// Match LSP numeric severities for easy interop.
export enum KqlDiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4
}

export type KqlDiagnostic = {
	range: KqlRange;
	severity: KqlDiagnosticSeverity;
	message: string;
	code?: string;
	source?: string;
};

export type KqlGetDiagnosticsParams = {
	text: string;
	connectionId?: string;
	database?: string;
	/** Optional: helps correlate diagnostics to a specific editor instance */
	boxId?: string;
	/** Optional: document URI if this request came from a VS Code text document */
	uri?: string;
};

export type KqlGetDiagnosticsResult = {
	diagnostics: KqlDiagnostic[];
};

export type KqlTableReference = {
	name: string;
	/** 0-based UTF-16 code unit offset */
	startOffset: number;
	/** 0-based UTF-16 code unit offset */
	endOffset: number;
};

export type KqlFindTableReferencesParams = {
	text: string;
	connectionId?: string;
	database?: string;
	boxId?: string;
	uri?: string;
};

export type KqlFindTableReferencesResult = {
	references: KqlTableReference[];
};

export type KqlLanguageMethod = 'textDocument/diagnostic' | 'kusto/findTableReferences';

export type KqlLanguageRequestMessage =
	| {
			type: 'kqlLanguageRequest';
			requestId: string;
			method: 'textDocument/diagnostic';
			params: KqlGetDiagnosticsParams;
	  }
	| {
			type: 'kqlLanguageRequest';
			requestId: string;
			method: 'kusto/findTableReferences';
			params: KqlFindTableReferencesParams;
	  };

export type KqlLanguageResponseMessage =
	| {
			type: 'kqlLanguageResponse';
			requestId: string;
			ok: true;
			result: KqlGetDiagnosticsResult | KqlFindTableReferencesResult;
		}
	| {
			type: 'kqlLanguageResponse';
			requestId: string;
			ok: false;
			error: { message: string };
		};
