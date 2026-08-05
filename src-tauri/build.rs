fn main() {
    // 图标文件变化时必须重新嵌入 exe 资源（tauri-build 默认只监视 tauri.conf.json 与 capabilities）
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
