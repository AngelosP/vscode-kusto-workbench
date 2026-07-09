---
name: pipeline-templates
description: "Author 1ES Pipeline Templates (1ES PT) — the standard governed build/release framework at Microsoft — plus OneBranch as its governed specialization (now on the 1ES PT migration path). Covers extends/Official/Unofficial, pool os/name/image, templateContext outputs & artifacts, injected SDL (BinSkim, CredScan, PoliCheck, CodeQL, Component Governance, SBOM, TSA), signing, macOS/ARM64, migration (StartRight), and OneBranch specifics (CrossPlat templates, globalSdl, ob_outputDirectory, container images, vPack, release stages, deploy). Triggers: 1ES PT, 1ES Pipeline Templates, 1ESPipelineTemplates, pipeline templates, PipelineTemplate.yml, templateContext, extends, governed pipeline, onebranch, pipeline, yaml, build, release, deploy, SDL, TSA, binskim, policheck, credscan, codeql, SBOM, signing, vpack, container, NonOfficial, Official, CrossPlat, ob_outputDirectory, PPE, production, StartRight, migration"
---

# Pipeline Templates — 1ES PT & OneBranch Authoring Reference

**1ES Pipeline Templates (1ES PT)** is the standard governed build/release pipeline framework for Microsoft internal services. It injects SDL scanning, SBOM generation, signing, and compliance into any compliant Azure DevOps YAML pipeline.

**OneBranch** is a **more prescriptive governed specialization** built on top of 1ES PT (containerized builds, managed SDL, vPack publishing, opinionated pools). OneBranch is now on a **convergence/migration path onto 1ES PT** — new work should prefer **1ES PT directly**, and existing OneBranch pipelines are being migrated org-by-org (Teams, ODSP, and others have active conversions). Prefer 1ES PT for anything new; use the OneBranch section below only when maintaining or reasoning about existing OneBranch pipelines.

| Framework | Scope | Platforms | Pool syntax | Artifacts | Status |
|-----------|-------|-----------|-------------|-----------|--------|
| **1ES PT** | Parent framework — any compliant ADO pipeline | Windows, Linux, **macOS**, ARM64 | `pool: os: / name: / image:` | `templateContext.outputs` | **Strategic / preferred** |
| **OneBranch** | Specialization for Windows/Linux container builds | Windows, Linux only | `pool: type: windows/linux` | `ob_outputDirectory` (implicit) | Migration path onto 1ES PT |

### Migration status (verified on EngHub, Jul 2026)

- Active **OneBranch → 1ES PT** conversions exist across major orgs, using the **StartRight** onboarding tool and a OneBranch→1ESPT converter.
- **Nuance**: some OneBranch release paths (e.g., **MOBR V1 / OneBranch YAML Release**) *"continue to remain compliant with 1ES governance standards and services need not migrate them"* — so it's convergence, not a hard cutoff. Confirm your service's specific mandate before migrating release pipelines.

### Docs map (EngHub)

| Topic | Link |
|-------|------|
| 1ES PT overview | https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-docs/1es-pipeline-templates/overview |
| Pipeline onboarding | https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-docs/1es-pipeline-templates/onboarding/overview |
| Outputs (artifacts) | https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-docs/1es-pipeline-templates/features/outputs |
| SDL analysis | https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-docs/1es-pipeline-templates/features/sdlanalysis/overview |
| Migration | https://eng.ms/docs/coreai/devdiv/one-engineering-system-1es/1es-docs/1es-pipeline-templates/migration/overview |
| 1ES PT schema | https://mseng.visualstudio.com/Domino/_git/1ESPipelines?path=/schema/1espt-base-schema.json |
| OneBranch docs | https://aka.ms/obpipelines · schema https://aka.ms/obpipelines/yaml/schema · support https://aka.ms/onebranchsup |
| PPE samples org | https://dev.azure.com/1ESPipelineTemplates-PPE/1ESPipelinesTest (access: https://coreidentity.microsoft.com/manage/Entitlement/entitlement/1espipelinet-zjbw) |

---

# Part 1 — 1ES Pipeline Templates (1ES PT) — **preferred**

## Template Repository & `extends`

Every 1ES PT pipeline **extends** a governed template rather than defining the full pipeline inline.

```yaml
trigger: none

resources:
  repositories:
    - repository: 1esPipelines
      type: git
      name: 1ESPipelineTemplates/1ESPipelineTemplates
      ref: refs/tags/release        # 'release' tag is intended for most pipelines

extends:
  template: v1/1ES.Unofficial.PipelineTemplate.yml@1esPipelines
  parameters:
    pool:
      name: <YourTeam_1ES_Hosted_Pool>    # your 1ES hosted pool
      image: <PoolImageName>              # image in that pool
      os: windows                         # windows (default) | linux | macOS
    stages:
      - stage: Stage
        jobs:
          - job: HostJob
            templateContext:
              outputs:
                - output: pipelineArtifact
                  targetPath: $(System.DefaultWorkingDirectory)/out
                  artifactName: drop
            steps:
              - pwsh: echo "Hello World from host"
```

### Official vs Unofficial template

| Template | Use case |
|----------|----------|
| `v1/1ES.Unofficial.PipelineTemplate.yml@1esPipelines` | Non-production / internal builds |
| `v1/1ES.Official.PipelineTemplate.yml@1esPipelines` | Production builds — required for signing, SBOM, and production releases; enables the full SDL break behavior below |

## Pool selection

- `os` accepts `windows` (default), `linux`, or `macOS`. **`os` cannot be a variable.** It must be specified for linux and macOS.
- Provide your 1ES hosted `pool.name` and an `image` in that pool.

## Property model — `templateContext`

- ADO **default** properties (`resources`, `pool`, `schedules`, `stages`, `jobs`, `steps`, …) stay where they normally go.
- 1ES PT **specific** properties (outputs, inputs, SDL knobs, etc.) must be nested under **`templateContext`**, which is allowed on both stages and jobs. ADO does not allow free-form properties directly under `stages`/`stage`/`jobs`/`job`.
- Full list of allowed `templateContext` properties: the [1ES PT schema](https://mseng.visualstudio.com/Domino/_git/1ESPipelines?path=/schema/1espt-base-schema.json).

## Outputs (artifacts) — **required for publishing**

1ES PT **blocks** the common ADO publish tasks (`PublishPipelineArtifact@1`, `PublishBuildArtifacts@1`, `ArtifactDropTask@1`, …) and requires 1ES PT outputs instead, so it can inject SBOM + Component Governance + Guardian scanning **before** the artifact is uploaded.

Two equivalent syntaxes — **prefer the declarative `templateContext.outputs`** (processed at end of job → dedupes SDL scanning; better perf):

```yaml
# Declarative (preferred)
- job: Job
  templateContext:
    outputs:
      - output: pipelineArtifact
        path: $(System.DefaultWorkingDirectory)/out
        artifact: drop
  steps:
    - pwsh: dotnet build

# Inline task (use when publishing mid-job, or inside a steps template —
# templateContext.outputs is job-level only)
- job: Job
  steps:
    - pwsh: dotnet build
    - task: 1ES.PublishPipelineArtifact@1
      inputs:
        path: $(System.DefaultWorkingDirectory)/out
        artifact: drop
```

### Supported outputs

| Output type | Declarative | Inline task | Note |
|-------------|-------------|-------------|------|
| Pipeline Artifacts | `pipelineArtifact` | `1ES.PublishPipelineArtifact@1` | Preferred artifact type |
| Azure Artifacts Drop | `artifactsDrop` | `1ES.PublishArtifactsDrop@1` | |
| Build Artifacts | `buildArtifacts` | `1ES.PublishBuildArtifacts@1` | Avoid — use Pipeline Artifacts |
| Container Image | `containerImage` | `1ES.PushContainerImage@1` | |
| NuGet Package | `nuget` | `1ES.PublishNuget@1` | |
| ADO Extension | `adoExtension` | `adoExtension` | |
| MicroBuild VSTS Drop | `microBuildUploadVstsDropFolder` | `1ES.MicroBuildVstsDrop@1` | |

### Output tips

- **Non-production artifacts** (logs, debug): set `isProduction: false` to skip SDL scanning (all tools except AntiMalware + SPMI; SBOM is blocked). Supported only for `pipelineArtifact` and `artifactsDrop`; not in jobs with `MSBuild`/`VSBuild` steps. Using these in a production release fails `Validate SBoM Manifest` (missing SBOM).
- **Upload logs even on failure**: add `condition: always()`.
- **`displayName` / `condition`** can be set next to any output's parameters.
- **Multiple outputs**: set `outputParentDirectory` (absolute path) to a common parent so SDL scans once for the parent instead of per-output.
- **Symbols**: use the retail `PublishSymbols@2` task directly (no extra SDL needed).

```yaml
templateContext:
  outputParentDirectory: $(System.DefaultWorkingDirectory)/out
  outputs:
    - output: pipelineArtifact
      displayName: Publish Logs
      targetPath: $(LogDirectory)
      artifactName: logs
      condition: always()
```

## SDL analysis (auto-injected)

1ES PT auto-enables SDL tools via **Guardian**, based on Official vs Unofficial. **No `gdnconfig` file needed** — 1ES PT provides it. Two categories:

- **Source-based** tools run in the injected **SDLSources stage** (always on a **Windows** machine — even for Linux/macOS builds, so you must give it a Windows pool).
- **Binary-based** tools run inside your user job once it declares `outputs` (or uses `1ES.BuildContainerImage`).

### Windows SDL pool for Linux/macOS builds

Linux/macOS builds still need a Windows pool for source analysis:

```yaml
extends:
  template: v1/1ES.Official.PipelineTemplate.yml@1esPipelines
  parameters:
    pool:
      os: linux
      name: <YourTeam_Linux_Pool>
      image: <LinuxImage>
    sdl:
      sourceAnalysisPool:
        name: <YourTeam_Windows_Pool>   # SDL source scans run here
        image: windows-2022
        os: windows
```

### Default behavior under the **Official** template

| Tool | On by default | Breaks build by default |
|------|:---:|:---:|
| AntiMalware | ✅ | ✅ |
| BinSkim | ✅ | ⚠️ (TSA-dependent) |
| Component Governance | ✅ | ⚠️ (unless alert has SLA) |
| CredScan | ❌ | ✅ (when run) |
| PoliCheck | ❌ | ✅ (when run) |
| PSScriptAnalyzer | ✅ | ⚠️ |
| ESLint / SpotBugs / Armory | ✅ | ⚠️ |
| CodeQL (3000) | ✅ | N/A |
| 1ES Secret Scanning (SPMI) | ✅ | ❌ |
| Roslyn | ❌ (copy-logs) | ✅ (when run) |

> **⚠️ = TSA-dependent**: if **TSA is enabled**, findings file bugs and the build does **not** break. If **TSA is disabled**, findings **break** the build and the break cannot be overridden to false. Other tools (BinSkim, CredScan, CodeQL, PreFast, ASan, ApiScan, CSRF, CSV) are supported but off by default; enable as needed.

- **Baselines / suppressions** for pre-existing findings: see the Generating Baselines and Suppressions doc; disable individual tools via the disabling-tools doc.
- **CloudBuild-based** builds route SDL through CloudBuild-Guardian (https://aka.ms/cbguardian) with a partial (growing) tool set.

## Signing, validation, containers, macOS/ARM64

- **Signing**: Official template + the Signing feature (ESRP). See features/signing.
- **Validation jobs**: `templateContext` validation job type for test-only jobs.
- **Containers for user-defined jobs**: run job steps in a container; `1ES.BuildContainerImage` / `containerImage` output for building/pushing images.
- **macOS**: `os: macOS`, `image: macos-latest-internal`, `name: Azure Pipelines` (bare-metal host, Xcode pre-installed; no container). Set Xcode via `DEVELOPER_DIR`. Needed for Xcode/Swift/ObjC, Apple signing/notarization, CocoaPods/Carthage, macOS unit tests.
- **ARM64**: supported — see the ARM64-on-1ES-PT doc.

## Migrating to 1ES PT

- **StartRight**: the onboarding tool that scaffolds/creates a compliant pipeline. See onboarding/migration docs.
- **Converter tooling** exists for OneBranch→1ES PT (used by Teams, ODSP conversions).
- Migration docs are split into **Migrating Build pipelines** and **Migrating Release pipelines**.
- When replacing a pipeline, **disable (deprecate)** the old one and keep it until the migrated governed pipeline is validated — don't delete first.

---

# Part 2 — OneBranch (governed specialization)

Use OneBranch for existing Windows/Linux **container-based** builds with vPacks, signing, and managed SDL. For anything new, prefer 1ES PT directly (Part 1). Drop to 1ES PT directly when you need macOS, non-containerized builds, or more flexibility.

## Template Repository & `extends`

```yaml
resources:
  repositories:
    - repository: templates
      type: git
      name: OneBranch.Pipelines/GovernedTemplates
      ref: refs/heads/main

extends:
  template: v2/OneBranch.NonOfficial.CrossPlat.yml@templates
  parameters:
    # ... pipeline config
```

| Template | Use case |
|----------|----------|
| `v2/OneBranch.NonOfficial.CrossPlat.yml` | Non-official (internal) builds — no vPack signing |
| `v2/OneBranch.Official.CrossPlat.yml` | Official builds — required for signed vPacks and production releases |

To produce **vPacks** you must use the `Official` template and register an official pipeline in the ADO project.

## Standard Variables

```yaml
variables:
  CDP_DEFINITION_BUILD_COUNT: $[counter('', 0)]   # required by onebranch.pipeline.version
  ENABLE_PRS_DELAYSIGN: 0
  ROOT: $(Build.SourcesDirectory)
  REPOROOT: $(Build.SourcesDirectory)
  OUTPUTROOT: $(REPOROOT)\out
  NUGET_XMLDOC_MODE: none
  WindowsContainerImage: 'onebranch.azurecr.io/windows/ltsc2022/vse2022:latest'
```

### Container Images

**Docs**: https://eng.ms/docs/products/onebranch/infrastructureandimages/containerimages

| Image | OS | VS | Notes |
|-------|----|----|-------|
| `onebranch.azurecr.io/windows/ltsc2019/vse2019:latest` | Server 2019 | 2019 | Legacy, no .NET 6+. **2019 hosts being deprecated.** |
| `onebranch.azurecr.io/windows/ltsc2019/vse2022:latest` | Server 2019 | 2022 | CMake 3.29.3. **2019 hosts being deprecated.** |
| `onebranch.azurecr.io/windows/ltsc2022/vse2022:latest` | Server 2022 | 2022 | CMake 3.31.6 (VS-bundled). FedRAMP compliant, **recommended** |
| `onebranch.azurecr.io/windows/ltsc2022/sdl:latest` | Server 2022 | — | Lightweight, for docker builds on 2022 hosts |

**Tags**: `latest` (production), `vprev` (rollback), `vnext` (pre-release). **`Windows_SDL_Container_Version`** controls the **SDL scanning container** tag — NOT the build container.

When using LTSC 2022, set the feature flag (**at the same level as `globalSdl`**, not inside it):

```yaml
featureFlags:
  WindowsHostVersion:
    Version: 2022         # required for 2022 containers
    Network: R1           # R1 = outbound internet access
```

For LTSC 2019 (default), no `Version` flag is needed; `Network: R1` still enables outbound. Images rebuilt monthly (Patch Tuesday, 2nd week), rolled out ~3rd week.

## SDL Configuration (`globalSdl`)

```yaml
globalSdl:
  baseline:
    baselineFile: $(Build.SourcesDirectory)\.gdn\.gdnbaselines
    suppressionSet: default
  tsa:
    enabled: false      # when false, SDL tools run in 'break' mode instead of reporting to TSA
  binskim:
    break: false        # true = fail build on BinSkim issues
  policheck:
    break: false
  # credscan:
  #   suppressionsFile: $(Build.SourcesDirectory)\.config\CredScanSuppressions.json
```

Suppressions: `.gdn/.gdnbaselines` (baselines), `.config/CredScanSuppressions.json` (CredScan). Code-sign validation exclusion (job variable): `ob_sdl_codeSignValidation_excludes: '-|**\*.exe;-|**\*.dll;-|**\*.js'`.

## Build & Release Stages

```yaml
stages:
- stage: build
  jobs:
  - job: build
    pool:
      type: windows          # OneBranch pool types: windows, linux
    variables:
      ob_outputDirectory: '$(Build.SourcesDirectory)\out'   # everything here → artifact drop_build_<job>
      target_project: '$(Build.SourcesDirectory)\MyProject\MyProject.csproj'
      BuildConfiguration: 'Release'
    steps:
      - task: DotNetCoreCLI@2
        displayName: 'Build + Publish'
        inputs:
          command: 'publish'
          publishWebProjects: false
          projects: '$(target_project)'
          arguments: '--configuration $(BuildConfiguration) --output $(ob_outputDirectory)'

- stage: PPE_release
  variables:
    ob_release_environment: PPE    # PPE or Production
  dependsOn: build
  jobs:
  - job: release
    templateContext:
      inputs:
      - input: pipelineArtifact
        artifactName: drop_build_build    # pattern: drop_<stage>_<job>
    pool:
      type: release
    steps:
      - task: AzureFunctionApp@2
        inputs:
          azureSubscription: 'MyServiceConnection'
          # ...
```

### `ob_outputDirectory` & artifact naming

- Everything written to `ob_outputDirectory` is auto-uploaded as pipeline artifact **`drop_<stageName>_<jobName>`** (e.g., stage `build` + job `build` → `drop_build_build`).
- **Download location (common mistake)**: with `templateContext.inputs`, OneBranch downloads artifact **contents directly into `$(Pipeline.Workspace)/`** — NOT into a subfolder named after the artifact. If build wrote `ob_outputDirectory/App_Data/...`, it lands at `$(Pipeline.Workspace)/App_Data/...`. Using `$(Pipeline.Workspace)\drop_build_build` fails with "No package found".

## Deployment Patterns

```yaml
# Azure Function (zip deploy)
- task: AzureFunctionApp@2
  inputs:
    azureSubscription: 'MyServiceConnection'
    appType: 'functionApp'
    appName: 'MyFunctionApp'
    package: '$(Pipeline.Workspace)/MyApp.zip'
    deploymentMethod: 'zipDeploy'
    platform: 'windows'
    runtimeStack: 'dotnetIsolated'
    resourceGroupName: 'my-rg'

# Azure WebJob / Web App (web deploy)
- task: AzureRmWebAppDeployment@4
  inputs:
    ConnectionType: 'AzureRM'
    azureSubscription: 'MyServiceConnection'
    appType: 'webApp'
    WebAppName: 'my-web-app'
    ResourceGroupName: 'my-rg'
    packageForLinux: '$(Pipeline.Workspace)'   # folder CONTAINING App_Data, not App_Data itself
    enableCustomDeployment: true
    DeploymentType: 'webDeploy'
```

WebJob folder structure: `App_Data/jobs/triggered/<Name>/` (triggered) or `App_Data/jobs/continuous/<Name>/` (continuous); include `run.cmd` + `Settings.job`. Note: `packageForLinux` is the generic package path for **both** Windows and Linux; `appType` (`webApp` vs `webAppLinux`) selects the platform.

## Release Environments & Versioning

- `ob_release_environment`: `PPE` (test) or `Production`. For production also set `ob_release_servicetreeid` to your ServiceTree GUID.
- Versioning: `name: 1.0.$(date:yyMMdd)$(rev:rr)` or the `onebranch.pipeline.version@1` task.

## Quick Checklist (OneBranch)

1. `trigger: none` or configure branch triggers
2. Import `OneBranch.Pipelines/GovernedTemplates`; extend the right `v2/OneBranch.*.CrossPlat.yml`
3. Configure `globalSdl` (baseline, TSA, BinSkim, PoliCheck)
4. Set `WindowsContainerImage` + `featureFlags.WindowsHostVersion` if using 2022
5. Build stage with `ob_outputDirectory`; release stage(s) with `pool: type: release` + `templateContext.inputs`
6. Right deployment task (`AzureFunctionApp@2` / `AzureRmWebAppDeployment@4`)

---

# Shared operations (both frameworks)

## Fetching Build Logs via REST API

```powershell
$token = (az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
$headers = @{ Authorization = "Bearer $token" }
$buildId = 140481664

# 1. Build timeline (all stages/jobs/tasks)
$timeline = Invoke-RestMethod -Uri "https://microsoft.visualstudio.com/DefaultCollection/{Project}/_apis/build/builds/$buildId/timeline?api-version=7.0" -Headers $headers

# 2. Find a task record (task GUID from the ADO URL's t= parameter)
$taskRecord = $timeline.records | Where-Object { $_.id -eq '<task-guid>' }

# 3. Download the full log text
$logContent = Invoke-RestMethod -Uri $taskRecord.log.url -Headers $headers
```

ADO build URL: `.../_build/results?buildId=<id>&view=logs&j=<job-guid>&t=<task-guid>`. Timeline records have `type` = `Stage`/`Phase`/`Job`/`Task`. Write log output to a temp file and `read_file` it back. Lines starting with `##[error]`/`##[section]` are ADO pipeline commands.

## Git Push in PowerShell Steps (Windows PowerShell 5.1)

OneBranch build containers run **Windows PowerShell 5.1** (not pwsh 7). When capturing `git push` output with `2>&1`, stderr lines become `ErrorRecord` objects; with `$ErrorActionPreference='Continue'` (ADO default) these trigger a `NativeCommandError` and exit 1 even when the push succeeds.

```powershell
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$pushOutput = git push --tags origin upmain:main 2>&1
$pushExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

$pushOutput | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host "[stderr] $($_.Exception.Message)" }
    else { Write-Host "[stdout] $_" }
}
if ($pushExit -ne 0) { Write-Host "##vso[task.logissue type=error]git push failed (exit $pushExit)."; exit 1 }
```

Git writes progress and `To https://...` to stderr even on success — always rely on `$LASTEXITCODE` (not `$?` or ErrorRecords) for native commands.

## Build Service Identity

Pipelines use `$(system.accesstoken)` for git and feed operations. The identity depends on the **Job Authorization Scope** ADO project setting (not the Official vs NonOfficial template):

| Setting | Identity |
|---------|----------|
| Organization/Collection scope | `Project Collection Build Service ({OrgName})` |
| Project scope (default for new projects) | `{ProjectName} Build Service ({OrgName})` |

Check the active identity in build logs under "Setup Packages Auth" / "Job preparation". When granting repo permissions (e.g., "Bypass policies when pushing"), grant the **correct identity** for your project's scope.
