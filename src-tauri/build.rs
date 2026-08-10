fn main() {
    // 图标文件变化时重新嵌入 exe 资源
    println!("cargo:rerun-if-changed=icons");
    // 显式声明 PerMonitorV2 DPI 感知，避免窗口/显示器坐标被系统虚拟化导致单位不一致
    let manifest = r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(manifest)),
    )
    .expect("failed to run tauri-build");
}
// rebuild-trigger: 2026-08-09 about-page-update
// rebuild-trigger: 2026-08-09 network-payloads-ai-eye
// rebuild-trigger: 2026-08-09 random-case
// rebuild-trigger: 2026-08-09 port-chips
// rebuild-212814
// rebuild-215850

// touch 20260810011337

// rebuild-trigger: 2026-08-10 020800 sql-friendly-errors cron-validation
