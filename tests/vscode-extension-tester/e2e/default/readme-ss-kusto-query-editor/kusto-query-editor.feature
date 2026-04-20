Feature: Capture kusto-query-editor screenshot
  Scenario: KQL datatable query with results
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 800 by 880
    And I execute command "kusto.openQueryEditor"
    And I wait 8 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    When I evaluate "__testFocusMonaco('kw-query-section .monaco-editor')" in the webview
    And I wait 1 second
    When I evaluate "__testSetEditorValue(atob('bGV0IFNhbXBsZURhdGEgPSBkYXRhdGFibGUoUHJvZHVjdDogc3RyaW5nLCBSZWdpb246IHN0cmluZywgU2FsZXM6IGludCwgRGF0ZTogZGF0ZXRpbWUpClsKICAgICJXaWRnZXQgQSIsICJOb3J0aCIsIDE1MCwgZGF0ZXRpbWUoMjAyNC0wMS0xNSksCiAgICAiV2lkZ2V0IEIiLCAiU291dGgiLCAyMzAsIGRhdGV0aW1lKDIwMjQtMDEtMTYpLAogICAgIldpZGdldCBBIiwgIkVhc3QiLCAxODAsIGRhdGV0aW1lKDIwMjQtMDEtMTcpLAogICAgIldpZGdldCBDIiwgIldlc3QiLCAzMjAsIGRhdGV0aW1lKDIwMjQtMDEtMTgpLAogICAgIldpZGdldCBCIiwgIk5vcnRoIiwgMjc1LCBkYXRldGltZSgyMDI0LTAxLTE5KSwKICAgICJXaWRnZXQgQSIsICJTb3V0aCIsIDE5NSwgZGF0ZXRpbWUoMjAyNC0wMS0yMCksCiAgICAiV2lkZ2V0IEMiLCAiRWFzdCIsIDQxMCwgZGF0ZXRpbWUoMjAyNC0wMS0yMSksCiAgICAiV2lkZ2V0IEIiLCAiV2VzdCIsIDI5MCwgZGF0ZXRpbWUoMjAyNC0wMS0yMikKXQo7ClNhbXBsZURhdGEKICAgIHwgc3VtbWFyaXplCiAgICAgICAgVG90YWxTYWxlcyA9IHN1bShTYWxlcyksCiAgICAgICAgQXZnU2FsZXMgPSBhdmcoU2FsZXMpCiAgICAgICAgYnkKICAgICAgICBQcm9kdWN0CiAgICB8IG9yZGVyIGJ5IFRvdGFsU2FsZXMgZGVzYwogICAgfCBleHRlbmQgUmFuayA9IHJvd19udW1iZXIoKQ=='))" in the webview
    And I wait 1 second
    And I press "Ctrl+S"
    And I wait 2 seconds
    Then I take a screenshot "01-query-editor"
