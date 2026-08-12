export interface PythonExecutionReservation {
	readonly boxId: string;
	readonly owner: object;
	readonly code: string;
	retired: boolean;
}

const pendingByBoxId = new Map<string, PythonExecutionReservation>();

export function reservePythonExecution(boxId: string, owner: object, code: string): boolean {
	const id = String(boxId || '').trim();
	if (!id || pendingByBoxId.has(id)) return false;
	pendingByBoxId.set(id, { boxId: id, owner, code, retired: false });
	return true;
}

export function retirePythonExecution(boxId: string, owner: object): void {
	const pending = pendingByBoxId.get(String(boxId || '').trim());
	if (pending?.owner === owner) pending.retired = true;
}

export function cancelPythonExecution(boxId: string, owner: object): void {
	const id = String(boxId || '').trim();
	const pending = pendingByBoxId.get(id);
	if (pending?.owner === owner) pendingByBoxId.delete(id);
}

export function consumePythonExecutionTerminal(boxId: string): PythonExecutionReservation | undefined {
	const pending = pendingByBoxId.get(boxId);
	if (pending) pendingByBoxId.delete(boxId);
	return pending;
}

export function isPythonExecutionPending(boxId: string): boolean {
	return pendingByBoxId.has(String(boxId || '').trim());
}

export function retireAllPythonExecutions(): void {
	for (const pending of pendingByBoxId.values()) pending.retired = true;
}

export function resetPythonExecutionAdmissionForTest(): void {
	pendingByBoxId.clear();
}