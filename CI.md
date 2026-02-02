# CI and buildability

## Workflows

| Workflow | Location | What it builds |
|----------|----------|----------------|
| **Build Stegstr** | `.github/workflows/build.yml` | Desktop Tauri app on macOS, Ubuntu, Windows. Uploads artifacts per platform. |
| **Release Stegstr** | `.github/workflows/release.yml` | Desktop Tauri on macOS/Ubuntu/Windows; creates DMG (macOS), exe/msi (Windows), deb/AppImage (Linux); creates GitHub Release with stable-named assets. |
| **Check PR** | `mobile-android/.github/workflows/PR-workflow.yml` | Android: detekt, lint, unit tests, compile AOSP/Google debug. Runs on macOS. |
| **Create release from tag** | `mobile-android/.github/workflows/tag-release.yml` | Android: build and sign APK/AAB, publish to Google Play internal, create GitHub release. Runs on Ubuntu. |
| **Build and publish iOS XCFramework** | `mobile-android/.github/workflows/ios-xcframework.yml` | iOS XCFramework from Android shared code; pushes to primal-shared-ios. Runs on macOS. |
| **Publish to Zapstore** | `mobile-android/.github/workflows/publish-zapstore.yml` | Manual: publish to Zapstore. Runs on Ubuntu. |

## Buildability rules

- **Desktop release runs on Windows.** Any step in `.github/workflows/release.yml` (or any job that uses `windows-latest`) whose `run:` script uses bash syntax must set **`shell: bash`**. See [.github/workflows/README.md](.github/workflows/README.md) for the shell convention.
- Workflows are grouped by product: desktop Tauri under repo `.github/workflows/`, Android under `mobile-android/.github/workflows/`. When adding or changing a version, keep that product’s workflows in its tree so one version stays updateable without breaking another.
