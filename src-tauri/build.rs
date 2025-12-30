use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // .envファイルから環境変数を読み込み
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let project_root = Path::new(&manifest_dir).parent().unwrap();
    let env_path = project_root.join(".env");

    if env_path.exists() {
        if let Ok(content) = fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    let key = key.trim();
                    let value = value.trim();
                    println!("cargo:rustc-env={}={}", key, value);
                }
            }
        }
    }

    tauri_build::build()
}
