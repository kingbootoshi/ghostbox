# Ghostbox macOS App

The native app is built from the XcodeGen spec at `native/project.yml`.
`native/Ghostbox.xcodeproj` is generated output and should not be edited as the source of truth.

## Prerequisites

- Xcode installed and selected with `xcode-select`
- XcodeGen installed: `brew install xcodegen`

## Generate the project

```bash
bun run native:generate
```

This creates `native/Ghostbox.xcodeproj` from `native/project.yml`.

## Build

```bash
bun run build:native
```

The build command regenerates the project first, then builds the `Ghostbox` scheme in Release configuration.

## Dependency lock

The generated project is ignored, but `native/Ghostbox.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` is intentionally tracked. That lockfile pins Swift Package Manager transitive dependencies so a clean checkout resolves the same package graph.

