{
  "targets": [
    {
      "target_name": "lamarck_device_identity",
      "sources": ["device_identity.cc"],
      "defines": ["NAPI_VERSION=9"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          }
        }],
        ["OS=='win'", {
          "libraries": ["windowsapp.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/EHsc"]
            }
          }
        }]
      ]
    }
  ]
}
