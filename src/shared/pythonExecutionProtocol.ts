type UnknownRecord = Record<string, unknown>;

export type PythonExecutionParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type PythonExecutionAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: PythonExecutionParseResult<T> }>;

type FieldParseResult<T> = PythonExecutionParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type ExecutePythonMessage = {
	type: 'executePython';
	boxId: string;
	code: string;
};

export type PythonResultMessage = {
	type: 'pythonResult';
	boxId: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export type PythonErrorMessage = {
	type: 'pythonError';
	boxId: string;
	error: string;
};

export type PythonExecutionWebviewMessage = ExecutePythonMessage;
export type PythonExecutionHostMessage = PythonResultMessage | PythonErrorMessage;

export const PYTHON_OUTPUT_MAX_BYTES = 200 * 1024;

const webviewMessageTypes = new Set(['executePython']);
const hostMessageTypes = new Set(['pythonResult', 'pythonError']);

function failure<T>(error: string): PythonExecutionParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	if (!value || typeof value !== 'object') return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): KnownTypeInspection {
	const inputType = typeof input;
	if (!input || (inputType !== 'object' && inputType !== 'function')) return { recognized: false };
	try {
		let owner: object | null = input as object;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) {
				return { recognized: true, type: { ok: false, error: 'type prototype inspection was cyclic.' } };
			}
			seen.add(owner);
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'type');
			if (descriptor) {
				const isDataProperty = Object.prototype.hasOwnProperty.call(descriptor, 'value');
				if (isDataProperty && typeof descriptor.value === 'string' && !types.has(descriptor.value)) {
					return { recognized: false };
				}
				if (owner !== input || !descriptor.enumerable || !isDataProperty) {
					return {
						recognized: true,
						type: { ok: false, error: 'type must be an own enumerable data property.' },
					};
				}
				return typeof descriptor.value === 'string'
					? { recognized: true, type: { ok: true, value: descriptor.value } }
					: { recognized: true, type: { ok: false, error: 'type must be a string.' } };
			}
			owner = Object.getPrototypeOf(owner);
		}
		return { recognized: true, type: { ok: false, error: 'type could not be resolved.' } };
	} catch {
		return { recognized: true, type: { ok: false, error: 'type could not be inspected.' } };
	}
}

function readOwnEnumerableDataProperty(input: UnknownRecord, key: string): FieldParseResult<unknown> {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return { ok: false, error: `${key} must be an own enumerable data property.` };
		}
		return { ok: true, value: descriptor.value };
	} catch {
		return { ok: false, error: `${key} could not be inspected.` };
	}
}

function readString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'string'
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a string.` };
}

function readNonblankString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readString(input, key);
	if (!field.ok) return field;
	return field.value.trim()
		? field
		: { ok: false, error: `${key} must not be blank.` };
}

function readBoundedOutput(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readString(input, key);
	if (!field.ok) return field;
	if (field.value.length > PYTHON_OUTPUT_MAX_BYTES
		|| new TextEncoder().encode(field.value).byteLength > PYTHON_OUTPUT_MAX_BYTES) {
		return { ok: false, error: `${key} must not exceed ${PYTHON_OUTPUT_MAX_BYTES} UTF-8 bytes.` };
	}
	return field;
}

function readExitCode(input: UnknownRecord): FieldParseResult<number | null> {
	const field = readOwnEnumerableDataProperty(input, 'exitCode');
	if (!field.ok) return field;
	return field.value === null
		|| (typeof field.value === 'number' && Number.isSafeInteger(field.value))
		? { ok: true, value: field.value }
		: { ok: false, error: 'exitCode must be a safe integer or null.' };
}

function hasOwn(input: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(input, key);
	} catch {
		return true;
	}
}

function parsePythonExecutionWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): PythonExecutionParseResult<PythonExecutionWebviewMessage> {
	if (!isRecord(input)) return failure('Python execution request must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'executePython') return failure('Unknown Python execution request type.');
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const code = readString(input, 'code');
	if (!code.ok) return failure(code.error);
	return {
		ok: true,
		value: { type: 'executePython', boxId: boxId.value, code: code.value },
	};
}

function parsePythonExecutionHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): PythonExecutionParseResult<PythonExecutionHostMessage> {
	if (!isRecord(input)) return failure('Python execution terminal must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'pythonResult' && type.value !== 'pythonError') {
		return failure('Unknown Python execution terminal type.');
	}
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);

	if (type.value === 'pythonError') {
		const error = readString(input, 'error');
		if (!error.ok) return failure(error.error);
		for (const key of ['stdout', 'stderr', 'exitCode']) {
			if (hasOwn(input, key)) return failure(`Python errors must not contain ${key}.`);
		}
		return {
			ok: true,
			value: { type: 'pythonError', boxId: boxId.value, error: error.value },
		};
	}

	const stdout = readBoundedOutput(input, 'stdout');
	if (!stdout.ok) return failure(stdout.error);
	const stderr = readBoundedOutput(input, 'stderr');
	if (!stderr.ok) return failure(stderr.error);
	const exitCode = readExitCode(input);
	if (!exitCode.ok) return failure(exitCode.error);
	if (hasOwn(input, 'error')) return failure('Python results must not contain error.');
	return {
		ok: true,
		value: {
			type: 'pythonResult',
			boxId: boxId.value,
			stdout: stdout.value,
			stderr: stderr.value,
			exitCode: exitCode.value,
		},
	};
}

export function isPythonExecutionWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isPythonExecutionHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitPythonExecutionWebviewMessage(
	input: unknown,
): PythonExecutionAdmissionResult<PythonExecutionWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parsePythonExecutionWebviewMessageWithType(input, inspection.type),
	};
}

export function admitPythonExecutionHostMessage(
	input: unknown,
): PythonExecutionAdmissionResult<PythonExecutionHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parsePythonExecutionHostMessageWithType(input, inspection.type),
	};
}

export function parsePythonExecutionWebviewMessage(
	input: unknown,
): PythonExecutionParseResult<PythonExecutionWebviewMessage> {
	const admission = admitPythonExecutionWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Python execution request type.');
}

export function parsePythonExecutionHostMessage(
	input: unknown,
): PythonExecutionParseResult<PythonExecutionHostMessage> {
	const admission = admitPythonExecutionHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Python execution terminal type.');
}