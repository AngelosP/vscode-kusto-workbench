Feature: Kusto favorites synchronize across sections and open files

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many.kqlx" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"id\":\"query_single_many\",\"query\":\"print single_many_kqlx=1\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.kql" exists with content "print single_many_sidecar_kql=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.kql.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"single-many-sidecar.kql\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.csl" exists with content "print single_many_sidecar_csl=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.csl.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"single-many-sidecar.csl\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"id\":\"query_one_source\",\"query\":\"print one_source_kqlx=1\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"id\":\"query_one_target\",\"query\":\"print one_target_kqlx=1\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql" exists with content "print source_plain_kql=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql" exists with content "print target_plain_kql=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl" exists with content "print source_plain_csl=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl" exists with content "print target_plain_csl=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql" exists with content "print source_sidecar_kql=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"one-source-sidecar.kql\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql" exists with content "print target_sidecar_kql=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"one-target-sidecar.kql\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl" exists with content "print source_sidecar_csl=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"one-source-sidecar.csl\"}]}}"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl" exists with content "print target_sidecar_csl=1"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl.json" exists with content "{\"kind\":\"kqlx\",\"version\":1,\"state\":{\"sections\":[{\"type\":\"query\",\"linkedQueryPath\":\"one-target-sidecar.csl\"}]}}"

  Scenario Outline: One open file updates every Kusto section in that file
    When I open file "<filePath>" in the editor
    And I wait for "kw-query-section" in the webview "<title>" for 20 seconds
    When I evaluate "window.__e2e.kusto.favorites.prepareDocument({ clusterUrl: '<clusterUrl>', database: '<database>', sectionCount: 3 })" in the webview "<title>" for 15 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<title>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3)" in the webview "<title>" for 10 seconds
    When I evaluate "window.__e2e.kusto.favorites.addFromSection(0)" in the webview "<title>" for 10 seconds
    And I type "<favoriteName>" into the InputBox
    And I press "Enter"
    When I evaluate "window.__e2e.kusto.favorites.assertVisibleInAllSections('<favoriteName>', 3, 10000)" in the webview "<title>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<title>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3, 10000)" in the webview "<title>" for 12 seconds
    When I execute command "workbench.action.closeAllEditors"

    Examples:
      | filePath                                                                                     | title                    | clusterUrl                                       | database   | favoriteName           |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many.kqlx              | single-many.kqlx         | https://favsync-single-kqlx.kusto.windows.net    | SingleDb01 | favsync-single-kqlx    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.kql        | single-many-sidecar.kql  | https://favsync-single-kqljs.kusto.windows.net   | SingleDb02 | favsync-single-kqljs   |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/single-many-sidecar.csl        | single-many-sidecar.csl  | https://favsync-single-csljs.kusto.windows.net   | SingleDb03 | favsync-single-csljs   |

  Scenario Outline: Favorite added in one open file appears in another already-open one-section file
    When I open file "<targetPath>" in the editor
    And I wait for "kw-query-section" in the webview "<targetTitle>" for 20 seconds
    When I evaluate "window.__e2e.kusto.favorites.prepareDocument({ clusterUrl: '<clusterUrl>', database: '<database>', sectionCount: 1 })" in the webview "<targetTitle>" for 15 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<targetTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 1)" in the webview "<targetTitle>" for 10 seconds
    And I evaluate "window.__favsyncProbeToken = window.__e2e.kusto.favorites.setProbe('<favoriteName>')" in the webview "<targetTitle>" for 5 seconds
    When I open file "<sourcePath>" in the editor
    And I wait for "kw-query-section" in the webview "<sourceTitle>" for 20 seconds
    When I evaluate "window.__e2e.kusto.favorites.prepareDocument({ clusterUrl: '<clusterUrl>', database: '<database>', sectionCount: 1 })" in the webview "<sourceTitle>" for 15 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<sourceTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 1)" in the webview "<sourceTitle>" for 10 seconds
    When I evaluate "window.__e2e.kusto.favorites.addFromSection(0)" in the webview "<sourceTitle>" for 10 seconds
    And I type "<favoriteName>" into the InputBox
    And I press "Enter"
    When I evaluate "window.__e2e.kusto.favorites.assertVisibleInAllSections('<favoriteName>', 1, 10000)" in the webview "<sourceTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertProbe(window.__favsyncProbeToken || '<missing>')" in the webview "<targetTitle>" for 5 seconds
    When I evaluate "window.__e2e.kusto.favorites.assertVisibleInAllSections('<favoriteName>', 1, 10000)" in the webview "<targetTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<sourceTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 1, 10000)" in the webview "<sourceTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 1, 10000)" in the webview "<targetTitle>" for 12 seconds
    When I execute command "workbench.action.closeAllEditors"

    Examples:
      | sourcePath                                                                                 | sourceTitle            | targetPath                                                                                 | targetTitle            | clusterUrl                                            | database | favoriteName              |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx           | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx           | one-target.kqlx        | https://favsync-1-kqlx-kqlx.kusto.windows.net         | OneDb01  | favsync-1-kqlx-kqlx      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx           | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql            | one-target.kql         | https://favsync-1-kqlx-kql.kusto.windows.net          | OneDb02  | favsync-1-kqlx-kql       |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx           | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl            | one-target.csl         | https://favsync-1-kqlx-csl.kusto.windows.net          | OneDb03  | favsync-1-kqlx-csl       |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx           | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql    | one-target-sidecar.kql | https://favsync-1-kqlx-kqljs.kusto.windows.net        | OneDb04  | favsync-1-kqlx-kqljs     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx           | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl    | one-target-sidecar.csl | https://favsync-1-kqlx-csljs.kusto.windows.net        | OneDb05  | favsync-1-kqlx-csljs     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql            | one-source.kql         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx           | one-target.kqlx        | https://favsync-1-kql-kqlx.kusto.windows.net          | OneDb06  | favsync-1-kql-kqlx       |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql            | one-source.kql         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql            | one-target.kql         | https://favsync-1-kql-kql.kusto.windows.net           | OneDb07  | favsync-1-kql-kql        |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql            | one-source.kql         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl            | one-target.csl         | https://favsync-1-kql-csl.kusto.windows.net           | OneDb08  | favsync-1-kql-csl        |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql            | one-source.kql         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql    | one-target-sidecar.kql | https://favsync-1-kql-kqljs.kusto.windows.net         | OneDb09  | favsync-1-kql-kqljs      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kql            | one-source.kql         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl    | one-target-sidecar.csl | https://favsync-1-kql-csljs.kusto.windows.net         | OneDb10  | favsync-1-kql-csljs      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl            | one-source.csl         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx           | one-target.kqlx        | https://favsync-1-csl-kqlx.kusto.windows.net          | OneDb11  | favsync-1-csl-kqlx       |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl            | one-source.csl         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql            | one-target.kql         | https://favsync-1-csl-kql.kusto.windows.net           | OneDb12  | favsync-1-csl-kql        |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl            | one-source.csl         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl            | one-target.csl         | https://favsync-1-csl-csl.kusto.windows.net           | OneDb13  | favsync-1-csl-csl        |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl            | one-source.csl         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql    | one-target-sidecar.kql | https://favsync-1-csl-kqljs.kusto.windows.net         | OneDb14  | favsync-1-csl-kqljs      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.csl            | one-source.csl         | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl    | one-target-sidecar.csl | https://favsync-1-csl-csljs.kusto.windows.net         | OneDb15  | favsync-1-csl-csljs      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql    | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx           | one-target.kqlx        | https://favsync-1-kqljs-kqlx.kusto.windows.net        | OneDb16  | favsync-1-kqljs-kqlx     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql    | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql            | one-target.kql         | https://favsync-1-kqljs-kql.kusto.windows.net         | OneDb17  | favsync-1-kqljs-kql      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql    | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl            | one-target.csl         | https://favsync-1-kqljs-csl.kusto.windows.net         | OneDb18  | favsync-1-kqljs-csl      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql    | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql    | one-target-sidecar.kql | https://favsync-1-kqljs-kqljs.kusto.windows.net       | OneDb19  | favsync-1-kqljs-kqljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql    | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl    | one-target-sidecar.csl | https://favsync-1-kqljs-csljs.kusto.windows.net       | OneDb20  | favsync-1-kqljs-csljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl    | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx           | one-target.kqlx        | https://favsync-1-csljs-kqlx.kusto.windows.net        | OneDb21  | favsync-1-csljs-kqlx     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl    | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kql            | one-target.kql         | https://favsync-1-csljs-kql.kusto.windows.net         | OneDb22  | favsync-1-csljs-kql      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl    | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.csl            | one-target.csl         | https://favsync-1-csljs-csl.kusto.windows.net         | OneDb23  | favsync-1-csljs-csl      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl    | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql    | one-target-sidecar.kql | https://favsync-1-csljs-kqljs.kusto.windows.net       | OneDb24  | favsync-1-csljs-kqljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl    | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl    | one-target-sidecar.csl | https://favsync-1-csljs-csljs.kusto.windows.net       | OneDb25  | favsync-1-csljs-csljs    |

  Scenario Outline: Favorite added in one open file appears in another already-open many-section file
    When I open file "<targetPath>" in the editor
    And I wait for "kw-query-section" in the webview "<targetTitle>" for 20 seconds
    When I evaluate "window.__e2e.kusto.favorites.prepareDocument({ clusterUrl: '<clusterUrl>', database: '<database>', sectionCount: 3 })" in the webview "<targetTitle>" for 15 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<targetTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3)" in the webview "<targetTitle>" for 10 seconds
    And I evaluate "window.__favsyncProbeToken = window.__e2e.kusto.favorites.setProbe('<favoriteName>')" in the webview "<targetTitle>" for 5 seconds
    When I open file "<sourcePath>" in the editor
    And I wait for "kw-query-section" in the webview "<sourceTitle>" for 20 seconds
    When I evaluate "window.__e2e.kusto.favorites.prepareDocument({ clusterUrl: '<clusterUrl>', database: '<database>', sectionCount: 3 })" in the webview "<sourceTitle>" for 15 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<sourceTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3)" in the webview "<sourceTitle>" for 10 seconds
    When I evaluate "window.__e2e.kusto.favorites.addFromSection(0)" in the webview "<sourceTitle>" for 10 seconds
    And I type "<favoriteName>" into the InputBox
    And I press "Enter"
    When I evaluate "window.__e2e.kusto.favorites.assertVisibleInAllSections('<favoriteName>', 3, 10000)" in the webview "<sourceTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertProbe(window.__favsyncProbeToken || '<missing>')" in the webview "<targetTitle>" for 5 seconds
    When I evaluate "window.__e2e.kusto.favorites.assertVisibleInAllSections('<favoriteName>', 3, 10000)" in the webview "<targetTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.clean({ clusterUrl: '<clusterUrl>', database: '<database>' })" in the webview "<sourceTitle>" for 10 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3, 10000)" in the webview "<sourceTitle>" for 12 seconds
    And I evaluate "window.__e2e.kusto.favorites.assertAbsentInAllSections('<favoriteName>', 3, 10000)" in the webview "<targetTitle>" for 12 seconds
    When I execute command "workbench.action.closeAllEditors"

    Examples:
      | sourcePath                                                                              | sourceTitle            | targetPath                                                                              | targetTitle            | clusterUrl                                           | database | favoriteName             |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx        | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx        | one-target.kqlx        | https://favsync-m-kqlx-kqlx.kusto.windows.net        | ManyDb01 | favsync-m-kqlx-kqlx      |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx        | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql | one-target-sidecar.kql | https://favsync-m-kqlx-kqljs.kusto.windows.net       | ManyDb02 | favsync-m-kqlx-kqljs     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source.kqlx        | one-source.kqlx        | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl | one-target-sidecar.csl | https://favsync-m-kqlx-csljs.kusto.windows.net       | ManyDb03 | favsync-m-kqlx-csljs     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx        | one-target.kqlx        | https://favsync-m-kqljs-kqlx.kusto.windows.net       | ManyDb04 | favsync-m-kqljs-kqlx     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql | one-target-sidecar.kql | https://favsync-m-kqljs-kqljs.kusto.windows.net      | ManyDb05 | favsync-m-kqljs-kqljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.kql | one-source-sidecar.kql | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl | one-target-sidecar.csl | https://favsync-m-kqljs-csljs.kusto.windows.net      | ManyDb06 | favsync-m-kqljs-csljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target.kqlx        | one-target.kqlx        | https://favsync-m-csljs-kqlx.kusto.windows.net       | ManyDb07 | favsync-m-csljs-kqlx     |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.kql | one-target-sidecar.kql | https://favsync-m-csljs-kqljs.kusto.windows.net      | ManyDb08 | favsync-m-csljs-kqljs    |
      | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-source-sidecar.csl | one-source-sidecar.csl | tests/vscode-extension-tester/runs/default/kusto-favorites-sync/one-target-sidecar.csl | one-target-sidecar.csl | https://favsync-m-csljs-csljs.kusto.windows.net      | ManyDb09 | favsync-m-csljs-csljs    |