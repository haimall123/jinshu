fn main() {
    for source in [
        "native/core.cpp",
        "native/core.h",
        "native/updates.cpp",
        "native/updates.h",
        "native/bridge.cpp",
        "native/vendor/json.hpp",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .flag_if_supported("/utf-8")
        .include("native")
        .file("native/core.cpp")
        .file("native/updates.cpp")
        .file("native/bridge.cpp")
        .compile("moira_bridge");
    for library in ["user32", "gdi32", "ole32", "uuid", "comdlg32", "shell32", "shlwapi"] {
        println!("cargo:rustc-link-lib={library}");
    }
    tauri_build::build();
}
