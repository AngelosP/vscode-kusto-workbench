Feature: Exported skill includes dashboard rules sidecar

  Background:
    Given the extension is in a clean state
    Then I collect JSON artifact "export-skill-workspace-preflight" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule?.('fs');
        const path = process.getBuiltinModule?.('path');
        if (!fs || !path) throw new Error('Node filesystem APIs are unavailable in the extension host');
        const tempRoot = String(process.env.TEMP || '');
        if (!tempRoot) throw new Error('TEMP must be set for the export-skill E2E workspace');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension) throw new Error('Kusto Workbench extension path is unavailable');
        const realpath = value => (fs.realpathSync.native || fs.realpathSync)(value);
        const isWithin = (candidate, root) => {
          const relative = path.relative(root, candidate);
          return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        };
        const canonicalExtension = realpath(extension.extensionUri.fsPath);
        const canonicalTemp = realpath(tempRoot);
        if (isWithin(canonicalTemp, canonicalExtension)) {
          throw new Error('TEMP resolved inside the extension repository: ' + canonicalTemp);
        }
        const expected = path.join(canonicalTemp, 'vscode-kusto-workbench-export-skill-sidecar');
        const ownerPath = path.join(expected, '.kusto-workbench-e2e-owner');
        const ownerContent = 'export-skill-sidecar-v1\n';
        const rootStat = fs.lstatSync(expected, { throwIfNoEntry: false });
        if (!rootStat) {
          fs.mkdirSync(expected);
          fs.writeFileSync(ownerPath, ownerContent, { encoding: 'utf8', flag: 'wx' });
        } else {
          if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error('Export-skill E2E workspace root is a link or has the wrong type: ' + expected);
          }
          const ownerStat = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
          if (!ownerStat) throw new Error('Export-skill E2E workspace already exists without its ownership marker: ' + expected);
          if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
            throw new Error('Export-skill E2E ownership marker is not an independent regular file: ' + ownerPath);
          }
          if (fs.readFileSync(ownerPath, 'utf8') !== ownerContent) {
            throw new Error('Export-skill E2E workspace has a foreign ownership marker: ' + expected);
          }
        }
        const guardedPaths = [
          { path: expected, kind: 'directory' },
          { path: ownerPath, kind: 'file' },
          { path: path.join(expected, '.github'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench', 'SKILL.md'), kind: 'file' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench', 'html-dashboard-rules.md'), kind: 'file' }
        ];
        for (const candidate of guardedPaths) {
          const candidatePath = candidate.path;
          const stat = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
          if (!stat) continue;
          if (stat.isSymbolicLink()) throw new Error('Export-skill E2E path contains a link: ' + candidatePath);
          if (candidate.kind === 'directory' && !stat.isDirectory()) throw new Error('Export-skill E2E directory path has the wrong type: ' + candidatePath);
          if (candidate.kind === 'file' && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Export-skill E2E file path is not an independent regular file: ' + candidatePath);
          const canonical = realpath(candidatePath);
          if (isWithin(canonical, canonicalExtension)) throw new Error('Export-skill E2E path resolves inside the extension repository: ' + candidatePath);
        }
        return { expected, extensionPath: canonicalExtension, guardedPathCount: guardedPaths.length };
      })()
      """
    When I add folder "${TEMP}/vscode-kusto-workbench-export-skill-sidecar" to the workspace
    Then I collect JSON artifact "export-skill-workspace" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule?.('fs');
        const path = process.getBuiltinModule?.('path');
        if (!fs || !path) throw new Error('Node filesystem APIs are unavailable in the extension host');
        const tempRoot = String(process.env.TEMP || '');
        if (!tempRoot) throw new Error('TEMP must be set for the export-skill E2E workspace');
        const realpath = value => (fs.realpathSync.native || fs.realpathSync)(value);
        const expected = path.join(realpath(tempRoot), 'vscode-kusto-workbench-export-skill-sidecar');
        const folders = vscode.workspace.workspaceFolders || [];
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension) throw new Error('Kusto Workbench extension path is unavailable');
        const canonicalExtension = realpath(extension.extensionUri.fsPath);
        const canonicalExpected = realpath(expected);
        const ownerPath = path.join(expected, '.kusto-workbench-e2e-owner');
        const ownerContent = 'export-skill-sidecar-v1\n';
        const isWithin = (candidate, root) => {
          const relative = path.relative(root, candidate);
          return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        };
        if (isWithin(canonicalExpected, canonicalExtension)) {
          throw new Error('Export-skill E2E workspace resolved inside the extension repository: ' + canonicalExpected);
        }
        const actualPaths = folders.map(folder => realpath(folder.uri.fsPath));
        const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (actualPaths.length !== 1 || normalize(actualPaths[0]) !== normalize(canonicalExpected)) {
          throw new Error('Export-skill E2E requires its temp workspace to be the sole workspace folder: ' + JSON.stringify({ expected: canonicalExpected, actual: actualPaths }));
        }
        const guardedPaths = [
          { path: expected, kind: 'directory' },
          { path: ownerPath, kind: 'file' },
          { path: path.join(expected, '.github'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench'), kind: 'directory' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench', 'SKILL.md'), kind: 'file' },
          { path: path.join(expected, '.github', 'skills', 'kusto-workbench', 'html-dashboard-rules.md'), kind: 'file' }
        ];
        for (const candidate of guardedPaths) {
          const candidatePath = candidate.path;
          const stat = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
          if (!stat) continue;
          if (stat.isSymbolicLink()) throw new Error('Export-skill E2E path contains a link after workspace activation: ' + candidatePath);
          if (candidate.kind === 'directory' && !stat.isDirectory()) throw new Error('Export-skill E2E directory path has the wrong type after workspace activation: ' + candidatePath);
          if (candidate.kind === 'file' && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Export-skill E2E file path is not an independent regular file after workspace activation: ' + candidatePath);
          if (isWithin(realpath(candidatePath), canonicalExtension)) {
            throw new Error('Export-skill E2E path resolves inside the extension repository after workspace activation: ' + candidatePath);
          }
        }
        if (fs.readFileSync(ownerPath, 'utf8') !== ownerContent) {
          throw new Error('Export-skill E2E workspace ownership changed after activation: ' + expected);
        }
        return { expected: canonicalExpected, actual: actualPaths[0], folderCount: folders.length };
      })()
      """
    When I delete file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md"
    When I delete file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md"
    And I wait 2 seconds

  Scenario: Export Agent Skill writes SKILL.md and html-dashboard-rules.md
    When I start command "kusto.exportSkill"
    Then I wait for QuickInput title "Where"
    When I press "Enter"
    And I wait 1 second

    Then the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" should exist
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should exist
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" should contain "# version: 19"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" should contain "./html-dashboard-rules.md"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" should contain "# Kusto Workbench Skill"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should contain "# Kusto Workbench HTML Dashboard Rules"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should contain "## Dashboard Checklist"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should contain "KustoWorkbench.renderTable(bindingId)"
    And the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should contain "## Validation Workflow"
    Then I collect JSON artifact "export-skill-exact-bytes" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension) throw new Error('Kusto Workbench extension path is unavailable');
        const target = path.join(process.env.TEMP, 'vscode-kusto-workbench-export-skill-sidecar', '.github', 'skills', 'kusto-workbench');
        const actualSkill = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
        const actualRules = fs.readFileSync(path.join(target, 'html-dashboard-rules.md'), 'utf8');
        const sourceSkill = fs.readFileSync(path.join(extension.extensionUri.fsPath, 'media', 'skill-template.md'), 'utf8');
        const sourceRules = fs.readFileSync(path.join(extension.extensionUri.fsPath, 'copilot-instructions', 'html-dashboard-rules.md'), 'utf8');
        const expectedSkill = sourceSkill.trimEnd() + String.fromCharCode(10);
        if (actualSkill !== expectedSkill) throw new Error('Exported SKILL.md bytes differ from the canonical template');
        if (actualRules !== sourceRules) throw new Error('Exported dashboard rules bytes differ from the canonical source');
        return { skillBytes: Buffer.byteLength(actualSkill), rulesBytes: Buffer.byteLength(actualRules), exact: true };
      })()
      """
    Then I take a screenshot "exported-skill-sidecar"

  Scenario: Existing sidecar local edits are not overwritten without consent
    Given a file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" exists with content "custom-skill-marker"
    Given a file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" exists with content "custom-dashboard-sidecar-marker"

    When I start command "kusto.exportSkill"
    Then I wait for QuickInput title "Where"
    When I press "Enter"
    And I wait 1 second
    Then I take a screenshot "skill-overwrite-confirmation"
    When I press "Escape"
    And I wait 1 second

    Then the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md" should contain "custom-skill-marker"
    Then the file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md" should contain "custom-dashboard-sidecar-marker"
    Then I collect JSON artifact "preserved-local-skill-exact-bytes" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        const target = path.join(process.env.TEMP, 'vscode-kusto-workbench-export-skill-sidecar', '.github', 'skills', 'kusto-workbench');
        const skill = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
        const rules = fs.readFileSync(path.join(target, 'html-dashboard-rules.md'), 'utf8');
        if (skill !== 'custom-skill-marker') throw new Error('SKILL.md local bytes changed: ' + JSON.stringify(skill));
        if (rules !== 'custom-dashboard-sidecar-marker') throw new Error('Dashboard rules local bytes changed: ' + JSON.stringify(rules));
        return { skill, rules, exact: true };
      })()
      """
    Then I take a screenshot "preserved-local-skill-edits"
    When I delete file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/SKILL.md"
    When I delete file "${TEMP}/vscode-kusto-workbench-export-skill-sidecar/.github/skills/kusto-workbench/html-dashboard-rules.md"
    Then I collect JSON artifact "export-skill-workspace-cleanup" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        const expected = path.join(process.env.TEMP, 'vscode-kusto-workbench-export-skill-sidecar');
        const ownerPath = path.join(expected, '.kusto-workbench-e2e-owner');
        const rootStat = fs.lstatSync(expected, { throwIfNoEntry: false });
        const ownerStat = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
        if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Owned export-skill workspace root is unavailable at cleanup');
        if (!ownerStat?.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1) throw new Error('Owned export-skill workspace marker is invalid at cleanup');
        if (fs.readFileSync(ownerPath, 'utf8') !== 'export-skill-sidecar-v1\n') throw new Error('Owned export-skill workspace marker changed before cleanup');
        fs.rmSync(path.join(expected, '.github'), { recursive: true, force: true });
        const remaining = fs.readdirSync(expected).sort();
        if (JSON.stringify(remaining) !== JSON.stringify(['.kusto-workbench-e2e-owner'])) {
          throw new Error('Owned export-skill workspace retained unexpected content: ' + JSON.stringify(remaining));
        }
        return { generatedContentRemoved: true, retainedOwnershipMarker: true };
      })()
      """
