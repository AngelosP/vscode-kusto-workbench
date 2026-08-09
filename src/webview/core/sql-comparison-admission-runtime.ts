type SqlComparisonAdmissionRetirementHandler = (
	comparisonBoxId: string,
	sourceBoxId: string,
) => boolean;

let retirementHandler: SqlComparisonAdmissionRetirementHandler | undefined;

export function registerSqlComparisonAdmissionRetirementHandler(
	handler: SqlComparisonAdmissionRetirementHandler,
): { dispose(): void } {
	retirementHandler = handler;
	return {
		dispose(): void {
			if (retirementHandler === handler) retirementHandler = undefined;
		},
	};
}

export function retireSqlComparisonAdmission(
	comparisonBoxId: string,
	sourceBoxId: string,
): boolean {
	return retirementHandler?.(comparisonBoxId, sourceBoxId) === true;
}
