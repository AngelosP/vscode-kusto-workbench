/**
 * Page objects for interacting with the Kusto Workbench custom editor webview.
 *
 * These encapsulate the CSS selectors used in the extension's UI so that E2E
 * tests can interact with query boxes, connection dropdowns, result tables,
 * toolbar buttons, etc. without hardcoding selectors everywhere.
 */
import {
	By,
	EditorView,
	Key,
	VSBrowser,
	WebDriver,
	Workbench,
	WebElement,
	until,
} from 'vscode-extension-tester';

/** Wait a specified number of milliseconds */
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Helper: wait for an element by locator using a driver-like object
// ---------------------------------------------------------------------------
async function waitForElementBy(
	driver: { findElement(locator: any): Promise<WebElement> },
	locator: ReturnType<typeof By.css>,
	timeoutMs = 15_000,
): Promise<WebElement> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			const el = await driver.findElement(locator);
			if (el) {
				return el;
			}
		} catch (e) {
			lastError = e;
		}
		await sleep(500);
	}
	throw new Error(
		`Timed out waiting for element ${locator} after ${timeoutMs}ms. Last error: ${lastError}`,
	);
}

// ---------------------------------------------------------------------------
// Low-level webview frame switching
// ---------------------------------------------------------------------------

/**
 * Manually switch into the webview iframe for a custom editor.
 * VS Code nests the webview content inside two layers of iframes:
 *   main DOM → iframe.webview.ready → iframe#active-frame → extension content
 */
async function switchToWebviewFrame(driver: WebDriver, timeoutMs = 30_000): Promise<void> {
	// First, switch back to default content to start clean
	await driver.switchTo().defaultContent();

	const start = Date.now();
	let lastError: unknown;

	while (Date.now() - start < timeoutMs) {
		try {
			// Find the outermost webview iframe
			const outerFrames = await driver.findElements(
				By.css('iframe.webview.ready'),
			);
			if (outerFrames.length === 0) {
				throw new Error('No iframe.webview.ready found');
			}
			// Use the last one (most recently opened)
			await driver.switchTo().frame(outerFrames[outerFrames.length - 1]);

			// Now find the inner active-frame iframe
			const innerFrame = await driver.findElement(By.id('active-frame'));
			await driver.switchTo().frame(innerFrame);

			// Verify we're inside the extension's content by checking for a known element
			await driver.findElement(By.css('#queries-container, .query-box, .add-controls'));
			return;
		} catch (e) {
			lastError = e;
			// Reset to default content before retrying
			try { await driver.switchTo().defaultContent(); } catch { /* ignore */ }
		}
		await sleep(1000);
	}
	throw new Error(
		`Timed out switching to webview frame after ${timeoutMs}ms. Last error: ${lastError}`,
	);
}

/** Switch back to the main VS Code DOM */
async function switchBackToMain(driver: WebDriver): Promise<void> {
	await driver.switchTo().defaultContent();
}

// ---------------------------------------------------------------------------
// KustoQueryBox – represents a single query section inside the editor
// ---------------------------------------------------------------------------
export class KustoQueryBox {
	constructor(
		private readonly driver: WebDriver,
		private readonly boxElement: WebElement,
	) {}

	/** Get the section name displayed in the header */
	async getName(): Promise<string> {
		const nameEl = await this.boxElement.findElement(By.css('.query-name'));
		return nameEl.getAttribute('value');
	}

	/** Set the section name */
	async setName(name: string): Promise<void> {
		const nameEl = await this.boxElement.findElement(By.css('.query-name'));
		await nameEl.clear();
		await nameEl.sendKeys(name);
	}

	/** Click the Run button for this query box */
	async clickRun(): Promise<void> {
		const runBtn = await this.boxElement.findElement(
			By.css('[class*="unified-btn-split-main"]'),
		);
		await runBtn.click();
	}

	/** Click the connection dropdown and return the menu element */
	async openConnectionDropdown(): Promise<WebElement> {
		const connBtn = await this.boxElement.findElement(
			By.css('[id$="_connection_btn"]'),
		);
		await this.driver.executeScript('arguments[0].click();', connBtn);
		await sleep(500);
		return waitForElementBy(this.driver, By.css('.kusto-dropdown-menu'));
	}

	/** Click the database dropdown and return the menu element */
	async openDatabaseDropdown(): Promise<WebElement> {
		const dbBtn = await this.boxElement.findElement(
			By.css('[id$="_database_btn"]'),
		);
		await dbBtn.click();
		return waitForElementBy(this.driver, By.css('.kusto-dropdown-menu'));
	}

	/** Get the currently selected connection text */
	async getConnectionText(): Promise<string> {
		const textEl = await this.boxElement.findElement(
			By.css('[id$="_connection_btn_text"]'),
		);
		return textEl.getText();
	}

	/** Get the currently selected database text */
	async getDatabaseText(): Promise<string> {
		const textEl = await this.boxElement.findElement(
			By.css('[id$="_database_btn_text"]'),
		);
		return textEl.getText();
	}

	/** Open the favorites dropdown */
	async openFavorites(): Promise<WebElement> {
		const favBtn = await waitForElementBy(this.boxElement, By.css('.kusto-favorites-btn'));
		await this.driver.executeScript('arguments[0].click();', favBtn);
		await sleep(500);
		return waitForElementBy(
			this.driver,
			By.css('.kusto-favorites-menu'),
		);
	}

	/** Check if results are visible */
	async hasResults(): Promise<boolean> {
		try {
			const results = await this.boxElement.findElement(
				By.css('.results-wrapper'),
			);
			return results.isDisplayed();
		} catch {
			return false;
		}
	}

	/** Get the schema info button */
	async getSchemaButton(): Promise<WebElement> {
		return this.boxElement.findElement(By.css('.schema-info-btn'));
	}

	/** Close the section (click the remove/close button) */
	async close(): Promise<void> {
		const closeBtn = await this.boxElement.findElement(By.css('.close-btn'));
		await closeBtn.click();
	}
}

// ---------------------------------------------------------------------------
// KustoEditorPage – top-level page object for the full Kusto custom editor
// ---------------------------------------------------------------------------
export class KustoEditorPage {
	private driver: WebDriver;
	private inFrame = false;

	constructor() {
		this.driver = VSBrowser.instance.driver;
	}

	/** Switch into the webview iframe — MUST be called before interacting with elements */
	async switchToWebview(timeout = 30_000): Promise<void> {
		await switchToWebviewFrame(this.driver, timeout);
		this.inFrame = true;
	}

	/** Switch back to the main VS Code window */
	async switchBack(): Promise<void> {
		if (this.inFrame) {
			await switchBackToMain(this.driver);
			this.inFrame = false;
		}
	}

	/** Get all query boxes currently visible */
	async getQueryBoxes(): Promise<KustoQueryBox[]> {
		const elements = await this.driver.findElements(By.css('.query-box'));
		return elements.map((el) => new KustoQueryBox(this.driver, el));
	}

	/** Get the first query box */
	async getFirstQueryBox(): Promise<KustoQueryBox> {
		const boxes = await this.getQueryBoxes();
		if (boxes.length === 0) {
			throw new Error('No query boxes found');
		}
		return boxes[0];
	}

	/** Click the "Add Section" dropdown button */
	async openAddSectionDropdown(): Promise<WebElement> {
		const btn = await waitForElementBy(this.driver, By.css('#addSectionDropdownBtn'));
		// Use JavaScript click to avoid ElementNotInteractableError (button may be outside viewport)
		await this.driver.executeScript('arguments[0].scrollIntoView({block:"center"}); arguments[0].click();', btn);
		await sleep(500);
		return waitForElementBy(this.driver, By.css('#addSectionDropdownMenu'));
	}

	/** Add a new section of the given type (e.g. 'query', 'markdown', 'chart') */
	async addSection(kind: string): Promise<void> {
		const menu = await this.openAddSectionDropdown();
		const item = await menu.findElement(
			By.css(`[data-add-kind="${kind}"]`),
		);
		await this.driver.executeScript('arguments[0].click();', item);
	}

	/** Get the queries container */
	async getQueriesContainer(): Promise<WebElement> {
		return waitForElementBy(this.driver, By.css('#queries-container'));
	}

	/** Wait for an element inside the webview using CSS selector */
	async waitForSelector(css: string, timeoutMs = 15_000): Promise<WebElement> {
		return waitForElementBy(this.driver, By.css(css), timeoutMs);
	}

	/** Find an element inside the webview by CSS selector */
	async findElement(css: string): Promise<WebElement> {
		return this.driver.findElement(By.css(css));
	}

	/** Find multiple elements inside the webview by CSS selector */
	async findElements(css: string): Promise<WebElement[]> {
		return this.driver.findElements(By.css(css));
	}
}

// ---------------------------------------------------------------------------
// Helpers for common VS Code operations
// ---------------------------------------------------------------------------

/** Open the command palette and execute a command by its title */
export async function executeCommand(commandTitle: string): Promise<void> {
	const workbench = new Workbench();
	const input = await workbench.openCommandPrompt();
	// setText replaces the existing '>' prefix, so we must include it
	await input.setText(`>${commandTitle}`);
	await sleep(1500);
	await input.confirm();
}

/** Open a file from the workspace by relative path using Quick Open */
export async function openFileFromWorkspace(relativePath: string): Promise<void> {
	const workbench = new Workbench();
	const input = await workbench.openCommandPrompt();
	// Quick Open: type without '>' prefix for file search
	await input.setText(relativePath);
	await sleep(1500);
	await input.confirm();
}

/** Dismiss any VS Code modal dialogs (e.g. "Do you want to save?") */
export async function dismissDialogs(): Promise<void> {
	const driver = VSBrowser.instance.driver;
	try {
		// Look for the dialog modal block and try pressing Escape or clicking "Don't Save"
		const dialogs = await driver.findElements(By.css('.monaco-dialog-box'));
		for (const dialog of dialogs) {
			try {
				// Try clicking "Don't Save" button if present
				const buttons = await dialog.findElements(By.css('.dialog-button'));
				for (const btn of buttons) {
					const text = await btn.getText();
					if (text.includes("Don't Save") || text.includes('No')) {
						await btn.click();
						await sleep(500);
						return;
					}
				}
			} catch { /* no dialog buttons */ }
		}
	} catch { /* no dialogs */ }

	// Fallback: press Escape to dismiss any dialog
	try {
		await driver.actions().sendKeys(Key.ESCAPE).perform();
		await sleep(300);
	} catch { /* ignore */ }
}

/** Close all editors, handling save dialogs */
export async function closeAllEditors(): Promise<void> {
	const driver = VSBrowser.instance.driver;
	// Make sure we're in the main frame
	try { await driver.switchTo().defaultContent(); } catch { /* ignore */ }

	// Dismiss any existing dialogs first
	await dismissDialogs();

	// Close all editors via the command palette
	try {
		const workbench = new Workbench();
		const input = await workbench.openCommandPrompt();
		await input.setText('>View: Close All Editors');
		await sleep(1000);
		await input.confirm();
		await sleep(1500);
		// Dismiss any save dialogs that appear
		await dismissDialogs();
		await sleep(500);
	} catch { /* best effort */ }
}
