# Package-manager release candidates

This directory prepares reviewable candidates. It does not publish a Homebrew
formula, upload a GitHub Release asset, create a WinGet pull request, or make
external catalog decisions. Those actions happen in the separate tap and
catalog repositories.

## Homebrew

`scripts/generate-package-manager-manifests.js` produces a formula candidate
from the exact `relmio-<version>.tgz` that is about to be, or has just been,
published to npm. Its URL is the immutable npm registry tarball URL and its
SHA-256 is calculated from the supplied local tarball.

The formula follows Homebrew's Node guidance: it depends on `node`, uses
`std_npm_args`, installs to `libexec`, and symlinks the resulting executables.
Relmio's dependency tree has an optional native Node addon, so the formula
also has a build dependency on `python` as Homebrew requires for `node-gyp`.

Before a public tap submission, download the published npm tarball from the
registry and confirm its SHA-256 matches the generated formula. Then validate
the candidate in the separate tap repository with Homebrew's current audit and
source-install commands. There is no tap in this repository and no assumption
that `homebrew/core` accepts the formula.

### External status

The external [`Demonbane18/homebrew-relmio`](https://github.com/Demonbane18/homebrew-relmio)
tap is live at formula commit `6c8038f`. Its macOS workflow run `30905921073`
passed the Homebrew audit, tap-qualified install, `relmio --version`, and
`brew test` for Relmio 0.2.14. This repository generated the reviewed
candidate; the external tap repository publishes and tests it.

## WinGet

WinGet does not accept script installers. The staged ZIP contains an actual
`relmio.exe` portable launcher, an official Node.js Windows runtime (including
npm/npx), the npm-package contents, and the production dependency tree. The
launcher always invokes the bundled `runtime\node.exe`, preserving Relmio's
Windows `npx` resolution relative to `process.execPath`.

Build one ZIP per architecture from checksum-verified official Node.js runtime
archives. The output names are fixed:

```
relmio-<version>-windows-x64.zip
relmio-<version>-windows-arm64.zip
```

The generated manifests use WinGet's current 1.12 multi-file format and the
portable ZIP pattern: `InstallerType: zip`, `NestedInstallerType: portable`,
and `relmio.exe` as the command alias. They point only to versioned GitHub
Release asset URLs. Generate the manifests only from the exact ZIPs uploaded to
that release.

The proposed identifier, `Demonbane18.Relmio`, must be checked for uniqueness
in `microsoft/winget-pkgs` before a submission. A maintainer must run `winget
validate` and the repository's Sandbox test against the generated directory,
then submit exactly one version through a separate `winget-pkgs` pull request.
The package is not available through WinGet until that pull request is merged
and the catalog has updated.

A WinGet manifest pull request has been submitted separately and is pending
review, merge, and catalog propagation. This repository's generator does not
submit that pull request or publish the catalog entry, and public documentation
must keep the WinGet install command hidden until the catalog accepts it.

## Generate candidates

Generate the Homebrew formula only after npm publishing, from the exact
immutable tarball downloaded back from the registry. Never use a separately
built local or Windows tarball for the tap checksum:

```powershell
curl.exe -fsSL https://registry.npmjs.org/relmio/-/relmio-<version>.tgz -o relmio-<version>.tgz
node scripts/generate-package-manager-manifests.js `
  --npm-tarball relmio-<version>.tgz `
  --output-dir .release/homebrew-candidate
```

The WinGet candidates are generated independently from the exact release ZIPs:

```powershell
node scripts/generate-package-manager-manifests.js `
  --winget-x64 .release/relmio-<version>-windows-x64.zip `
  --winget-arm64 .release/relmio-<version>-windows-arm64.zip `
  --output-dir .release/package-manager-candidates
```

The command intentionally refuses to overwrite an existing output directory.
It makes no network request and prints an explicit non-publication notice.

## Primary references checked on 2026-08-04

- [Homebrew: Node for Formula Authors](https://docs.brew.sh/Node-for-Formula-Authors)
- [Homebrew: Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Microsoft Learn: Create your package manifest](https://learn.microsoft.com/windows/package-manager/package/manifest)
- [Microsoft Learn: Submit your manifest to the repository](https://learn.microsoft.com/windows/package-manager/package/repository)
