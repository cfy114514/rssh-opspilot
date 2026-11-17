#[path = "../scripts/platform-cfg.rs"]
mod platform_cfg;

fn main() {
    println!("cargo:rerun-if-changed=../scripts/platform-cfg.rs");
    platform_cfg::configure();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var_os("CARGO_FEATURE_TAURI").is_some()
    {
        println!("cargo:rustc-link-arg-bin=rssh=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    #[cfg(feature = "tauri")]
    tauri_build::build();
}
