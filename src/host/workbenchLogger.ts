import * as vscode from 'vscode';

export const WORKBENCH_LOG_CHANNEL_NAME = 'Kusto Workbench';

export type WorkbenchLogger = Pick<vscode.LogOutputChannel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> & {
	show(preserveFocus?: boolean): void;
	log(message: string, ...args: unknown[]): void;
};

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel(WORKBENCH_LOG_CHANNEL_NAME, { log: true });
	}
	return channel;
}

export function getWorkbenchLogger(): WorkbenchLogger {
	const logger = getChannel();
	return {
		trace: (message: string, ...args: unknown[]) => logger.trace(message, ...args),
		debug: (message: string, ...args: unknown[]) => logger.debug(message, ...args),
		info: (message: string, ...args: unknown[]) => logger.info(message, ...args),
		warn: (message: string, ...args: unknown[]) => logger.warn(message, ...args),
		error: (error: string | Error, ...args: unknown[]) => logger.error(error, ...args),
		show: (preserveFocus?: boolean) => logger.show(preserveFocus),
		log: (message: string, ...args: unknown[]) => logger.info(message, ...args),
	};
}

export function showWorkbenchLogChannel(preserveFocus?: boolean): void {
	getChannel().show(preserveFocus);
}

export function registerWorkbenchLogger(context: vscode.ExtensionContext): void {
	context.subscriptions.push({
		dispose: () => {
			channel?.dispose();
			channel = undefined;
		},
	});
}